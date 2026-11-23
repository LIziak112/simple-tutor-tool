import type { PracticeWorkflowUpdateRequest } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Attempt, attempts } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { requireUsableAttempt } from "./attempt-access.ts";
import { kernelAttemptUnavailable } from "./kernel-assignment-runtime.ts";
import {
  reserveKernelCourseWorkflow,
  resolveKernelCourseWorkflow,
} from "./kernel-course-workflow.ts";
import {
  courseKernelBinding,
  wrongKernelBinding,
} from "./kernel-question-delivery-binding.ts";
import { readQuestionDeliveryFacts } from "./kernel-question-delivery-recovery.ts";
import {
  assertDraftCourseVisible,
  attemptWorkflowView,
  practiceProtocolOf,
  requireOwnActiveAttempt,
} from "./practice-workflow-wiring.ts";

function stale(): never {
  throw new HttpError(
    409,
    "WORKFLOW_REVISION_STALE",
    "反馈节奏已在其他设备修改，请刷新后重试",
  );
}

function assertMutableWorkflow(db: Db, attempt: Attempt) {
  if (practiceProtocolOf(attempt) !== "v1")
    throw new HttpError(
      409,
      "WORKFLOW_LEGACY",
      "这份作答不支持更改反馈节奏（旧协议或讲练作答）",
    );
  if (attempt.status !== "draft")
    throw new HttpError(
      409,
      "ALREADY_SUBMITTED",
      "已交卷的作答不能更改反馈节奏",
    );
  assertDraftCourseVisible(db, attempt.studentId, attempt);
}

function checkedWorkflow(
  db: Db,
  attempt: Attempt,
  request: PracticeWorkflowUpdateRequest,
) {
  assertMutableWorkflow(db, attempt);
  const view = attemptWorkflowView(db, attempt);
  if (view === null)
    throw new HttpError(
      409,
      "WORKFLOW_LEGACY",
      "这份作答的工作流数据异常，按旧协议处理",
    );
  if (view.questionProgress.some(({ submittedAt }) => submittedAt !== null))
    throw new HttpError(
      409,
      "QUESTION_ALREADY_SUBMITTED",
      "已有题目提交，反馈节奏已固定",
    );
  if (attempt.workflowRevision !== request.workflowRevision) stale();
  if (
    !view.practiceWorkflow.allowedFeedbackModes.includes(request.feedbackMode)
  )
    throw new HttpError(
      400,
      "WORKFLOW_MODE_NOT_ALLOWED",
      "当前规则不允许该反馈节奏",
    );
}

export function updateAttemptWorkflow(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  request: PracticeWorkflowUpdateRequest,
) {
  const load = () => {
    const attempt = requireOwnActiveAttempt(db, studentId, attemptId);
    assertMutableWorkflow(db, attempt);
    const course =
      attempt.sourceType === "course"
        ? courseKernelBinding(db, attempt.id)
        : undefined;
    if (
      !course &&
      (attempt.sourceType !== "wrong" || !wrongKernelBinding(db, attempt.id))
    )
      return { attempt, course };
    const facts = readQuestionDeliveryFacts(db, dataDir, attempt);
    if (!facts) kernelAttemptUnavailable();
    const recovered =
      course?.pendingWorkflow?.workflowRevision === request.workflowRevision &&
      course.pendingWorkflow.feedbackMode === request.feedbackMode &&
      facts.attempt.workflowRevision === request.workflowRevision + 1;
    return {
      attempt: facts.attempt,
      course: course ? courseKernelBinding(db, attempt.id) : undefined,
      recovered,
    };
  };
  const written = db.$client
    .transaction(() => {
      const { attempt, course, recovered } = load();
      if (recovered) return attempt;
      checkedWorkflow(db, attempt, request);
      if (course && request.feedbackMode !== attempt.feedbackMode) {
        requireUsableAttempt(db, studentId, attemptId);
        const pending = course.pendingWorkflow;
        if (pending) {
          if (
            pending.workflowRevision !== request.workflowRevision ||
            pending.feedbackMode !== request.feedbackMode
          )
            stale();
        } else reserveKernelCourseWorkflow(db, attempt, request);
        return undefined;
      }
      if (course?.pendingWorkflow) stale();
      const fresh = db
        .update(attempts)
        .set({
          feedbackMode: request.feedbackMode,
          workflowRevision: request.workflowRevision + 1,
        })
        .where(
          and(
            eq(attempts.id, attempt.id),
            eq(attempts.workflowRevision, request.workflowRevision),
          ),
        )
        .returning()
        .get();
      if (!fresh) stale();
      return fresh;
    })
    .immediate();
  const attempt =
    written ??
    db.$client
      .transaction(() => {
        const { attempt, course, recovered } = load();
        if (recovered) return attempt;
        checkedWorkflow(db, attempt, request);
        if (!course?.pendingWorkflow) kernelAttemptUnavailable();
        requireUsableAttempt(db, studentId, attemptId);
        return resolveKernelCourseWorkflow(db, dataDir, attempt, true);
      })
      .immediate();
  const view = attemptWorkflowView(db, attempt);
  if (!view) throw new HttpError(500, "INTERNAL", "工作流投影缺失");
  return view;
}

import { createHash, randomUUID } from "node:crypto";
import {
  type AttemptPartialRequest,
  attemptSettlementResultSchema,
  type PracticeSubmissionOrigin,
} from "@tutor/contract";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { attemptSettlements, responses } from "../db/schema.ts";
import { canonicalJsonOf } from "../lib/canonical-json.ts";
import { HttpError } from "../lib/http-error.ts";
import { attemptAnswersPublished } from "./answer-publication.ts";
import { autoFinishPerQuestionAttempt } from "./attempt-auto-finish.ts";
import { frozenMemberRefs } from "./attempt-frozen-integrity.ts";
import { commitPracticeQuestion } from "./attempt-practice-submit.ts";
import {
  materialSlotOrderOf,
  resultQuestionOf,
  studentFacingResultOf,
} from "./attempt-question-projection.ts";
import { restrictedResultQuestionOf } from "./attempt-result-release.ts";
import { attemptSourceMeta, frozenRowsInDisplayOrder } from "./attempt-rows.ts";
import { timeProjectionsOf } from "./attempt-time-projection";
import { sealResponseTimeWithin } from "./attempt-time-seal";
import { submissionActivityOf } from "./event-service.ts";
import {
  assertDraftCourseVisible,
  attemptWorkflowView,
  requireOwnActiveAttempt,
} from "./practice-workflow-wiring.ts";
import { reviewEvidenceReader } from "./review-evidence.ts";
import { snapshotOfRow } from "./snapshot.ts";
import { recordedActiveSecTotal } from "./submission-time.ts";

function conflict(message: string): never {
  throw new HttpError(409, "SETTLEMENT_CONFLICT", message);
}

export function getStudentSettlement(
  db: Db,
  studentId: string,
  attemptId: string,
  seq: number,
) {
  const attempt = requireOwnActiveAttempt(db, studentId, attemptId);
  assertDraftCourseVisible(db, studentId, attempt);
  const settlement = db
    .select()
    .from(attemptSettlements)
    .where(
      and(
        eq(attemptSettlements.attemptId, attemptId),
        eq(attemptSettlements.seq, seq),
      ),
    )
    .get();
  if (!settlement)
    throw new HttpError(404, "SETTLEMENT_NOT_FOUND", "本批结果不存在");
  const workflow = attemptWorkflowView(db, attempt)?.practiceWorkflow;
  // 当前教师规则收紧后不重放旧秘密；只投影本批成员。
  const meta = attemptSourceMeta(db, attempt);
  const released =
    attempt.status !== "draft"
      ? attemptAnswersPublished(
          {
            attemptSubmitted: true,
            sourceType: attempt.sourceType,
            release:
              attempt.sourceType === "assignment"
                ? { answerRelease: meta.answerRelease, dueAt: meta.dueAt }
                : null,
          },
          new Date(),
        )
      : workflow?.allowedFeedbackModes.includes("per_question") === true;
  const slots = materialSlotOrderOf(db, attemptId);
  const evidenceOf = reviewEvidenceReader(db, attempt.id, attempt.studentId);
  const entries = frozenRowsInDisplayOrder(db, attempt);
  const members = entries.filter(({ row }) => row.settlementSeq === seq);
  if (members.length !== settlement.questionCount)
    conflict("本批成员数据不完整，请联系老师检查");
  const time = timeProjectionsOf(db, [attemptId]);
  return attemptSettlementResultSchema.parse({
    settlement: {
      seq: settlement.seq,
      kind: settlement.kind,
      createdAt: settlement.createdAt,
      questionCount: settlement.questionCount,
      activeSec: settlement.activeSec,
      time: time.aggregate(attemptId, seq),
    },
    questions: members.map(({ row }) => {
      const snapshot = snapshotOfRow(row);
      if (!snapshot) conflict("本批题目数据不完整，请联系老师检查");
      const projected = studentFacingResultOf({
        ...resultQuestionOf(row, snapshot, {
          materialSlots: slots,
          db,
          time: time.responseTime.get(row.id),
        }),
        ...evidenceOf(
          row.questionId,
          (snapshot.materialRefs ?? []).map((r) => r.material),
        ),
      });
      return {
        ...(released ? projected : restrictedResultQuestionOf(projected)),
        time: time.responseTime.get(row.id),
      };
    }),
    answersReleased: released,
    questionNos: Object.fromEntries(
      entries.flatMap(({ row }, index) =>
        row.settlementSeq === seq ? [[row.questionId, index + 1]] : [],
      ),
    ),
  });
}

/** 外层IMMEDIATE和逐题savepoint同连接；任何失败回滚整批及事件/证据/用时。 */
export function settleStudentAttempt(
  db: Db,
  studentId: string,
  attemptId: string,
  req: AttemptPartialRequest,
  now = new Date(),
  options: {
    origin?: PracticeSubmissionOrigin;
    beforeSettlement?: (existingSeq: number | null) => void;
  } = {},
) {
  const digest = createHash("sha256")
    .update(
      canonicalJsonOf({
        attemptId,
        workflowVersion: req.workflowVersion,
        workflowRevision: req.workflowRevision,
        questions: [...req.questions].sort((a, b) =>
          a.questionId.localeCompare(b.questionId),
        ),
      }),
    )
    .digest("hex");
  const seq = db.$client
    .transaction(() => {
      const attempt = requireOwnActiveAttempt(db, studentId, attemptId);
      assertDraftCourseVisible(db, studentId, attempt);
      const previous = db
        .select()
        .from(attemptSettlements)
        .where(
          and(
            eq(attemptSettlements.attemptId, attemptId),
            eq(attemptSettlements.mutationId, req.mutationId),
          ),
        )
        .get();
      if (previous) {
        if (previous.requestDigest !== digest)
          conflict("同一提交标识的内容不一致，请重新确认");
        options.beforeSettlement?.(previous.seq);
        return previous.seq;
      }
      options.beforeSettlement?.(null);
      const view = attemptWorkflowView(db, attempt, now);
      if (!view?.practiceWorkflow.canSettlePartially)
        throw new HttpError(
          409,
          "WORKFLOW_RESTRICTED",
          "当前练习不允许分批提交",
        );
      if (attempt.workflowRevision !== req.workflowRevision)
        throw new HttpError(
          409,
          "WORKFLOW_REVISION_STALE",
          "做题设置已变化，请刷新后重试",
        );
      if (
        new Set(req.questions.map((q) => q.questionId)).size !==
        req.questions.length
      )
        conflict("同一题不能重复选择");
      frozenMemberRefs(db, attemptId);
      const activity = submissionActivityOf(db, attemptId).activeSecByQuestion;
      for (const question of req.questions) {
        commitPracticeQuestion(
          db,
          studentId,
          attemptId,
          question.questionId,
          {
            ...question,
            workflowVersion: 1,
            workflowRevision: req.workflowRevision,
            submissionMutationId: req.mutationId,
          },
          now,
          {
            ...(options.origin === undefined ? {} : { origin: options.origin }),
            settlement: true,
            activeSecByQuestion: activity,
            deferTimeSeal: true,
          },
        );
      }
      sealResponseTimeWithin(
        db,
        attemptId,
        db
          .select({ id: responses.id, questionId: responses.questionId })
          .from(responses)
          .where(eq(responses.attemptId, attemptId))
          .all()
          .filter((r) =>
            req.questions.some((q) => q.questionId === r.questionId),
          )
          .map((r) => r.id),
        now.toISOString(),
      );
      const unassigned = db
        .select()
        .from(responses)
        .where(
          and(
            eq(responses.attemptId, attemptId),
            isNull(responses.settlementSeq),
            isNotNull(responses.submittedAt),
          ),
        )
        .all();
      if (!unassigned.length) conflict("没有可结算的已提交题目");
      const finished = autoFinishPerQuestionAttempt(
        db,
        attemptId,
        now.toISOString(),
        { mutationId: req.mutationId, requestDigest: digest },
      );
      if (finished.attempt) {
        const final = db
          .select()
          .from(attemptSettlements)
          .where(
            and(
              eq(attemptSettlements.attemptId, attemptId),
              eq(attemptSettlements.kind, "final"),
            ),
          )
          .get();
        if (!final) conflict("整卷结算未生成");
        return final.seq;
      }
      const next = db
        .select({
          seq: sql<number>`coalesce(max(${attemptSettlements.seq}),0)+1`,
        })
        .from(attemptSettlements)
        .where(eq(attemptSettlements.attemptId, attemptId))
        .get()?.seq;
      if (next === undefined) conflict("无法分配批次序号");
      db.insert(attemptSettlements)
        .values({
          id: randomUUID(),
          attemptId,
          seq: next,
          kind: "partial",
          createdAt: now.toISOString(),
          questionCount: unassigned.length,
          activeSec: recordedActiveSecTotal(unassigned),
          mutationId: req.mutationId,
          requestDigest: digest,
        })
        .run();
      const changed = db
        .update(responses)
        .set({ settlementSeq: next })
        .where(
          and(
            eq(responses.attemptId, attemptId),
            isNull(responses.settlementSeq),
            isNotNull(responses.submittedAt),
          ),
        )
        .run().changes;
      if (changed !== unassigned.length) conflict("结算成员集合已变化");
      return next;
    })
    .immediate();
  return getStudentSettlement(db, studentId, attemptId, seq);
}

import { randomUUID } from "node:crypto";
import type {
  AttemptStartData,
  CourseAttemptStartOptions,
  PracticeFeedbackMode,
  PracticeWorkflowStartOptions,
} from "@tutor/contract";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { type Assignment, type Attempt, attempts } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { requireAssignmentVisible } from "./attempt-access.ts";
import {
  contextEntriesOf,
  liveAttemptContextClosure,
} from "./attempt-context.ts";
import {
  freezeInputsOfNewAttempt,
  insertFrozenResponses,
} from "./attempt-freeze.ts";
import {
  type AttemptStartClient,
  refreshOpenedAttempt,
} from "./attempt-opened-refresh.ts";
import { withAllowRedo } from "./attempt-redo-policy";
import { attemptSummaryOf } from "./attempt-summary.ts";
import { startOpenedAttemptTimer } from "./attempt-timing.ts";
import { requireVisibleCourseUnit } from "./course-service";
import { startKernelAssignmentAttempt } from "./kernel-assignment-attempt.ts";
import { requireNoPendingKernelRefreeze } from "./kernel-assignment-refreeze-guard.ts";
import { isKernelAssignment } from "./kernel-assignment-routing.ts";
import { kernelAttemptUnavailable } from "./kernel-assignment-runtime.ts";
import {
  courseRestartStale,
  finishKernelCourseOpening,
  reserveKernelCourseOpening,
  reserveKernelCourseRefreeze,
  resumeBoundKernelCourse,
} from "./kernel-course-opening.ts";
import {
  courseKernelBinding,
  pendingKernelCourseOpening,
} from "./kernel-question-delivery-binding.ts";
import { freezeAttemptContextSnapshotsWithin } from "./material-repository.ts";
import { newDraftAttempt } from "./new-draft-attempt.ts";
import { studentSelfReviewEnabledOf } from "./practice-feedback-settings-service.ts";
import { resolveNewAttemptWorkflow } from "./practice-workflow-wiring";
import type { Tx } from "./question-sync";

/** 建卷请求的可选工作流选项（M1b；契约 attemptStartOptionsRequestSchema 解析产物） */
export type AttemptWorkflowStartOptions = PracticeWorkflowStartOptions;

/** options → attempts 工作流三列（旧协议返回空对象，由 newDraftAttempt 缺省兜底；wrong-practice 复用） */
export function workflowStartColumns(
  db: Db,
  sourceType: "assignment" | "course" | "wrong",
  studentId: string,
  assignmentId: string | null,
  options: AttemptWorkflowStartOptions,
  /** 该卷的单元 id（M5-D2 文档推荐档：course 传单元；assignment 按 assignment_units 聚合不传；wrong 不传） */
  unitId?: string | null,
): {
  practiceWorkflowVersion?: 1;
  feedbackMode?: PracticeFeedbackMode;
  workflowRevision?: number;
} {
  if (options.workflowVersion !== 1) return {};
  const resolved = resolveNewAttemptWorkflow(db, {
    sourceType,
    studentId,
    assignmentId,
    unitId: unitId ?? null,
    studentChoice: options.feedbackMode ?? null,
  });
  return {
    practiceWorkflowVersion: resolved.practiceWorkflowVersion,
    feedbackMode: resolved.feedbackMode,
    workflowRevision: resolved.workflowRevision,
  };
}

/**
 * 入口取回进行中的卷。未激活的空卷不入账，入口页按「开始练习」给出限时选项：
 * 本次选了限时，就从这一刻起算并激活（限时卷点「开始」即激活，计时不可撤回）。
 * 已激活的卷沿用它自己的时钟，本次所选不生效。
 */
function resumeDraftAttempt(
  db: Db,
  draft: Attempt,
  options: Pick<AttemptWorkflowStartOptions, "timeLimitMinutes">,
  client: AttemptStartClient,
): Attempt {
  const attempt = refreshOpenedAttempt(db, draft, client);
  return startOpenedAttemptTimer(db, attempt, options.timeLimitMinutes);
}

// ---------- POST /api/student/assignments/:id/attempt ----------

/**
 * 创建或取回作业来源的 attempt（幂等；入口类接口，先过 requireAssignmentVisible）：
 * - 作业不存在/已删除 → 404；未被指派（含被移出名单，D13 立即不可见）→ 403；
 * - 已有进行中（draft）attempt → 直接返回它（一个作业一人一份进行中——
 *   本规则仅对 assignment 来源生效，D10）；
 * - 已交卷/已批 → 返回最近一份（status 告知前端直接进结果视图，不另开新卷；
 *   attemptNo 缺省 1、显式 redo:true 开新卷后递增，hall-15313）；
 * - 否则插入新 draft attempt（courseId=作业所属课程、unitId=null——多单元
 *   题目集合走 assignment_units；sourceType=assignment）。
 */
export function startAttempt(
  db: Db,
  studentId: string,
  assignmentId: string,
  options: AttemptWorkflowStartOptions = {},
  client: AttemptStartClient = {},
  kernelDataDir?: string,
): AttemptStartData {
  const assignment = requireAssignmentVisible(db, studentId, assignmentId);
  if (isKernelAssignment(db, assignment.id)) {
    if (!kernelDataDir) kernelAttemptUnavailable();
    return startKernelAssignmentAttempt(
      db,
      kernelDataDir,
      studentId,
      assignmentId,
      options,
      client,
    );
  }

  const existing = db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.studentId, studentId),
        eq(attempts.assignmentId, assignmentId),
      ),
    )
    // 选卷 tie-break = attemptNo（hall-15658 F2）：随机 UUID 的 id 不表达卷次，
    // 同 startedAt 双卷时会与 latestAttemptOf（完成态/名单代表卷，attemptNo
    // tie-break）选出不同卷
    .orderBy(desc(attempts.startedAt), desc(attempts.attemptNo))
    .all();
  // 进行中的那份优先（一人一份进行中）；显式重做也不掐进行中卷——先查 draft 再判策略位（hall-15313）
  const draft = existing.find((row) => row.status === "draft");
  if (draft !== undefined) {
    return withAllowRedo(
      attemptSummaryOf(resumeDraftAttempt(db, draft, options, client)),
      assignment.allowRedo,
    );
  }

  // 显式重做（hall-15313）：已交卷后开新卷（attemptNo 递增、从空白开始、历次可回看）；
  // 不允许重做且无进行中卷 → 409。「查最近卷 + 插新卷」同事务（D10；单写者串行化防重复开卷）
  if (options.redo === true) {
    if (assignment.allowRedo === false) {
      throw new HttpError(
        409,
        "REDO_NOT_ALLOWED",
        "这份作业不允许重做，只能回看已交的作答",
      );
    }
    return db.transaction((tx): AttemptStartData => {
      const rows = tx
        .select()
        .from(attempts)
        .where(
          and(
            eq(attempts.studentId, studentId),
            eq(attempts.assignmentId, assignmentId),
          ),
        )
        // 同款 tie-break（hall-15658 F2）：与外层查询 / latestAttemptOf 同序
        .orderBy(desc(attempts.startedAt), desc(attempts.attemptNo))
        .all();
      const inFlight = rows.find((row) => row.status === "draft");
      if (inFlight !== undefined) {
        return withAllowRedo(
          attemptSummaryOf(resumeDraftAttempt(db, inFlight, options, client)),
          assignment.allowRedo,
        );
      }
      return withAllowRedo(
        createAssignmentAttempt(
          db,
          tx,
          assignment,
          studentId,
          rows.reduce((max, row) => Math.max(max, row.attemptNo), 0) + 1,
          options,
        ),
        assignment.allowRedo,
      );
    });
  }

  // 缺省语义不变（幂等 create-or-return）：已交卷后再 POST 返回最近已交那份，
  // 不因已交而开新卷——开新卷只能走显式 redo:true（hall-15313）
  const latest = existing[0];
  if (latest !== undefined) {
    return withAllowRedo(attemptSummaryOf(latest), assignment.allowRedo);
  }

  return withAllowRedo(
    db.transaction((tx) =>
      createAssignmentAttempt(db, tx, assignment, studentId, 1, options),
    ),
    assignment.allowRedo,
  );
}

/**
 * 作业来源建卷（T6R.3 冻结；attemptNo 由调用方裁决——首卷 1、重做 = 既有最大值 +1，
 * hall-15313）。冻结输入读走外层 db，写走同事务 tx（同连接同步执行，课程建卷同款）。
 */
function createAssignmentAttempt(
  db: Db,
  tx: Tx,
  assignment: Pick<Assignment, "id" | "courseId">,
  studentId: string,
  attemptNo: number,
  options: AttemptWorkflowStartOptions,
): AttemptStartData {
  const attempt = newDraftAttempt({
    id: randomUUID(),
    studentId,
    sourceType: "assignment",
    assignmentId: assignment.id,
    lectureId: null,
    // T2A.7：courseId 取作业所属课程（可空，D9/D13）；unitId 恒 null——
    // 多单元作业题目集合走 assignment_units（attemptUnitIds），不再落单单元
    courseId: assignment.courseId,
    unitId: null,
    attemptNo,
    startedAt: new Date().toISOString(),
    // 模块 2：自选时长（缺省不限时）
    timeLimitMinutes: options.timeLimitMinutes,
    // M1b：仅显式 workflowVersion=1 走新协议（服务端按作业授权裁决）；省略维持旧协议
    ...workflowStartColumns(
      db,
      "assignment",
      studentId,
      assignment.id,
      options,
    ),
  });
  return persistFrozenAttempt(db, tx, attempt);
}

// 作业与课程宿主卷共用同一套冻结行和依赖闭包。
function persistFrozenAttempt(
  db: Db,
  tx: Tx,
  attempt: Attempt,
): AttemptStartData {
  const { liveRows, teacherId, knowledgeByQuestion } = freezeInputsOfNewAttempt(
    db,
    attempt,
  );
  // tt-07a（QM-06）：材料/组依赖闭包同事务冻结（缺依赖先于事务 fail closed）
  const entries =
    teacherId === null
      ? []
      : contextEntriesOf(
          liveAttemptContextClosure(
            db,
            teacherId,
            liveRows.map((row) => row.id),
          ),
        );
  tx.insert(attempts).values(attempt).run();
  insertFrozenResponses(
    tx,
    attempt.id,
    liveRows,
    knowledgeByQuestion,
    studentSelfReviewEnabledOf(db, teacherId),
  );
  freezeAttemptContextSnapshotsWithin(
    tx,
    attempt.id,
    entries,
    attempt.startedAt,
  );
  return attemptSummaryOf(attempt);
}

// ---------- POST /api/student/courses/:cid/units/:uid/attempts（T2A.6） ----------

/** 先校验课程可见性，再串行续作、重开指定草稿或从空白开下一卷。 */
export function startCourseAttempt(
  db: Db,
  studentId: string,
  courseId: string,
  unitId: string,
  options: CourseAttemptStartOptions = {},
  client: AttemptStartClient = {},
  kernel?: { dataDir: string; enabled: boolean },
): AttemptStartData {
  const { restartAttemptId, timeLimitMinutes, feedbackMode } = options;
  const openingDir =
    kernel?.enabled &&
    feedbackMode !== "per_question" &&
    (restartAttemptId === undefined || timeLimitMinutes === undefined)
      ? kernel.dataDir
      : undefined;
  const decide = (tx: Tx) => {
    const item = requireVisibleCourseUnit(db, studentId, courseId, unitId);
    const existing = tx
      .select()
      .from(attempts)
      .where(
        and(
          eq(attempts.studentId, studentId),
          eq(attempts.sourceType, "course"),
          eq(attempts.courseId, courseId),
          eq(attempts.unitId, unitId),
        ),
      )
      .all();
    const draft = existing.find(
      (row) => row.status === "draft" && row.abandonedAt === null,
    );
    if (restartAttemptId !== undefined && draft?.id !== restartAttemptId)
      throw courseRestartStale();
    const attemptNo =
      existing.reduce((max, row) => Math.max(max, row.attemptNo), 0) + 1;
    const pending = pendingKernelCourseOpening(tx, {
      studentId,
      courseId,
      unitId,
    });
    if (pending) {
      if (
        pending.attemptNo !== attemptNo ||
        pending.draft.restartAttemptId !== draft?.id ||
        (restartAttemptId !== undefined &&
          (timeLimitMinutes !== undefined || feedbackMode === "per_question"))
      )
        kernelAttemptUnavailable();
      return { opening: pending };
    }
    const bound = draft && courseKernelBinding(tx, draft.id);
    if (draft && !bound) requireNoPendingKernelRefreeze(tx, draft);
    if (draft && restartAttemptId === undefined) {
      if (!bound)
        return attemptSummaryOf(resumeDraftAttempt(db, draft, options, client));
      if (!kernel) kernelAttemptUnavailable();
      if (
        client.snapshotProof !== false &&
        reserveKernelCourseRefreeze(db, tx, kernel.dataDir, draft, item.title)
      )
        return { refreeze: draft };
      return attemptSummaryOf(
        resumeBoundKernelCourse(db, kernel.dataDir, draft, timeLimitMinutes),
      );
    }
    if (bound && draft) {
      if (!openingDir) kernelAttemptUnavailable();
      // 先补落已被内核接受的旧交卷，提交主库事务后再返回过期错误。
      if (resumeBoundKernelCourse(db, openingDir, draft).status !== "draft")
        return { error: courseRestartStale() };
    }
    const attempt = newDraftAttempt({
      id: randomUUID(),
      studentId,
      sourceType: "course",
      assignmentId: null,
      lectureId: null,
      courseId,
      unitId,
      attemptNo,
      startedAt: new Date().toISOString(),
      // 模块 2：自选时长（缺省不限时）
      timeLimitMinutes,
      // M1b：显式 workflowVersion=1 按教师策略裁决写新协议列；省略旧协议。
      // M5-D2：传该卷 unitId——学生未设置偏好时课程单元的文档推荐参与裁决
      ...workflowStartColumns(
        db,
        "course",
        studentId,
        null,
        bound ? { ...options, workflowVersion: 1 } : options,
        unitId,
      ),
    });
    const opening = reserveKernelCourseOpening(
      db,
      tx,
      attempt,
      item.title,
      bound || restartAttemptId === undefined ? openingDir : undefined,
      bound ? restartAttemptId : undefined,
    );
    if (opening) return { opening };
    if (bound) kernelAttemptUnavailable();
    if (draft)
      tx.update(attempts)
        .set({ abandonedAt: attempt.startedAt })
        .where(eq(attempts.id, draft.id))
        .run();
    return persistFrozenAttempt(db, tx, attempt);
  };
  const start = db.transaction(decide, { behavior: "immediate" });
  if ("error" in start) throw start.error;
  if ("opening" in start)
    return attemptSummaryOf(
      finishKernelCourseOpening(
        db,
        kernel?.dataDir,
        start.opening,
        restartAttemptId !== undefined,
      ),
    );
  if ("refreeze" in start)
    return attemptSummaryOf(
      resumeBoundKernelCourse(
        db,
        kernel?.dataDir,
        start.refreeze,
        timeLimitMinutes,
        true,
      ),
    );
  return start;
}

import { randomUUID } from "node:crypto";
import type {
  AttemptStartData,
  CourseAttemptStartOptions,
  PracticeFeedbackMode,
  PracticeWorkflowStartOptions,
} from "@tutor/contract";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { type Assignment, attempts } from "../db/schema";
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
import { withAllowRedo } from "./attempt-redo-policy";
import { attemptSummaryOf } from "./attempt-summary.ts";
import { requireVisibleCourseUnit } from "./course-service";
import { freezeAttemptContextSnapshotsWithin } from "./material-repository.ts";
import { newDraftAttempt } from "./new-draft-attempt.ts";
import { studentSelfReviewEnabledOf } from "./practice-feedback-settings-service.ts";
import { resolveNewAttemptWorkflow } from "./practice-workflow-wiring";
import type { Tx } from "./question-sync";

// 快照解析统一走 services/snapshot.ts 的 snapshotOfRow（全服务端唯一实现，
// 含坏数据 warn 留痕）——本文件经顶部 import 使用，不再留平行 safeParse。

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
): AttemptStartData {
  const assignment = requireAssignmentVisible(db, studentId, assignmentId);

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
    return withAllowRedo(attemptSummaryOf(draft), assignment.allowRedo);
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
        return withAllowRedo(attemptSummaryOf(inFlight), assignment.allowRedo);
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
  // T6R.3：建卷冻结——题目集合/题序/完整快照/单元归属逐题预插 responses 行
  //（assignment 单元序 × 题序）；教师改题库只影响之后新建的卷
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

/**
 * 课程练习入口（D10）：
 * - 每次调用都先校验 D5 可见性（requireVisibleCourseUnit：非成员/归档 403、
 *   条目不可见 404，D22）；
 * - 存在未交卷（draft）作答 → 返回它（入口为「继续作答」）；
 * - 否则新建 attempt（attemptNo = 该 (学生, 课程, 单元) 历次最大值 + 1，从 1 起；
 *   新一次从空白开始——不预填上次答案与笔迹，历次记录互不影响）；
 * - 「(学生, 课程, 单元) 同时最多 1 份未交卷」在事务内先查后插保证：
 *   better-sqlite3 同步事务天然串行，并发两次 POST 只产生一份 draft。
 */
export function startCourseAttempt(
  db: Db,
  studentId: string,
  courseId: string,
  unitId: string,
  options: CourseAttemptStartOptions = {},
): AttemptStartData {
  requireVisibleCourseUnit(db, studentId, courseId, unitId);

  return db.transaction((tx) => {
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
    if (options.restartAttemptId !== undefined) {
      if (draft?.id !== options.restartAttemptId) {
        throw new HttpError(
          409,
          "ATTEMPT_RESTART_STALE",
          "当前作答已变化，请关闭确认后查看最新记录。",
        );
      }
      tx.update(attempts)
        .set({ abandonedAt: new Date().toISOString() })
        .where(eq(attempts.id, draft.id))
        .run();
    } else if (draft !== undefined) {
      return attemptSummaryOf(draft);
    }

    const maxAttemptNo = existing.reduce(
      (max, row) => Math.max(max, row.attemptNo),
      0,
    );
    const attempt = newDraftAttempt({
      id: randomUUID(),
      studentId,
      sourceType: "course",
      assignmentId: null,
      lectureId: null,
      courseId,
      unitId,
      attemptNo: maxAttemptNo + 1,
      startedAt: new Date().toISOString(),
      // 模块 2：自选时长（缺省不限时）
      timeLimitMinutes: options.timeLimitMinutes,
      // M1b：显式 workflowVersion=1 按教师策略裁决写新协议列；省略旧协议。
      // M5-D2：传该卷 unitId——学生未设置偏好时课程单元的文档推荐参与裁决
      ...workflowStartColumns(db, "course", studentId, null, options, unitId),
    });
    // T6R.3：建卷冻结——课程单元当前 live 题逐题预插快照行。冻结输入读走外层 db
    // （同连接同步执行，事务内读写口径一致），写走 tx 与 attempt 行同事务落库
    const { liveRows, teacherId, knowledgeByQuestion } =
      freezeInputsOfNewAttempt(db, attempt);
    // tt-07a（QM-06）：材料/组依赖闭包同事务冻结（读在外层 db，同款口径）
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
  });
}

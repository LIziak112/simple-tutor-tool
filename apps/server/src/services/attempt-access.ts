import { and, eq, inArray, isNotNull, isNull, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Assignment,
  type Attempt,
  assignmentStudents,
  assignments,
  attempts,
  type ResponseRow,
  responses,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { ensureAttemptFrozen } from "./attempt-freeze.ts";
import { assertDraftCourseVisible } from "./practice-workflow-wiring";

/** 作业行（含已删除——作答记录不随作业软删消失）；不存在 → 404 ASSIGNMENT_NOT_FOUND */
export function requireAssignmentRow(db: Db, id: string): Assignment {
  const row = db.select().from(assignments).where(eq(assignments.id, id)).get();
  if (!row) {
    throw new HttpError(404, "ASSIGNMENT_NOT_FOUND", "作业不存在");
  }
  return row;
}

/**
 * 批量预取作业的公布口径（题目笔记本 2026-10 起，与 student-records 的
 * 作业记录列表同型收敛）：id 去重交调用方负责 → 单条 inArray 只取
 * answerRelease/dueAt → Map。含已软删行（作答记录不随作业软删消失，
 * requireAssignmentRow 同口径）；已交作业缺少公布事实时按未公布处理。
 */
export function assignmentReleaseByIds(
  db: Db,
  ids: readonly string[],
): Map<string, Pick<Assignment, "answerRelease" | "dueAt">> {
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({
        id: assignments.id,
        answerRelease: assignments.answerRelease,
        dueAt: assignments.dueAt,
      })
      .from(assignments)
      .where(inArray(assignments.id, [...ids]))
      .all()
      .map((row) => [row.id, row] as const),
  );
}

/**
 * 题级「已单题提交」领域谓词（2026-10 讲练三消费方收敛；M2 起普通 v1 卷
 * 同写本列，谓词按行值判定、来源无关）：口径按题级行值
 * （responses.submittedAt 非空），不回看 attempt 级状态——正常非 draft 卷
 * （lesson 与 v1）整卷收尾对剩余行写交卷时刻、恒非空，历史旧协议卷恒
 * null；判定方向恒取严（null = 未提交 = 不放行）。消费方：lesson-service
 * released、note-service 笔记本解析 gate、teaching-policy-service
 * 「本题完成」判定。
 */
export function lessonQuestionSubmitted(
  row: Pick<ResponseRow, "submittedAt">,
): boolean {
  return row.submittedAt !== null;
}

/**
 * 取本人 attempt：不存在 → 404 ATTEMPT_NOT_FOUND；非本人 → 403 FORBIDDEN（验收项）。
 * attempt 归属是所有 /attempts/:id/* 接口的第一道权限依据，
 * 抽为导出函数保证各接口口径永不漂移。
 */
export function requireOwnAttempt(
  db: Db,
  studentId: string,
  attemptId: string,
): Attempt {
  const row = db
    .select()
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .get();
  if (!row) {
    throw new HttpError(404, "ATTEMPT_NOT_FOUND", "作答记录不存在");
  }
  if (row.studentId !== studentId) {
    throw new HttpError(403, "FORBIDDEN", "只能查看自己的作答");
  }
  return row;
}

/**
 * 取本人 attempt 并按来源做访问权校验（T2A.6，D7/D22）：course 来源且 draft
 * 每次重校验可见性与成员资格（403 COURSE_ACCESS_DENIED / 404 NOT_FOUND，
 * requireVisibleCourseUnit 统一口径）；course 已交卷只读不校验；assignment
 * 归属即权限。草稿保存、交卷、提示、笔迹、事件、详情、通用取卷全部经此进门。
 *
 * **T6R.3 冻结统一门口**：末尾经 ensureAttemptFrozen 懒冻结遗留草稿并返回
 * **最新行**——消费方必须用返回值（旧内存对象 frozenAt=null 会误走遗留分支）；
 * 已冻结/已交卷时幂等直返。
 */
export function requireUsableAttempt(
  db: Db,
  studentId: string,
  attemptId: string,
): Attempt {
  const attempt = requireOwnAttempt(db, studentId, attemptId);
  // 作废卷（课程练习或讲练重开）：其上一切读写都拒绝（本函数是共用取卷入口），前端提示重新进入
  if (attempt.abandonedAt !== null) {
    throw new HttpError(
      409,
      "ATTEMPT_ABANDONED",
      "这份作答已作废，请回到练习入口继续最新一次",
    );
  }
  assertDraftCourseVisible(db, studentId, attempt);
  return ensureAttemptFrozen(db, attempt);
}

/**
 * 校验题目属于该 attempt 的**冻结集合**（T6R.3 三来源统一：题目集合 = attempt
 * 自有 responses 行，建卷/懒冻结后必有快照），否则 404 QUESTION_NOT_FOUND
 * （T2.8 ink-service 复用：笔迹上传与草稿答案同一口径）。
 * - 权限语义不变：本函数只管题目集合成员资格；课程/作业访问权守卫与懒冻结
 *   都在 requireUsableAttempt 门口（调用方先过它再进这里，「冻结内容不冻结
 *   权限」——软删/改题不再把题从进行中的卷里移走，但课程撤权等照样拦截）；
 * - 要求快照非空：快照缺失的历史行（软删/缺失题）不算可用题——旧标签页
 *   对这类题的陈旧写入按 404 拒绝，不落到永不展示/判分的行上。
 */
export function requireAttemptQuestion(
  db: Db,
  attempt: Attempt,
  questionId: string,
): { id: string } {
  const hit = db
    .select({ id: responses.id })
    .from(responses)
    .where(buildAttemptQuestionWhere(attempt.id, questionId))
    .get();
  if (hit === undefined) {
    throw questionNotFound();
  }
  return hit;
}

/**
 * 单题提交后的**行级锁定守卫**（2026-10 讲练一体；M2 起普通 v1 卷已提交行
 * 同守卫）：该题已单题提交（responses.submittedAt 非空）→ 409
 * QUESTION_ALREADY_SUBMITTED——判定已按提交时的答案落定，答案与笔迹此后
 * 不可再改（saveDraftAnswer / saveInk 调用，都在 requireAttemptQuestion
 * 之后）。历史旧协议行的 submittedAt 恒 null，既有来源行为零变化。
 */
export function assertRowNotSubmitted(
  db: Db,
  attemptId: string,
  questionId: string,
  action = "修改答案",
): void {
  const row = db
    .select({ submittedAt: responses.submittedAt })
    .from(responses)
    .where(
      and(
        eq(responses.attemptId, attemptId),
        eq(responses.questionId, questionId),
      ),
    )
    .get();
  if (row !== undefined && row.submittedAt !== null) {
    throw new HttpError(
      409,
      "QUESTION_ALREADY_SUBMITTED",
      `这道题已经提交过了，不能再${action}`,
    );
  }
}

/** 严格口径的 WHERE 单源（单题/批量两兄弟共用；C8）——三条件：
 * attempt 归属 + 题目成员 + 快照非空（语义见 requireAttemptQuestion 注释） */
export function buildAttemptQuestionWhere(
  attemptId: string,
  questionId: string,
): SQL {
  return and(
    eq(responses.attemptId, attemptId),
    eq(responses.questionId, questionId),
    isNotNull(responses.questionSnapshotJson),
  ) as SQL;
}

/**
 * 严格口径的**批量**兄弟（C8，唯一消费方 note-service.getStudentNoteHeads）：
 * 一次 inArray 判定全部题目（替代 N 次点查），任一题目不在冻结集合 → 按
 * 请求序取首个缺失者抛**同码同文案** 404（可观察行为与逐题门口完全一致）。
 * questionIds 由调用方去重保序。
 */
export function requireAttemptQuestions(
  db: Db,
  attempt: Attempt,
  questionIds: readonly string[],
): void {
  const hitIds = new Set(
    db
      .select({ id: responses.questionId })
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, attempt.id),
          inArray(responses.questionId, [...questionIds]),
          isNotNull(responses.questionSnapshotJson),
        ),
      )
      .all()
      .map((row) => row.id),
  );
  for (const questionId of questionIds) {
    if (!hitIds.has(questionId)) {
      throw questionNotFound();
    }
  }
}

/**
 * 题目成员资格的**宽松**口径（T6R.5 复审④上移至此，与上方严格口径同处可
 * 对照）：只要求该 attempt 的 responses 行存在——不查 questions 当前存活
 * （软删题历史证据可读），也不要求快照非空（升级前遗留卷的响应行仍可定位，
 * 历史读取方返回空投影而非 404；证据/笔记行本就只可能由新代码写入，遗留卷
 * 恒为空态）。消费方：note-service 的 evidence 读（学生 ② / 教师 ⑥）与
 * T6R.15 的 correction/supplement 写通道（订正/补充是历史材料，软删题照常
 * 可写——门口返回行 id 兼作 notes.questionRevisionId）；scratch 写通道
 * （笔记上传/工作稿头）仍走严格 requireAttemptQuestion。
 */
export function requireAttemptQuestionRow(
  db: Db,
  attemptId: string,
  questionId: string,
): { id: string } {
  const hit = db
    .select({ id: responses.id })
    .from(responses)
    .where(
      and(
        eq(responses.attemptId, attemptId),
        eq(responses.questionId, questionId),
      ),
    )
    .get();
  if (hit === undefined) {
    throw questionNotFound();
  }
  return hit;
}

/**
 * 入口类可见性校验（POST /assignments/:id/attempt 开卷用）：作业不存在/已
 * 软删 → 404；未被指派**或在册判定含 removedAt IS NULL**（被移出名单的学生
 * 立即不可见，D13）→ 403。与 T2.4 旧取卷接口（assignment-service 的
 * getStudentAssignmentPaper）同口径。
 */
export function requireAssignmentVisible(
  db: Db,
  studentId: string,
  assignmentId: string,
): Assignment {
  const row = requireAssignmentRow(db, assignmentId);
  if (row.deletedAt !== null) {
    throw new HttpError(
      404,
      "ASSIGNMENT_NOT_FOUND",
      "作业不存在（可能已被删除）",
    );
  }
  const assigned = db
    .select({ studentId: assignmentStudents.studentId })
    .from(assignmentStudents)
    .where(
      and(
        eq(assignmentStudents.assignmentId, assignmentId),
        eq(assignmentStudents.studentId, studentId),
        isNull(assignmentStudents.removedAt),
      ),
    )
    .get();
  if (assigned === undefined) {
    throw new HttpError(403, "FORBIDDEN", "未被指派此作业，无权作答");
  }
  return row;
}

/** 该题已单题提交的统一拒绝（2026-10；与整卷重复交卷 ALREADY_SUBMITTED 分码） */
export function questionAlreadySubmitted(): HttpError {
  return new HttpError(
    409,
    "QUESTION_ALREADY_SUBMITTED",
    "这道题已经提交过了，不能重复提交",
  );
}

/** 该题不在本卷冻结集合（或快照损坏）的统一 404（M2 起提交/反馈多端点共用） */
export function questionNotFound(): HttpError {
  return new HttpError(404, "QUESTION_NOT_FOUND", "题目不存在或不属于这次练习");
}

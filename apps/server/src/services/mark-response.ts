import type {
  MarkRequest,
  MarkResponseData,
  PendingMarkCard,
  PendingMarkListData,
  PendingMarkListQuery,
  StudentAnswer,
} from "@tutor/contract";
import { and, asc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  attempts,
  type ResponseRow,
  responses,
  students,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { answerOf, finalScoreOf } from "./attempt-service";
import { pendingMarkCount } from "./pending-mark";
import { snapshotOfRow } from "./snapshot";
import {
  inkByQuestionOf,
  inkInfoOf,
  sourceOf,
} from "./teacher-attempt-service";

/**
 * 批注与待批队列业务层（T3.2b，Phase3 清单 D3/D4）：
 * - markResponse：教师批注单题（判定 + 评语一次提交）。归属链
 *   response → attempt → student → teacherId（非本人 → 404 RESPONSE_NOT_FOUND，
 *   不暴露存在性，T2B 域口径）；draft attempt → 409 NOT_SUBMITTED（未交卷的
 *   题没有可批改的冻结行）；**允许对任何已交卷的题批注/改判**（含自动判过的
 *   题，入口在详情页）。事务内：写 teacherMark/teacherComment → 本题
 *   finalCorrect = teacherMark ?? autoCorrect（D3 持久化口径）→ 用
 *   attempt-service 的 finalScoreOf 重算整卷 scoreFinal/status 写回（D2 状态机，
 *   与交卷链路同一实现，不复制公式）；
 * - listPendingMarks：待批队列（D4 共享谓词口径——已交卷 attempt 中
 *   finalCorrect IS NULL 的 responses，含只写笔迹未填最终答案的手写题）；
 *   教师域过滤 + courseId/assignmentId/studentId 筛选 + submittedAt 升序
 *   （先交先批）。卡片拼装复用 teacher-attempt-service 的公共函数（来源上下文/
 *   快照/答案解析/ink 关联），不复制。
 *
 * mark=null 清除教师判定（finalCorrect 回落 autoCorrect；手写题回落 null 重新
 * 待批，status 回 submitted、scoreFinal 置 null）；comment 归一化已在契约层
 * 完成（trim 后空串 → null），服务层不做二次处理。
 */

/** 选项下标 → 展示字母（A=0；超出 26 个选项兜底用数字本身） */
function optionLabel(index: number): string {
  return index >= 0 && index < 26
    ? String.fromCharCode(65 + index)
    : String(index);
}

/**
 * 学生答案 → 人类可读文本（待批卡片与 D13 CSV 导出共用同一序列化口径）：
 * - judge：布尔 →「正确/错误」；字符串（旧版判断题写法）原样保留——待批队列里
 *   正是写法无法归一化的题，教师需要看到学生原文；
 * - choice：选项字母（A=0）；
 * - multi：所选下标升序去重拼接（「A、C」）；空选=未作答语义，序列化为空串；
 * - fill：按空序拼接，空与空用「；」分隔（每空文本可能含「、」，不与其混用）；
 * - final（手写题）：最终答案原文（可空串=只写笔迹未填）；
 * - null（answerJson 缺失）→ null（未作答）。
 */
export function serializeStudentAnswer(
  answer: StudentAnswer | null,
): string | null {
  if (answer === null) return null;
  switch (answer.kind) {
    case "judge":
      return typeof answer.value === "boolean"
        ? answer.value
          ? "正确"
          : "错误"
        : answer.value;
    case "choice":
      return optionLabel(answer.index);
    case "multi":
      return [...new Set(answer.indexes)]
        .sort((a, b) => a - b)
        .map(optionLabel)
        .join("、");
    case "fill":
      return answer.values.join("；");
    case "final":
      return answer.finalAnswer;
  }
}

// ---------- POST /api/teacher/responses/:id/mark ----------

/**
 * 教师批注单题（D3）。req.comment 已由契约层归一化（trim 后空串 → null）。
 * 事务内三步（见模块头注释）；返回写回后的最新状态（本题 + 整卷 + 剩余待批数）。
 */
export function markResponse(
  db: Db,
  teacherId: string,
  responseId: string,
  req: MarkRequest,
): MarkResponseData {
  // 归属链 response → attempt → student → teacherId；不存在或非本人 → 404
  const row = db
    .select({
      response: responses,
      attempt: attempts,
      ownerTeacherId: students.teacherId,
    })
    .from(responses)
    .innerJoin(attempts, eq(responses.attemptId, attempts.id))
    .innerJoin(students, eq(attempts.studentId, students.id))
    .where(eq(responses.id, responseId))
    .get();
  if (row === undefined || row.ownerTeacherId !== teacherId) {
    throw new HttpError(404, "RESPONSE_NOT_FOUND", "作答记录不存在");
  }
  if (row.attempt.status === "draft") {
    throw new HttpError(409, "NOT_SUBMITTED", "未交卷的作答不能批注");
  }

  const attemptId = row.attempt.id;
  // D3 持久化口径：finalCorrect = teacherMark ?? autoCorrect（枚举转布尔；
  // mark=null 时回落 autoCorrect，手写题为 null 即重新待批）
  const finalCorrect =
    req.mark === null ? row.response.autoCorrect : req.mark === "correct";
  db.transaction((tx) => {
    // 1. 写教师判定与评语；本题 finalCorrect 按上述口径同步写回
    tx.update(responses)
      .set({
        teacherMark: req.mark,
        teacherComment: req.comment,
        finalCorrect,
      })
      .where(eq(responses.id, responseId))
      .run();
    // 2. 整卷重算（finalScoreOf 与交卷链路同一实现，D2 状态机不复制公式）。
    //    与待批谓词同口径过滤幽灵行（快照空的历史题目缺失行不进重算——
    //    它们永远 null finalCorrect，计入会让 attempt 永卡 submitted）
    const finalCorrects = tx
      .select({ finalCorrect: responses.finalCorrect })
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, attemptId),
          isNotNull(responses.questionSnapshotJson),
        ),
      )
      .all()
      .map((r) => r.finalCorrect);
    const { status, scoreFinal } = finalScoreOf(finalCorrects);
    // 3. 写回 attempt（scoreAuto/submittedAt 等其余列不动）
    tx.update(attempts)
      .set({ status, scoreFinal })
      .where(eq(attempts.id, attemptId))
      .run();
  });

  // 事务后回读最新状态（response 与 attempt）
  const updated = db
    .select()
    .from(responses)
    .where(eq(responses.id, responseId))
    .get();
  const attempt = db
    .select()
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .get();
  if (updated === undefined || attempt === undefined) {
    // 理论不可达（事务刚写完）；防御性兜底不让接口 500 无信息
    throw new HttpError(500, "INTERNAL", "批注写回失败，请重试");
  }
  return {
    responseId,
    questionId: updated.questionId,
    attemptId,
    teacherMark:
      updated.teacherMark === "correct" || updated.teacherMark === "wrong"
        ? updated.teacherMark
        : null,
    teacherComment: updated.teacherComment,
    finalCorrect: updated.finalCorrect,
    // 批注只发生在已交卷 attempt，回读的 status 不会是 draft
    attemptStatus: attempt.status === "graded" ? "graded" : "submitted",
    scoreFinal: attempt.scoreFinal,
    pendingCount: pendingMarkCount(db, attempt),
  };
}

// ---------- GET /api/teacher/pending-marks ----------

/**
 * 待批队列（D4）：共享谓词口径（responses.finalCorrect IS NULL 且 attempt
 * 已交卷）+ 教师域过滤（students.teacherId）+ 可选 courseId/assignmentId/
 * studentId 筛选。排序 submittedAt 升序（先交先批；同刻并列按 attemptId、
 * questionId 升序兜底稳定，同一 attempt 的待批题相邻）。无分页（见契约注释）。
 * 卡片拼装：按 attempt 分组复用 sourceOf/inkByQuestionOf（每 attempt 一次查询），
 * 快照坏数据行跳过并留痕（snapshotOfRow 内 warn，全服务端同一口径）。
 */
export function listPendingMarks(
  db: Db,
  teacherId: string,
  query: PendingMarkListQuery,
): PendingMarkListData {
  const where = and(
    eq(students.teacherId, teacherId),
    // 共享谓词（pending-mark.ts 同口径）：已交卷 attempt + finalCorrect IS NULL
    // + 快照非空（T6R.3：幽灵行不进队列——它们不可批也不显示）
    ne(attempts.status, "draft"),
    isNull(responses.finalCorrect),
    isNotNull(responses.questionSnapshotJson),
    query.studentId !== undefined
      ? eq(attempts.studentId, query.studentId)
      : undefined,
    query.courseId !== undefined
      ? eq(attempts.courseId, query.courseId)
      : undefined,
    query.assignmentId !== undefined
      ? eq(attempts.assignmentId, query.assignmentId)
      : undefined,
  );
  const rows = db
    .select({
      response: responses,
      attempt: attempts,
      studentName: students.displayName,
    })
    .from(responses)
    .innerJoin(attempts, eq(responses.attemptId, attempts.id))
    .innerJoin(students, eq(attempts.studentId, students.id))
    .where(where)
    .orderBy(
      asc(attempts.submittedAt),
      asc(attempts.id),
      asc(responses.questionId),
    )
    .all();

  // 按 attempt 分组（排序键含 attemptId，同 attempt 的行必然相邻，分组不破坏全局顺序）
  const byAttempt = new Map<
    string,
    {
      attempt: Attempt;
      studentName: string;
      responses: ResponseRow[];
    }
  >();
  for (const { response, attempt, studentName } of rows) {
    const group = byAttempt.get(attempt.id);
    if (group === undefined) {
      byAttempt.set(attempt.id, {
        attempt,
        studentName,
        responses: [response],
      });
    } else {
      group.responses.push(response);
    }
  }

  const marks: PendingMarkCard[] = [];
  for (const [attemptId, group] of byAttempt) {
    const source = sourceOf(db, group.attempt, teacherId);
    const inkByQuestion = inkByQuestionOf(db, attemptId);
    for (const response of group.responses) {
      const snapshot = snapshotOfRow(response);
      if (snapshot === null) continue; // 坏快照按缺失计（snapshotOfRow 内留痕）
      marks.push({
        responseId: response.id,
        attemptId,
        questionId: response.questionId,
        studentId: group.attempt.studentId,
        studentName: group.studentName,
        ...source,
        type: snapshot.type,
        difficulty: snapshot.difficulty,
        knowledge: snapshot.knowledge,
        stemMd: snapshot.stemMd,
        ...(snapshot.options !== undefined
          ? { options: snapshot.options.map((option) => option.text) }
          : {}),
        answers: snapshot.answers ?? null,
        answerText: serializeStudentAnswer(answerOf(response.answerJson)),
        ink: inkInfoOf(inkByQuestion.get(response.questionId)),
        activeSec: response.activeSec,
        hintsUsed: response.hintsUsed,
        changeCount: response.changeCount,
        // 待批题必属已交卷 attempt（submittedAt 必非空）；直插异常数据兜底 startedAt
        submittedAt: group.attempt.submittedAt ?? group.attempt.startedAt,
      });
    }
  }
  return { marks };
}

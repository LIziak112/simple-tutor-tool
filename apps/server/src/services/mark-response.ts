import type {
  MarkRequest,
  MarkResponseData,
  PendingMarkCard,
  PendingMarkListData,
  PendingMarkListQuery,
  Question,
  StudentAnswer,
} from "@tutor/contract";
import {
  dispatchBehavior,
  emptyPublicStructure,
  finalCorrectOf,
  NEW_QUESTION_TYPES,
} from "@tutor/contract";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  attempts,
  type ResponseRow,
  responses,
  students,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import {
  attemptFinalOutcomeOf,
  hasUsableQuestionSnapshotSql,
} from "./attempt-final-outcome.ts";
import {
  answerOf,
  materialSlotOrderOf,
  structuresOfSnapshot,
} from "./attempt-service";
import { pendingMarkCount, submittedTeacherPendingSql } from "./pending-mark";
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
 *   不暴露存在性，T2B 域口径）；行未交（attempt 为 draft 且该行未单题提交）
 *   → 409 NOT_SUBMITTED（未交卷的题没有可批改的冻结行；2026-10 讲练一体起
 *   lesson 进行中卷已单题提交的行允许课中批改，与待批谓词同口径）；
 *   **允许对任何已交卷的题批注/改判**（含自动判过的题，入口在详情页）。
 *   事务内：写 teacherMark/teacherComment → 本题 finalCorrect =
 *   teacherMark ?? autoCorrect（D3 持久化口径）→ 已离开 draft 的卷用
 *   attemptFinalOutcomeOf 重算整卷 scoreFinal/status 写回（D2 状态机，
 *   与交卷链路同一实现，不复制公式；lesson 进行中卷不重算——收尾链路驱动，
 *   课中批改不提前收卷）；
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

/**
 * 学生答案 → 人类可读文本（待批卡片与 D13 CSV 导出共用同一序列化口径）：
 * - judge：布尔 →「正确/错误」；字符串（旧版判断题写法）原样保留——待批队列里
 *   正是写法无法归一化的题，教师需要看到学生原文；
 * - choice：选项字母（A=0；≥26 兜底数字本身）；
 * - multi：所选下标升序去重拼接（「A、C」）；空选=未作答语义，序列化为空串；
 * - fill：按空序拼接，空与空用「；」分隔（每空文本可能含「、」，不与其混用）；
 * - final（手写题）：最终答案原文（可空串=只写笔迹未填）；
 * - null（answerJson 缺失）→ null（未作答）。
 *
 * UA-01 起为契约纯行为登记表 teacher-queue 口径的兼容代理（原 kind switch
 * 与 optionLabel 已删——选项字母唯一实现收归契约 answer-kinds
 * queueOptionLabel；输出逐字不变，差分锁定见 packages/contract 差分测试）。
 */
export function serializeStudentAnswer(
  answer: StudentAnswer | null,
): string | null {
  if (answer === null) return null;
  return dispatchBehavior(answer, "teacher-queue", emptyPublicStructure);
}

/**
 * 行级序列化（QM-16 细项 3）：待批队列/CSV/单题包/AI 受控出口共用——
 * 新题型按冻结快照装配完整公开结构（matching 选项池+槽位序 ordinal、
 * ordering 项正文），配对/排序答案以**真实选项/项正文**与「第 N 空」标签
 * 序列化（与材料面板（N）编号同口径）；旧七型结构恒空，输出逐字不变。
 * 快照缺失/坏行回落裸序列化（emptyPublicStructure——id 回落路径，不抛错）。
 */
/** 行级序列化主体（单题/批量两出口共用一条路径，不复制装配） */
function serializeRowWithStructures(
  answer: StudentAnswer | null,
  snapshot: Question | null,
  slotOrder: ReadonlyMap<string, readonly string[]>,
  unitId: string | null,
): string | null {
  if (answer === null) return null;
  if (snapshot === null || !NEW_QUESTION_TYPES.includes(snapshot.type)) {
    return serializeStudentAnswer(answer);
  }
  return dispatchBehavior(
    answer,
    "teacher-queue",
    structuresOfSnapshot(snapshot, slotOrder, unitId),
  );
}

export function serializeStudentAnswerOfRow(
  db: Db,
  attemptId: string,
  row: Pick<
    ResponseRow,
    "attemptId" | "questionId" | "questionSnapshotJson" | "unitId"
  >,
  answer: StudentAnswer | null,
): string | null {
  return serializeRowWithStructures(
    answer,
    snapshotOfRow(row),
    materialSlotOrderOf(db, attemptId),
    row.unitId,
  );
}

/**
 * serializeStudentAnswerOfRow 的批量消费点出口（审查 P3-3）：原函数逐行调用
 * 都全量重扫 attempt_context_snapshots 并逐条 JSON.parse——130 题全待批即
 * 130 次全卷扫描。本工厂按 attemptId 请求内记忆化槽位序（一处 Map，行循环
 * 外建一次），待批队列/错题重练 CSV/学情包导出（v1+v2 经 PackCore）共用；
 * 行为与逐行原函数逐字一致。单题调用点（单题包）无循环收益，直接用原函数。
 */
export function batchSerializeStudentAnswerOfRow(
  db: Db,
): (
  attemptId: string,
  row: Pick<
    ResponseRow,
    "attemptId" | "questionId" | "questionSnapshotJson" | "unitId"
  >,
  answer: StudentAnswer | null,
) => string | null {
  const slotOrders = new Map<string, Map<string, readonly string[]>>();
  return (attemptId, row, answer) => {
    let slotOrder = slotOrders.get(attemptId);
    if (slotOrder === undefined) {
      slotOrder = materialSlotOrderOf(db, attemptId);
      slotOrders.set(attemptId, slotOrder);
    }
    return serializeRowWithStructures(
      answer,
      snapshotOfRow(row),
      slotOrder,
      row.unitId,
    );
  };
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
  return db.transaction(
    (tx) => {
      const row = tx
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
      if (row.attempt.abandonedAt !== null) {
        throw new HttpError(
          409,
          "ATTEMPT_ABANDONED",
          "这份作答已作废，不能批改",
        );
      }
      if (row.attempt.status === "draft" && row.response.submittedAt === null) {
        throw new HttpError(409, "NOT_SUBMITTED", "未交卷的作答不能批注");
      }
      if (snapshotOfRow(row.response) === null) {
        throw new HttpError(404, "RESPONSE_NOT_FOUND", "作答题目快照不可用");
      }

      const attemptId = row.attempt.id;
      const finalCorrect = finalCorrectOf(req.mark, row.response.autoCorrect);
      tx.update(responses)
        .set({
          teacherMark: req.mark,
          teacherComment: req.comment,
          finalCorrect,
        })
        .where(eq(responses.id, responseId))
        .run();

      let attempt = row.attempt;
      if (attempt.status !== "draft") {
        const outcomeRows = tx
          .select({
            gradingPolicy: responses.gradingPolicy,
            submittedAt: responses.submittedAt,
            finalCorrect: responses.finalCorrect,
          })
          .from(responses)
          .where(
            and(
              eq(responses.attemptId, attemptId),
              hasUsableQuestionSnapshotSql,
            ),
          )
          .all();
        const outcome = attemptFinalOutcomeOf(outcomeRows, { finalized: true });
        tx.update(attempts)
          .set(outcome)
          .where(eq(attempts.id, attemptId))
          .run();
        attempt = { ...attempt, ...outcome };
      }
      return {
        responseId,
        questionId: row.response.questionId,
        attemptId,
        teacherMark: req.mark,
        teacherComment: req.comment,
        finalCorrect,
        attemptStatus: attempt.status === "graded" ? "graded" : "submitted",
        scoreFinal: attempt.scoreFinal,
        pendingCount: pendingMarkCount(db, attempt),
      };
    },
    { behavior: "immediate" },
  );
}

// ---------- GET /api/teacher/pending-marks ----------

/**
 * 待批队列（D4）：共享谓词口径（教师待批、快照可用、且题已「交」
 * ——attempt 非 draft 或该行已单题提交，lesson 进行中卷已提交的手写/无答案题
 * 即时进队供课中批改）+ 教师域过滤（students.teacherId）+ 可选 courseId/
 * assignmentId/studentId 筛选。排序 submittedAt 升序（先交先批；lesson 进行中
 * 卷 attempt.submittedAt 为空，按 startedAt 兜底——开卷即排队）。无分页（见
 * 契约注释）。卡片拼装：按 attempt 分组复用 sourceOf/inkByQuestionOf（每
 * attempt 一次查询），快照坏数据行跳过并留痕（snapshotOfRow 内 warn，全服务
 * 端同一口径）。
 */
export function listPendingMarks(
  db: Db,
  teacherId: string,
  query: PendingMarkListQuery,
): PendingMarkListData {
  const where = and(
    eq(students.teacherId, teacherId),
    submittedTeacherPendingSql,
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
  // 审查 P3-3：行循环用批量出口（attemptId 请求内记忆化槽位序，一处 Map）
  const answerTextOf = batchSerializeStudentAnswerOfRow(db);
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
        answerText: answerTextOf(
          attemptId,
          response,
          answerOf(response.answerJson),
        ),
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

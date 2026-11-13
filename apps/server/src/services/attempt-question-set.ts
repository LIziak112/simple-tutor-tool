import {
  ATTEMPT_QUESTION_LIMIT_EXCEEDED,
  ATTEMPT_SUBMIT_MAX_QUESTIONS,
} from "@tutor/contract";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  assignmentUnits,
  type Question as QuestionRow,
  questions,
  students,
} from "../db/schema";
import { HttpError } from "../lib/http-error";

function liveQuestionsInUnits(teacherId: string, unitIds?: string[]) {
  return and(
    eq(questions.teacherId, teacherId),
    isNull(questions.deletedAt),
    unitIds === undefined ? undefined : inArray(questions.unitId, unitIds),
  );
}

/** 每个单元的有效题数。指定单元时只统计本次选中的范围。 */
export function liveQuestionCounts(
  db: Pick<Db, "select">,
  teacherId: string,
  unitIds?: string[],
): Map<string, number> {
  const rows = db
    .select({ unitId: questions.unitId, total: count() })
    .from(questions)
    .where(liveQuestionsInUnits(teacherId, unitIds))
    .groupBy(questions.unitId)
    .all();
  return new Map(rows.map((row) => [row.unitId, row.total]));
}

export function assertAttemptQuestionLimit(questionCount: number): void {
  if (questionCount > ATTEMPT_SUBMIT_MAX_QUESTIONS) {
    throw new HttpError(
      400,
      ATTEMPT_QUESTION_LIMIT_EXCEEDED,
      `单份练习最多 ${ATTEMPT_SUBMIT_MAX_QUESTIONS} 题，当前有 ${questionCount} 题，请减少题目或拆分布置`,
    );
  }
}

export function assertAssignmentBatchQuestionLimits(
  db: Pick<Db, "select">,
  teacherId: string,
  batches: readonly { units: readonly { id: string }[] }[],
): void {
  const unitIds = batches.flatMap((batch) =>
    batch.units.map((unit) => unit.id),
  );
  const counts = liveQuestionCounts(db, teacherId, unitIds);
  for (const batch of batches) {
    const total = batch.units.reduce(
      (sum, unit) => sum + (counts.get(unit.id) ?? 0),
      0,
    );
    assertAttemptQuestionLimit(total);
  }
}

/**
 * attempt → student.teacherId 推导教师域（T2B.5，D10）：学生侧无会话教师，
 * 取卷/判分/提示/结果视图等一切按 unitId/questionId 查 units/questions 的地方
 * 在复合主键 (teacherId, id) 后不再唯一，必须带域（否则两位教师持同 id 单元/
 * 题目时会串到别人的内容——既是泄露也是判分错误）。attempt 归属学生一生只归
 * 一位教师（D14），故域取 students.teacherId。
 * D9 异常行防御：无教师域的学生行（回填后不应存在）返回 null，调用方按
 * 空结果/缺省处理（fail closed，与 T2B.4 listStudentAssignments 同口径）。
 * 导出供 hint-service 复用（提示内容同样按域取题）。
 */
export function attemptTeacherId(db: Db, attempt: Attempt): string | null {
  const row = db
    .select({ teacherId: students.teacherId })
    .from(students)
    .where(eq(students.id, attempt.studentId))
    .get();
  return row?.teacherId ?? null;
}

/**
 * attempt 的有序单元 id 列表（T2A.7）：
 * - course 来源：[attempt.unitId]（单单元，创建时必写；防御性空列表兜底异常行；
 *   课程侧可见性由 requireVisibleCourseUnit 把关）；
 * - lesson 来源（2026-10 讲练一体）：[attempt.unitId]（嵌入单元的快照值，开卷
 *   时写入；零题讲练页为讲义 id 占位——该值下无题目行，冻结结果为空卷）；
 * - assignment 来源：该作业 assignment_units 按 order 升序的列表（作业行经 FK
 *   必存在——含已删作业，作答不随作业软删消失）。
 *   D16：**单元软删不影响作业通道**——引用行保留，题目照常下发/判分；
 *   只有 questions.deletedAt（T1.12 题目级软删）才把题从判分/快照口径排除。
 * - wrong 来源（2026-10）：恒 []——错题重练卷不落单元，题目集合/快照/题序
 *   全在 attempt 自己的 responses 行（wrongAttemptResponseRows）。
 * 判分/快照/草稿/取卷/题目归属校验全部以本列表为唯一口径（wrong 来源除外，
 * 各消费方按 wrong 分支走自有行）。
 */
export function attemptUnitIds(db: Db, attempt: Attempt): string[] {
  if (attempt.sourceType === "wrong") {
    return [];
  }
  if (attempt.sourceType === "course" || attempt.sourceType === "lesson") {
    return attempt.unitId !== null ? [attempt.unitId] : [];
  }
  const assignmentId = attempt.assignmentId;
  if (assignmentId === null) return []; // 防御性兜底：assignment 来源必写 assignmentId
  return db
    .select({ unitId: assignmentUnits.unitId })
    .from(assignmentUnits)
    .where(eq(assignmentUnits.assignmentId, assignmentId))
    .orderBy(asc(assignmentUnits.order), asc(assignmentUnits.unitId))
    .all()
    .map((row) => row.unitId);
}

/**
 * attempt 的判分/快照题目集合（按 sourceType 分派，D9；T2A.7 多单元拼接）：
 * 各单元未删除题按 (order, id) 升序后**按 attemptUnitIds 的单元顺序拼接**——
 * 题号全卷连续（D12），得分按全卷计算。course 来源为单单元的特例。
 * T2B.5：按 attempt → student.teacherId 域内取题（D10——同 id 题目分属不同
 * 教师，判分输入不可串域；无教师域的异常行按空集合处理）。
 */
export function loadAttemptQuestions(
  db: Db,
  attempt: Attempt,
): { teacherId: string | null; liveRows: QuestionRow[] } {
  const teacherId = attemptTeacherId(db, attempt);
  const unitIds = attemptUnitIds(db, attempt);
  if (unitIds.length === 0 || teacherId === null)
    return { teacherId, liveRows: [] };
  const rows = db
    .select()
    .from(questions)
    .where(liveQuestionsInUnits(teacherId, unitIds))
    .orderBy(asc(questions.order), asc(questions.id))
    .all();
  // 按单元顺序拼接（组内已按题序排序）
  const byUnit = new Map<string, QuestionRow[]>();
  for (const row of rows) {
    const list = byUnit.get(row.unitId);
    if (list === undefined) byUnit.set(row.unitId, [row]);
    else list.push(row);
  }
  return {
    teacherId,
    liveRows: unitIds.flatMap((unitId) => byUnit.get(unitId) ?? []),
  };
}

export function attemptQuestionRows(db: Db, attempt: Attempt): QuestionRow[] {
  return loadAttemptQuestions(db, attempt).liveRows;
}

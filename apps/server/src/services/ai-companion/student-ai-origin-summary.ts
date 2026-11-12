import type {
  AiAttemptOriginSummary,
  AiTaskBatchOrigin,
  AiTaskOriginSummary,
} from "@tutor/contract";
import { and, asc, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  type AiTaskRow,
  aiTasks,
  assignments,
  attempts,
  courses,
  lectures,
  responses,
} from "../../db/schema.ts";
import { batchKeyOfTask, sha256Hex } from "./student-ai-shared.ts";

/**
 * 「求助记录」列表的来源摘要（展示与导航定位）：两类任务共用作答级摘要，
 * 逐题任务在其上追加卷内题号与批量复盘批次来源。整页批量预取，不逐行 N+1；
 * 只放公开字段——不读题面、答案与作答内容。
 */

/**
 * 全卷题号（1 起连续）：建卷冻结序——unitId 首现序分组 + rowid 组内序
 * （attempt-service.frozenRowsInDisplayOrder 冻结路径同规则；null unitId 行
 * 归末尾兜底组）。wrong 卷行全 null → 纯 rowid 序。返回 questionId → 题号；
 * 卷内无该题（软删/缺失）不在 Map 中，调用方置 null 不伪造题号。
 */
export function questionNoByQuestionOf(
  rows: readonly { questionId: string; unitId: string | null }[],
): Map<string, number> {
  const unitRank = new Map<string, number>();
  for (const row of rows) {
    if (row.unitId !== null && !unitRank.has(row.unitId)) {
      unitRank.set(row.unitId, unitRank.size);
    }
  }
  const rankOf = (unitId: string | null): number =>
    unitId === null
      ? Number.MAX_SAFE_INTEGER
      : (unitRank.get(unitId) ?? Number.MAX_SAFE_INTEGER);
  // sort 稳定：组内保持 rowid 序（查询已按 rowid 排序）
  const sorted = [...rows].sort((a, b) => rankOf(a.unitId) - rankOf(b.unitId));
  const numbers = new Map<string, number>();
  sorted.forEach((row, index) => {
    if (!numbers.has(row.questionId)) numbers.set(row.questionId, index + 1);
  });
  return numbers;
}

/** 空 id 集不进 inArray（既省查询也免去空数组 SQL 形态的版本差异） */
function titlesOf(
  ids: readonly (string | null)[],
  load: (ids: string[]) => { id: string; title: string }[],
): Map<string, string> {
  const present = ids.filter((id): id is string => id !== null);
  return new Map(
    present.length === 0
      ? []
      : load(present).map((row) => [row.id, row.title] as const),
  );
}

/**
 * 作答级来源摘要（attempts 一批、三类标题各一批）：来源 / 第几次 / 标题 /
 * 导航定位键 / 作答阶段。返回 attemptId → 摘要；行已不在的不进 Map。
 */
export function attemptOriginSummariesOf(
  db: Db,
  attemptIds: readonly string[],
): Map<string, AiAttemptOriginSummary> {
  const uniqueIds = [...new Set(attemptIds)];
  if (uniqueIds.length === 0) return new Map();
  const attemptRows = db
    .select()
    .from(attempts)
    .where(inArray(attempts.id, uniqueIds))
    .all();
  const assignmentTitles = titlesOf(
    attemptRows.map((row) => row.assignmentId),
    (ids) =>
      db
        .select({ id: assignments.id, title: assignments.title })
        .from(assignments)
        .where(inArray(assignments.id, ids))
        .all(),
  );
  const courseTitles = titlesOf(
    attemptRows.map((row) => row.courseId),
    (ids) =>
      db
        .select({ id: courses.id, title: courses.title })
        .from(courses)
        .where(inArray(courses.id, ids))
        .all(),
  );
  const lectureTitles = titlesOf(
    attemptRows.map((row) => row.lectureId),
    (ids) =>
      db
        .select({ id: lectures.id, title: lectures.title })
        .from(lectures)
        .where(inArray(lectures.id, ids))
        .all(),
  );
  // 三个标题 Map 的键均为卷 id；wrong 无卷标题恒 null
  const titleOf = (
    titles: Map<string, string>,
    id: string | null,
  ): string | null => (id === null ? null : (titles.get(id) ?? null));
  return new Map(
    attemptRows.map((attempt) => {
      const title =
        attempt.sourceType === "assignment"
          ? titleOf(assignmentTitles, attempt.assignmentId)
          : attempt.sourceType === "course"
            ? titleOf(courseTitles, attempt.courseId)
            : attempt.sourceType === "lesson"
              ? titleOf(lectureTitles, attempt.lectureId)
              : null;
      return [
        attempt.id,
        {
          sourceType: attempt.sourceType,
          attemptNo: attempt.attemptNo,
          title,
          assignmentId: attempt.assignmentId,
          courseId: attempt.courseId,
          unitId: attempt.unitId,
          lectureId: attempt.lectureId,
          attemptStatus: attempt.status,
        },
      ] as const;
    }),
  );
}

/** 批次对外标识：按学生 + 作答 + 批次键取哈希，幂等键原文不出服务端 */
function batchIdOf(row: {
  studentId: string;
  attemptId: string;
  batchKey: string;
}): string {
  return sha256Hex(
    `ai-batch:${row.studentId}:${row.attemptId}:${row.batchKey}`,
  ).slice(0, 32);
}

/**
 * 整页逐题任务的批次来源（一条查询）：批次不落列，由批量复盘的幂等键派生
 * 规则反解（见 batchKeyOfTask）。任务数与发起时刻按「该学生该作答下同批次
 * 的全部任务」统计（含已归档、含不在本页的），所以翻页与归档不改变批次
 * 口径。返回 任务 id → 批次；单题求助不在 Map 中。
 */
function batchOriginsOf(
  db: Db,
  page: readonly AiTaskRow[],
): Map<string, AiTaskBatchOrigin> {
  const batchIdByTask = new Map<string, string>();
  for (const row of page) {
    const batchKey = batchKeyOfTask(row);
    if (batchKey !== null) {
      batchIdByTask.set(row.id, batchIdOf({ ...row, batchKey }));
    }
  }
  if (batchIdByTask.size === 0) return new Map();
  const batchRows = page.filter((row) => batchIdByTask.has(row.id));
  const stats = new Map<string, AiTaskBatchOrigin>();
  for (const row of db
    .select({
      studentId: aiTasks.studentId,
      attemptId: aiTasks.attemptId,
      questionId: aiTasks.questionId,
      mutationId: aiTasks.mutationId,
      createdAt: aiTasks.createdAt,
    })
    .from(aiTasks)
    .where(
      and(
        inArray(aiTasks.studentId, [
          ...new Set(batchRows.map((item) => item.studentId)),
        ]),
        inArray(aiTasks.attemptId, [
          ...new Set(batchRows.map((item) => item.attemptId)),
        ]),
      ),
    )
    .all()) {
    const batchKey = batchKeyOfTask(row);
    if (batchKey === null) continue;
    const id = batchIdOf({ ...row, batchKey });
    const current = stats.get(id);
    stats.set(id, {
      id,
      taskCount: (current?.taskCount ?? 0) + 1,
      createdAt:
        current === undefined || row.createdAt < current.createdAt
          ? row.createdAt
          : current.createdAt,
    });
  }
  const origins = new Map<string, AiTaskBatchOrigin>();
  for (const [taskId, batchId] of batchIdByTask) {
    const batch = stats.get(batchId);
    if (batch !== undefined) origins.set(taskId, batch);
  }
  return origins;
}

/**
 * 整页逐题任务来源摘要：作答级摘要 + 卷内题号（按冻结序，题不在卷行中如实
 * null）+ 批次来源（单题求助为 null）。
 */
export function aiTaskOriginSummariesOf(
  db: Db,
  page: readonly AiTaskRow[],
): Record<string, AiTaskOriginSummary> {
  const attemptIds = [...new Set(page.map((row) => row.attemptId))];
  if (attemptIds.length === 0) return {};
  const attemptOrigins = attemptOriginSummariesOf(db, attemptIds);
  const rowsByAttempt = new Map<
    string,
    { questionId: string; unitId: string | null }[]
  >();
  for (const row of db
    .select({
      attemptId: responses.attemptId,
      questionId: responses.questionId,
      unitId: responses.unitId,
    })
    .from(responses)
    .where(inArray(responses.attemptId, attemptIds))
    .orderBy(asc(responses.attemptId), sql`rowid`)
    .all()) {
    const list = rowsByAttempt.get(row.attemptId);
    if (list === undefined) rowsByAttempt.set(row.attemptId, [row]);
    else list.push(row);
  }
  const questionNoByAttempt = new Map(
    [...rowsByAttempt].map(
      ([attemptId, rows]) => [attemptId, questionNoByQuestionOf(rows)] as const,
    ),
  );
  const batches = batchOriginsOf(db, page);
  const origins: Record<string, AiTaskOriginSummary> = {};
  for (const row of page) {
    const attemptOrigin = attemptOrigins.get(row.attemptId);
    if (attemptOrigin === undefined) continue; // 行已不在（理论不可达，FK 保证）
    origins[row.id] = {
      ...attemptOrigin,
      questionNo:
        questionNoByAttempt.get(row.attemptId)?.get(row.questionId) ?? null,
      batch: batches.get(row.id) ?? null,
    };
  }
  return origins;
}

import {
  AI_TASK_QUEUE_BUCKETS,
  aiContextSnapshotSchema,
  type Question,
  type RubricReview,
  rubricAdjudicationSchema,
  rubricAssessmentSchema,
  rubricReviewSchema,
} from "@tutor/contract";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { type AiTaskRow, aiTasks, type ResponseRow } from "../db/schema";

/**
 * 通用量表判卷（模块 3）读侧：量表在冻结题目快照里（`question.rubric`），
 * 三份记录存 responses 行三列 JSON（自评 / Agent 意见 / 本人裁定）。单独成
 * 模块以便 attempt-service 结果投影引用而不牵入 AI 队列模块（避免环引用）。
 */

function parseJson<T>(
  column: string | null,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
): T | null {
  if (column === null) return null;
  try {
    const result = parse(JSON.parse(column));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** 任务快照里的目的；损坏 / 旧快照 / 普通求助为 undefined */
function purposeOf(task: AiTaskRow): string | undefined {
  try {
    const parsed = aiContextSnapshotSchema.safeParse(
      JSON.parse(task.contextSnapshotJson),
    );
    return parsed.success ? parsed.data.purpose : undefined;
  } catch {
    return undefined;
  }
}

/** 本题在途（未回信、未终态）的判卷任务 id；没有为 null */
export function pendingRubricTaskIdOf(
  db: Db,
  attemptId: string,
  questionId: string,
): string | null {
  const active = [
    ...AI_TASK_QUEUE_BUCKETS.pending,
    ...AI_TASK_QUEUE_BUCKETS.processing,
  ];
  const rows = db
    .select()
    .from(aiTasks)
    .where(
      and(
        eq(aiTasks.attemptId, attemptId),
        eq(aiTasks.questionId, questionId),
        inArray(aiTasks.status, active),
      ),
    )
    .orderBy(desc(aiTasks.createdAt))
    .all();
  return rows.find((row) => purposeOf(row) === "rubric_opinion")?.id ?? null;
}

/**
 * 结果页投影：题无量表 → null（调用方不注入键）。只在已公布的结果投影里调用
 * （公布 gate 由 releaseAwareQuestion 统一裁决，本函数不重复判）。
 */
export function rubricReviewOf(
  db: Db,
  row: Pick<
    ResponseRow,
    | "attemptId"
    | "questionId"
    | "rubricSelfJson"
    | "rubricAgentJson"
    | "rubricFinalJson"
  >,
  snapshot: Pick<Question, "rubric">,
): RubricReview | null {
  const rubric = snapshot.rubric;
  if (rubric === undefined) return null;
  return rubricReviewSchema.parse({
    rubric,
    self: parseJson(row.rubricSelfJson, (v) =>
      rubricAssessmentSchema.safeParse(v),
    ),
    agent: parseJson(row.rubricAgentJson, (v) =>
      rubricAssessmentSchema.safeParse(v),
    ),
    final: parseJson(row.rubricFinalJson, (v) =>
      rubricAdjudicationSchema.safeParse(v),
    ),
    pendingAgentTaskId: pendingRubricTaskIdOf(
      db,
      row.attemptId,
      row.questionId,
    ),
  });
}

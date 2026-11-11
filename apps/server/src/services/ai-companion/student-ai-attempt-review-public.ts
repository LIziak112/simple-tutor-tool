import {
  AI_ATTEMPT_REVIEW_ALLOWED_ACTIONS,
  type AiAttemptReviewCounts,
  type AiAttemptReviewTaskPublic,
  aiAttemptReviewCountsSchema,
} from "@tutor/contract";
import { eq, max } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  type AiAttemptReviewTaskRow,
  aiAttemptReviewResults,
} from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";
import { jsonOf } from "../snapshot.ts";
import { asDb, type QueueTx } from "./student-ai-shared.ts";

/** 公开视图的计数来源：counts_json 反规范化投影（损坏 → AI_ATTEMPT_REVIEW_BROKEN） */
function countsOfTask(task: AiAttemptReviewTaskRow): AiAttemptReviewCounts {
  const parsed = aiAttemptReviewCountsSchema.safeParse(jsonOf(task.countsJson));
  if (!parsed.success) {
    throw new HttpError(
      500,
      "AI_ATTEMPT_REVIEW_BROKEN",
      "整体复盘任务计数数据已损坏，无法读取",
    );
  }
  return parsed.data;
}

export function attemptReviewPublicViewOf(
  db: Db | QueueTx,
  task: AiAttemptReviewTaskRow,
  /** 列表批量查询的最近回信时刻（省略时按行查询） */
  resultAtOverride?: string | null,
): AiAttemptReviewTaskPublic {
  // counts 是创建时冻结的反规范化投影（counts_json），公开视图不解整体
  // 快照——列表/详情/动作的响应面不为此解析 256KiB 内部视图
  const counts = countsOfTask(task);
  const resultAt =
    resultAtOverride === undefined
      ? (asDb(db)
          .select({ at: max(aiAttemptReviewResults.receivedAt) })
          .from(aiAttemptReviewResults)
          .where(eq(aiAttemptReviewResults.taskId, task.id))
          .get()?.at ?? null)
      : resultAtOverride;
  return {
    id: task.id,
    attemptId: task.attemptId,
    status: task.status,
    purpose: task.purpose,
    questionCount: task.questionCount,
    counts,
    snapshotVersion: task.snapshotVersion,
    generation: task.generation,
    retryCount: task.retryCount,
    errorText: task.errorText,
    hasResult: resultAt !== null,
    openedAt: task.openedAt,
    archivedAt: task.archivedAt,
    allowedActions: [...AI_ATTEMPT_REVIEW_ALLOWED_ACTIONS[task.status]],
    createdAt: task.createdAt,
    updatedAt:
      task.status === "replied" ? (resultAt ?? task.updatedAt) : task.updatedAt,
  };
}

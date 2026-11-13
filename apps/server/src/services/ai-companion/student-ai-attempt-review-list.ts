import type {
  AiAttemptReviewListData,
  AiAttemptReviewStatus,
} from "@tutor/contract";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  or,
  type SQL,
} from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  aiAttemptReviewResults,
  aiAttemptReviewTasks,
} from "../../db/schema.ts";
import { attemptReviewPublicViewOf } from "./student-ai-attempt-review-public.ts";
import { attemptOriginSummariesOf } from "./student-ai-origin-summary.ts";
import { decodeCursor, encodeCursor } from "./student-ai-shared.ts";

/**
 * 本人整卷复盘任务列表（学生 Cookie 会话与 MCP 只读工具共用）。
 * 只读公开视图与来源摘要：不取报告正文、不写任何状态——浏览列表不等于
 * 读过报告（已读只由 open 动作在授权门之后写入）。
 */

export interface ListAttemptReviewInput {
  readonly studentId: string;
  readonly attemptId?: string;
  readonly status?: AiAttemptReviewStatus;
  /** 归档过滤（与逐题任务列表同义）：exclude = 未归档、only = 已归档；缺省 = 全部 */
  readonly archived?: "exclude" | "only";
  readonly includeOrigins?: boolean;
  readonly limit: number;
  readonly cursor?: string;
}

/**
 * 稳定游标分页（createdAt + id 双键倒序，与逐题任务列表同款）。账号范围默认附
 * 来源摘要；按作答过滤时，只有求助记录显式请求才计算。
 */
export function listAttemptReviewTasks(
  db: Db,
  input: ListAttemptReviewInput,
): AiAttemptReviewListData {
  const filters: (SQL<unknown> | undefined)[] = [
    eq(aiAttemptReviewTasks.studentId, input.studentId),
  ];
  if (input.attemptId !== undefined) {
    filters.push(eq(aiAttemptReviewTasks.attemptId, input.attemptId));
  }
  if (input.status !== undefined) {
    filters.push(eq(aiAttemptReviewTasks.status, input.status));
  }
  if (input.archived === "exclude") {
    filters.push(isNull(aiAttemptReviewTasks.archivedAt));
  } else if (input.archived === "only") {
    filters.push(isNotNull(aiAttemptReviewTasks.archivedAt));
  }
  if (input.cursor !== undefined) {
    const payload = decodeCursor(input.cursor);
    // DESC 序的 keyset 游标：上一页末条 (c, i) → 下一页 = createdAt < c
    // OR (createdAt = c AND id < i)。AND(lt, lte) 会把同秒更小 id 之后、
    // 更早 createdAt 的行整段漏掉（/code-review 修复）
    filters.push(
      or(
        lt(aiAttemptReviewTasks.createdAt, payload.c),
        and(
          eq(aiAttemptReviewTasks.createdAt, payload.c),
          lt(aiAttemptReviewTasks.id, payload.i),
        ),
      ),
    );
  }
  const rows = db
    .select()
    .from(aiAttemptReviewTasks)
    .where(and(...filters))
    .orderBy(
      desc(aiAttemptReviewTasks.createdAt),
      desc(aiAttemptReviewTasks.id),
    )
    .limit(input.limit + 1)
    .all();
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page.at(-1);
  const pageIds = page.map((row) => row.id);
  const resultTimes = new Map(
    pageIds.length === 0
      ? []
      : db
          .select({
            taskId: aiAttemptReviewResults.taskId,
            at: max(aiAttemptReviewResults.receivedAt),
          })
          .from(aiAttemptReviewResults)
          .where(inArray(aiAttemptReviewResults.taskId, pageIds))
          .groupBy(aiAttemptReviewResults.taskId)
          .all()
          .map((row) => [row.taskId, row.at] as const),
  );
  const tasks = page.map((row) =>
    attemptReviewPublicViewOf(db, row, resultTimes.get(row.id) ?? null),
  );
  const nextCursor =
    hasMore && last !== undefined
      ? encodeCursor({ c: last.createdAt, i: last.id })
      : null;
  if (input.attemptId !== undefined && !input.includeOrigins)
    return { tasks, nextCursor };
  const attemptOrigins = attemptOriginSummariesOf(
    db,
    page.map((row) => row.attemptId),
  );
  const origins: NonNullable<AiAttemptReviewListData["origins"]> = {};
  for (const row of page) {
    const origin = attemptOrigins.get(row.attemptId);
    if (origin !== undefined) origins[row.id] = origin;
  }
  return { tasks, nextCursor, origins };
}

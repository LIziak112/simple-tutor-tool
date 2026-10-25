import { z } from "zod";

/** 本次冻结题目结果；未做仍进总数，待批与待自评独立保留。
 * 学生端只在整卷提交并按既有规则公布后下发，草稿/未公布为 null。
 * 旧响应允许缺省；客户端不得从兼容保留的百分比分数反推计数。
 */
export const attemptResultCountsSchema = z
  .object({
    correctCount: z.number().int().min(0),
    totalCount: z.number().int().min(0),
    pendingCount: z.number().int().min(0),
    pendingSelfReviewCount: z.number().int().min(0),
  })
  .refine(
    (counts) =>
      counts.correctCount +
        counts.pendingCount +
        counts.pendingSelfReviewCount <=
      counts.totalCount,
    "已确认与待判题数不能超过总题数",
  );

export type AttemptResultCounts = z.infer<typeof attemptResultCountsSchema>;

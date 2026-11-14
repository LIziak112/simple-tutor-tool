import { z } from "zod";

/** 首提交封存，客户端时钟活动证据；与旧动态 activity v1 分开版本化。 */
export const ATTEMPT_TIME_LEDGER_VERSION = 1 as const;
const seconds = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const sealedQuestionTimeSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("available"),
      activeSec: seconds,
      observedSec: seconds,
      actions: seconds,
      viewed: z.boolean(),
    })
    .strict(),
  z
    .object({
      state: z.literal("unknown"),
      reason: z.enum(["no_client_evidence", "clock_invalid", "ledger_missing"]),
      activeSec: z.null(),
      observedSec: z.null(),
    })
    .strict(),
]);
export type SealedQuestionTime = z.infer<typeof sealedQuestionTimeSchema>;
export const sealedTimeAggregateSchema = z
  .object({
    metric: z.literal("question_activity_sealed"),
    version: z.literal(1),
    memberCount: seconds,
    knownCount: seconds,
    unknownCount: seconds,
    knownActiveSec: seconds,
    knownObservedSec: seconds,
    activeSec: seconds.nullable(),
    observedSec: seconds.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.knownCount + value.unknownCount !== value.memberCount ||
      value.activeSec !==
        (value.unknownCount === 0 ? value.knownActiveSec : null) ||
      value.observedSec !==
        (value.unknownCount === 0 ? value.knownObservedSec : null)
    ) {
      ctx.addIssue({ code: "custom", message: "用时覆盖与合计不一致" });
    }
  });
export type SealedTimeAggregate = z.infer<typeof sealedTimeAggregateSchema>;
export const attemptTimeSchema = z.union([
  sealedTimeAggregateSchema,
  z
    .object({
      metric: z.literal("legacy_focus"),
      version: z.null(),
      activeSec: seconds.nullable(),
    })
    .strict(),
]);
export type AttemptTime = z.infer<typeof attemptTimeSchema>;
export const responseTimeSchema = z.union([
  z
    .object({
      metric: z.literal("question_activity_sealed"),
      version: z.literal(1),
      value: sealedQuestionTimeSchema,
    })
    .strict(),
  z
    .object({
      metric: z.literal("legacy_focus"),
      version: z.null(),
      activeSec: seconds.nullable(),
    })
    .strict(),
]);
export type ResponseTime = z.infer<typeof responseTimeSchema>;
/** 先逐题取整、再合计；未知不能当作零宣称完整。 */
export function aggregateSealedTime(
  rows: readonly SealedQuestionTime[],
): SealedTimeAggregate {
  let knownCount = 0,
    knownActiveSec = 0,
    knownObservedSec = 0;
  for (const row of rows)
    if (row.state === "available") {
      knownCount++;
      knownActiveSec += row.activeSec;
      knownObservedSec += row.observedSec;
    }
  const unknownCount = rows.length - knownCount;
  return sealedTimeAggregateSchema.parse({
    metric: "question_activity_sealed",
    version: 1,
    memberCount: rows.length,
    knownCount,
    unknownCount,
    knownActiveSec,
    knownObservedSec,
    activeSec: unknownCount === 0 ? knownActiveSec : null,
    observedSec: unknownCount === 0 ? knownObservedSec : null,
  });
}

/** 跨卷统计分指标输出，绝不把历史焦点秒混进活动秒。 */
export function aggregateResponseTimes(
  rows: readonly ResponseTime[],
): AttemptTime[] {
  const activity = rows.filter(
    (r): r is Extract<ResponseTime, { metric: "question_activity_sealed" }> =>
      r.metric === "question_activity_sealed",
  );
  const legacy = rows.filter(
    (r): r is Extract<ResponseTime, { metric: "legacy_focus" }> =>
      r.metric === "legacy_focus",
  );
  const known = legacy.flatMap((r) =>
    r.activeSec === null ? [] : [r.activeSec],
  );
  return [
    ...(activity.length
      ? [aggregateSealedTime(activity.map((r) => r.value))]
      : []),
    ...(legacy.length
      ? [
          {
            metric: "legacy_focus" as const,
            version: null,
            activeSec:
              known.length === legacy.length
                ? known.reduce((a, b) => a + b, 0)
                : null,
          },
        ]
      : []),
  ];
}

export const attemptTimeEstimateSchema = z
  .object({
    metric: z.literal("question_activity_estimate"),
    version: z.literal(1),
    activeSecTotal: seconds,
  })
  .strict();

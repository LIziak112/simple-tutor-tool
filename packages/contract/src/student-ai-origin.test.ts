import { expect, it } from "vitest";
import {
  aiAttemptReviewListDataSchema,
  aiAttemptReviewListQuerySchema,
} from "./student-ai-attempt-review.ts";
import {
  aiAttemptOriginSummarySchema,
  aiTaskBatchOriginSchema,
  aiTaskOriginSummarySchema,
} from "./student-ai-origin.ts";

const attemptOrigin = {
  sourceType: "lesson",
  attemptNo: 2,
  title: "二次函数讲练页",
  assignmentId: null,
  courseId: "6b7c8d9e-0000-4000-8000-ffffffffffff",
  unitId: "unit-b",
  lectureId: "7c8d9e0f-0000-4000-8000-aaaaaaaaaaaa",
  attemptStatus: "submitted",
};

it("SAI-23 任务来源摘要：来源/次数/题号/标题与导航定位键（列表附加视图）", () => {
  const origin = { ...attemptOrigin, questionNo: 3, batch: null };
  expect(aiTaskOriginSummarySchema.parse(origin)).toEqual(origin);
  // 题不在本卷（软删/缺失）如实可表达，不伪造题号
  expect(
    aiTaskOriginSummarySchema.parse({ ...origin, questionNo: null }).questionNo,
  ).toBeNull();
  // strict：未知字段与非法来源拒绝
  expect(
    aiTaskOriginSummarySchema.safeParse({ ...origin, extra: 1 }).success,
  ).toBe(false);
  expect(
    aiTaskOriginSummarySchema.safeParse({ ...origin, sourceType: "exam" })
      .success,
  ).toBe(false);
  expect(
    aiTaskOriginSummarySchema.safeParse({ ...origin, attemptNo: 0 }).success,
  ).toBe(false);
});

it("批次来源：同一次批量复盘的逐题任务共用批次标识；单题求助显式为 null", () => {
  const batch = {
    id: "3f2a9c1e5b7d4a60",
    taskCount: 6,
    createdAt: "2026-11-12T17:09:19.000Z",
  };
  const origin = { ...attemptOrigin, questionNo: 8, batch };
  expect(aiTaskOriginSummarySchema.parse(origin).batch).toEqual(batch);
  // 单题求助必须显式给 null——缺省不等于「不属于任何批次」
  expect(
    aiTaskOriginSummarySchema.safeParse({ ...attemptOrigin, questionNo: 8 })
      .success,
  ).toBe(false);
  // 批次只放标识、任务数与发起时刻：strict 拒绝幂等键原文等任何额外字段
  expect(
    aiTaskBatchOriginSchema.safeParse({ ...batch, mutationId: "m-1" }).success,
  ).toBe(false);
  expect(
    aiTaskBatchOriginSchema.safeParse({ ...batch, taskCount: 0 }).success,
  ).toBe(false);
  expect(aiTaskBatchOriginSchema.safeParse({ ...batch, id: "" }).success).toBe(
    false,
  );
});

it("作答级来源摘要：整卷任务只到作答这一层，不带题号与批次", () => {
  expect(aiAttemptOriginSummarySchema.parse(attemptOrigin)).toEqual(
    attemptOrigin,
  );
  expect(
    aiAttemptOriginSummarySchema.safeParse({ ...attemptOrigin, questionNo: 1 })
      .success,
  ).toBe(false);
  expect(
    aiAttemptOriginSummarySchema.safeParse({ ...attemptOrigin, batch: null })
      .success,
  ).toBe(false);
});

it("整卷任务列表：origins 可省略；携带时按作答级来源摘要 strict 校验", () => {
  expect(
    aiAttemptReviewListDataSchema.parse({ tasks: [], nextCursor: null })
      .origins,
  ).toBeUndefined();
  const withOrigins = {
    tasks: [],
    nextCursor: null,
    origins: { "4f5a6b7c-0000-4000-8000-dddddddddddd": attemptOrigin },
  };
  expect(aiAttemptReviewListDataSchema.parse(withOrigins).origins).toEqual(
    withOrigins.origins,
  );
  expect(
    aiAttemptReviewListDataSchema.safeParse({
      tasks: [],
      nextCursor: null,
      origins: { "t-1": { ...attemptOrigin, questionNo: 1 } },
    }).success,
  ).toBe(false);
});

it("整卷任务列表查询：archived 与逐题列表同义，缺省 = 全部", () => {
  expect(
    aiAttemptReviewListQuerySchema.parse({ archived: "exclude" }).archived,
  ).toBe("exclude");
  expect(
    aiAttemptReviewListQuerySchema.parse({ archived: "only" }).archived,
  ).toBe("only");
  expect(aiAttemptReviewListQuerySchema.parse({}).archived).toBeUndefined();
  expect(
    aiAttemptReviewListQuerySchema.safeParse({ archived: "all" }).success,
  ).toBe(false);
});

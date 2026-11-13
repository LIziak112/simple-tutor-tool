import { describe, expect, it } from "vitest";
import { deviceRegisterSchema } from "./device-api.ts";
import { learningContextSchema } from "./learning-context.ts";
import { memoCreateTextSchema } from "./memo-api.ts";

const context = {
  schemaVersion: 1,
  content: {
    courseId: null,
    unitId: "unit-1",
    lectureId: null,
    sectionId: null,
    questionId: "q-1",
    titles: { course: null, unit: "单元", lecture: null },
  },
  session: {
    attemptId: "00000000-0000-4000-8000-000000000001",
    questionRevisionId: "00000000-0000-4000-8000-000000000002",
    questionNo: 2,
    questionCount: 3,
    settlementSeq: null,
  },
  view: null,
  deviceId: null,
};

describe("学习上下文与设备契约", () => {
  it("版本化上下文同时保留稳定内容坐标与冻结会话坐标", () => {
    expect(learningContextSchema.parse(context)).toEqual(context);
    expect(
      learningContextSchema.safeParse({ ...context, schemaVersion: 2 }).success,
    ).toBe(false);
    expect(
      learningContextSchema.safeParse({
        ...context,
        session: { ...context.session, questionNo: 4 },
      }).success,
    ).toBe(false);
  });
  it("讲义可无会话，设备登记只接受有界元数据", () => {
    expect(
      learningContextSchema.safeParse({ ...context, session: null }).success,
    ).toBe(true);
    expect(
      deviceRegisterSchema.safeParse({
        deviceId: crypto.randomUUID(),
        type: "tablet",
        os: "iPadOS",
        browser: "Safari",
        standalone: true,
      }).success,
    ).toBe(true);
    expect(
      deviceRegisterSchema.safeParse({ deviceId: "", type: "tablet" }).success,
    ).toBe(false);
  });
  it("旧随笔创建仍有效，新字段按上下文契约校验", () => {
    const legacy = { clientId: crypto.randomUUID(), text: "记录" };
    expect(memoCreateTextSchema.parse(legacy)).toEqual(legacy);
    expect(memoCreateTextSchema.parse({ ...legacy, context }).context).toEqual(
      context,
    );
    expect(
      memoCreateTextSchema.safeParse({
        ...legacy,
        context: { ...context, schemaVersion: 2 },
      }).success,
    ).toBe(false);
  });
});

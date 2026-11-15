import { describe, expect, it } from "vitest";
import { deviceRegisterSchema } from "./device-api.ts";
import { learningContextSchema } from "./learning-context.ts";
import { memoAnchorSchema, memoCreateTextSchema } from "./memo-api.ts";

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

it.each([80, 81, 160, 161])(
  "新旧内容坐标沿用合法DSL id，不截断长度 %i",
  (length) => {
    const id = "q".repeat(length);
    expect(
      learningContextSchema.parse({
        ...context,
        content: { ...context.content, questionId: id, sectionId: id },
      }).content.questionId,
    ).toBe(id);
    expect(
      memoAnchorSchema.parse({
        kind: "question",
        attemptId: context.session.attemptId,
        questionId: id,
        label: "题",
      }),
    ).toMatchObject({ questionId: id });
    expect(
      memoAnchorSchema.parse({
        kind: "lecture",
        lectureId: "l-1",
        sectionId: id,
        label: "讲义",
      }),
    ).toMatchObject({ sectionId: id });
  },
);

it("源内容允许501字符标题，上下文快照保留完整标题", () => {
  const title = "长".repeat(501);
  expect(
    learningContextSchema.parse({
      ...context,
      content: {
        ...context.content,
        titles: { course: title, unit: title, lecture: title },
      },
    }).content.titles,
  ).toEqual({ course: title, unit: title, lecture: title });
});

it.each([
  "opaque-row-ref",
  "兼容:冻结行/17",
  "r".repeat(512),
  context.session.questionRevisionId,
])(
  "冻结题行引用沿用既有questionRevisionId契约并原样保留 %s",
  (questionRevisionId) => {
    const parsed = learningContextSchema.parse({
      ...context,
      session: { ...context.session, questionRevisionId },
    });
    expect(parsed.session?.questionRevisionId).toBe(questionRevisionId);
  },
);
it.each(["", " ", " ref", "ref ", "r".repeat(513)])(
  "冻结题行引用拒绝既有契约不合法值 %j",
  (questionRevisionId) => {
    expect(
      learningContextSchema.safeParse({
        ...context,
        session: { ...context.session, questionRevisionId },
      }).success,
    ).toBe(false);
  },
);
it("行引用放宽不改变真实attemptId/deviceId的UUID约束", () => {
  expect(
    learningContextSchema.safeParse({
      ...context,
      session: { ...context.session, attemptId: "opaque-row-ref" },
    }).success,
  ).toBe(false);
  expect(
    learningContextSchema.safeParse({ ...context, deviceId: "opaque-row-ref" })
      .success,
  ).toBe(false);
});

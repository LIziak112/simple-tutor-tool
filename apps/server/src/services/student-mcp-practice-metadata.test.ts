import {
  MEMO_METADATA_MAX_BYTES,
  type StudentAnswer,
  type StudentMcpPracticeQuestionData,
  studentMcpPracticeQuestionDataSchema,
} from "@tutor/contract";
import { afterEach, beforeEach, expect, it } from "vitest";
import { callToolJson } from "../test/mcp-test-utils.ts";
import { studentPracticeReadEnv } from "../test/student-mcp-practice-fixtures.ts";
import {
  assertStudentMcpQuestionMetadata,
  studentMcpQuestionMetadata,
} from "./student-mcp-practice-metadata.ts";

let env: Awaited<ReturnType<typeof studentPracticeReadEnv>>;
let data: StudentMcpPracticeQuestionData;
beforeEach(async () => {
  env = await studentPracticeReadEnv("class");
  const read = await callToolJson(env.client, "get_practice_question", {
    practiceId: env.practiceId,
    questionId: "q-1",
    includeImages: false,
  });
  expect(read.isError).toBe(false);
  data = studentMcpPracticeQuestionDataSchema.parse(read.data);
});
afterEach(async () => {
  await env?.client.close();
  env?.db.$client.close();
});

const large = "正文".repeat(40_000);
const tooLarge = { code: "MEMO_METADATA_TOO_LARGE", status: 413 };
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

it("65536B元数据精确允许，增加1B拒绝，不截断字段", () => {
  const base = { ...data, question: { ...data.question, knowledge: [""] } };
  const room =
    MEMO_METADATA_MAX_BYTES - bytes(studentMcpQuestionMetadata(base));
  const exact = {
    ...base,
    question: { ...base.question, knowledge: ["a".repeat(room)] },
  };
  expect(bytes(studentMcpQuestionMetadata(exact))).toBe(
    MEMO_METADATA_MAX_BYTES,
  );
  expect(() => assertStudentMcpQuestionMetadata(exact)).not.toThrow();
  expect(exact.question.knowledge[0]?.length).toBe(room);
  expect(() =>
    assertStudentMcpQuestionMetadata({
      ...exact,
      question: {
        ...exact.question,
        knowledge: [`${exact.question.knowledge[0]}a`],
      },
    }),
  ).toThrowError(expect.objectContaining(tooLarge));
});

it("只扣除公开正文，完整保留id/标题/结构/上下文/证据等元字段", () => {
  const input = studentMcpPracticeQuestionDataSchema.parse({
    ...data,
    question: {
      ...data.question,
      stemMd: large,
      options: [large],
      matchingOptions: {
        allowRepeat: false,
        options: [{ id: "opt-1", text: large }],
      },
      orderingItems: [{ id: "it-1", text: large, fixedPosition: null }],
    },
    materials: [
      { id: "mat-1", title: "材料标题", sourceVersion: 1, contentMd: large },
    ],
    currentAnswer: {
      kind: "response",
      title: "本人标题",
      body: "文".repeat(30_000),
    },
  });
  expect(bytes(input)).toBeGreaterThan(MEMO_METADATA_MAX_BYTES);
  const metadata = studentMcpQuestionMetadata(input);
  expect(() => assertStudentMcpQuestionMetadata(input)).not.toThrow();
  expect(metadata).toMatchObject({
    question: {
      id: "q-1",
      questionRevisionId: data.question.questionRevisionId,
      matchingOptions: { options: [{ id: "opt-1" }] },
      orderingItems: [{ id: "it-1", fixedPosition: null }],
    },
    materials: [{ id: "mat-1", title: "材料标题", sourceVersion: 1 }],
    currentAnswer: { kind: "response" },
    context: input.context,
    submission: input.submission,
  });
  expect(JSON.stringify(metadata)).not.toContain(large);
});

it.each([
  { kind: "judge", value: large },
  { kind: "fill", values: [large] },
  { kind: "final", finalAnswer: large },
] satisfies StudentAnswer[])("$kind本人自由正文不计元数据", (answer) => {
  expect(() =>
    assertStudentMcpQuestionMetadata({ ...data, currentAnswer: answer }),
  ).not.toThrow();
});

it.each([
  { kind: "matching", pairs: { [large]: large } },
  { kind: "ordering", sequence: [large] },
  { kind: "multi", indexes: Array.from({ length: 40_000 }, () => 1) },
] satisfies StudentAnswer[])(
  "$kind答案中的ID/编号不冒充大正文豁免",
  (answer) => {
    expect(() =>
      assertStudentMcpQuestionMetadata({ ...data, currentAnswer: answer }),
    ).toThrowError(expect.objectContaining(tooLarge));
  },
);

it("材料标题和图片来源/MIME/真实size都累计", () => {
  expect(() =>
    assertStudentMcpQuestionMetadata({
      ...data,
      materials: [
        { id: "mat-1", title: large, sourceVersion: 1, contentMd: "小正文" },
      ],
    }),
  ).toThrowError(expect.objectContaining(tooLarge));
  expect(() =>
    assertStudentMcpQuestionMetadata({
      ...data,
      images: Array.from({ length: 800 }, (_, index) => ({
        src: `blobs/media/${index.toString(16).padStart(64, "0")}.png`,
        mimeType: "image/png",
        byteSize: 76,
      })),
    }),
  ).toThrowError(expect.objectContaining(tooLarge));
});

it("未来新增元字段默认累计，不因当前白名单遗漏而放过", () => {
  for (const input of [
    { ...data, futureMetadata: large },
    { ...data, question: { ...data.question, futureMetadata: large } },
    {
      ...data,
      currentAnswer: {
        kind: "response" as const,
        body: "正文",
        futureMetadata: large,
      },
    },
  ]) {
    expect(() => assertStudentMcpQuestionMetadata(input)).toThrowError(
      expect.objectContaining(tooLarge),
    );
  }
  if (!data.submission.available) throw new Error("夹具缺少真实准备参数");
  const parameters = { ...data.submission.parameters, futureMetadata: large };
  expect(() =>
    assertStudentMcpQuestionMetadata({
      ...data,
      submission: { available: true, parameters },
    }),
  ).toThrowError(expect.objectContaining(tooLarge));
});

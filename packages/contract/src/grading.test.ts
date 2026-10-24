import { describe, expect, it } from "vitest";
import {
  choiceStudentAnswerSchema,
  fillStudentAnswerSchema,
  handwrittenStudentAnswerSchema,
  judgeStudentAnswerSchema,
  multiStudentAnswerSchema,
  RESPONSE_BODY_MAX_CHARS,
  RESPONSE_TITLE_MAX_CHARS,
  responseStudentAnswerSchema,
  studentAnswerSchema,
} from "./grading";

describe("StudentAnswer：各题型学生答案（T2.5）", () => {
  it("判断题：布尔为标准形态，字符串写法（旧版 §5 全集）同样可解析", () => {
    expect(
      judgeStudentAnswerSchema.safeParse({ kind: "judge", value: true })
        .success,
    ).toBe(true);
    expect(
      judgeStudentAnswerSchema.safeParse({ kind: "judge", value: false })
        .success,
    ).toBe(true);
    // 旧版判断题写法：对/错/√/×/T/F/TRUE/FALSE/是/否 等，判分时归一化
    expect(
      judgeStudentAnswerSchema.safeParse({ kind: "judge", value: "对" })
        .success,
    ).toBe(true);
    expect(
      judgeStudentAnswerSchema.safeParse({ kind: "judge", value: "×" }).success,
    ).toBe(true);
    expect(
      judgeStudentAnswerSchema.safeParse({ kind: "judge", value: "" }).success,
    ).toBe(true);
  });

  it("判断题：value 缺省或数字等其他类型被拒绝", () => {
    expect(judgeStudentAnswerSchema.safeParse({ kind: "judge" }).success).toBe(
      false,
    );
    expect(
      judgeStudentAnswerSchema.safeParse({ kind: "judge", value: 1 }).success,
    ).toBe(false);
  });

  it("单选：index 为 0 起非负整数（与 choiceAnswersSchema.index 同口径）", () => {
    expect(
      choiceStudentAnswerSchema.safeParse({ kind: "choice", index: 0 }).success,
    ).toBe(true);
    expect(
      choiceStudentAnswerSchema.safeParse({ kind: "choice", index: 3 }).success,
    ).toBe(true);
    expect(
      choiceStudentAnswerSchema.safeParse({ kind: "choice", index: -1 })
        .success,
    ).toBe(false);
    expect(
      choiceStudentAnswerSchema.safeParse({ kind: "choice", index: 1.5 })
        .success,
    ).toBe(false);
  });

  it("多选：indexes 为下标集合，允许空数组（未选）", () => {
    expect(
      multiStudentAnswerSchema.safeParse({ kind: "multi", indexes: [0, 2] })
        .success,
    ).toBe(true);
    expect(
      multiStudentAnswerSchema.safeParse({ kind: "multi", indexes: [] })
        .success,
    ).toBe(true);
    expect(
      multiStudentAnswerSchema.safeParse({ kind: "multi", indexes: [-1] })
        .success,
    ).toBe(false);
  });

  it("填空：values 按空序，元素允许空串（空着交卷）", () => {
    expect(
      fillStudentAnswerSchema.safeParse({ kind: "fill", values: ["4", "-7"] })
        .success,
    ).toBe(true);
    expect(
      fillStudentAnswerSchema.safeParse({ kind: "fill", values: [""] }).success,
    ).toBe(true);
    expect(
      fillStudentAnswerSchema.safeParse({ kind: "fill", values: [] }).success,
    ).toBe(true);
    expect(
      fillStudentAnswerSchema.safeParse({ kind: "fill", values: [3] }).success,
    ).toBe(false);
  });

  it("手写题最终答案：finalAnswer 允许空串（未填 → 判 null 进待批）", () => {
    expect(
      handwrittenStudentAnswerSchema.safeParse({
        kind: "final",
        finalAnswer: "-3",
      }).success,
    ).toBe(true);
    expect(
      handwrittenStudentAnswerSchema.safeParse({
        kind: "final",
        finalAnswer: "",
      }).success,
    ).toBe(true);
    expect(
      handwrittenStudentAnswerSchema.safeParse({ kind: "final" }).success,
    ).toBe(false);
  });

  it("response：title 可缺省、body 允许空串（仅手写作答合法）；标题/正文各有防御性字符上限（拒绝不截断，QM-09）", () => {
    expect(
      responseStudentAnswerSchema.safeParse({ kind: "response", body: "" })
        .success,
    ).toBe(true);
    expect(
      responseStudentAnswerSchema.safeParse({
        kind: "response",
        title: "分歧是治理的起点",
        body: "第一段……\n\n第二段……",
      }).success,
    ).toBe(true);
    // 上限内长文不截断可保存（5 万字符量级，远超任何作文题）
    expect(
      responseStudentAnswerSchema.safeParse({
        kind: "response",
        body: "字".repeat(RESPONSE_BODY_MAX_CHARS),
      }).success,
    ).toBe(true);
    // 超限拒绝（保存与提交同码走 VALIDATION_ERROR，不在任何一层截断长文）
    expect(
      responseStudentAnswerSchema.safeParse({
        kind: "response",
        body: "字".repeat(RESPONSE_BODY_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(
      responseStudentAnswerSchema.safeParse({
        kind: "response",
        title: "题".repeat(RESPONSE_TITLE_MAX_CHARS + 1),
        body: "正文",
      }).success,
    ).toBe(false);
    expect(
      responseStudentAnswerSchema.safeParse({ kind: "response" }).success,
    ).toBe(false);
  });

  it("判别联合：五种 kind 可解析，未知 kind 被拒绝", () => {
    expect(
      studentAnswerSchema.safeParse({ kind: "judge", value: true }).success,
    ).toBe(true);
    expect(
      studentAnswerSchema.safeParse({ kind: "choice", index: 1 }).success,
    ).toBe(true);
    expect(
      studentAnswerSchema.safeParse({ kind: "multi", indexes: [0] }).success,
    ).toBe(true);
    expect(
      studentAnswerSchema.safeParse({ kind: "fill", values: ["1/2"] }).success,
    ).toBe(true);
    expect(
      studentAnswerSchema.safeParse({ kind: "final", finalAnswer: "1.4" })
        .success,
    ).toBe(true);
    expect(
      studentAnswerSchema.safeParse({ kind: "essay", text: "…" }).success,
    ).toBe(false);
  });
});

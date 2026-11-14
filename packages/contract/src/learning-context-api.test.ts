import { expect, it } from "vitest";
import { learningContextRequestSchema } from "./learning-context-api";
import { lessonQuestionIdsInDisplayOrder } from "./lesson-question-order";
import { studentMcpLiveFocusRequestSchema } from "./student-mcp-live-focus";

it("读取来源不接受伪造节id，未知事实必须省略", () => {
  expect(
    learningContextRequestSchema.safeParse({
      kind: "lecture",
      lectureId: "lecture",
      sectionId: "guessed-0",
    }).success,
  ).toBe(false);
  expect(
    learningContextRequestSchema.safeParse({
      kind: "lecture",
      lectureId: "lecture",
      sectionId: null,
    }).success,
  ).toBe(true);
});
it("DSL id不被80/512任意长度截断，未知阶段字段拒绝", () => {
  const questionId = "题".repeat(1000);
  const target = {
    kind: "question",
    attemptId: crypto.randomUUID(),
    questionId,
    surface: "attempt",
  };
  expect(learningContextRequestSchema.parse(target)).toEqual(target);
  expect(
    learningContextRequestSchema.safeParse({ ...target, phase: "active" })
      .success,
  ).toBe(false);
  expect(
    studentMcpLiveFocusRequestSchema.parse({
      generation: "a".repeat(64),
      viewId: crypto.randomUUID(),
      sequence: 1,
      questionId: "q".repeat(700),
    }).questionId,
  ).toHaveLength(700);
});
it("讲练正文首现去重，不存在引用跳过，真实孤儿题留在末尾", () => {
  expect(
    lessonQuestionIdsInDisplayOrder(
      [
        { type: "md" },
        { type: "question", questionId: "q2" },
        { type: "question", questionId: "q2" },
        { type: "question", questionId: "missing" },
      ],
      ["q1", "q2", "q3"],
    ),
  ).toEqual(["q2", "q1", "q3"]);
});

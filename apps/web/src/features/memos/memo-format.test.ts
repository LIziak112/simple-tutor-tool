import { afterEach, describe, expect, it } from "vitest";
import {
  clearLearningFocus,
  getLearningFocus,
  publishLearningFocus,
  resetLearningFocusForTest,
} from "./learning-focus-store";
import {
  memoAnchorHref,
  memoAnchorLabel,
  splitMemoTagInput,
} from "./memo-format";

/** 随笔界面小工具与「我现在在哪」存储的纯逻辑测试 */

describe("memo-format", () => {
  it("锚的文字与回链：题 → 作答页带 q；讲义 → 讲义页；无锚 → null", () => {
    const question = {
      kind: "question" as const,
      attemptId: "a1",
      questionId: "q 3",
      label: "第 3 题",
    };
    expect(memoAnchorLabel(question)).toBe("第 3 题");
    expect(memoAnchorHref(question)).toBe("/s/attempts/a1?q=q%203");
    const lecture = {
      kind: "lecture" as const,
      lectureId: "l1",
      sectionId: null,
      label: "第二讲",
    };
    expect(memoAnchorLabel(lecture)).toBe("第二讲");
    expect(memoAnchorHref(lecture)).toBe("/s/lectures/l1");
    expect(memoAnchorLabel({ kind: "none" })).toBeNull();
    expect(memoAnchorHref({ kind: "none" })).toBeNull();
  });

  it("标签输入按逗号 / 空格 / 顿号切分并去重", () => {
    expect(splitMemoTagInput("易错, 疑问，待办、易错  疑问")).toEqual([
      "易错",
      "疑问",
      "待办",
    ]);
    expect(splitMemoTagInput("   ")).toEqual([]);
  });
});

describe("learning-focus-store", () => {
  afterEach(() => resetLearningFocusForTest());

  it("发布 / 清除：只清自己发布的那个锚", () => {
    const a = {
      kind: "question" as const,
      attemptId: "a",
      questionId: "1",
      label: "第 1 题",
    };
    const b = { ...a, questionId: "2", label: "第 2 题" };
    publishLearningFocus(a);
    expect(getLearningFocus()).toEqual(a);
    publishLearningFocus(b);
    clearLearningFocus(a);
    expect(getLearningFocus()).toEqual(b);
    clearLearningFocus(b);
    expect(getLearningFocus()).toEqual({ kind: "none" });
  });
});

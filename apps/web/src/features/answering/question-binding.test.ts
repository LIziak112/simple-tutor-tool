import type { QuestionType } from "@tutor/contract";
import {
  HANDWRITTEN_QUESTION_TYPES,
  questionEvidenceBindings,
  questionTypeSchema,
} from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { HANDWRITTEN_TYPES } from "../attempt/answer-format";
import { questionBindings } from "./question-binding";

/**
 * 题型绑定测试（方案 §4.1，UA-02）：
 * - 七题型穷尽绑定（keys ≡ questionTypeSchema 枚举）；
 * - answerKind / paperRole 从 contract questionEvidenceBindings 派生（逐项相等，
 *   锁「不得复制字面量成第二真相」）；
 * - web HANDWRITTEN_TYPES 兼容入口与 paperRole 派生集、contract 派生集三方一致；
 * - placement 值与 §4.1 表逐行一致（仅属 web 的本地真相）。
 */

const ALL_TYPES = questionTypeSchema.options as readonly QuestionType[];

describe("questionBindings（题型绑定，§4.1）", () => {
  it("七题型穷尽：键集 ≡ questionTypeSchema 枚举（编译期 satisfies + 运行期核对）", () => {
    expect([...Object.keys(questionBindings)].sort()).toEqual(
      [...ALL_TYPES].sort(),
    );
  });

  it("answerKind / paperRole 逐项来自 contract questionEvidenceBindings（单源派生）", () => {
    for (const type of ALL_TYPES) {
      expect(questionBindings[type].answerKind).toBe(
        questionEvidenceBindings[type].answerKind,
      );
      expect(questionBindings[type].paperRole).toBe(
        questionEvidenceBindings[type].paperRole,
      );
    }
  });

  it("placement 与 §4.1 表逐行一致（仅属 web 的本地真相；新三型 TT-05a 定 §5.7.2 表，控件 TT-08 接入）", () => {
    expect(questionBindings.judge.placement).toBe("judge-buttons");
    expect(questionBindings.choice.placement).toBe("options-radio");
    expect(questionBindings.multi.placement).toBe("options-checkbox");
    expect(questionBindings.fill.placement).toBe("inline-slots");
    expect(questionBindings.solve.placement).toBe("handwritten-final");
    expect(questionBindings.apply.placement).toBe("handwritten-final");
    expect(questionBindings["find-error"].placement).toBe("handwritten-final");
    expect(questionBindings.response.placement).toBe("text-below-stem");
    expect(questionBindings.matching.placement).toBe("match-controls");
    expect(questionBindings.ordering.placement).toBe("order-controls");
  });

  it("web HANDWRITTEN_TYPES ≡ paperRole=answerInk 派生集 ≡ contract 派生集（三方一致；response 自 TT-05a 新进集合，D14 预期新增）", () => {
    const byPaperRole = new Set(
      ALL_TYPES.filter(
        (type) => questionBindings[type].paperRole === "answerInk",
      ),
    );
    expect([...byPaperRole].sort()).toEqual([
      "apply",
      "find-error",
      "response",
      "solve",
    ]);
    expect(HANDWRITTEN_TYPES).toEqual(byPaperRole);
    expect(HANDWRITTEN_TYPES).toEqual(new Set(HANDWRITTEN_QUESTION_TYPES));
  });
});

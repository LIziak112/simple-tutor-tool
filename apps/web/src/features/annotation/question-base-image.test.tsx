import type { AttemptQuestionPublic } from "@tutor/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderQuestionBaseImage } from "./question-base-image";

const question: AttemptQuestionPublic = {
  id: "q",
  questionRevisionId: "r1",
  type: "fill",
  stemMd: "甲 [[]]，乙 [[]]",
  difficulty: 1,
  knowledge: [],
  hintCount: 0,
};
afterEach(() => vi.restoreAllMocks());
describe("新题面底图准入", () => {
  it("拒绝未脱敏题面和选项，不创建离屏宿主", async () => {
    const reference = document.createElement("div");
    for (const unsafe of [
      { ...question, stemMd: "答案 [[秘密]]" },
      { ...question, type: "choice" as const, options: ["[[秘密]]"] },
    ]) {
      await expect(renderQuestionBaseImage(unsafe, reference)).rejects.toThrow(
        "答案标记",
      );
    }
    expect(
      document.querySelector('[data-slot="question-base-host"]'),
    ).toBeNull();
  });
  it("不可见题面和超宽题面不允许生成底图", async () => {
    const reference = document.createElement("div");
    await expect(renderQuestionBaseImage(question, reference)).rejects.toThrow(
      "题面尚未就绪",
    );
    vi.spyOn(reference, "getBoundingClientRect").mockReturnValue({
      width: 2200,
      height: 100,
    } as DOMRect);
    await expect(renderQuestionBaseImage(question, reference)).rejects.toThrow(
      "尺寸超限",
    );
  });
});

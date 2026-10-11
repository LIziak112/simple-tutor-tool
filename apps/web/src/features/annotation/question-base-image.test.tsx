import {
  ANNOTATION_SURFACE_PIXEL_RATIO,
  ANNOTATION_SURFACE_RENDER_VERSION,
  type AttemptQuestionPublic,
} from "@tutor/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  measureQuestionSurface,
  questionSurfaceMatchesLayout,
  renderQuestionBaseImage,
} from "./question-base-image";

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
  it("编辑覆盖层不参与题面签名，不能改变准入几何", () => {
    const reference = document.createElement("div");
    reference.innerHTML =
      '<p>题干</p><div data-slot="question-annotation-overlay"><canvas></canvas></div>';
    expect(
      measureQuestionSurface(reference).blocks.map((block) => block.tag),
    ).toEqual(["DIV", "P"]);
  });
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
  it("crypto.subtle 缺失（HTTP 部署非安全上下文）时匹配校验不抛错", async () => {
    // 回归锁：曾裸调 crypto.subtle.digest，http://IP 部署下打开圈画层
    // 即抛 TypeError（2026-10 修复）。藏 subtle 模拟非安全上下文。
    const cryptoObject = crypto as { subtle?: unknown };
    const own = Object.getOwnPropertyDescriptor(cryptoObject, "subtle");
    Object.defineProperty(cryptoObject, "subtle", {
      configurable: true,
      value: undefined,
    });
    try {
      // 自证藏属性生效：否则走 SHA-256 路径同样返回 false，测不到降级分支
      expect((cryptoObject as { subtle?: unknown }).subtle).toBeUndefined();
      const reference = document.createElement("div");
      vi.spyOn(reference, "getBoundingClientRect").mockReturnValue({
        width: 300,
        height: 200,
      } as DOMRect);
      const matches = await questionSurfaceMatchesLayout(question, reference, {
        renderVersion: ANNOTATION_SURFACE_RENDER_VERSION,
        questionRevisionId: question.questionRevisionId,
        cssWidth: 300,
        cssHeight: 200,
        pixelRatio: ANNOTATION_SURFACE_PIXEL_RATIO,
        styleVersion: 1,
        contentSignature: "a".repeat(64),
        geometrySignature: "b".repeat(64),
        fontSignature: "c".repeat(64),
      });
      expect(matches).toBe(false);
    } finally {
      if (own) Object.defineProperty(cryptoObject, "subtle", own);
      else delete cryptoObject.subtle;
    }
  });
});

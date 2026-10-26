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
  it("固定题面整体缩放后仍以逻辑坐标测量，不能把缩放当成重排", () => {
    const frame = document.createElement("div");
    frame.dataset.annotationScale = "0.5";
    const reference = document.createElement("div");
    const paragraph = document.createElement("p");
    frame.append(reference);
    reference.append(paragraph);
    vi.spyOn(reference, "getBoundingClientRect").mockReturnValue({
      left: 20,
      top: 30,
      width: 300,
      height: 100,
    } as DOMRect);
    vi.spyOn(paragraph, "getBoundingClientRect").mockReturnValue({
      left: 30,
      top: 40,
      width: 200,
      height: 40,
    } as DOMRect);
    expect(measureQuestionSurface(reference)).toMatchObject({
      cssWidth: 600,
      cssHeight: 200,
      blocks: [
        { tag: "DIV", x: 0, y: 0, width: 600, height: 200 },
        { tag: "P", x: 20, y: 20, width: 400, height: 80 },
      ],
    });
  });
  it("编辑覆盖层不参与题面签名，不能改变准入几何", () => {
    const reference = document.createElement("div");
    reference.innerHTML =
      '<p>题干</p><div data-slot="question-annotation-overlay"><canvas></canvas></div>';
    expect(
      measureQuestionSurface(reference).blocks.map((block) => block.tag),
    ).toEqual(["DIV", "P"]);
  });
  it("LR-5：blocks[].node 采自身或最近 data-lr-node 祖先的键（surface 根恒有 root）", () => {
    const reference = document.createElement("div");
    reference.setAttribute("data-lr-node", "root");
    const paragraph = document.createElement("p");
    paragraph.setAttribute("data-lr-node", "stem/p/0");
    const katex = document.createElement("div");
    katex.className = "katex"; // 公式子块 → 继承最近带键祖先（段落）
    const figure = document.createElement("figure"); // 无自身键 → 继承根 root
    paragraph.append(katex);
    reference.append(paragraph, figure);
    const blocks = measureQuestionSurface(reference).blocks;
    const nodeOf = (tag: string) => blocks.find((b) => b.tag === tag)?.node;
    expect(nodeOf("DIV")).toBe("root");
    expect(nodeOf("P")).toBe("stem/p/0");
    expect(nodeOf("FIGURE")).toBe("root");
    // 公式子块继承段落键（surface 根是其上方第一个 DIV，公式是第二个）
    expect(blocks.filter((b) => b.tag === "DIV")[1]?.node).toBe("stem/p/0");
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

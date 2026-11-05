import {
  ANNOTATION_SURFACE_PIXEL_RATIO,
  ANNOTATION_SURFACE_RENDER_VERSION,
  type AttemptQuestionPublic,
  stableContentHash64,
} from "@tutor/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureFrozenControls } from "@/features/answering";
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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("新题面底图准入", () => {
  it("填空槽位来自导出副本同一次布局框，缺槽位或错位不得推测位置", () => {
    const exported = document.createElement("div");
    const first = document.createElement("input");
    const second = document.createElement("input");
    first.dataset.answerSlotId = "slot-1";
    second.dataset.answerSlotId = "slot-2";
    exported.append(first, second);
    vi.spyOn(exported, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 200,
      width: 300,
      height: 160,
    } as DOMRect);
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue({
      left: 112,
      top: 220,
      width: 112,
      height: 44,
    } as DOMRect);
    vi.spyOn(second, "getBoundingClientRect").mockReturnValue({
      left: 150,
      top: 260,
      width: 112,
      height: 44,
    } as DOMRect);
    expect(captureFrozenControls(question, exported)).toEqual([
      { slotId: "slot-1", kind: "text", x: 12, y: 20, width: 112, height: 44 },
      { slotId: "slot-2", kind: "text", x: 50, y: 60, width: 112, height: 44 },
    ]);
    second.remove();
    expect(() => captureFrozenControls(question, exported)).toThrow("槽位");
  });
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
  it.each([0.5, 1, 1.25])(
    "逻辑宽高差按 10px 比较，不受显示比例 %s 或 DPR 影响",
    async (scale) => {
      vi.stubGlobal("devicePixelRatio", scale === 0.5 ? 3 : 2);
      const frame = document.createElement("div");
      frame.dataset.annotationScale = String(scale);
      const surface = document.createElement("div");
      frame.append(surface);
      let delta = 0;
      vi.spyOn(surface, "getBoundingClientRect").mockImplementation(
        () => new DOMRect(30, 40, (300 + delta) * scale, (200 + delta) * scale),
      );
      const original = measureQuestionSurface(surface);
      const layout = {
        renderVersion: 2 as const,
        questionRevisionId: question.questionRevisionId,
        cssWidth: 300,
        cssHeight: 200,
        pixelRatio: 2 as const,
        styleVersion: 1 as const,
        contentSignature: "a".repeat(64),
        geometrySignature: "b".repeat(64),
        fontSignature: "c".repeat(64),
        compatibility: {
          version: 1 as const,
          contentSignature: stableContentHash64({
            type: question.type,
            stemMd: question.stemMd,
            options: [],
          }),
          blocks: original.blocks,
          fonts: original.fonts,
          textRects: original.textRects,
        },
      };
      for (const nextDelta of [0, 2, 9.999, 10, 10.001, -2, -10, -10.001]) {
        delta = nextDelta;
        await expect(
          questionSurfaceMatchesLayout(question, surface, layout),
        ).resolves.toBe(Math.abs(delta) <= 10);
      }
      expect(layout.cssWidth).toBe(300);
      expect(layout.compatibility.blocks).toEqual(original.blocks);
      delta = 0;
      await expect(
        questionSurfaceMatchesLayout(
          { ...question, stemMd: "另一公开题面" },
          surface,
          layout,
        ),
      ).resolves.toBe(false);
      await expect(
        questionSurfaceMatchesLayout(
          { ...question, questionRevisionId: "other" },
          surface,
          layout,
        ),
      ).resolves.toBe(false);
    },
  );
  it("块偏移 10.001px 不能被历史 1/64px 签名取整吞掉", async () => {
    const surface = document.createElement("div");
    const paragraph = document.createElement("p");
    paragraph.dataset.lrNode = "stem/p/0";
    surface.append(paragraph);
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 300, 200),
    );
    let delta = 0;
    vi.spyOn(paragraph, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(20 + delta, 20, 100, 28),
    );
    const original = measureQuestionSurface(surface);
    const layout = {
      renderVersion: 2 as const,
      questionRevisionId: question.questionRevisionId,
      cssWidth: 300,
      cssHeight: 200,
      pixelRatio: 2 as const,
      styleVersion: 1 as const,
      contentSignature: "a".repeat(64),
      geometrySignature: "b".repeat(64),
      fontSignature: "c".repeat(64),
      compatibility: {
        version: 1 as const,
        contentSignature: stableContentHash64({
          type: question.type,
          stemMd: question.stemMd,
          options: [],
        }),
        blocks: original.blocks,
        fonts: original.fonts,
        textRects: [],
      },
    };
    delta = 10;
    await expect(
      questionSurfaceMatchesLayout(question, surface, layout),
    ).resolves.toBe(true);
    delta = 10.001;
    await expect(
      questionSurfaceMatchesLayout(question, surface, layout),
    ).resolves.toBe(false);
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

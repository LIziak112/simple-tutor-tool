import type {
  AttemptContextData,
  AttemptContextMaterial,
} from "@tutor/contract";
import { afterEach, describe, expect, it, vi } from "vitest";

// P3-6 形态 ② 用例的栅格化边界 mock（html-to-image 属浏览器链路，此处测
// 我方流程逻辑：先量高再决定整篇/分块，超限内容永不进 toBlob）
const toBlobMock = vi.hoisted(() =>
  vi.fn(
    async (target: HTMLElement) =>
      new Blob([target.textContent ?? ""], { type: "image/png" }),
  ),
);
vi.mock("html-to-image", () => ({
  toBlob: (target: HTMLElement) => toBlobMock(target),
}));

import {
  exportMaterialsOfQuestion,
  splitMaterialBlocks,
} from "./material-export-pages";

/**
 * 导出材料闭包纯函数测试（QM-16 细项 1）：组内题收组材料全部版本、
 * 组外题零材料、字母编号、版本徽标、槽位编号正文。渲染栅格化属浏览器
 * 链路（html-to-image），由 e2e/真机覆盖，不在 jsdom 单测伪造；
 * 分块/分页纯函数（P3-6 形态 ①②）在本文件覆盖。
 */

function material(
  id: string,
  version: number,
  content: string,
  title?: string,
): AttemptContextMaterial & { id: string; sourceVersion: number } {
  return {
    id,
    sourceVersion: version,
    ...(title !== undefined ? { title } : {}),
    contentMd: content,
    anchors: [],
    slots: [{ id: `${id}-s1`, slotKind: "match", order: 0 }],
    mediaPaths: [],
  };
}

describe("exportMaterialsOfQuestion（导出材料闭包）", () => {
  const context: AttemptContextData = {
    attemptId: "a-1",
    materials: [
      material("m-1", 1, "Passage with {{m-1-s1}}.", "阅读材料"),
      material("m-1", 2, "第二版 {{m-1-s1}}。", "阅读材料"),
      material("m-2", 1, "独立材料，组未引用。"),
    ],
    groups: [
      {
        id: "g-1",
        sourceVersion: 1,
        title: "组",
        introMd: "",
        materialRefs: [{ material: "m-1" }, { material: "m-1" }],
        questionIds: ["q-1", "q-2"],
      },
    ],
  };

  it("组内题：组引用材料全部版本（引用序去重、版本键不塌缩）、字母编号、版本徽标、槽位编号", () => {
    const materials = exportMaterialsOfQuestion(context, "q-1");
    expect(materials).toHaveLength(2);
    expect(materials[0]).toMatchObject({
      letter: "A",
      label: "阅读材料（历史版本 1）",
    });
    expect(materials[0]?.contentMd).toBe("Passage with **（1）**.");
    expect(materials[1]).toMatchObject({
      letter: "B",
      label: "阅读材料（历史版本 2）",
    });
    expect(materials[1]?.contentMd).toBe("第二版 **（1）**。");
  });

  it("组外题零材料（不携带无关材料）；题级引用随学生投影并入闭包（审查 P2-2：与服务端组∪题级同源）", () => {
    expect(exportMaterialsOfQuestion(context, "q-9")).toEqual([]);
    // 题级引用（无组）也进闭包——多材料题正文引用的材料随题导出
    const withQuestionRefs = exportMaterialsOfQuestion(context, "q-3", [
      { material: "m-2" },
    ]);
    expect(withQuestionRefs).toHaveLength(1);
    expect(withQuestionRefs[0]).toMatchObject({
      letter: "A",
      label: "材料",
    });
    expect(withQuestionRefs[0]?.contentMd).toBe("独立材料，组未引用。");
  });

  it("组引用 ∪ 题级引用去重；编号口径与服务端闭包对齐（审查 P3-2：(id, sourceVersion) 稳定序）", () => {
    // 组引用顺序（m-2 先、m-1 后）与 id 稳定序（m-1 < m-2）相反——字母编号
    // 必须按服务端 frozenMaterialsForQuestion 的 (id, sourceVersion) 排序，
    // 两出口（PNG 材料页 / 单题包）字母一致
    const mixed: AttemptContextData = {
      attemptId: "a-3",
      materials: [
        material("m-2", 1, "材料二正文。", "材料二"),
        material("m-1", 1, "材料一 v1 {{m-1-s1}}。", "材料一"),
        material("m-1", 2, "材料一 v2 {{m-1-s1}}。", "材料一"),
      ],
      groups: [
        {
          id: "g-3",
          sourceVersion: 1,
          title: "组",
          introMd: "",
          materialRefs: [{ material: "m-2" }, { material: "m-1" }],
          questionIds: ["q-7"],
        },
      ],
    };
    // 组 ∪ 题级同材料去重（m-1 两版本各一条，不因重复引用翻倍）
    const union = exportMaterialsOfQuestion(mixed, "q-7", [
      { material: "m-1" },
    ]);
    expect(union.map((item) => `${item.letter}:${item.label}`)).toEqual([
      "A:材料一（历史版本 1）",
      "B:材料一（历史版本 2）",
      "C:材料二",
    ]);
    // 仅题级（组外题）零材料口径不回归
    expect(exportMaterialsOfQuestion(mixed, "q-8")).toEqual([]);
  });

  it("无标题材料回落「材料」；未声明槽位标记原样保留", () => {
    const single: AttemptContextData = {
      attemptId: "a-2",
      materials: [
        {
          id: "m-3",
          sourceVersion: 1,
          contentMd: "含未知标记 {{nope}} 的正文。",
          anchors: [],
          slots: [],
          mediaPaths: [],
        },
      ],
      groups: [
        {
          id: "g-2",
          sourceVersion: 1,
          title: "组",
          introMd: "",
          materialRefs: [{ material: "m-3" }],
          questionIds: ["q-5"],
        },
      ],
    };
    const materials = exportMaterialsOfQuestion(single, "q-5");
    expect(materials).toEqual([
      {
        letter: "A",
        label: "材料",
        contentMd: "含未知标记 {{nope}} 的正文。",
      },
    ]);
  });
});

describe("splitMaterialBlocks（P3-6 形态 ①：围栏感知分块）", () => {
  it("普通空行分块保持既有口径（空白行首尾/连续空行不产生空块）", () => {
    expect(splitMaterialBlocks("第一段。\n\n第二段。")).toEqual([
      "第一段。",
      "第二段。",
    ]);
    expect(splitMaterialBlocks("\n\n  \n仅一段。\n\n\n")).toEqual(["仅一段。"]);
    expect(splitMaterialBlocks("")).toEqual([]);
  });

  it("含空行的围栏代码块不被切断（\ns*\n 会切成残开栏+残闭栏）", () => {
    const fenced = "前文段落。\n\n```\ncode a\n\ncode b\n```\n\n后文段落。";
    expect(splitMaterialBlocks(fenced)).toEqual([
      "前文段落。",
      "```\ncode a\n\ncode b\n```",
      "后文段落。",
    ]);
  });

  it("~ 围栏与更长闭栏（同字符长度≥开栏才闭）；带 info 的开栏不误判闭栏", () => {
    expect(splitMaterialBlocks("~~~\na\n\nb\n~~~~~~\n\n后文")).toEqual([
      "~~~\na\n\nb\n~~~~~~",
      "后文",
    ]);
    // ```js 开栏（info string）→ 空行后 ``` 是闭栏
    expect(splitMaterialBlocks("```js\nx\n\n```\n\n后文")).toEqual([
      "```js\nx\n\n```",
      "后文",
    ]);
  });

  it("引用块的 > 续行空行不切段（块整体保留）；未闭合围栏兜底收尾", () => {
    expect(splitMaterialBlocks("> 第一段\n>\n> 第二段\n\n普通段")).toEqual([
      "> 第一段\n>\n> 第二段",
      "普通段",
    ]);
    // 文档结尾未闭合的围栏整体成块（防御：不崩溃不丢内容）
    expect(splitMaterialBlocks("```\nunclosed")).toEqual(["```\nunclosed"]);
  });
});

describe("renderMaterialExportPages 量高路径（P3-6 形态 ②）", () => {
  const ORIGINAL_RECT = Element.prototype.getBoundingClientRect;
  afterEach(() => {
    Element.prototype.getBoundingClientRect = ORIGINAL_RECT;
    toBlobMock.mockClear();
  });

  /** 计划块结构断言的口径材料：三段普通文本 */
  const TALL = ["段落一。", "段落二。", "段落三。"].join("\n\n");

  it("整篇超限（Safari 面积上限形态）：先量高分块，超限整篇永不进 toBlob", async () => {
    const { renderMaterialExportPages } = await import(
      "./material-export-pages"
    );
    // 量高恒超限（css 100000 × dpr 1 > 3600）：每块独立成页
    Element.prototype.getBoundingClientRect = () =>
      ({
        height: 100_000,
        width: 720,
        top: 0,
        left: 0,
        right: 720,
        bottom: 100_000,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const pages = await renderMaterialExportPages([
      { letter: "A", label: "长材料", contentMd: TALL },
    ]);
    expect(pages).toHaveLength(3);
    expect(pages.map((page) => page.label)).toEqual([
      "材料 A：长材料 · 第 1/3 页",
      "材料 A：长材料 · 第 2/3 页",
      "材料 A：长材料 · 第 3/3 页",
    ]);
    // 形态 ② 核心：任何一次栅格化的元素都不是整篇（旧实现首拍必是整篇
    // toBlob，在 Safari canvas 面积上限附近恒 null、重试永远失败）
    for (const call of toBlobMock.mock.calls) {
      const text = call[0]?.textContent ?? "";
      expect(text.includes("段落一")).toBe(text.trim() === "段落一。");
    }
    expect(toBlobMock).toHaveBeenCalledTimes(3);
  });

  it("页高上限内（jsdom 零高度量高）：单页路径只栅格化一次（整篇挂载复用）", async () => {
    const { renderMaterialExportPages } = await import(
      "./material-export-pages"
    );
    const pages = await renderMaterialExportPages([
      { letter: "A", label: "常规材料", contentMd: "单段正文。" },
    ]);
    expect(pages).toEqual([
      { blob: expect.any(Blob), label: "材料 A：常规材料" },
    ]);
    expect(toBlobMock).toHaveBeenCalledTimes(1);
    expect(toBlobMock.mock.calls[0]?.[0]?.textContent).toContain("单段正文。");
  });
});

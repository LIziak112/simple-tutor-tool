import { describe, expect, it } from "vitest";
import {
  anchorKeyForStroke,
  blocksInBaseDomain,
  strokeBbox,
} from "./annotation-anchor";

/**
 * 圈画收笔锚定单测（LR-6，学习记录模型设计稿 §5.3；LR-PR2 验收点
 * 「锚定选择最大重叠块」）：纯几何、jsdom 无关。
 * - 重叠面积最大的带键块胜出（跨块圈选时按重叠量，不是按块序）；
 * - 全不相交取块心最近者；
 * - 无带键块（旧布局 blocks[].node 缺省）→ 不锚（undefined）；
 * - 空笔画不锚。
 */

const BLOCKS = [
  { x: 0, y: 0, width: 200, height: 40, tag: "p", node: "stem/p/0" },
  { x: 0, y: 60, width: 200, height: 40, tag: "p", node: "stem/p/1" },
  { x: 0, y: 120, width: 200, height: 40, tag: "p", node: "stem/p/2" },
];

describe("annotation-anchor（LR-6 收笔锚定）", () => {
  it("strokeBbox：多点取极值；空笔画返回 null", () => {
    const bbox = strokeBbox({
      tool: "pen",
      color: "#000",
      weight: 4,
      points: [
        { x: 30, y: 70, p: 0.5, t: 0 },
        { x: 10, y: 90, p: 0.5, t: 16 },
        { x: 50, y: 65, p: 0.5, t: 32 },
      ],
    });
    expect(bbox).toEqual({ minX: 10, minY: 65, maxX: 50, maxY: 90 });
    expect(
      strokeBbox({ tool: "pen", color: "#000", weight: 4, points: [] }),
    ).toBeNull();
  });

  it("锚定取重叠面积最大的带键块（不是第一个相交块）", () => {
    // 笔画横跨第 2、3 块：与 p/2 重叠 40×20=800 > p/1 的 40×10=400
    const bbox = { minX: 10, minY: 90, maxX: 50, maxY: 140 };
    expect(anchorKeyForStroke(bbox, BLOCKS)).toBe("stem/p/2");
    // 大部分落在第 1 块内
    const bbox1 = { minX: 10, minY: 10, maxX: 50, maxY: 30 };
    expect(anchorKeyForStroke(bbox1, BLOCKS)).toBe("stem/p/0");
  });

  it("圈住选项 label 的笔画锚到 options/option/<n>", () => {
    const optionBlocks = [
      ...BLOCKS,
      {
        x: 0,
        y: 180,
        width: 200,
        height: 44,
        tag: "LABEL",
        node: "options/option/1",
      },
    ];
    const bbox = { minX: 5, minY: 185, maxX: 60, maxY: 215 };
    expect(anchorKeyForStroke(bbox, optionBlocks)).toBe("options/option/1");
  });

  it("全不相交：取块心最近的带键块", () => {
    // 笔画在页眉空白处（y≈50，介于 p/0 底 40 与 p/1 顶 60 之间，不相交）
    const bbox = { minX: 10, minY: 46, maxX: 30, maxY: 54 };
    const key = anchorKeyForStroke(bbox, BLOCKS);
    expect(key === "stem/p/0" || key === "stem/p/1").toBe(true);
  });

  it("无带键块（旧布局）不锚：返回 undefined", () => {
    const legacy = [
      { x: 0, y: 0, width: 200, height: 40, tag: "p" },
      { x: 0, y: 60, width: 200, height: 40, tag: "p" },
    ];
    expect(
      anchorKeyForStroke({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, legacy),
    ).toBeUndefined();
    expect(
      anchorKeyForStroke({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, []),
    ).toBeUndefined();
  });

  it("空笔画（无点）不锚", () => {
    const bbox = strokeBbox({
      tool: "pen",
      color: "#000",
      weight: 4,
      points: [],
    });
    expect(bbox).toBeNull();
  });
});

/**
 * LR-5 域转换测试锁（评审 #11768，PR24 合入前置）：measure 落盘的 blocks 是
 * CSS 像素、笔画包围盒是底图像素（CSS × pixelRatio）——消费方必须先经
 * blocksInBaseDomain 转换；不转换时同一点会锚到错误的块。
 */
describe("blocksInBaseDomain 域转换（PR24 合入前置）", () => {
  it("CSS 块转底图域后锚定正确：y 70→78 锚到 p/0（不转域会错锚 p/1）", () => {
    const cssBlocks = [
      { x: 0, y: 0, width: 720, height: 40, tag: "p", node: "stem/p/0" },
      { x: 0, y: 60, width: 720, height: 40, tag: "p", node: "stem/p/1" },
    ];
    // 底图域笔画点 y 70→78：转域后落在 p/0（base [0,80]）内
    const converted = blocksInBaseDomain(cssBlocks, 2);
    const bbox = { minX: 10, minY: 70, maxX: 30, maxY: 78 };
    expect(anchorKeyForStroke(bbox, converted)).toBe("stem/p/0");
    // 反证：不转域（CSS 块直接消费）时同一点错锚 p/1
    expect(anchorKeyForStroke(bbox, cssBlocks)).toBe("stem/p/1");
  });
});

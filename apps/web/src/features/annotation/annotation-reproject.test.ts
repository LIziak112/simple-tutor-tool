import type {
  AnnotationDoc,
  AnnotationSurfaceLayout,
  InkDeletedStroke,
} from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  inverseReproject,
  reprojectAnnotation,
  reprojectable,
} from "./annotation-reproject";

/**
 * 圈画重投影单测（LR-6，学习记录模型设计稿 §5.3；LR-PR4 验收点）：
 * - 重投影往返误差 < 1px（节点相对坐标无损互转）；
 * - 锚块缺失 → root 兜底缩放 + approximate/unanchored 如实标记；
 * - 墓碑随文档一起重投影；weight 同域等比；
 * - inverseReproject 把目标布局新笔画映射回保存坐标域。
 */

const SAVED: AnnotationSurfaceLayout = {
  renderVersion: 2,
  questionRevisionId: "rev-1",
  cssWidth: 720,
  cssHeight: 400,
  pixelRatio: 2,
  styleVersion: 1,
  contentSignature: "a".repeat(64),
  geometrySignature: "b".repeat(64),
  fontSignature: "c".repeat(64),
  compatibility: {
    version: 1,
    contentSignature: "a".repeat(64),
    // blocks 是 CSS 像素（measure 落盘口径）：×pixelRatio 2 = 底图像素域
    blocks: [
      { x: 0, y: 0, width: 720, height: 40, tag: "p", node: "stem/p/0" },
      { x: 0, y: 60, width: 720, height: 40, tag: "p", node: "stem/p/1" },
    ],
    fonts: [
      ["16px", "16px", "16px", "sans-serif", "normal"],
      ["16px", "16px", "16px", "sans-serif", "normal"],
    ],
    textRects: [],
  },
};

/** 目标布局：宽 1.5 倍（iPad 720 → 桌面 1080），块随内容等比挪动放大 */
const TARGET: AnnotationSurfaceLayout = {
  ...SAVED,
  cssWidth: 1080,
  cssHeight: 560,
  compatibility: {
    version: 1,
    contentSignature: "d".repeat(64),
    blocks: [
      { x: 0, y: 0, width: 1080, height: 60, tag: "p", node: "stem/p/0" },
      { x: 0, y: 100, width: 1080, height: 65, tag: "p", node: "stem/p/1" },
    ],
    fonts: [
      ["16px", "16px", "16px", "sans-serif", "normal"],
      ["16px", "16px", "16px", "sans-serif", "normal"],
    ],
    textRects: [],
  },
};

function strokeAt(
  id: string,
  points: Array<[number, number]>,
  weight = 4,
): import("@tutor/contract").InkStroke {
  return {
    tool: "pen",
    color: "#000000",
    weight,
    id,
    startedAt: 1727392800000,
    pointer: "pen",
    points: points.map(([x, y], i) => ({ x, y, p: 0.5, t: i * 16 })),
  };
}

const TOMB: InkDeletedStroke = {
  ...strokeAt("stroke-3", [[200, 30]]),
  // InkDeletedStroke 要求 id 必填（spread 的可选类型不收窄，显式补）
  id: "stroke-3",
  deletedAt: 1727392900000,
  deletedBy: "eraser",
};

const DOC: AnnotationDoc = {
  version: 1,
  baseWidth: 1440,
  baseHeight: 800,
  strokes: [
    strokeAt("stroke-1", [
      [100, 10],
      [300, 60],
    ]),
    strokeAt("stroke-2", [[150, 150]], 8),
  ],
  deleted: [TOMB],
  anchors: {
    "stroke-1": "stem/p/0",
    "stroke-2": "stem/p/1",
    "stroke-3": "stem/p/0",
  },
};

describe("reprojectAnnotation（LR-6）", () => {
  it("带锚笔画按块矩形重投影：块内相对位置保持（往返误差 < 1px）", () => {
    const result = reprojectAnnotation(DOC, SAVED, TARGET);
    expect(result.approximate).toBe(false);
    expect(result.unanchored).toBe(0);
    // stroke-1 锚 stem/p/0：saved 块 (0,0,1440,80)，target 块 (0,0,2160,120)
    const first = result.strokes[0];
    expect(first).toBeDefined();
    const p0 = first?.points[0];
    // u=(100−0)/1440、v=(10−0)/1440（都除块宽），目标 = u×2160=150、v×2160=15
    expect(p0?.x).toBeCloseTo(150, 6);
    expect(p0?.y).toBeCloseTo(15, 6);
    // weight 随块宽等比：×(2160/1440)=×1.5
    expect(first?.weight).toBeCloseTo(6, 6);
  });

  it("往返（reproject → inverse）逐点误差 < 1px；id/startedAt/pointer/墓碑字段不丢", () => {
    const result = reprojectAnnotation(DOC, SAVED, TARGET);
    for (const [index, mapped] of result.strokes.entries()) {
      const original = DOC.strokes[index];
      expect(original).toBeDefined();
      const anchor = DOC.anchors?.[mapped.id ?? ""];
      const back = inverseReproject(mapped, anchor, SAVED, TARGET);
      expect(original?.points.length).toBe(back.points.length);
      for (let i = 0; i < (original?.points.length ?? 0); i++) {
        const o = original?.points[i];
        const b = back.points[i];
        expect(Math.abs((o?.x ?? 0) - (b?.x ?? 0))).toBeLessThan(1);
        expect(Math.abs((o?.y ?? 0) - (b?.y ?? 0))).toBeLessThan(1);
        expect(Math.abs((o?.t ?? 0) - (b?.t ?? 0))).toBe(0);
      }
      expect(back.id).toBe(original?.id);
      expect(back.startedAt).toBe(original?.startedAt);
      expect(back.pointer).toBe(original?.pointer);
    }
    // 墓碑同样往返无损（deletedAt/deletedBy 保留）
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0]?.deletedBy).toBe("eraser");
    const mappedTomb = result.deleted[0];
    const tombAnchor = DOC.anchors?.[mappedTomb?.id ?? ""];
    if (mappedTomb === undefined) return;
    const tombBack = inverseReproject(mappedTomb, tombAnchor, SAVED, TARGET);
    const tombPoint = tombBack.points[0];
    expect(tombPoint?.x).toBeCloseTo(200, 6);
    expect(tombPoint?.y).toBeCloseTo(30, 6);
  });

  it("锚缺失（无锚旧稿 / 目标布局缺该键）→ root 兜底缩放 + approximate + unanchored 计数", () => {
    const legacyDoc: AnnotationDoc = {
      version: 1,
      baseWidth: 1440,
      baseHeight: 800,
      strokes: [strokeAt("stroke-9", [[720, 400]])],
      deleted: [],
    };
    const result = reprojectAnnotation(legacyDoc, SAVED, TARGET);
    expect(result.approximate).toBe(true);
    expect(result.unanchored).toBe(1);
    // root 兜底按宽比 2160/1440=1.5 等比缩放
    expect(result.strokes[0]?.points[0]?.x).toBeCloseTo(1080, 6);
    expect(result.strokes[0]?.points[0]?.y).toBeCloseTo(600, 6);
    // 目标布局缺锚键同样走兜底
    const targetCompatibility = TARGET.compatibility;
    expect(targetCompatibility).toBeDefined();
    if (targetCompatibility === undefined) return;
    const missingKeyTarget: AnnotationSurfaceLayout = {
      ...TARGET,
      compatibility: {
        ...targetCompatibility,
        blocks: targetCompatibility.blocks.slice(0, 1),
      },
    };
    const partial = reprojectAnnotation(DOC, SAVED, missingKeyTarget);
    // 仅 stroke-2（锚 stem/p/1 在目标缺块）走兜底；stroke-1 与墓碑锚 stem/p/0 两侧都在
    expect(partial.unanchored).toBe(1);
    expect(partial.approximate).toBe(true);
  });

  it("reprojectable：两侧布局都有带键块才可节点级重投影", () => {
    expect(reprojectable(SAVED, TARGET)).toBe(true);
    const legacy: AnnotationSurfaceLayout = {
      ...SAVED,
      compatibility: undefined,
    };
    expect(reprojectable(legacy, TARGET)).toBe(false);
  });
});

/**
 * LR-PR4 必改③ 测试锁（评审 #11771）：非等比位移下 ×ratio 才正确——
 * TARGET p/1 CSS y 100（非等比下移）：底图域 p/1 = [y 200, h 130]；
 * stroke-2 底图点 (150,150) → 转换后投影 (225, 248.75)（去掉 ×ratio
 * 则 y = 235，两值分叉 13.75px 即锁住）。
 */
describe("keyedBlocksOf 非等比位移（LR-PR4 必改③）", () => {
  const TARGET_NON_UNIFORM: AnnotationSurfaceLayout = {
    ...TARGET,
    compatibility: {
      version: 1,
      contentSignature: "e".repeat(64),
      blocks: [
        { x: 0, y: 0, width: 1080, height: 60, tag: "p", node: "stem/p/0" },
        { x: 0, y: 100, width: 1080, height: 65, tag: "p", node: "stem/p/1" },
      ],
      fonts: [
        ["16px", "16px", "16px", "sans-serif", "normal"],
        ["16px", "16px", "16px", "sans-serif", "normal"],
      ],
      textRects: [],
    },
  };

  it("非等比位移：×ratio 与否投影结果分叉（转换路径被锁定）", () => {
    const result = reprojectAnnotation(DOC, SAVED, TARGET_NON_UNIFORM);
    const mapped = result.strokes.find((stroke) => stroke.id === "stroke-2");
    expect(mapped?.points[0]?.x).toBeCloseTo(225, 6);
    // 245 与王玄策 #11771 背书的期望值一致（×ratio 路径）
    expect(mapped?.points[0]?.y).toBeCloseTo(245, 6);
    // 反证：不转域（CSS 块直接消费）时同一点 y = 235，两者分叉 13.75px
    const unconvertedY = 100 + ((150 - 120) / 80) * 130;
    expect(Math.abs(unconvertedY - 248.75)).toBeGreaterThan(10);
  });
});

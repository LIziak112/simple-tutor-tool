import type {
  AnnotationDoc,
  AnnotationSurfaceLayout,
  InkDeletedStroke,
} from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  type ApproximateTargetLayout,
  approximateModePlan,
  createLayoutMap,
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
    //（底图域 saved p/1 y=120、target p/1 y=100×2=200：x' = 225，
    // y' = 200 + ((150−120)/1440)×2160 = 245；不转域（CSS 块直接消费）
    // 则 y = 100 + ((150−60)/720)×1080 = 235，分叉 10px）
    const second = result.strokes.find((stroke) => stroke.id === "stroke-2");
    expect(second?.points[0]?.x).toBeCloseTo(225, 6);
    expect(second?.points[0]?.y).toBeCloseTo(245, 6);
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

describe("createLayoutMap（LR-PR4 第二层：近似原位垫片）", () => {
  const SAVEDG = {
    cssWidth: SAVED.cssWidth,
    cssHeight: SAVED.cssHeight,
    pixelRatio: SAVED.pixelRatio,
    blocks: SAVED.compatibility?.blocks ?? [],
  };
  const TARGETG = {
    cssWidth: TARGET.cssWidth,
    cssHeight: TARGET.cssHeight,
    pixelRatio: TARGET.pixelRatio,
    blocks: TARGET.compatibility?.blocks ?? [],
  };

  it("strokeToTarget 按锚块矩形对映射；strokeToSaved 往返误差 < 0.01px", () => {
    const map = createLayoutMap(SAVEDG, TARGETG);
    const stroke = strokeAt("m-1", [
      [100, 10],
      [300, 60],
    ]);
    const forward = map.strokeToTarget(stroke, "stem/p/0");
    expect(forward.unanchored).toBe(false);
    // u=100/1440 ×2160 = 150；v=10/1440 ×2160 = 15；宽比 2160/1440 = 1.5
    expect(forward.stroke.points[0]?.x).toBeCloseTo(150, 5);
    expect(forward.stroke.points[0]?.y).toBeCloseTo(15, 5);
    expect(forward.stroke.weight).toBeCloseTo(6, 5);
    const back = map.strokeToSaved(forward.stroke, "stem/p/0");
    expect(back.unanchored).toBe(false);
    for (const [i, point] of stroke.points.entries()) {
      const round = back.stroke.points[i];
      expect(Math.abs((round?.x ?? 0) - point.x)).toBeLessThan(0.01);
      expect(Math.abs((round?.y ?? 0) - point.y)).toBeLessThan(0.01);
    }
    expect(back.stroke.weight).toBeCloseTo(stroke.weight, 5);
    // id/startedAt/pointer 等字段原样保留
    expect(back.stroke.id).toBe("m-1");
    expect(back.stroke.startedAt).toBe(stroke.startedAt);
    expect(back.stroke.pointer).toBe("pen");
  });

  it("锚键缺失 → root 整域等比兜底（unanchored 如实）", () => {
    const map = createLayoutMap(SAVEDG, TARGETG);
    const stroke = strokeAt("m-2", [[100, 10]]);
    const forward = map.strokeToTarget(stroke, undefined);
    expect(forward.unanchored).toBe(true);
    expect(forward.stroke.points[0]?.x).toBeCloseTo(150, 5);
    expect(forward.stroke.points[0]?.y).toBeCloseTo(15, 5);
  });

  it("pointToSaved：块内按块对映射，块外 root 兜底；ratio 为局部存储/视图宽比", () => {
    const map = createLayoutMap(SAVEDG, TARGETG);
    // 目标域块 stem/p/0（底图域 0,0,2160,120）：块内点走块对（ratio = 1440/2160）
    const inside = map.pointToSaved({ x: 150, y: 15 });
    expect(inside.x).toBeCloseTo(100, 5);
    expect(inside.y).toBeCloseTo(10, 5);
    expect(inside.ratio).toBeCloseTo(1440 / 2160, 5);
    // 块外（y=500 不在任一块内）走 root：y 按整域映射（若误走块对会是 200）
    const outside = map.pointToSaved({ x: 2100, y: 500 });
    expect(outside.x).toBeCloseTo(1400, 5);
    expect(outside.y).toBeCloseTo((500 * 1440) / 2160, 5);
    expect(outside.ratio).toBeCloseTo(1440 / 2160, 5);
  });
});

describe("approximateModePlan（LR-PR4 第二层：近似原位准入）", () => {
  const target: ApproximateTargetLayout = {
    questionRevisionId: TARGET.questionRevisionId,
    cssWidth: TARGET.cssWidth,
    cssHeight: TARGET.cssHeight,
    pixelRatio: TARGET.pixelRatio,
    blocks: TARGET.compatibility?.blocks ?? [],
    fonts: TARGET.compatibility?.fonts ?? [],
    textRects: [],
  };

  it("全部笔画与墓碑有锚且双布局含键 → 合格", () => {
    expect(approximateModePlan(DOC, SAVED, target)).toEqual({
      eligible: true,
      totalCount: 3,
      unprojectable: 0,
    });
  });

  it("任一笔缺锚 / 锚键不在目标块表内 / 空稿 / 修订版不同 → 不合格", () => {
    const noAnchor: AnnotationDoc = {
      ...DOC,
      anchors: { "stroke-1": "stem/p/0", "stroke-3": "stem/p/0" },
    };
    const missing = approximateModePlan(noAnchor, SAVED, target);
    expect(missing.eligible).toBe(false);
    expect(missing.unprojectable).toBe(1);

    const missingKey: ApproximateTargetLayout = {
      ...target,
      blocks: target.blocks.filter((block) => block.node !== "stem/p/1"),
    };
    const plan = approximateModePlan(DOC, SAVED, missingKey);
    expect(plan.eligible).toBe(false);
    expect(plan.unprojectable).toBe(1);

    const empty: AnnotationDoc = {
      version: 1,
      baseWidth: 1440,
      baseHeight: 800,
      strokes: [],
    };
    const emptyPlan = approximateModePlan(empty, SAVED, target);
    expect(emptyPlan.eligible).toBe(false);
    expect(emptyPlan.totalCount).toBe(0);

    const revised = { ...target, questionRevisionId: "rev-9" };
    expect(approximateModePlan(DOC, SAVED, revised).eligible).toBe(false);
  });
});

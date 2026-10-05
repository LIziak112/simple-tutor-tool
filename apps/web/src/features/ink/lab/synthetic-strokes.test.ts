import { inkDocSchema } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import type { InkDoc } from "../engine/types.ts";
import {
  buildSyntheticAtramentDoc,
  totalPoints,
} from "./synthetic-strokes.ts";

/**
 * 合成笔迹生成器测试（T6R.1，TDD 先行）：
 * - 确定性：同种子同参数 → 逐字段一致；
 * - 契约兼容：输出能过 inkDocSchema（与 atrament InkDoc 同形状；
 *   use-ink-upload.ts 的 isInkDocEmpty 按 data.strokes.length 判空，非空即"有内容"）；
 * - 参数与形状边界：笔画数、每笔点数、点字段取值范围、t 单调不减。
 */

/** 基准参数（默认纸张高度 800 逻辑单位） */
const BASE = { seed: 20261005, strokeCount: 120, pointsPerStroke: 40 };

describe("buildSyntheticAtramentDoc", () => {
  it("同种子同参数输出完全一致（确定性）", () => {
    const a = buildSyntheticAtramentDoc(BASE);
    const b = buildSyntheticAtramentDoc(BASE);
    expect(a).toEqual(b);
    // JSON 序列化逐字节一致（压缩/哈希场景依赖这一点）
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("不同种子输出不同（避免所有样本千篇一律）", () => {
    const a = buildSyntheticAtramentDoc(BASE);
    const b = buildSyntheticAtramentDoc({ ...BASE, seed: 42 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("笔画数参数生效且非空文档（isInkDocEmpty 形状：strokes 非空）", () => {
    const doc = buildSyntheticAtramentDoc({ ...BASE, strokeCount: 7 });
    expect(doc.data.strokes).toHaveLength(7);
    expect(doc.data.strokes.length).toBeGreaterThan(0);
  });

  it("零笔时为合法空文档", () => {
    const doc = buildSyntheticAtramentDoc({ ...BASE, strokeCount: 0 });
    expect(doc.data.strokes).toHaveLength(0);
    expect(inkDocSchema.parse(doc)).toBeTruthy();
  });

  it("输出通过契约 inkDocSchema 校验（引擎/服务端同一形状）", () => {
    const doc = buildSyntheticAtramentDoc(BASE);
    expect(() => inkDocSchema.parse(doc)).not.toThrow();
    // 明确校验判别键与外层字段
    const parsed = inkDocSchema.parse(doc);
    expect(parsed.engine).toBe("atrament");
    if (parsed.engine !== "atrament") return;
    expect(parsed.data.width).toBe(1000);
    expect(parsed.version).toBe(1);
  });

  it("每个点满足取值范围：p∈[0,1]、t≥0、x∈[0,1000]、y∈[0,纸高]", () => {
    const paperHeight = 800;
    const doc = buildSyntheticAtramentDoc({ ...BASE, paperHeightLogical: paperHeight });
    for (const s of doc.data.strokes) {
      expect(s.points.length).toBeGreaterThanOrEqual(1);
      let prevT = -1;
      for (const pt of s.points) {
        expect(pt.p).toBeGreaterThanOrEqual(0);
        expect(pt.p).toBeLessThanOrEqual(1);
        expect(pt.t).toBeGreaterThanOrEqual(0);
        // 同一笔内 t 单调不减（与真实采样一致）
        expect(pt.t).toBeGreaterThanOrEqual(prevT);
        prevT = pt.t;
        expect(pt.x).toBeGreaterThanOrEqual(0);
        expect(pt.x).toBeLessThanOrEqual(1000);
        expect(pt.y).toBeGreaterThanOrEqual(0);
        expect(pt.y).toBeLessThanOrEqual(paperHeight);
      }
      // 线宽为正的逻辑单位
      expect(s.weight).toBeGreaterThan(0);
      expect(s.color.length).toBeGreaterThan(0);
    }
  });

  it("形状覆盖：同时出现笔与荧光笔、点按小笔画与多点长笔画", () => {
    const doc = buildSyntheticAtramentDoc({ ...BASE, strokeCount: 200 });
    const tools = new Set(doc.data.strokes.map((s) => s.tool));
    expect(tools.has("pen")).toBe(true);
    expect(tools.has("highlighter")).toBe(true);

    // 点按小笔画：1–3 个点
    const dotStrokes = doc.data.strokes.filter(
      (s) => s.tool === "pen" && s.points.length <= 3,
    );
    expect(dotStrokes.length).toBeGreaterThan(0);
    // 长演算线段：点数达到基准量级（不被形状折算削没）
    const longStrokes = doc.data.strokes.filter(
      (s) => s.tool === "pen" && s.points.length >= BASE.pointsPerStroke,
    );
    expect(longStrokes.length).toBeGreaterThan(0);
    // 荧光笔重叠涂抹：同一涂抹带内来回（x 方向出现折返）
    const hl = doc.data.strokes.filter((s) => s.tool === "highlighter");
    expect(hl.length).toBeGreaterThan(0);
    let hasBacktrack = false;
    for (const s of hl) {
      for (let i = 2; i < s.points.length; i++) {
        const dx1 = s.points[i - 1]!.x - s.points[i - 2]!.x;
        const dx2 = s.points[i]!.x - s.points[i - 1]!.x;
        if (dx1 * dx2 < 0) hasBacktrack = true;
      }
    }
    expect(hasBacktrack).toBe(true);
  });

  it("根号/分数线/上下标类折线：存在多段折向（方向显著变化）的笔画", () => {
    const doc = buildSyntheticAtramentDoc({ ...BASE, strokeCount: 200 });
    const polylineLike = doc.data.strokes.filter((s) => {
      if (s.tool !== "pen" || s.points.length < 4) return false;
      let turns = 0;
      for (let i = 2; i < s.points.length; i++) {
        const dx1 = s.points[i - 1]!.x - s.points[i - 2]!.x;
        const dx2 = s.points[i]!.x - s.points[i - 1]!.x;
        const dy1 = s.points[i - 1]!.y - s.points[i - 2]!.y;
        const dy2 = s.points[i]!.y - s.points[i - 1]!.y;
        // x 或 y 方向发生明确折返（阈值过滤抖动）
        if (dx1 * dx2 < -4 || dy1 * dy2 < -4) turns++;
      }
      return turns >= 1;
    });
    expect(polylineLike.length).toBeGreaterThan(0);
  });

  it("totalPoints 等于各笔点数之和", () => {
    const doc: InkDoc<"atrament"> = buildSyntheticAtramentDoc(BASE);
    const sum = doc.data.strokes.reduce((n, s) => n + s.points.length, 0);
    expect(totalPoints(doc)).toBe(sum);
    expect(totalPoints(doc)).toBeGreaterThan(0);
  });

  it("每笔点数参数影响点数总量（更多点 → 更大总点数）", () => {
    const small = buildSyntheticAtramentDoc({ ...BASE, pointsPerStroke: 8 });
    const large = buildSyntheticAtramentDoc({ ...BASE, pointsPerStroke: 80 });
    expect(totalPoints(large)).toBeGreaterThan(totalPoints(small));
  });
});

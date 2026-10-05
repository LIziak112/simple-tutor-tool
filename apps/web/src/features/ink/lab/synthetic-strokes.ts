import {
  INK_HIGHLIGHTER,
  INK_LOGICAL_WIDTH,
  INK_PEN_COLORS,
  INK_PEN_SIZES,
  type InkDoc,
  type InkPenColor,
  type InkPenSize,
  type InkStroke,
  type InkStrokePoint,
} from "../engine/types.ts";

/**
 * 确定性合成类手写数学笔迹生成器（T6R.1 桌面自动化测量用）。
 *
 * 目的：在没有 iPad 真机时，为字节预算/编码耗时/重绘耗时等桌面可测项提供
 * 形状接近真实演算的 InkDoc 样本。它**不是**真机测量的替代——手感、采样率、
 * 压感分布仍须真机验证（docs/Phase6任务清单.md T6R.1 真机闸门）。
 *
 * 输出与 atrament 引擎的 InkDoc<"atrament"> 完全同形状（契约 inkDocSchema
 * 可解析；use-ink-upload.ts 的 isInkDocEmpty 按 data.strokes.length 判空，
 * 非空即视为有内容）。
 *
 * 形状覆盖（任务要求）：
 * - short/medium/long：短/中/长演算线段（带竖向抖动的横写波浪线）；
 * - dot：点按小笔画（小数点、句点类，1–2 点）；
 * - sqrt/fraction/supsub：根号/分数线/上下标类折线（方向显著折转）；
 * - highlight：荧光笔重叠涂抹段（同一涂抹带来回折返，覆盖在既有笔迹上）。
 *
 * 确定性：同一 seed + 同一参数 → 逐字节一致（mulberry32 PRNG，无 Date/
 * Math.random/环境依赖）。
 */

/** 合成形状种类 */
export type SyntheticShapeKind =
  | "short"
  | "medium"
  | "long"
  | "dot"
  | "sqrt"
  | "fraction"
  | "supsub"
  | "highlight";

/** 生成参数 */
export interface SyntheticDocOptions {
  /** 随机种子（同种子同参数 → 完全一致输出） */
  seed: number;
  /** 总笔画数（含荧光笔笔画） */
  strokeCount: number;
  /** 基准每笔点数（各形状按比例折算；点按固定 1–2 点） */
  pointsPerStroke: number;
  /** 逻辑纸高（默认 800；方案 §4.3 上限 3000） */
  paperHeightLogical?: number;
}

/** 默认逻辑纸高（与方案 §4.3 首版默认一致） */
const DEFAULT_PAPER_HEIGHT = 800;

/** 版心（逻辑单位，宽度固定 1000） */
const MARGIN_LEFT = 60;
const MARGIN_RIGHT = 940;
const FIRST_BASELINE = 60;
/** 行高（演算行距） */
const LINE_HEIGHT = 46;
/** 笔画之间的水平间隙 */
const STROKE_GAP = 18;

/** mulberry32：32 位确定性 PRNG，返回 [0,1) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 笔画生成过程中的游标（当前书写位置，逻辑单位） */
interface Cursor {
  x: number;
  y: number;
  /** 换行回卷次数（用于错开重叠，避免整段重复压低 gzip 体积估计） */
  wrapCount: number;
}

/** 一支笔的配置（一次绘制内保持不变，模拟真实握笔） */
interface PenConfig {
  color: InkPenColor;
  size: InkPenSize;
}

/** 生成器上下文：游标 + 版心换行（生成宽形状前先保证放得下） */
interface DrawContext {
  cursor: Cursor;
  paperHeight: number;
  /** 宽形状落笔前检查：放不下先换行（保证所有点 x ≤ 1000） */
  ensureFit(neededWidth: number): void;
}

/** 把 y 夹在版心内（留 16 上下边距） */
function clampY(y: number, paperHeight: number): number {
  return Math.min(paperHeight - 16, Math.max(16, y));
}

/** 加法抖动：[-scale, scale] */
function jitter(rng: () => number, scale: number): number {
  return (rng() * 2 - 1) * scale;
}

/** 生成一支笔（颜色/粗细按权重挑，黑色更常见） */
function pickPen(rng: () => number): PenConfig {
  const colors: InkPenColor[] = ["black", "black", "black", "blue", "red"];
  const sizes: InkPenSize[] = ["thin", "medium", "medium", "medium", "thick"];
  return {
    color: colors[Math.floor(rng() * colors.length)] ?? "black",
    size: sizes[Math.floor(rng() * sizes.length)] ?? "medium",
  };
}

/** 组装一个点：坐标 + 压力 + 相对毫秒（数值取整保证序列化稳定） */
function pt(x: number, y: number, p: number, t: number): InkStrokePoint {
  return {
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    p: Math.round(Math.min(0.95, Math.max(0.05, p)) * 1000) / 1000,
    t: Math.max(0, Math.round(t)),
  };
}

/** 演算线段（short/medium/long）：横写波浪线，长度与点数按档位折算 */
function lineStroke(
  rng: () => number,
  ctx: DrawContext,
  kind: "short" | "medium" | "long",
  basePoints: number,
  pen: PenConfig,
): { stroke: InkStroke; advance: number } {
  const length =
    kind === "short"
      ? 60 + rng() * 50
      : kind === "medium"
        ? 180 + rng() * 80
        : 420 + rng() * 200;
  ctx.ensureFit(length);
  const cursor = ctx.cursor;
  const count = Math.max(
    2,
    Math.ceil(
      basePoints * (kind === "short" ? 0.35 : kind === "medium" ? 1 : 1.5),
    ),
  );
  const points: InkStrokePoint[] = [];
  const pressureBase = 0.25 + rng() * 0.6;
  const drift = jitter(rng, 6);
  let t = 0;
  for (let i = 0; i < count; i++) {
    const x = cursor.x + (length * i) / (count - 1);
    // 竖向抖动模拟手写波浪；首尾点收敛到基线（起收笔）
    const edge = i === 0 || i === count - 1 ? 0.3 : 1;
    const y = clampY(
      cursor.y + jitter(rng, 3.5) * edge + (drift * i) / count,
      ctx.paperHeight,
    );
    t += 5 + Math.floor(rng() * 8);
    points.push(pt(x, y, pressureBase + jitter(rng, 0.08), t));
  }
  return {
    stroke: {
      tool: "pen",
      color: INK_PEN_COLORS[pen.color],
      weight: INK_PEN_SIZES[pen.size],
      points,
    },
    advance: length + STROKE_GAP,
  };
}

/** 点按小笔画：1–2 点、几乎不位移（小数点/点选） */
function dotStroke(
  rng: () => number,
  ctx: DrawContext,
  pen: PenConfig,
): { stroke: InkStroke; advance: number } {
  const cursor = ctx.cursor;
  const count = rng() < 0.7 ? 1 : 2;
  const points: InkStrokePoint[] = [];
  for (let i = 0; i < count; i++) {
    points.push(
      pt(
        cursor.x + jitter(rng, 1.5),
        clampY(cursor.y + jitter(rng, 1.5), ctx.paperHeight),
        0.5 + jitter(rng, 0.2),
        i === 0 ? 0 : 12 + Math.floor(rng() * 10),
      ),
    );
  }
  return {
    stroke: {
      tool: "pen",
      color: INK_PEN_COLORS[pen.color],
      weight: INK_PEN_SIZES[pen.size],
      points,
    },
    advance: 26,
  };
}

/** 沿折线路径均匀布点（根号/分数线类共用） */
function polylinePoints(
  rng: () => number,
  vertices: { x: number; y: number }[],
  count: number,
  pressureBase: number,
): InkStrokePoint[] {
  // 先按线段长度累积参数，再均匀取 count 个点
  const segLens: number[] = [];
  let total = 0;
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1] as { x: number; y: number };
    const b = vertices[i] as { x: number; y: number };
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segLens.push(len);
    total += len;
  }
  const points: InkStrokePoint[] = [];
  let t = 0;
  let seg = 0;
  let consumed = 0;
  for (let i = 0; i < count; i++) {
    const target = (total * i) / (count - 1);
    while (seg < segLens.length - 1 && consumed + (segLens[seg] as number) < target) {
      consumed += segLens[seg] as number;
      seg++;
    }
    const a = vertices[seg] as { x: number; y: number };
    const b = (vertices[seg + 1] ?? vertices[seg]) as { x: number; y: number };
    const segLen = (segLens[seg] as number) || 1;
    const f = Math.min(1, Math.max(0, (target - consumed) / segLen));
    t += 4 + Math.floor(rng() * 7);
    points.push(
      pt(
        a.x + (b.x - a.x) * f + jitter(rng, 1.2),
        a.y + (b.y - a.y) * f + jitter(rng, 1.2),
        pressureBase + jitter(rng, 0.08),
        t,
      ),
    );
  }
  return points;
}

/** 根号：短横 → 斜上 → 顶部横线（vinculum） */
function sqrtStroke(
  rng: () => number,
  ctx: DrawContext,
  basePoints: number,
  pen: PenConfig,
): { stroke: InkStroke; advance: number } {
  const diagonal = 46 + rng() * 18;
  const vinculum = 110 + rng() * 50;
  ctx.ensureFit(12 + diagonal * 0.9 + vinculum);
  const cursor = ctx.cursor;
  const y = clampY(cursor.y, ctx.paperHeight);
  const top = Math.max(16, y - diagonal); // 首行处下限夹取，防 y<0
  const vertices = [
    { x: cursor.x, y },
    { x: cursor.x + 12, y },
    { x: cursor.x + 12 + diagonal * 0.9, y: top },
    { x: cursor.x + 12 + diagonal * 0.9 + vinculum, y: top },
  ];
  const count = Math.max(6, Math.ceil(basePoints * 1.4));
  return {
    stroke: {
      tool: "pen",
      color: INK_PEN_COLORS[pen.color],
      weight: INK_PEN_SIZES[pen.size],
      points: polylinePoints(rng, vertices, count, 0.3 + rng() * 0.5),
    },
    advance: 12 + diagonal * 0.9 + vinculum + STROKE_GAP,
  };
}

/** 分数线：略带抖动的长横线（位于基线上方一点） */
function fractionStroke(
  rng: () => number,
  ctx: DrawContext,
  basePoints: number,
  pen: PenConfig,
): { stroke: InkStroke; advance: number } {
  const length = 120 + rng() * 45;
  ctx.ensureFit(length);
  const cursor = ctx.cursor;
  const y = clampY(cursor.y - 12, ctx.paperHeight);
  const vertices = [
    { x: cursor.x, y },
    { x: cursor.x + length, y },
  ];
  const count = Math.max(4, Math.ceil(basePoints * 0.7));
  return {
    stroke: {
      tool: "pen",
      color: INK_PEN_COLORS[pen.color],
      weight: INK_PEN_SIZES[pen.size],
      points: polylinePoints(rng, vertices, count, 0.35 + rng() * 0.4),
    },
    advance: length + STROKE_GAP,
  };
}

/** 上下标：抬升/下移的小锯齿折线（方向显著折转） */
function supsubStroke(
  rng: () => number,
  ctx: DrawContext,
  basePoints: number,
  pen: PenConfig,
): { stroke: InkStroke; advance: number } {
  const width = 26 + rng() * 14;
  ctx.ensureFit(width);
  const cursor = ctx.cursor;
  const up = rng() < 0.6;
  const baseY = clampY(cursor.y + (up ? -26 : 22), ctx.paperHeight);
  const count = Math.max(5, Math.ceil(basePoints * 0.35));
  const points: InkStrokePoint[] = [];
  const pressureBase = 0.3 + rng() * 0.4;
  let t = 0;
  for (let i = 0; i < count; i++) {
    const x = cursor.x + (width * i) / (count - 1);
    // 交替上下锯齿（幅度 ≥5，保证方向折转可检测）
    const dy = (i % 2 === 0 ? 1 : -1) * (5 + rng() * 5);
    t += 5 + Math.floor(rng() * 6);
    points.push(
      pt(x, clampY(baseY + dy, ctx.paperHeight), pressureBase + jitter(rng, 0.06), t),
    );
  }
  return {
    stroke: {
      tool: "pen",
      color: INK_PEN_COLORS[pen.color],
      weight: INK_PEN_SIZES[pen.size],
      points,
    },
    advance: width + STROKE_GAP * 0.7,
  };
}

/** 荧光笔重叠涂抹段：同一涂抹带来回 2–3 趟，覆盖在既有笔迹区域上 */
function highlightStroke(
  rng: () => number,
  ctx: DrawContext,
  basePoints: number,
): InkStroke {
  const cursor = ctx.cursor;
  const width = 140 + rng() * 90;
  const passes = rng() < 0.5 ? 2 : 3;
  const count = Math.max(8, Math.ceil(basePoints * 1.2));
  // 涂抹带回退到最近书写区域（覆盖既有内容），不推进游标
  const startX = Math.max(MARGIN_LEFT, cursor.x - width - 40);
  const points: InkStrokePoint[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    const f = i / (count - 1);
    // 趟内进度 0→1→0→1…（来回折返）
    const passF = f * passes;
    const inPass = passF - Math.floor(passF);
    const direction = Math.floor(passF) % 2 === 0 ? inPass : 1 - inPass;
    const x = startX + width * direction;
    const y = clampY(cursor.y + jitter(rng, 7), ctx.paperHeight);
    t += 3 + Math.floor(rng() * 6);
    points.push(pt(x, y, 0.5, t));
  }
  return {
    tool: "highlighter",
    color: INK_HIGHLIGHTER.color,
    weight: INK_HIGHLIGHTER.weight,
    points,
  };
}

/** 非荧光形状的加权随机（荧光/点按有固定周期保底，见 buildSyntheticAtramentDoc） */
function pickLineKind(
  rng: () => number,
): "short" | "medium" | "long" | "sqrt" | "fraction" | "supsub" {
  const weights: [
    "short" | "medium" | "long" | "sqrt" | "fraction" | "supsub",
    number,
  ][] = [
    ["short", 3],
    ["medium", 3],
    ["long", 2],
    ["sqrt", 1.5],
    ["fraction", 1.2],
    ["supsub", 2],
  ];
  const total = weights.reduce((n, [, w]) => n + w, 0);
  let roll = rng() * total;
  for (const [kind, w] of weights) {
    roll -= w;
    if (roll < 0) return kind;
  }
  return "short";
}

/**
 * 构建合成 atrament 笔迹文档（确定性：同 seed 同参数 → 完全一致）。
 * updatedAt 固定 0（与 emptyAtramentDoc 同语义，避免墙上时钟破坏确定性）。
 */
export function buildSyntheticAtramentDoc(
  opts: SyntheticDocOptions,
): InkDoc<"atrament"> {
  const paperHeight = opts.paperHeightLogical ?? DEFAULT_PAPER_HEIGHT;
  const basePoints = Math.max(1, Math.floor(opts.pointsPerStroke));
  const rng = mulberry32(opts.seed);
  const cursor: Cursor = { x: MARGIN_LEFT, y: FIRST_BASELINE, wrapCount: 0 };

  /** 版心换行：超出纸高回卷到首行（回卷错开 x，避免完美重叠） */
  function newline(): void {
    cursor.wrapCount++;
    cursor.y += LINE_HEIGHT;
    cursor.x = MARGIN_LEFT + ((cursor.wrapCount * 17) % 51); // 三档错位，确定性
    if (cursor.y > paperHeight - 40) {
      cursor.y = FIRST_BASELINE;
    }
  }

  const ctx: DrawContext = {
    cursor,
    paperHeight,
    ensureFit(neededWidth: number): void {
      if (cursor.x + neededWidth > MARGIN_RIGHT) newline();
    },
  };

  const strokes: InkStroke[] = [];
  for (let i = 0; i < Math.max(0, Math.floor(opts.strokeCount)); i++) {
    // 形状选择：荧光笔每 9 笔保底一次、点按每 13 笔保底一次（确定性覆盖），
    // 其余按权重随机——保证任意 seed 下两类形状必然出现。
    const kind: SyntheticShapeKind =
      i % 9 === 8 ? "highlight" : i % 13 === 5 ? "dot" : pickLineKind(rng);

    if (kind === "highlight") {
      strokes.push(highlightStroke(rng, ctx, basePoints));
      continue; // 荧光笔覆盖既有区域，不推进游标
    }
    const pen = pickPen(rng);
    const result =
      kind === "dot"
        ? dotStroke(rng, ctx, pen)
        : kind === "sqrt"
          ? sqrtStroke(rng, ctx, basePoints, pen)
          : kind === "fraction"
            ? fractionStroke(rng, ctx, basePoints, pen)
            : kind === "supsub"
              ? supsubStroke(rng, ctx, basePoints, pen)
              : lineStroke(rng, ctx, kind, basePoints, pen);
    strokes.push(result.stroke);

    // 版心内推进；放不下时换行（宽形状在生成前已 ensureFit，这里兜底窄形状）
    const nextX = cursor.x + result.advance;
    if (nextX > MARGIN_RIGHT) {
      newline();
    } else {
      cursor.x = nextX;
    }
  }

  return {
    engine: "atrament",
    version: 1,
    data: { width: INK_LOGICAL_WIDTH, strokes },
    updatedAt: 0,
  };
}

/** 文档总点数（各笔点数之和） */
export function totalPoints(doc: InkDoc<"atrament">): number {
  return doc.data.strokes.reduce((n, s) => n + s.points.length, 0);
}

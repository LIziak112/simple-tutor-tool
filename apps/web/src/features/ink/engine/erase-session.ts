/**
 * 擦除会话：橡皮从落下到抬起这一次拖动里，哪些笔画被擦掉、哪些被切开。
 *
 * 两种模式同一套流程——整笔模式碰到即整笔拿掉，局部模式换成切剩的各段
 * （erase-partial.ts）。会话按开始那一刻的笔画算，拖动途中只改自己的账，
 * 不动正文；书写面用 visible() 画预览，抬笔时把 result() 一次性提交成一个
 * 历史条目（撤销 = 整次拖动恢复）。纯数据，不碰 DOM；草稿纸、正式手写、
 * 圈画与材料圈画共用。
 */
import { type StrokeBounds, strokeBounds, unionOfBoxes } from "./bounds.ts";
import { strokeHit } from "./erase.ts";
import { splitStrokeByEraser } from "./erase-partial.ts";
import { mintStrokeId } from "./history.ts";
import type { InkEraserMode, InkStroke, InkStrokePoint } from "./types.ts";

type XY = Pick<InkStrokePoint, "x" | "y">;

/** 画面上的一笔 */
export interface EraseVisible {
  stroke: InkStroke;
  /** 出自会话开始时的第几笔（没动过的就是它自己） */
  source: number;
  /** 这一笔画得到的范围（见 strokePaintBounds）；局部重画据此判断要不要带上它 */
  paintBounds: StrokeBounds | null;
}

export interface EraseResult {
  /** 被擦掉或被切开的原笔画下标（提交前的下标，升序） */
  removed: number[];
  /** 切剩的各段：index 是提交后的下标（升序），source 是出自提交前的第几笔 */
  added: Array<{ index: number; stroke: InkStroke; source: number }>;
}

export interface EraseSession {
  /**
   * 橡皮从 from 划到 (x, y)（from 缺省为原地点一下）。返回这一步改动到的
   * 区域（改动前那几笔画得到的范围之并，书写面据此只重画这一块）；没有改动
   * 返回 null。
   */
  sweep(x: number, y: number, radius: number, from?: XY): StrokeBounds | null;
  /** 现在画面上该有的笔画，按绘制顺序 */
  visible(): readonly EraseVisible[];
  /** 抬笔时要提交的改动；什么都没擦到返回 null */
  result(): EraseResult | null;
}

export interface EraseSessionOptions {
  /** 给切剩的段铸造 id；缺省用引擎的 mintStrokeId */
  mintId?: () => string;
  /** 画面笔画数上限（圈画有）：切开会超限的那一笔改为整笔擦掉 */
  maxStrokes?: number;
}

/**
 * 一笔画得到的范围：包围盒外扩整个笔宽再加 2。压感最重时线宽翻倍、自然笔感
 * 的轮廓半径最大到一个笔宽，都在这个范围里；atrament 随运笔速度的加粗另由
 * 书写面按屏幕像素补（region-redraw.ts 的 PAINT_SPREAD_CSS）。
 * box 可传入预先算好的未外扩包围盒。
 */
export function strokePaintBounds(
  stroke: InkStroke,
  box: StrokeBounds | null = strokeBounds(stroke),
): StrokeBounds | null {
  if (box === null) return null;
  const scale =
    stroke.rendering?.renderer === "freehand" ? stroke.rendering.sizeScale : 1;
  const pad = stroke.weight * scale + 2;
  return {
    minX: box.minX - pad,
    minY: box.minY - pad,
    maxX: box.maxX + pad,
    maxY: box.maxY + pad,
  };
}

/** 会话里的一笔：连同只算一次的包围盒（box 未外扩，命中粗筛用） */
interface Held {
  stroke: InkStroke;
  box: StrokeBounds | null;
  paintBounds: StrokeBounds | null;
}

function hold(stroke: InkStroke): Held {
  const box = strokeBounds(stroke);
  return { stroke, box, paintBounds: strokePaintBounds(stroke, box) };
}

export function createEraseSession(
  strokes: readonly InkStroke[],
  mode: InkEraserMode,
  options: EraseSessionOptions = {},
): EraseSession {
  const originals = strokes.map(hold);
  const mintId = options.mintId ?? mintStrokeId;
  const maxStrokes = options.maxStrokes ?? Number.POSITIVE_INFINITY;
  /** 动过的笔画 → 它现在剩下的各段（整笔拿掉为空数组）；没动过的不在表里 */
  const changed = new Map<number, Held[]>();
  let count = originals.length;
  let visibleCache: EraseVisible[] | null = null;
  let resultCache: EraseResult | null = null;

  function sweep(
    x: number,
    y: number,
    radius: number,
    from?: XY,
  ): StrokeBounds | null {
    const to = { x, y };
    const dirty: Array<StrokeBounds | null> = [];
    originals.forEach((original, index) => {
      const pieces = changed.get(index);
      if (pieces === undefined && mode === "stroke") {
        const { stroke, box } = original;
        if (!strokeHit(stroke, x, y, radius, box, from)) return;
        dirty.push(original.paintBounds);
        count -= 1;
        changed.set(index, []);
        return;
      }
      // 局部模式：没动过的整笔当作唯一的一段，和已经切开的各段同样处理
      const next: Held[] = [];
      let touched = false;
      for (const piece of pieces ?? [original]) {
        const rest = splitStrokeByEraser(
          piece.stroke,
          to,
          radius,
          from,
          piece.box,
        );
        if (rest === null) {
          next.push(piece);
          continue;
        }
        touched = true;
        dirty.push(piece.paintBounds);
        // 切开会超出笔画数上限：这一段整段拿掉
        const kept = count - 1 + rest.length > maxStrokes ? [] : rest;
        count += kept.length - 1;
        next.push(...kept.map(hold));
      }
      if (touched) changed.set(index, next);
    });
    if (dirty.length === 0) return null;
    visibleCache = null;
    resultCache = null;
    return unionOfBoxes(dirty);
  }

  function visible(): readonly EraseVisible[] {
    if (visibleCache !== null) return visibleCache;
    const list: EraseVisible[] = [];
    originals.forEach((original, source) => {
      for (const { stroke, paintBounds } of changed.get(source) ?? [original]) {
        list.push({ stroke, source, paintBounds });
      }
    });
    visibleCache = list;
    return list;
  }

  function result(): EraseResult | null {
    if (changed.size === 0) return null;
    if (resultCache !== null) return resultCache;
    const added: EraseResult["added"] = [];
    visible().forEach(({ stroke, source }, index) => {
      if (!changed.has(source)) return;
      added.push({ index, stroke: { ...stroke, id: mintId() }, source });
    });
    resultCache = {
      removed: [...changed.keys()].sort((a, b) => a - b),
      added,
    };
    return resultCache;
  }

  return { sweep, visible, result };
}

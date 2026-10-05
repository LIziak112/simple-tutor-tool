import type { InkDoc } from "../engine/types.ts";
import { measureEncoding } from "./measure.ts";
import { buildSyntheticAtramentDoc, totalPoints } from "./synthetic-strokes.ts";

/**
 * 预算试验纯逻辑（T6R.1）：按合成长稿测"多少笔/多少点触到预算线"。
 *
 * ⚠️ 限额数值全部是**暂定值**（docs/题目草稿功能方案.md §7 建议起点），
 * 真机定标后由 T6R.1 真机结论修订，本文件不冒充任何真机测量。
 */

/** 正文预算限额（暂定值） */
export interface BudgetLimits {
  /** 正文 gzip 后上限（方案 §7 建议 ≤2MiB） */
  bodyGzipMaxBytes: number;
  /** 正文解压后上限（方案 §7 建议 ≤32MiB） */
  bodyDecompressedMaxBytes: number;
}

/** 暂定限额：真机定标前一律以此标注，不与旧 ink 的 2MB 常量混用（独立命名） */
export const TENTATIVE_BUDGET_LIMITS: BudgetLimits = {
  bodyGzipMaxBytes: 2 * 1024 * 1024,
  bodyDecompressedMaxBytes: 32 * 1024 * 1024,
};

/** 默认试验阶梯（笔数；逐级翻倍直到触线） */
export const DEFAULT_BUDGET_RUNGS: readonly number[] = [
  50, 100, 200, 400, 800, 1600, 3200,
];

/** 一级阶梯的测量行 */
export interface BudgetRow {
  strokes: number;
  points: number;
  rawBytes: number;
  gzipBytes: number;
  gzipMs: number;
  hitsGzipLimit: boolean;
  hitsDecompressedLimit: boolean;
}

/** 单行测量参数 */
export interface EvaluateBudgetRowOptions {
  strokeCount: number;
  pointsPerStroke: number;
  seed: number;
  /** 限额（缺省用暂定值） */
  limits?: BudgetLimits;
  /** 逻辑纸高（缺省 800） */
  paperHeightLogical?: number;
}

/** 测一级阶梯：构建合成文档 → JSON → 原始/gzip 字节 + 触线标志 */
export async function evaluateBudgetRow(
  opts: EvaluateBudgetRowOptions,
): Promise<BudgetRow> {
  const doc = buildSyntheticAtramentDoc({
    seed: opts.seed,
    strokeCount: opts.strokeCount,
    pointsPerStroke: opts.pointsPerStroke,
    ...(opts.paperHeightLogical !== undefined
      ? { paperHeightLogical: opts.paperHeightLogical }
      : {}),
  });
  return evaluateBudgetRowForDoc(doc, opts.limits);
}

/** 对既有文档测字节与触线（面板复用：同一份文档既测字节又进引擎渲染） */
export async function evaluateBudgetRowForDoc(
  doc: InkDoc<"atrament">,
  limits?: BudgetLimits,
): Promise<BudgetRow> {
  const l = limits ?? TENTATIVE_BUDGET_LIMITS;
  const m = await measureEncoding(JSON.stringify(doc));
  return {
    strokes: doc.data.strokes.length,
    points: totalPoints(doc),
    rawBytes: m.rawBytes,
    gzipBytes: m.gzipBytes,
    gzipMs: m.gzipMs,
    hitsGzipLimit: m.gzipBytes > l.bodyGzipMaxBytes,
    hitsDecompressedLimit: m.rawBytes > l.bodyDecompressedMaxBytes,
  };
}

/** 第一个满足条件的行 + 其前一行（定位"在 X 与 Y 之间触线"） */
export function firstCrossing<T>(
  rows: readonly T[],
  hits: (row: T) => boolean,
): { crossing: T; before: T | null } | null {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as T;
    if (hits(row)) {
      return { crossing: row, before: i > 0 ? (rows[i - 1] as T) : null };
    }
  }
  return null;
}

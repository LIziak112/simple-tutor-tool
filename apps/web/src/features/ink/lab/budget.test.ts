import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_RUNGS,
  evaluateBudgetRow,
  evaluateBudgetRowForDoc,
  firstCrossing,
  TENTATIVE_ANALYSIS_PNG_MAX_BYTES,
  TENTATIVE_BUDGET_LIMITS,
} from "./budget.ts";
import { buildSyntheticAtramentDoc, totalPoints } from "./synthetic-strokes.ts";

/**
 * 预算试验纯逻辑测试（T6R.1）：
 * - evaluateBudgetRow：字节测量 + 触线标志（限额可注入，小限额即可测触线分支）；
 * - firstCrossing：阶梯中第一个触线行与前一行的定位；
 * - 暂定限额常量与方案 §7 一致（gzip ≤2MiB、解压 ≤32MiB）。
 *
 * 注意：这里不冒充任何真机测量——数值断言只针对纯函数行为。
 */

describe("evaluateBudgetRow", () => {
  it("小阶梯行字段齐全且不触暂定线", async () => {
    const row = await evaluateBudgetRow({
      strokeCount: 40,
      pointsPerStroke: 24,
      seed: 20261005,
    });
    expect(row.strokes).toBe(40);
    expect(row.points).toBeGreaterThan(0);
    expect(row.rawBytes).toBeGreaterThan(0);
    expect(row.gzipBytes).toBeGreaterThan(0);
    expect(row.gzipMs).toBeGreaterThanOrEqual(0);
    expect(row.hitsGzipLimit).toBe(false);
    expect(row.hitsDecompressedLimit).toBe(false);
    // 点数与合成文档一致（同一构建逻辑）
    const doc = buildSyntheticAtramentDoc({
      seed: 20261005,
      strokeCount: 40,
      pointsPerStroke: 24,
    });
    expect(row.points).toBe(totalPoints(doc));
  });

  it("注入小限额时正确标记触线", async () => {
    const row = await evaluateBudgetRow({
      strokeCount: 40,
      pointsPerStroke: 24,
      seed: 20261005,
      limits: { bodyGzipMaxBytes: 10, bodyDecompressedMaxBytes: 20 },
    });
    expect(row.hitsGzipLimit).toBe(true);
    expect(row.hitsDecompressedLimit).toBe(true);
  });

  it("对既有文档测量（evaluateBudgetRowForDoc，面板复用路径）", async () => {
    const doc = buildSyntheticAtramentDoc({
      seed: 20261005,
      strokeCount: 40,
      pointsPerStroke: 24,
    });
    const row = await evaluateBudgetRowForDoc(doc, {
      bodyGzipMaxBytes: 10,
      bodyDecompressedMaxBytes: 10,
    });
    expect(row.strokes).toBe(40);
    expect(row.points).toBe(totalPoints(doc));
    expect(row.hitsGzipLimit).toBe(true);
    expect(row.hitsDecompressedLimit).toBe(true);
  });

  it("原始字节等于文档 JSON 的 UTF-8 编码长度", async () => {
    const row = await evaluateBudgetRow({
      strokeCount: 30,
      pointsPerStroke: 16,
      seed: 7,
    });
    const doc = buildSyntheticAtramentDoc({
      seed: 7,
      strokeCount: 30,
      pointsPerStroke: 16,
    });
    expect(row.rawBytes).toBe(
      new TextEncoder().encode(JSON.stringify(doc)).length,
    );
  });
});

describe("firstCrossing", () => {
  const rows = [
    { strokes: 10, hitsGzipLimit: false, hitsDecompressedLimit: false },
    { strokes: 20, hitsGzipLimit: false, hitsDecompressedLimit: false },
    { strokes: 40, hitsGzipLimit: true, hitsDecompressedLimit: false },
    { strokes: 80, hitsGzipLimit: true, hitsDecompressedLimit: true },
  ];

  it("返回第一个触 gzip 线的行及其前一行", () => {
    const hit = firstCrossing(rows, (r) => r.hitsGzipLimit);
    expect(hit?.crossing.strokes).toBe(40);
    expect(hit?.before?.strokes).toBe(20);
  });

  it("返回第一个触解压线的行及其前一行", () => {
    const hit = firstCrossing(rows, (r) => r.hitsDecompressedLimit);
    expect(hit?.crossing.strokes).toBe(80);
    expect(hit?.before?.strokes).toBe(40);
  });

  it("从不触线时返回 null", () => {
    expect(firstCrossing(rows, () => false)).toBeNull();
  });

  it("第一行就触线时 before 为 null", () => {
    const hit = firstCrossing(rows, () => true);
    expect(hit?.crossing.strokes).toBe(10);
    expect(hit?.before).toBeNull();
  });
});

describe("常量", () => {
  it("暂定限额与方案 §7 建议起点一致（2MiB / 32MiB / 每图 2MiB）", () => {
    expect(TENTATIVE_BUDGET_LIMITS.bodyGzipMaxBytes).toBe(2 * 1024 * 1024);
    expect(TENTATIVE_BUDGET_LIMITS.bodyDecompressedMaxBytes).toBe(
      32 * 1024 * 1024,
    );
    expect(TENTATIVE_ANALYSIS_PNG_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it("默认阶梯为递增笔数", () => {
    for (let i = 1; i < DEFAULT_BUDGET_RUNGS.length; i++) {
      expect(DEFAULT_BUDGET_RUNGS[i]!).toBeGreaterThan(
        DEFAULT_BUDGET_RUNGS[i - 1]!,
      );
    }
  });
});

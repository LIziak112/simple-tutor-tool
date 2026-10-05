import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canGzipInThisEnvironment,
  createDurationSampler,
  formatBytes,
  measureEncoding,
  observableMemory,
  timingStats,
} from "./measure.ts";

/**
 * 测量原语测试（T6R.1，TDD 先行）：
 * - 统计：空样本边界（返回 null 不抛错）、已知分位数、单调关系；
 * - 采样器：计数、非负时长、重置；
 * - 编码测量：原始字节、gzip 字节与耗时；
 * - 可观测内存：performance.memory 不存在时返回 null（跨浏览器不抛错）。
 */

describe("timingStats", () => {
  it("空样本返回 null（不抛错）", () => {
    expect(timingStats([])).toBeNull();
  });

  it("单样本：所有统计量等于该值", () => {
    const s = timingStats([7]);
    expect(s).not.toBeNull();
    expect(s?.count).toBe(1);
    expect(s?.min).toBe(7);
    expect(s?.p50).toBe(7);
    expect(s?.p95).toBe(7);
    expect(s?.max).toBe(7);
    expect(s?.mean).toBe(7);
  });

  it("1–100 的最近秩分位：p50=50、p95=95、max=100", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    const s = timingStats(samples);
    expect(s?.count).toBe(100);
    expect(s?.min).toBe(1);
    expect(s?.p50).toBe(50);
    expect(s?.p95).toBe(95);
    expect(s?.max).toBe(100);
    expect(s?.mean).toBeCloseTo(50.5, 10);
  });

  it("单调关系：min ≤ p50 ≤ p95 ≤ max（乱序输入同样成立）", () => {
    const samples = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3];
    const s = timingStats(samples);
    expect(s).not.toBeNull();
    expect(s!.min).toBeLessThanOrEqual(s!.p50);
    expect(s!.p50).toBeLessThanOrEqual(s!.p95);
    expect(s!.p95).toBeLessThanOrEqual(s!.max);
  });

  it("负值/零时长样本也可统计（不抛错）", () => {
    const s = timingStats([0, 0, 1]);
    expect(s?.count).toBe(3);
    expect(s?.min).toBe(0);
    expect(s?.max).toBe(1);
  });
});

describe("createDurationSampler", () => {
  it("measure 记录次数与时长（时长 ≥ 0）并透传返回值", () => {
    const sampler = createDurationSampler();
    const returned = sampler.measure(() => 42);
    expect(returned).toBe(42);
    const stats = sampler.stats();
    expect(stats?.count).toBe(1);
    expect(stats?.max).toBeGreaterThanOrEqual(0);
  });

  it("多次 measure 后 count 与样本数一致", () => {
    const sampler = createDurationSampler();
    for (let i = 0; i < 5; i++) sampler.measure(() => undefined);
    expect(sampler.sampleCount()).toBe(5);
  });

  it("reset 清空样本", () => {
    const sampler = createDurationSampler();
    sampler.measure(() => undefined);
    sampler.reset();
    expect(sampler.sampleCount()).toBe(0);
    expect(sampler.stats()).toBeNull();
  });
});

describe("measureEncoding", () => {
  it("原始字节等于 UTF-8 编码长度；gzip 字节与耗时非负", async () => {
    const text = '{"a":"中文内容"}'.repeat(50);
    const m = await measureEncoding(text);
    expect(m.rawBytes).toBe(new TextEncoder().encode(text).length);
    expect(m.gzipBytes).toBeGreaterThan(0);
    expect(m.gzipMs).toBeGreaterThanOrEqual(0);
    expect(m.textLength).toBe(text.length);
  });

  it("高重复文本 gzip 后显著变小（能真实压缩的环境）", async () => {
    const text = "0123456789abcdef".repeat(4000);
    const m = await measureEncoding(text);
    if (canGzipInThisEnvironment()) {
      expect(m.compressed).toBe(true);
      expect(m.gzipBytes).toBeLessThan(m.rawBytes / 4);
    } else {
      // 降级：gzip 字节即原始字节（如 jsdom 的 Blob 无 .stream()）
      expect(m.compressed).toBe(false);
      expect(m.gzipBytes).toBe(m.rawBytes);
    }
  });
});

describe("observableMemory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("performance.memory 不存在时返回 null（不抛错）", () => {
    // jsdom 的 performance 没有 memory 字段
    expect(observableMemory()).toBeNull();
  });

  it("存在 memory 时返回三个数值", () => {
    vi.stubGlobal("performance", {
      now: () => 0,
      memory: {
        usedJSHeapSize: 100,
        totalJSHeapSize: 200,
        jsHeapSizeLimit: 400,
      },
    });
    expect(observableMemory()).toEqual({
      usedJSHeapSize: 100,
      totalJSHeapSize: 200,
      jsHeapSizeLimit: 400,
    });
  });

  it("memory 字段类型异常时返回 null（不抛错）", () => {
    vi.stubGlobal("performance", {
      now: () => 0,
      memory: { usedJSHeapSize: "不是数字" },
    });
    expect(observableMemory()).toBeNull();
  });
});

describe("formatBytes", () => {
  it("常见量级格式化", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MiB");
    expect(formatBytes(32 * 1024 * 1024)).toBe("32.0 MiB");
  });
});

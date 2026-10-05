import { gzipOrRaw } from "../gzip.ts";

/**
 * 测量原语（T6R.1 桌面自动化测量用）：耗时统计、字节测量、可观测内存。
 *
 * 全部为纯 TS，可在 Vitest（jsdom/node）单测；不在任何真机未经实测的场合
 * 产生"测量结论"——这些原语只提供数字，解释权归调用方与真机验证。
 */

/** 耗时统计摘要（最近秩分位） */
export interface TimingStats {
  count: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

/** 最近秩分位数：sorted[ceil(q·n) − 1]（空数组调用方先行判空） */
function nearestRank(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
  return sorted[idx] as number;
}

/**
 * 样本统计：空样本返回 null（边界不抛错）；
 * 单调性保证 min ≤ p50 ≤ p95 ≤ max。
 */
export function timingStats(samples: readonly number[]): TimingStats | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: sorted[0] as number,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    max: sorted[sorted.length - 1] as number,
    mean: sum / sorted.length,
  };
}

/** 同步回调耗时采样器：measure 包裹回调并记录 performance.now() 差值 */
export function createDurationSampler(): {
  measure<T>(fn: () => T): T;
  stats(): TimingStats | null;
  sampleCount(): number;
  reset(): void;
} {
  let samples: number[] = [];
  return {
    measure<T>(fn: () => T): T {
      const start = performance.now();
      try {
        return fn();
      } finally {
        samples.push(performance.now() - start);
      }
    },
    stats(): TimingStats | null {
      return timingStats(samples);
    },
    sampleCount(): number {
      return samples.length;
    },
    reset(): void {
      samples = [];
    },
  };
}

/** 文本编码测量结果 */
export interface EncodingMeasurement {
  /** 字符数 */
  textLength: number;
  /** UTF-8 原始字节数（即服务端解压后的正文大小口径） */
  rawBytes: number;
  /** gzip 后字节数（环境不支持压缩时等于 rawBytes） */
  gzipBytes: number;
  /** 压缩耗时（毫秒；不支持压缩的环境为 0） */
  gzipMs: number;
  /** 当前环境是否真正执行了 gzip 压缩 */
  compressed: boolean;
}

/**
 * 当前环境能否真实执行 gzip 压缩测量。
 * 需要 CompressionStream + 可流的 Blob（jsdom 的 Blob 无 .stream()，会抛错）+
 * Response；任一缺失时测量降级为原始字节，不冒充压缩结果。
 */
export function canGzipInThisEnvironment(): boolean {
  return (
    typeof CompressionStream !== "undefined" &&
    typeof Blob === "function" &&
    typeof Blob.prototype.stream === "function" &&
    typeof Response !== "undefined"
  );
}

/** 测量一段文本（通常是 InkDoc 的 JSON 序列化）的原始/gzip 字节与压缩耗时 */
export async function measureEncoding(
  text: string,
): Promise<EncodingMeasurement> {
  const raw = new TextEncoder().encode(text);
  let gz: Uint8Array<ArrayBuffer> = raw;
  let compressed = false;
  const start = performance.now();
  if (canGzipInThisEnvironment()) {
    try {
      gz = await gzipOrRaw(text);
      compressed = true;
    } catch {
      // 极端环境压缩中途失败：降级原始字节，不冒充压缩测量
      gz = raw;
      compressed = false;
    }
  }
  const gzipMs = performance.now() - start;
  return {
    textLength: text.length,
    rawBytes: raw.length,
    gzipBytes: gz.byteLength,
    gzipMs,
    compressed,
  };
}

/** 可观测内存快照（Chrome 系 performance.memory，非标准 API） */
export interface MemorySnapshot {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/** performance.memory 的宽松形状（字段逐个校验，不用 any） */
interface MemoryLike {
  usedJSHeapSize?: unknown;
  totalJSHeapSize?: unknown;
  jsHeapSizeLimit?: unknown;
}

/**
 * 读取可观测内存：performance.memory 存在且字段为数字才返回快照；
 * 跨浏览器（Safari/Firefox 无此 API）返回 null，任何情况不抛错。
 */
export function observableMemory(): MemorySnapshot | null {
  try {
    const perf: unknown = (globalThis as { performance?: unknown }).performance;
    if (perf === null || typeof perf !== "object") return null;
    const memory: unknown = (perf as { memory?: unknown }).memory;
    if (memory === null || typeof memory !== "object") return null;
    const m = memory as MemoryLike;
    if (
      typeof m.usedJSHeapSize !== "number" ||
      typeof m.totalJSHeapSize !== "number" ||
      typeof m.jsHeapSizeLimit !== "number"
    ) {
      return null;
    }
    return {
      usedJSHeapSize: m.usedJSHeapSize,
      totalJSHeapSize: m.totalJSHeapSize,
      jsHeapSizeLimit: m.jsHeapSizeLimit,
    };
  } catch {
    // 极端环境（如 Object getter 抛错）下不冒泡——测量工具不能成为故障源
    return null;
  }
}

/** 字节数的人类可读格式（1024 进制，一位小数） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${(Math.round(kib * 10) / 10).toFixed(1)} KiB`;
  return `${(Math.round((kib / 1024) * 10) / 10).toFixed(1)} MiB`;
}

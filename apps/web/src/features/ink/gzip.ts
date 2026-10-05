/**
 * 前端 gzip 工具（T2.8，§5.4.1 数据层第 4 条：CompressionStream 压缩后上传）。
 *
 * - 支持 CompressionStream 的浏览器（iPad Safari 16.4+、现代 Chrome/Edge）：
 *   流式压缩 InkDoc JSON；
 * - 不支持的旧环境：返回原始字节（服务端按"无 gzip 魔数当原始 JSON"兼容解析，
 *   见 apps/server ink-service.parseStrokesDoc）——老设备可用，只是体积大些。
 *
 * 返回类型固定 Uint8Array<ArrayBuffer>（BlobPart 直接可用）。
 */

/**
 * 当前环境能否真正走通压缩管道。除 CompressionStream 外还要求 Blob 可流
 * （jsdom 的 Blob 无 .stream()，直接走管道会抛错）与 Response 可用。
 * gzipOrRaw／gzipBytesOrRaw 与测量侧（lab/measure.ts）共用这一份判断，
 * 避免"测量声称压缩了、实际走了回退"的口径漂移。
 */
export function canGzip(): boolean {
  return (
    typeof CompressionStream !== "undefined" &&
    typeof Blob === "function" &&
    typeof Blob.prototype.stream === "function" &&
    typeof Response !== "undefined"
  );
}

/** 字节级压缩入口：能压则 gzip，不能则原样返回（调用方只 encode 一次） */
export async function gzipBytesOrRaw(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!canGzip()) {
    return bytes;
  }
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

export async function gzipOrRaw(
  text: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof CompressionStream === "undefined") {
    return new TextEncoder().encode(text);
  }
  return gzipBytesOrRaw(new TextEncoder().encode(text));
}

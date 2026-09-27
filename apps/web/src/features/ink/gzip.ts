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
export async function gzipOrRaw(
  text: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof CompressionStream === "undefined") {
    return new TextEncoder().encode(text);
  }
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

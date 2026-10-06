/**
 * PNG 字节级小原语（T6R.5 复审⑥从 ink-service 上提共享）：
 * - PNG_MAGIC + pngSize：魔数与 IHDR 尺寸解析（不解码像素数据）；
 * - 消费方：ink-service（快照校验）、note-service（补图完整性校验）——
 *   后者不再跨域 import ink-service。
 */

/** PNG 魔数（\x89PNG\r\n\x1a\n） */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 解析 PNG 尺寸（IHDR 固定偏移：大端 u32 宽/高）；非法 PNG 返回 null */
export function pngSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
  if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

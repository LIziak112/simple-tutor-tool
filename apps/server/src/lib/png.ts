/**
 * PNG 字节级小原语（T6R.5 复审⑥从 ink-service 上提共享）：
 * - PNG_MAGIC + pngSize：魔数与 IHDR 尺寸解析（不解码像素数据）；
 * - pngIntact：完整性口径（魔数 + IHDR 长度=13 + 尾部 IEND 哨兵）；
 * - 消费方：ink-service（快照校验，pngSize 宽松口径——历史行为不变）、
 *   note-service（补图完整性校验 pngIntact——收编后不再跨域 import ink-service）。
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

/**
 * PNG 完整性校验（复审轮③——比 pngSize 严一档，供上传通道用）：
 * - 魔数 + IHDR 标签 + **IHDR 长度字段恒 13**（大端 u32 @8）；
 * - 尾部 IEND 哨兵：PNG 文件必以 IEND 块结尾（长度 0 + "IEND" + CRC4 =
 *   末 12 字节），最廉实现取 len-8..len-4 判 "IEND"（不做逐块遍历与 CRC）；
 * - 截断文件（丢尾块）与私造头部长度在此被拒。
 */
export function pngIntact(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  const size = pngSize(bytes);
  if (size === null) return null;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.readUInt32BE(8) !== 13) return null;
  if (buf.length < 24 + 12) return null;
  if (buf.toString("latin1", buf.length - 8, buf.length - 4) !== "IEND") {
    return null;
  }
  return size;
}

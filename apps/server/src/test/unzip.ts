import { inflateRawSync } from "node:zlib";

/**
 * 测试内嵌的最小 zip 解包器（export-service.test 与 teacher-export.test 共享，
 * 原 export-service.test 内联版收敛）：central directory 权威口径；不引入新
 * 依赖——技术栈清单无解压库，EOCD → CD → local header → inflateRaw。
 */
export function unzipEntries(buffer: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(buffer);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("测试夹具：zip 缺少 EOCD");
  const count = buf.readUInt16LE(eocd + 10);
  let cursor = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("测试夹具：central directory 签名错误");
    }
    const method = buf.readUInt16LE(cursor + 10);
    const compSize = buf.readUInt32LE(cursor + 20);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString("utf8", cursor + 46, cursor + 46 + nameLen);
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`测试夹具：${name} 的 local header 签名错误`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

import { crc32 } from "node:zlib";

/**
 * 测试夹具：手工构造最小 stored（method 0）zip——本地文件头 + 中央目录 + EOCD，
 * 逐条 CRC 正确、条目名原样写入（archiver 会清洗 ../ 之类的名字，危险条目名只能
 * 手打）。zip-import-service.test（危险条目名）与 attachment-format.test（docx
 * 识别按中央目录判定）共用；生产代码的读取端是 lib/zip-read.ts。
 */

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
}
function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

export function storedZipOf(
  files: ReadonlyArray<{ name: string; data: Buffer }>,
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), // 本地文件头签名
      u16(20), // 版本
      u16(0x0800), // UTF-8 名标志
      u16(0), // method 0 = stored
      u16(0),
      u16(0), // 时间 / 日期
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      data,
    ]);
    locals.push(local);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50), // 中央目录签名
        u16(20),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(nameBuf.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBuf,
      ]),
    );
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  return Buffer.concat([
    ...locals,
    cd,
    u32(0x06054b50), // EOCD 签名
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(cd.length),
    u32(offset),
    u16(0),
  ]);
}

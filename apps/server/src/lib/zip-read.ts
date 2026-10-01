import { inflateRawSync, crc32 as zlibCrc32 } from "node:zlib";

/**
 * 最小 zip 读取器（T4.5 恢复用，只读不写；写入端是 archiver）。
 *
 * 为什么手写：技术栈内只有 archiver（只打包不解包），红线禁止新增依赖，
 * Node 内置 zlib 能解 deflate 但不懂 zip 容器——因此按 zip 格式规范
 * （APPNOTE）解析中央目录 + 本地文件头，用 inflateRawSync 解压。
 *
 * 范围与取舍（一对一自部署场景，zip 来源 = 本系统下载的备份）：
 * - 支持 method 0（stored）与 method 8（deflate）——archiver 的全部输出形态；
 * - 逐条 CRC32 校验（zlib.crc32，Node ≥22.2 内置），损坏即整体拒绝；
 * - 不支持 ZIP64（>4GB 或 >65535 条目：中央目录字段为哨兵值时明确报错）；
 * - 文件名按 UTF-8 解码（archiver 对非 ASCII 名置 UTF-8 标志；
 *   legacy cp437 编码的第三方 zip 超出范围，解码失败会按替换字符落名，
 *   随后白名单校验拒绝未知顶层名，不会误装）；
 * - 条目名安全校验（isSafeZipEntryName）：拒绝绝对路径、反斜杠、`..` 段、
 *   盘符与 NUL——恢复侧纵深防御（备份 service 还有一层白名单）。
 * 全部失败路径抛 ZipReadError（中文说明），不抛裸 RangeError。
 */

/** 读取出的 zip 条目：解压后的完整字节与原始条目名（'/' 分隔） */
export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** zip 解析失败（损坏 / 结构不符 / 不支持的特性），message 为中文说明 */
export class ZipReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipReadError";
  }
}

// ---------- 签名与常量（见 APPNOTE） ----------

/** 中央目录结尾记录（End of Central Directory）签名 */
const EOCD_SIGNATURE = 0x06054b50;
/** 中央目录文件头签名 */
const CENTRAL_SIGNATURE = 0x02014b50;
/** 本地文件头签名 */
const LOCAL_SIGNATURE = 0x04034b50;
/** EOCD 最小长度（固定 22 字节，不含注释） */
const EOCD_MIN_SIZE = 22;
/** zip 注释最大长度（u16），EOCD 向后扫描的边界 */
const MAX_COMMENT_SIZE = 0xffff;

/** u16 / u32 小端读取；越界抛 ZipReadError（翻译 Node 的 RangeError） */
function u16(buffer: Buffer, offset: number): number {
  try {
    return buffer.readUInt16LE(offset);
  } catch {
    throw new ZipReadError("压缩包损坏（读取越界）");
  }
}

function u32(buffer: Buffer, offset: number): number {
  try {
    return buffer.readUInt32LE(offset);
  } catch {
    throw new ZipReadError("压缩包损坏（读取越界）");
  }
}

/** 从末尾定位 EOCD（考虑最多 64KB 注释）；找不到抛错 */
function findEocd(buffer: Buffer): number {
  const scanEnd = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= scanEnd; i -= 1) {
    if (u32(buffer, i) === EOCD_SIGNATURE) {
      return i;
    }
  }
  throw new ZipReadError("压缩包损坏（不是有效的 zip 文件）");
}

/**
 * 条目名安全校验：拒绝会逃出解压目录或引入歧义路径的名字。
 * 规则：非空；不含 NUL 与反斜杠；不以 '/' 开头（绝对路径）；无盘符
 * （第二字符为 ':'）；'/' 分段后无空段、'.' 与 '..' 段（干净相对路径）。
 */
export function isSafeZipEntryName(name: string): boolean {
  if (name.length === 0 || name.includes("\0") || name.includes("\\")) {
    return false;
  }
  if (name.startsWith("/")) {
    return false;
  }
  // 盘符（c:、D:\ 等）——Windows 绝对路径
  if (name.length >= 2 && name[1] === ":") {
    return false;
  }
  const segments = name.split("/");
  // 任一段为空（"a//b"）、"."（"a/./b"）或 ".."（"../x"）都拒绝——
  // 合法备份条目名只会是干净的相对路径
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return false;
  }
  return true;
}

/**
 * 解析 zip 并解压全部文件条目。
 * - 目录条目（名以 '/' 结尾）跳过（目录在恢复落位时按需创建）；
 * - 逐条校验签名、方法、大小与 CRC32，任一不符抛 ZipReadError；
 * - 顺序按中央目录出现顺序（稳定）。
 */
export function readZipEntries(buffer: Buffer): ZipEntry[] {
  const eocd = findEocd(buffer);
  const entryCount = u16(buffer, eocd + 10);
  const centralOffset = u32(buffer, eocd + 16);

  // ZIP64 哨兵值：条目数或偏移占满 16/32 位说明是 ZIP64 打包
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    throw new ZipReadError("不支持 ZIP64 格式的压缩包");
  }
  if (entryCount === 0) {
    throw new ZipReadError("压缩包为空");
  }

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (u32(buffer, cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipReadError("压缩包损坏（中央目录签名不符）");
    }
    const flags = u16(buffer, cursor + 8);
    const method = u16(buffer, cursor + 10);
    const crcExpected = u32(buffer, cursor + 16);
    const compressedSize = u32(buffer, cursor + 20);
    const uncompressedSize = u32(buffer, cursor + 24);
    const nameLength = u16(buffer, cursor + 28);
    const extraLength = u16(buffer, cursor + 30);
    const commentLength = u16(buffer, cursor + 32);
    const localOffset = u32(buffer, cursor + 42);
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");

    // 加密位（bit 0）：不是本系统备份的形态，明确拒绝
    if ((flags & 0x0001) !== 0) {
      throw new ZipReadError("不支持加密的压缩包");
    }

    // 目录条目：跳过（内容条目自带完整路径）
    if (name.endsWith("/")) {
      cursor += 46 + nameLength + extraLength + commentLength;
      continue;
    }
    if (!isSafeZipEntryName(name)) {
      throw new ZipReadError(`压缩包含不安全的条目名：${name}`);
    }

    // 本地文件头：只取名字/额外段长度以定位数据起点（大小以中央目录为准）
    if (u32(buffer, localOffset) !== LOCAL_SIGNATURE) {
      throw new ZipReadError("压缩包损坏（本地文件头签名不符）");
    }
    const localNameLength = u16(buffer, localOffset + 26);
    const localExtraLength = u16(buffer, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) {
      // stored：原样字节
      data = Buffer.from(compressed);
    } else if (method === 8) {
      // deflate：raw inflate（zip 的 deflate 不带 zlib 头）
      try {
        data = inflateRawSync(compressed);
      } catch {
        throw new ZipReadError(`压缩包损坏（条目解压失败：${name}）`);
      }
    } else {
      throw new ZipReadError(
        `不支持的压缩方法（条目 ${name}，方法码 ${method}）`,
      );
    }

    if (data.length !== uncompressedSize) {
      throw new ZipReadError(`压缩包损坏（条目大小不符：${name}）`);
    }
    if (zlibCrc32(data) !== crcExpected) {
      throw new ZipReadError(`压缩包损坏（条目校验失败：${name}）`);
    }

    entries.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  if (entries.length === 0) {
    throw new ZipReadError("压缩包内没有文件");
  }
  return entries;
}

import { inflateRawSync, crc32 as zlibCrc32 } from "node:zlib";

/**
 * 最小 zip 读取器（T4.5 恢复用，只读不写；写入端是 archiver）。
 *
 * 为什么手写：技术栈内只有 archiver（只打包不解包），红线禁止新增依赖，
 * Node 内置 zlib 能解 deflate 但不懂 zip 容器——因此按 zip 格式规范
 * （APPNOTE）解析中央目录 + 本地文件头，用 inflateRawSync 解压。
 * 另提供 listZipEntryNames（只走中央目录、不解压、不校验条目名安全）——
 * 资料附件按包结构识别 docx 用（attachment-format）。
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
    if (
      u32(buffer, i) === EOCD_SIGNATURE &&
      i + EOCD_MIN_SIZE + u16(buffer, i + 20) === buffer.length
    ) {
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

export class ZipBudgetError extends ZipReadError {
  constructor(message: string) {
    super(message);
    this.name = "ZipBudgetError";
  }
}

export interface ZipReadOptions {
  readonly names?: ReadonlySet<string>;
  readonly maxEntries?: number;
  readonly maxEntryBytes?: number;
  readonly maxTotalBytes?: number;
}

/** 经过结构与预算预检的条目，压缩数据引用输入的对应片段。 */
export interface ZipEntryPlan {
  readonly name: string;
  readonly method: 0 | 8;
  readonly compressed: Buffer;
  readonly uncompressedSize: number;
  readonly crcExpected: number;
}

/** Map 形态快捷读取，服务端测试与 E2E 共用。 */
export function readZipEntriesMap(buffer: Buffer): Map<string, Buffer> {
  return new Map(
    readZipEntries(buffer).map((entry) => [entry.name, entry.data]),
  );
}

function centralDirectoryOf(buffer: Buffer) {
  const eocd = findEocd(buffer);
  const entryCount = u16(buffer, eocd + 10);
  const centralSize = u32(buffer, eocd + 12);
  const centralOffset = u32(buffer, eocd + 16);
  if (
    entryCount === 0xffff ||
    centralOffset === 0xffffffff ||
    centralSize === 0xffffffff
  ) {
    throw new ZipReadError("不支持 ZIP64 格式的压缩包");
  }
  if (entryCount === 0) throw new ZipReadError("压缩包为空");
  if (
    u16(buffer, eocd + 4) !== 0 ||
    u16(buffer, eocd + 6) !== 0 ||
    u16(buffer, eocd + 8) !== entryCount
  ) {
    throw new ZipReadError("不支持分卷的压缩包");
  }
  const centralEnd = centralOffset + centralSize;
  if (centralEnd > eocd) throw new ZipReadError("压缩包损坏（中央目录越界）");
  return { entryCount, centralOffset, centralEnd };
}

function* centralEntries(
  buffer: Buffer,
  directory: ReturnType<typeof centralDirectoryOf>,
) {
  let offset = directory.centralOffset;
  for (let index = 0; index < directory.entryCount; index += 1) {
    if (
      offset + 46 > directory.centralEnd ||
      u32(buffer, offset) !== CENTRAL_SIGNATURE
    ) {
      throw new ZipReadError("压缩包损坏（中央目录签名不符）");
    }
    const nameEnd = offset + 46 + u16(buffer, offset + 28);
    const next = nameEnd + u16(buffer, offset + 30) + u16(buffer, offset + 32);
    if (next > directory.centralEnd)
      throw new ZipReadError("压缩包损坏（读取越界）");
    yield {
      name: buffer.subarray(offset + 46, nameEnd).toString("utf8"),
      offset,
    };
    offset = next;
  }
}

/** 只列中央目录中的条目名，供探测 Office 包结构。 */
export function listZipEntryNames(buffer: Buffer): string[] {
  return Array.from(
    centralEntries(buffer, centralDirectoryOf(buffer)),
    (entry) => entry.name,
  );
}

function formatBudget(bytes: number): string {
  const mib = 1024 * 1024;
  return bytes % mib === 0 ? `${bytes / mib} MB` : `${bytes} 字节`;
}

function entryPlanOf(
  buffer: Buffer,
  offset: number,
  centralOffset: number,
  name: string,
): ZipEntryPlan {
  const flags = u16(buffer, offset + 8);
  const method = u16(buffer, offset + 10);
  const crcExpected = u32(buffer, offset + 16);
  const compressedSize = u32(buffer, offset + 20);
  const uncompressedSize = u32(buffer, offset + 24);
  const localOffset = u32(buffer, offset + 42);
  if ((flags & 1) !== 0) throw new ZipReadError("不支持加密的压缩包");
  if (method !== 0 && method !== 8) {
    throw new ZipReadError(
      `不支持的压缩方法（条目 ${name}，方法码 ${method}）`,
    );
  }
  if (method === 0 && compressedSize !== uncompressedSize) {
    throw new ZipReadError(`压缩包损坏（条目大小不符：${name}）`);
  }
  if (
    localOffset + 30 > centralOffset ||
    u32(buffer, localOffset) !== LOCAL_SIGNATURE
  ) {
    throw new ZipReadError("压缩包损坏（本地文件头签名不符）");
  }
  const localNameEnd = localOffset + 30 + u16(buffer, localOffset + 26);
  const dataStart = localNameEnd + u16(buffer, localOffset + 28);
  const dataEnd = dataStart + compressedSize;
  if (
    dataEnd > centralOffset ||
    u16(buffer, localOffset + 8) !== method ||
    (u16(buffer, localOffset + 6) & 1) !== 0 ||
    buffer.subarray(localOffset + 30, localNameEnd).toString("utf8") !== name
  ) {
    throw new ZipReadError(`压缩包损坏（条目位置不符：${name}）`);
  }
  return {
    name,
    method,
    compressed: buffer.subarray(dataStart, dataEnd),
    uncompressedSize,
    crcExpected,
  };
}

/** 先完成整个目录的路径、结构与展开预算校验，再允许解压任一条目。 */
export function planZipEntries(
  buffer: Buffer,
  options: ZipReadOptions = {},
): ZipEntryPlan[] {
  const directory = centralDirectoryOf(buffer);
  if (
    options.maxEntries !== undefined &&
    directory.entryCount > options.maxEntries
  ) {
    throw new ZipBudgetError(
      `压缩包条目数超过上限（最多 ${options.maxEntries} 个，当前 ${directory.entryCount} 个）`,
    );
  }
  const entries: ZipEntryPlan[] = [];
  const names = new Set<string>();
  let total = 0;
  for (const { name, offset } of centralEntries(buffer, directory)) {
    if (options.names && !options.names.has(name)) continue;
    const isDirectory = name.endsWith("/");
    if (!isSafeZipEntryName(isDirectory ? name.slice(0, -1) : name)) {
      throw new ZipReadError(`压缩包含不安全的条目名：${name}`);
    }
    if (isDirectory) continue;
    if (names.has(name)) throw new ZipReadError(`压缩包包含重复条目：${name}`);
    names.add(name);
    const entry = entryPlanOf(buffer, offset, directory.centralOffset, name);
    if (
      options.maxEntryBytes !== undefined &&
      entry.uncompressedSize > options.maxEntryBytes
    ) {
      throw new ZipBudgetError(
        `压缩包条目「${name}」展开后超过 ${formatBudget(options.maxEntryBytes)} 上限`,
      );
    }
    total += entry.uncompressedSize;
    if (options.maxTotalBytes !== undefined && total > options.maxTotalBytes) {
      throw new ZipBudgetError(
        `压缩包解压后合计超过 ${formatBudget(options.maxTotalBytes)} 上限`,
      );
    }
    entries.push(entry);
  }
  if (entries.length === 0) throw new ZipReadError("压缩包内没有文件");
  return entries;
}

export function assertZipEntryIntegrity(
  entry: ZipEntryPlan,
  bytes: number,
  crc: number,
): void {
  if (bytes !== entry.uncompressedSize) {
    throw new ZipReadError(`压缩包损坏（条目大小不符：${entry.name}）`);
  }
  if (crc !== entry.crcExpected) {
    throw new ZipReadError(`压缩包损坏（条目校验失败：${entry.name}）`);
  }
}

/** 小体积调用方按中央目录顺序完整读取，逐条校验实际展开大小与 CRC32。 */
export function readZipEntries(
  buffer: Buffer,
  options?: ZipReadOptions,
): ZipEntry[] {
  return planZipEntries(buffer, options).map((entry) => {
    let data: Buffer;
    try {
      data =
        entry.method === 0
          ? Buffer.from(entry.compressed)
          : inflateRawSync(entry.compressed, {
              maxOutputLength: Math.max(1, entry.uncompressedSize),
            });
    } catch {
      throw new ZipReadError(`压缩包损坏（条目解压失败：${entry.name}）`);
    }
    assertZipEntryIntegrity(entry, data.byteLength, zlibCrc32(data));
    return { name: entry.name, data };
  });
}

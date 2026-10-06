import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { HttpError } from "./http-error";

/**
 * blobs 落盘 IO 共享原语（T6R.4 复审①从 ink-service/note-service/media-service
 * 抽取的小型公用件——只抽机制，错误码/分级语义留在各调用方）：
 * - parseGzipOrJsonBytes：gzip 魔数识别 + 解压上限 + UTF-8 文本化；
 * - writeFileAtomic：唯一临时文件 + rename 原子落位 + 失败清理
 *   （note 版语义为准；ink/media 原固定 tmp 名实现换用，顺带修并发短板）；
 * - resolveWithinRoot：path.relative 目录边界校验（强算法唯一实现，
 *   ink 旧 startsWith 弱实现一并换用——同前缀相邻目录不再可能骗过）。
 */

// ---------- gzip / 原始 JSON 兼容解析 ----------

/** gzip 魔数（1f 8b）：前端 CompressionStream 压缩；老浏览器回退发原始 JSON */
const GZIP_MAGIC = 0x1f8b;

/** 模块级解码器（无状态可复用；TextDecoder 直读 Uint8Array 视图不整包拷贝） */
const utf8Decoder = new TextDecoder();

/**
 * 上传字节 → JSON 文本（机制层；JSON.parse 与 schema 校验在调用方）：
 * - gzip 魔数开头 → gunzip（maxOutputLength 防高压缩比炸弹：超限 Node 抛
 *   code=ERR_BUFFER_TOO_LARGE 的 RangeError，数据损坏抛 Z_DATA_ERROR——
 *   两者如何映射 400/413 由各调用方分级，本函数原样抛出）；
 * - 否则按原始 JSON 文本解码（TextDecoder.decode 非 fatal：非法 UTF-8 以
 *   U+FFFD 替换不抛错，与 Buffer.toString("utf8") 行为一致，坏数据交给
 *   调用方的 JSON.parse 拒绝）。
 * - 已知宽容差异（复审⑨，有意保留）：TextDecoder 会**剥掉**开头的
 *   U+FEFF BOM 而 Buffer.toString("utf8") 原样保留——带 BOM 的原始 JSON
 *   上传在旧实现走 JSON.parse 抛错 400，现在能解析成功。方向是放宽而非
 *   收紧（Windows 记事本类工具常带 BOM），ink 通道换用本函数后同样放宽。
 */
export function parseGzipOrJsonBytes(
  bytes: Uint8Array,
  opts: { maxDecompressed: number },
): string {
  const isGzip =
    bytes.length >= 2 && (bytes[0] ?? 0) * 256 + (bytes[1] ?? 0) === GZIP_MAGIC;
  if (!isGzip) {
    return utf8Decoder.decode(bytes);
  }
  return utf8Decoder.decode(
    gunzipSync(bytes, { maxOutputLength: opts.maxDecompressed }),
  );
}

// ---------- 原子写（唯一临时文件 → rename） ----------

/** 原子写故障注入钩子（测试专用，生产恒不传；调用方示例见 note-service） */
export interface AtomicFileFaults {
  /** 临时文件写之前触发（模拟磁盘写失败/此刻崩溃） */
  beforeTmpWrite?: () => void;
  /** 临时文件写完、rename 之前触发（测试可捕获 tmp 名；模拟此刻中断） */
  beforeRename?: () => void;
  /** rename 落位后触发（模拟调用方后续步骤〔如 DB 事务〕失败/此刻崩溃） */
  afterRename?: () => void;
}

/**
 * 原子写文件：写唯一临时文件 → rename 到最终路径（写一半崩溃不留半截文件；
 * rename 落位即对读者可见完整内容）。
 * - 临时文件名缺省 `.tmp-<randomUUID>`：**每次调用唯一**，并发请求永不共享
 *   tmp（ink/media 旧版固定 `<名>.tmp` 在并发同路径上传时会互相覆盖/清理
 *   对方的临时文件——换用本实现后消除）；
 * - 目标目录懒建（父路径被同名文件占据等异常形态由 mkdirSync 原样抛出）；
 * - 写/rename 失败：清理本次临时文件再抛（钩子抛错同样走清理路径）。
 */
export function writeFileAtomic(params: {
  /** 最终路径（绝对路径；临时文件写在其所在目录） */
  finalPath: string;
  bytes: Uint8Array;
  /** 测试故障注入钩子（生产恒不传） */
  faults?: AtomicFileFaults;
}): void {
  const dir = dirname(params.finalPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  params.faults?.beforeTmpWrite?.();
  try {
    writeFileSync(tmpPath, params.bytes);
    params.faults?.beforeRename?.();
    renameSync(tmpPath, params.finalPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp 尚未创建（写失败）或已被清理——无需处理
    }
    throw err;
  }
  params.faults?.afterRename?.();
}

// ---------- 目录边界校验 ----------

/**
 * 相对路径 → 绝对路径，并校验落在 dataDir 内指定根目录（如 blobs/ink、
 * blobs/notes、blobs/media）的真子路径内。
 *
 * 算法用 path.relative 判定（越界 ⇔ 结果为空串=根本身、以 .. 开头、或为
 * 绝对路径）——**不是**字符串 startsWith：`blobs/notes-evil` 能骗过
 * `abs.startsWith(root("blobs/notes"))`，骗不过 relative 判定。
 *
 * 违例抛 HttpError(500)：violationCode 由调用方传入以保留各自错误码
 * （ink 传 INK_UNREADABLE、note 传 NOTE_BODY_PATH_INVALID）；suffix 传
 * null/undefined 跳过后缀检查（白名单后缀是纵深防御，不是访问控制）。
 */
export function resolveWithinRoot(
  dataDir: string,
  rootRel: string,
  relPath: string,
  opts: { suffix?: string; violationCode: string },
): string {
  const root = resolve(dataDir, rootRel);
  const abs = resolve(dataDir, relPath);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new HttpError(
      500,
      opts.violationCode,
      "文件路径越界（不在允许的 blobs 目录内）",
    );
  }
  if (opts.suffix !== undefined && !abs.endsWith(opts.suffix)) {
    throw new HttpError(500, opts.violationCode, "文件路径后缀非法");
  }
  return abs;
}

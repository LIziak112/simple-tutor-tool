import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  NOTE_BODY_DECOMPRESSED_MAX_BYTES,
  NOTE_BODY_GZIP_MAX_BYTES,
  type NoteDoc,
  noteDocSchema,
  noteIssueIsLimit,
} from "@tutor/contract";
import {
  type AtomicFileFaults,
  parseGzipOrJsonBytes,
  resolveWithinRoot,
  writeFileAtomic,
} from "../lib/blob-io.ts";
import { HttpError } from "../lib/http-error.ts";

// ---------- 路径规则与目录边界 ----------

/** 不可变正文文件名：v<revision>-<hash 前 12 位>.json.gz（三段全服务端生成） */
function noteBodyFileName(revision: number, hash: string): string {
  return `v${revision}-${hash.slice(0, 12)}.json.gz`;
}

/** 不可变正文相对路径（DATA_DIR 内）：blobs/notes/<noteId>/<文件名> */
export function noteBodyRelPath(
  noteId: string,
  revision: number,
  hash: string,
): string {
  // 入库串固定用 "/" 分隔（复审⑦）：join() 在 Windows 产反斜杠会让存储
  // 路径形态跨平台漂移；读侧 path.resolve/relative 本就双兼容两种分隔符，
  // 不需要迁移——本表未发布，无存量回填负担
  return ["blobs", "notes", noteId, noteBodyFileName(revision, hash)].join("/");
}

/**
 * 相对路径 → 绝对路径，并做**目录边界**校验（方案 §6.3：路径包含关系不能
 * 只用字符串 startsWith——blobs/notes-evil 会骗过 startsWith(blobs/notes)）。
 * 强算法唯一实现在 lib/blob-io 的 resolveWithinRoot（path.relative 判定），
 * 本函数是携带 note 域错误码与 .json.gz 后缀的薄壳。
 */
export function resolveNoteBodyPath(dataDir: string, relPath: string): string {
  return resolveNoteBlobPath(dataDir, relPath, ".json.gz");
}

/** 派生图等其它 notes 域内文件的边界校验（后缀可指定；T6R.6/GC 用） */
export function resolveNoteBlobPath(
  dataDir: string,
  relPath: string,
  suffix: string | undefined,
): string {
  return resolveWithinRoot(dataDir, join("blobs", "notes"), relPath, {
    ...(suffix ? { suffix } : {}),
    violationCode: "NOTE_BODY_PATH_INVALID",
  });
}

// ---------- 正文解析与限额（契约 NOTE_LIMIT_EXCEEDED / NOTE_VALIDATION_FAILED 分级） ----------

/**
 * 上传字节 → NoteDoc（先验后写，坏数据不落盘）：
 * - 接收字节（gzip 后或原始 JSON）超 NOTE_BODY_GZIP_MAX_BYTES → 413；
 * - gzip 解压（机制在 lib/blob-io.parseGzipOrJsonBytes，解压上限
 *   NOTE_BODY_DECOMPRESSED_MAX_BYTES）：超限 Node 抛 ERR_BUFFER_TOO_LARGE
 *   → 413 高压缩比炸弹；数据损坏 Z_DATA_ERROR → 400；
 * - JSON 非法 / 不符合 noteDocSchema → 400；其中限额类校验问题（单笔/总
 *   点数，契约 superRefine 以 params.limit===true 结构标记）→ 413。
 */
export function parseNoteBodyBytes(bytes: Uint8Array): NoteDoc {
  if (bytes.byteLength > NOTE_BODY_GZIP_MAX_BYTES) {
    throw new HttpError(
      413,
      "NOTE_LIMIT_EXCEEDED",
      `草稿正文超过 ${NOTE_BODY_GZIP_MAX_BYTES / (1024 * 1024)}MiB 上传限额（暂定值），请精简后重试`,
    );
  }
  let jsonText: string;
  try {
    jsonText = parseGzipOrJsonBytes(bytes, {
      maxDecompressed: NOTE_BODY_DECOMPRESSED_MAX_BYTES,
    });
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new HttpError(
        413,
        "NOTE_LIMIT_EXCEEDED",
        "草稿解压后超过 32MiB 上限（高压缩比数据），请精简后重试",
      );
    }
    throw new HttpError(
      400,
      "NOTE_VALIDATION_FAILED",
      "草稿数据解压失败（不是合法的 gzip 文档）",
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonText) as unknown;
  } catch {
    throw new HttpError(
      400,
      "NOTE_VALIDATION_FAILED",
      "草稿正文不是合法的 JSON 文档",
    );
  }
  const parsed = noteDocSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "NoteDoc 结构不合法";
    // 复杂度超预算（413）与形状错误（400）分级：契约限额 issue 携带结构
    // 标记 params.limit===true（判据集中在契约 noteIssueIsLimit，措辞无关
    // ——勿退回中文消息子串匹配）。混合错误（形状+限额并存）按限额口径
    // 413，且消息取限额 issue 自己的文案（复审⑥：限额消息自带
    // 「（N > 上限，暂定值）」数值，比首条 issue 更可诊断）
    const limitIssue = parsed.error.issues.find(noteIssueIsLimit);
    if (limitIssue !== undefined) {
      throw new HttpError(413, "NOTE_LIMIT_EXCEEDED", limitIssue.message);
    }
    throw new HttpError(
      400,
      "NOTE_VALIDATION_FAILED",
      `草稿文档不合法：${first}`,
      // 圈画审查 P0-1：错误体附 zod issue 路径与文案（不含正文）——线上
      // 卡死记录（如 12fed1e6/5.3-36）此前日志与响应都不含字段位置，无法
      // 定位坏字段；路径字符串无内容语义，随响应壳下发不放宽任何投影
      {
        _issues: parsed.error.issues.slice(0, 5).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    );
  }
  return parsed.data;
}

// ---------- 不可变文件写入（唯一临时文件 → rename） ----------

/**
 * 规范化正文字节 → gzip → 唯一临时文件 → rename 到不可变路径。
 * 机制（唯一 tmp 名/失败清理/故障钩子 AtomicFileFaults）在
 * lib/blob-io.writeFileAtomic；本函数只补 note 域两件事：按
 * (noteId, revision, hash) 定不可变路径 + 目录边界校验。亦导出供测试
 * 直接构造「rename 前/后中断」的崩溃现场。rename 目标与已确认版本同名
 * 的场景只可能是「上次崩溃留下的未引用孤儿」（同 hash 必同字节），
 * 覆盖无害。
 */
export function writeNoteBodyFile(
  dataDir: string,
  noteId: string,
  revision: number,
  hash: string,
  canonicalBytes: Uint8Array,
  faults?: AtomicFileFaults,
): void {
  const relPath = noteBodyRelPath(noteId, revision, hash);
  const absPath = resolveNoteBodyPath(dataDir, relPath);
  writeFileAtomic({
    finalPath: absPath,
    bytes: gzipSync(canonicalBytes),
    ...(faults !== undefined ? { faults } : {}),
  });
}

/**
 * best-effort 删除 notes 域内文件（复审轮⑮参数化后缀，正文/图片三处共用）：
 * 文件未创建（写/rename 前失败）或已被删除时静默；域外路径仍会被
 * resolveNoteBlobPath 边界校验拦下（500 不吞）。
 */
export function cleanupNoteFile(
  dataDir: string,
  relPath: string,
  suffix: ".json.gz" | ".png",
): void {
  try {
    unlinkSync(resolveNoteBlobPath(dataDir, relPath, suffix));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // 文件未落位或已被删——无需处理
  }
}

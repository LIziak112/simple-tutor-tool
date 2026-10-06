import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INK_MAX_UPLOAD_BYTES,
  type InkDoc,
  type InkMeta,
  type InkUploadData,
  inkDocSchema,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts, type InkRow, ink, students } from "../db/schema";
import {
  parseGzipOrJsonBytes,
  resolveWithinRoot,
  writeFileAtomic,
} from "../lib/blob-io";
import { HttpError } from "../lib/http-error";
import {
  requireAttemptQuestion,
  requireUsableAttempt,
} from "./attempt-service";

/**
 * InkService（T2.8）——手写笔迹的文件存储与元数据管理（架构 §5.2/§5.4）。
 *
 * 核心设计（db-change 红线：笔迹不进数据库、不用 base64）：
 * - 矢量文档：gzip 后写 `DATA_DIR/blobs/ink/<attemptId>/<安全名>.json.gz`；
 * - 快照 PNG：写同目录 `<安全名>.png`；
 * - 数据库 ink 表只存相对路径与元数据（width/height/strokeCount/updatedAt）；
 * - 同题再上传幂等覆盖：文件经 lib/blob-io.writeFileAtomic 原子替换（唯一
 *   临时文件 + rename，写一半崩溃不会留下半截文件），行 upsert 且 id 保持
 *   不变（教师端 inkId 引用稳定）。
 *
 * 路径安全：questionId 来自 DSL（可能含中文/点/`../`），落盘前经 safeInkFileName
 * 映射成安全文件名（encodeURIComponent + 超长/Windows 保留名回退 hash），
 * 且最终路径强制校验落在 blobs/ink/<attemptId> 目录内（纵深防御，测试锁定）。
 *
 * 限额口径（契约 INK_MAX_UPLOAD_BYTES）：gzip 后 strokes 字节数 + PNG 字节数
 * 之和 ≤ 2 MiB，超出 413 INK_TOO_LARGE（T2.8 验收项）；解压侧另有 32 MiB
 * 解压上限（INK_MAX_STROKES_UNCOMPRESSED，防 gzip 炸弹，超出 400 INK_INVALID）。
 *
 * T2B.5 教师域（D10/D12）：教师侧取笔迹按 ink → attempt → student.teacherId
 * 判定归属（乙取甲学生的笔迹 → 404，不暴露存在性）；学生侧接口按 attemptId
 * （requireUsableAttempt 归属即权限）天然隔离，行为不变。
 */

/** questionId → 安全文件名（不含扩展名）。export 供测试锁定路径安全行为 */
export function safeInkFileName(questionId: string): string {
  // 统一前缀避免 Windows 保留名（CON/PRN/COM1…）与空段
  const encoded = `q-${encodeURIComponent(questionId)}`;
  if (encoded.length <= 120 && !encoded.includes("%00")) {
    return encoded;
  }
  // 编码后过长（中文每字符 9 字节，超长 id 会突破文件名 255 上限）：改用内容 hash
  return `q-${createHash("sha256").update(questionId).digest("hex").slice(0, 40)}`;
}

/** PNG 魔数（\x89PNG\r\n\x1a\n） */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 相对路径（DATA_DIR 内）→ 绝对路径，并校验不越出 blobs/ink 根（纵深防御）。
 * 边界算法在 lib/blob-io.resolveWithinRoot（path.relative 强判定——T6R.4 复审
 * ①换掉旧 startsWith 弱实现：同前缀相邻目录不再可能骗过）；suffix 传空串
 * 表示不做后缀检查（旧签名兼容口径）。
 */
function inkFileAbs(dataDir: string, relPath: string, suffix: string): string {
  return resolveWithinRoot(dataDir, join("blobs", "ink"), relPath, {
    suffix: suffix === "" ? null : suffix,
    violationCode: "INK_UNREADABLE",
  });
}

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
 * strokes 解压后体积上限（防 gzip 炸弹：上传限额只按压缩后字节计，≤2MiB 的
 * gzip 理论上可解出数百 MiB）。前端压缩比通常 5-10 倍，2MiB 压缩包对应
 * ~10-20MiB 原文，32MiB 留裕量；超限时 gunzipSync 抛错，落进 parseStrokesDoc
 * 现有的 400 INK_INVALID 处理路径。
 */
const INK_MAX_STROKES_UNCOMPRESSED = 32 * 1024 * 1024;

/**
 * strokes 字节 → InkDoc：
 * - gzip/原始 JSON 识别与解压上限的机制在 lib/blob-io.parseGzipOrJsonBytes
 *   （T6R.4 复审①抽取共用；错误分类留在此处：解压失败含超上限统一
 *   400 INK_INVALID，与既有口径一致）；
 * - JSON 非法 / 不符合 inkDocSchema → 400 INK_INVALID。
 */
function parseStrokesDoc(bytes: Uint8Array): InkDoc {
  let jsonText: string;
  try {
    jsonText = parseGzipOrJsonBytes(bytes, {
      maxDecompressed: INK_MAX_STROKES_UNCOMPRESSED,
    });
  } catch {
    throw new HttpError(
      400,
      "INK_INVALID",
      "笔迹数据解压失败（不是合法的 gzip/JSON，或解压后超过 32MB 上限）",
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonText) as unknown;
  } catch {
    throw new HttpError(400, "INK_INVALID", "笔迹数据不是合法的 JSON 文档");
  }
  const parsed = inkDocSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "InkDoc 结构不合法";
    throw new HttpError(400, "INK_INVALID", `笔迹文档不合法：${first}`);
  }
  return parsed.data;
}

/** InkDoc → strokeCount（引擎相关口径：atrament=strokes.length；excalidraw=elements.length） */
function strokeCountOf(doc: InkDoc): number {
  return doc.engine === "atrament"
    ? doc.data.strokes.length
    : doc.data.scene.elements.length;
}

/** 笔迹目录（懒建）：DATA_DIR/blobs/ink/<attemptId> */
function inkDir(dataDir: string, attemptId: string): string {
  const dir = join(dataDir, "blobs", "ink", attemptId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 取 ink 行：不存在 → 404 INK_NOT_FOUND */
function requireInkRow(db: Db, attemptId: string, questionId: string): InkRow {
  const row = db
    .select()
    .from(ink)
    .where(and(eq(ink.attemptId, attemptId), eq(ink.questionId, questionId)))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "INK_NOT_FOUND", "这道题还没有笔迹");
  }
  return row;
}

// ---------- PUT /api/student/attempts/:id/ink/:questionId ----------

/**
 * 上传/覆盖一道手写题的笔迹（multipart 解析后的两段字节）：
 * - attempt 不存在 → 404；非本人 → 403（验收项）；已交卷 → 409 ALREADY_SUBMITTED；
 * - 题目不属于该作业单元/已软删 → 404 QUESTION_NOT_FOUND；
 * - strokes+snapshot 合计超 2 MiB → 413 INK_TOO_LARGE（验收项）；
 * - strokes 不能解压 / 不符合 inkDocSchema，或 snapshot 不是 PNG → 400 INK_INVALID；
 * - 幂等覆盖：文件原子重写 + ink 行 upsert（id 不变），width/height 从 PNG IHDR
 *   提取（失败为 0），strokeCount 从 InkDoc 提取。
 */
export function saveInk(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  questionId: string,
  strokesBytes: Uint8Array,
  snapshotBytes: Uint8Array,
): InkUploadData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  if (attempt.status !== "draft") {
    throw new HttpError(
      409,
      "ALREADY_SUBMITTED",
      "这份作业已交卷，不能再修改笔迹",
    );
  }
  requireAttemptQuestion(db, attempt, questionId);

  // 限额（契约口径：gzip 后 strokes + png 合计）
  if (
    strokesBytes.byteLength + snapshotBytes.byteLength >
    INK_MAX_UPLOAD_BYTES
  ) {
    throw new HttpError(
      413,
      "INK_TOO_LARGE",
      `笔迹数据超过 2MB 限额（本次 ${(strokesBytes.byteLength + snapshotBytes.byteLength) / (1024 * 1024)} MB），请精简后重试`,
    );
  }

  // 校验 strokes（解压 + inkDocSchema）与 PNG 魔数——先验后写，坏数据不落盘
  const doc = parseStrokesDoc(strokesBytes);
  const size = pngSize(snapshotBytes);
  if (size === null) {
    throw new HttpError(400, "INK_INVALID", "快照不是合法的 PNG 文件");
  }

  // 落盘（原子替换：唯一 tmp + rename，机制在 lib/blob-io.writeFileAtomic——
  // T6R.4 复审①起 tmp 名每次唯一，并发上传不再共享/互清临时文件）
  const dir = inkDir(dataDir, attemptId);
  const base = safeInkFileName(questionId);
  const strokesPath = join(dir, `${base}.json.gz`);
  const pngPath = join(dir, `${base}.png`);
  writeFileAtomic({ finalPath: strokesPath, bytes: strokesBytes });
  writeFileAtomic({ finalPath: pngPath, bytes: snapshotBytes });

  // upsert ink 行（幂等覆盖保留 id）
  const now = new Date().toISOString();
  const strokeCount = strokeCountOf(doc);
  const relStrokes = join("blobs", "ink", attemptId, `${base}.json.gz`);
  const relPng = join("blobs", "ink", attemptId, `${base}.png`);
  // 单语句 upsert + RETURNING（复审⑩，仓库首例）：INSERT..ON CONFLICT..
  // RETURNING 返回受影响行的**实际值**（新插返回新行、冲突返回更新后的
  // 既有行）——drizzle 0.45 的 better-sqlite3 驱动把 RETURNING 行走
  // .get() 取首行，语义等价于 SQLite 原生 RETURNING；由此免掉前置点查，
  // inkId 稳定性由 DB 行本身保证（冲突分支不更新 id 列）
  const saved = db
    .insert(ink)
    .values({
      id: randomUUID(),
      attemptId,
      questionId,
      strokesPath: relStrokes,
      pngPath: relPng,
      width: size.width,
      height: size.height,
      strokeCount,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [ink.attemptId, ink.questionId],
      set: {
        strokesPath: relStrokes,
        pngPath: relPng,
        width: size.width,
        height: size.height,
        strokeCount,
        updatedAt: now,
      },
    })
    .returning({ id: ink.id })
    .get();
  if (saved === undefined) {
    // 防御：upsert 必有受影响行（drizzle/SQLite 契约），不可达
    throw new HttpError(500, "INTERNAL", "笔迹行写入失败");
  }
  const inkId = saved.id;

  return {
    questionId,
    inkId,
    strokeCount,
    width: size.width,
    height: size.height,
    updatedAt: now,
  };
}

// ---------- GET /api/student/attempts/:id/ink/:questionId ----------

/**
 * 取回该题当前的矢量文档（学生端草稿恢复/刷新后续写）：
 * - attempt 不存在 → 404；非本人 → 403（requireUsableAttempt 统一口径：course
 *   来源 draft 失去访问权 403/404；已交卷记录按只读保留）；draft 与已交卷都可取
 *   （看自己的笔迹不涉答案）；
 * - 无笔迹 → 404 INK_NOT_FOUND（前端据此跳过 load，从空白开始）。
 */
export function getInkDoc(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  questionId: string,
): InkDoc {
  requireUsableAttempt(db, studentId, attemptId);
  const row = requireInkRow(db, attemptId, questionId);
  // 读侧换共享 parseGzipOrJsonBytes（复审⑩三得）：免 new Uint8Array 整包
  // 拷贝、gzip/原始 JSON 双格式由机制层统一回退（替代手写二次 try）、
  // 补上读侧解压上限（落盘文件被替换成高压缩炸弹时不解出大 Buffer）
  let jsonText: string;
  try {
    jsonText = parseGzipOrJsonBytes(
      readFileSync(inkFileAbs(dataDir, row.strokesPath, ".json.gz")),
      { maxDecompressed: INK_MAX_STROKES_UNCOMPRESSED },
    );
  } catch (err) {
    if (err instanceof HttpError) throw err; // 边界校验码原样重抛
    throw new HttpError(
      500,
      "INK_UNREADABLE",
      "笔迹文件读取失败，请联系老师处理",
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonText) as unknown;
  } catch {
    throw new HttpError(500, "INK_UNREADABLE", "笔迹文件损坏，请联系老师处理");
  }
  const parsed = inkDocSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new HttpError(500, "INK_UNREADABLE", "笔迹文件损坏，请联系老师处理");
  }
  return parsed.data;
}

/** 笔迹落盘文件读取结果（路由直出用：PNG 快照与 gzip 矢量共用） */
export interface InkFile {
  /** 文件字节（独立 ArrayBuffer 拷贝，脱离 Node Buffer 视图——Response BodyInit 类型友好） */
  bytes: ArrayBuffer;
  /** 响应 ETag（行 id + updatedAt） */
  etag: string;
}

/** 学生取自己的笔迹 PNG（结果页缩略图；404/403 口径同 getInkDoc） */
export function getStudentInkPng(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  questionId: string,
): InkFile {
  requireUsableAttempt(db, studentId, attemptId);
  return readInkPng(db, dataDir, attemptId, questionId);
}

/** 读取落盘文件为独立 ArrayBuffer（Buffer 视图 → 拷贝；运行时类型即 ArrayBuffer） */
function readFileBytes(filePath: string): ArrayBuffer {
  const buf = readFileSync(filePath);
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

/** ink 行 + 文件 → PNG 字节（权限已由调用方校验） */
function readInkPng(
  db: Db,
  dataDir: string,
  attemptId: string,
  questionId: string,
): InkFile {
  const row = requireInkRow(db, attemptId, questionId);
  try {
    return {
      bytes: readFileBytes(inkFileAbs(dataDir, row.pngPath, ".png")),
      etag: `"${row.id}-${row.updatedAt}"`,
    };
  } catch {
    throw new HttpError(404, "INK_NOT_FOUND", "笔迹快照不存在");
  }
}

// ---------- GET /api/teacher/ink/:inkId(.png / .json.gz) ----------

/**
 * 按会话教师取 ink 行（T2B.5，D10/D12）：ink → attempt → student → teacherId
 * 判定归属——非本人学生的笔迹按不存在处理（404 INK_NOT_FOUND，不暴露存在性）。
 * ink.id 为 uuid 全局唯一，但归属链必须落到 students.teacherId 才放行。
 */
function requireTeacherInkRow(
  db: Db,
  teacherId: string,
  inkId: string,
): InkRow {
  const row = db
    .select({ ink: ink, ownerTeacherId: students.teacherId })
    .from(ink)
    .innerJoin(attempts, eq(ink.attemptId, attempts.id))
    .innerJoin(students, eq(attempts.studentId, students.id))
    .where(eq(ink.id, inkId))
    .get();
  if (row === undefined || row.ownerTeacherId !== teacherId) {
    throw new HttpError(404, "INK_NOT_FOUND", "笔迹记录不存在");
  }
  return row.ink;
}

/**
 * 教师按 inkId 取 PNG（批改页缩略图/大图）；不存在或非本人学生的笔迹 →
 * 404 INK_NOT_FOUND（T2B.5：归属校验在文件读取之前）。
 */
export function getTeacherInkPng(
  db: Db,
  dataDir: string,
  teacherId: string,
  inkId: string,
): InkFile {
  const row = requireTeacherInkRow(db, teacherId, inkId);
  try {
    return {
      bytes: readFileBytes(inkFileAbs(dataDir, row.pngPath, ".png")),
      etag: `"${row.id}-${row.updatedAt}"`,
    };
  } catch {
    throw new HttpError(404, "INK_NOT_FOUND", "笔迹快照不存在");
  }
}

/**
 * 教师按 inkId 取矢量文档 gzip 原字节（T3.3 笔迹回放，D12）：
 * - 归属口径同 getTeacherInkPng（乙取甲学生笔迹 → 404，不暴露存在性）；
 * - 响应体 = 落盘 .json.gz 逐字节原样回传（服务端不解不校验，解压消费在前端
 *   InkReplay）；IO 方式与 .png 分支一致（readFileBytes + inkFileAbs 后缀校验）；
 * - 文件缺失（或路径不带 .json.gz 后缀的存量行，inkFileAbs 抛错）→ 404
 *   INK_NOT_FOUND——前端据此降级为 PNG 快照 + 「无回放数据」提示（D12）。
 */
export function getTeacherInkStrokes(
  db: Db,
  dataDir: string,
  teacherId: string,
  inkId: string,
): InkFile {
  const row = requireTeacherInkRow(db, teacherId, inkId);
  try {
    return {
      bytes: readFileBytes(inkFileAbs(dataDir, row.strokesPath, ".json.gz")),
      etag: `"${row.id}-${row.updatedAt}"`,
    };
  } catch {
    throw new HttpError(404, "INK_NOT_FOUND", "笔迹矢量数据不存在");
  }
}

/** 教师取笔迹元数据（T3.1 批改页用）；不存在或非本人学生的笔迹 → 404 */
export function getTeacherInkMeta(
  db: Db,
  teacherId: string,
  inkId: string,
): InkMeta {
  const row = requireTeacherInkRow(db, teacherId, inkId);
  return {
    id: row.id,
    attemptId: row.attemptId,
    questionId: row.questionId,
    width: row.width,
    height: row.height,
    strokeCount: row.strokeCount,
    updatedAt: row.updatedAt,
  };
}

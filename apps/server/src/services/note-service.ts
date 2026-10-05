import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { NoteUploadMeta } from "@tutor/contract";
import {
  INK_LOGICAL_WIDTH,
  NOTE_BODY_DECOMPRESSED_MAX_BYTES,
  NOTE_BODY_GZIP_MAX_BYTES,
  type NoteDoc,
  type NoteVersionReceipt,
  noteDocSchema,
  noteIssueIsLimit,
} from "@tutor/contract";
import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type NoteRow,
  noteImages,
  notes,
  noteVersions,
  responses,
  submissionEvidence,
} from "../db/schema";
import {
  type AtomicFileFaults,
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
 * NoteService（T6R.4）——题目草稿的不可变版本存储：正文上传、服务端规范化
 * hash、CAS 切头与 mutationId 幂等（方案 §6.2/§6.3，契约 packages/contract
 * note.ts 的上传协议与错误码）。
 *
 * 与 ink-service（T2.8 手写作答通道）的关系：只共享「gzip/原始 JSON 兼容 +
 * 解压上限」的原则口径，不复用其固定路径覆盖语义——ink 是同题幂等覆盖
 * （<安全名>.json.gz 原地重写），本服务是**只追加的不可变版本链**
 * （每次成功上传产生新文件新行，禁止覆盖既有版本路径）。
 *
 * 写入协议（方案 §6.3「临时文件 → rename → 事务切头」）：
 * 1. 解析与限额校验（失败在一切副作用之前）；
 * 2. 服务端规范化序列化 → sha-256（见 canonicalNoteJson 注释的规则定义）；
 * 3. 写唯一临时文件 → rename 到不可变路径 blobs/notes/<noteId>/v<rev>-<hash12>.json.gz
 *    （路径三段全部服务端生成：noteId/revision/hash——questionId 来自 DSL
 *    可含中文/点/斜杠/Windows 保留名，**永不进文件路径**）；
 * 4. 事务内：CAS 复核（baseRevision = 当前 head）→ scratch 先查后插 →
 *    插 note_versions 不可变行 → 切 notes 头指针；
 * 5. 任一失败：清理临时/孤儿文件——可以留下未引用文件（GC 延迟回收），
 *    绝不留下指向未完成文件的已确认记录（事务回滚保证）。
 *
 * 并发口径：better-sqlite3 同步单进程，预检与事务之间无交错；事务内的
 * CAS 复核是对未来多进程化的纵深防御（预检已挡掉绝大多数冲突，省文件 IO）。
 */

// ---------- hash 规范化（契约 noteBodyHashSchema 的语义实现） ----------

/**
 * 服务端规范化序列化规则（最终定义，幂等判断同规则）：
 * - 输入是经 noteDocSchema.parse 后的 NoteDoc——默认值已物化
 *   （paperHeightLogical=800、background="grid"），客户端缺省与显式默认值
 *   得到同一 hash；
 * - 按固定键序**重建**对象树（不依赖客户端 JSON 键序）：
 *   顶层 {version, ink, paperHeightLogical, background}；ink {width, strokes}；
 *   每笔 {tool, color, weight, points}；每点 {x, y, p, t}；
 * - JSON.stringify 紧凑输出（无空白）；数值走 ECMAScript Number::toString
 *   （同值同串；NaN/±Infinity 已被 schema 拒绝；-0 序列化为 "0"）；
 * - 不参与 hash：客户端 gzip 字节（压缩相关）、客户端墙钟（NoteDoc 无时间
 *   字段）、上传通道（gzip/原始 JSON 同文同 hash）。
 */
export function canonicalNoteJson(doc: NoteDoc): string {
  return JSON.stringify({
    version: 1,
    ink: {
      width: INK_LOGICAL_WIDTH,
      strokes: doc.ink.strokes.map((stroke) => ({
        tool: stroke.tool,
        color: stroke.color,
        weight: stroke.weight,
        points: stroke.points.map((p) => ({ x: p.x, y: p.y, p: p.p, t: p.t })),
      })),
    },
    paperHeightLogical: doc.paperHeightLogical,
    background: doc.background,
  });
}

/** 规范化正文 → sha-256（64 位小写 hex，契约 noteBodyHashSchema） */
export function noteDocSha256(doc: NoteDoc): string {
  return createHash("sha256")
    .update(canonicalNoteJson(doc), "utf8")
    .digest("hex");
}

/** 正文计数（note_versions 行的 strokeCount/pointCount/paperHeight 来源） */
function noteMetrics(doc: NoteDoc): {
  strokeCount: number;
  pointCount: number;
  paperHeight: number;
} {
  let pointCount = 0;
  for (const stroke of doc.ink.strokes) pointCount += stroke.points.length;
  return {
    strokeCount: doc.ink.strokes.length,
    pointCount,
    paperHeight: doc.paperHeightLogical,
  };
}

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
  return join("blobs", "notes", noteId, noteBodyFileName(revision, hash));
}

/**
 * 相对路径 → 绝对路径，并做**目录边界**校验（方案 §6.3：路径包含关系不能
 * 只用字符串 startsWith——blobs/notes-evil 会骗过 startsWith(blobs/notes)）。
 * 强算法唯一实现在 lib/blob-io 的 resolveWithinRoot（path.relative 判定），
 * 本函数是携带 note 域错误码与 .json.gz 后缀的薄壳。
 */
export function resolveNoteBodyPath(dataDir: string, relPath: string): string {
  return resolveWithinRoot(dataDir, join("blobs", "notes"), relPath, {
    suffix: ".json.gz",
    violationCode: "NOTE_BODY_PATH_INVALID",
  });
}

/** 派生图等其它 notes 域内文件的边界校验（后缀可指定；T6R.6/GC 用） */
function resolveNoteBlobPath(
  dataDir: string,
  relPath: string,
  suffix: string | null,
): string {
  return resolveWithinRoot(dataDir, join("blobs", "notes"), relPath, {
    suffix,
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
    // ——勿退回中文消息子串匹配）
    if (parsed.error.issues.some(noteIssueIsLimit)) {
      throw new HttpError(
        413,
        "NOTE_LIMIT_EXCEEDED",
        `草稿复杂度超上限：${first}（暂定值）`,
      );
    }
    throw new HttpError(
      400,
      "NOTE_VALIDATION_FAILED",
      `草稿文档不合法：${first}`,
    );
  }
  return parsed.data;
}

// ---------- 不可变文件写入（唯一临时文件 → rename） ----------

/** 测试故障注入钩子（生产恒不传；三个中断点语义见 lib/blob-io.AtomicFileFaults） */
export type NoteWriteFaults = AtomicFileFaults;

/**
 * 规范化正文字节 → gzip → 唯一临时文件 → rename 到不可变路径。
 * 机制（唯一 tmp 名/失败清理/故障钩子）在 lib/blob-io.writeFileAtomic；
 * 本函数只补 note 域两件事：按 (noteId, revision, hash) 定不可变路径 +
 * 目录边界校验。亦导出供测试直接构造「rename 前/后中断」的崩溃现场。
 * rename 目标与已确认版本同名的场景只可能是「上次崩溃留下的未引用孤儿」
 * （同 hash 必同字节），覆盖无害。
 */
export function writeNoteBodyFile(
  dataDir: string,
  noteId: string,
  revision: number,
  hash: string,
  canonicalBytes: Uint8Array,
  faults?: NoteWriteFaults,
): { relPath: string; absPath: string } {
  const relPath = noteBodyRelPath(noteId, revision, hash);
  const absPath = resolveNoteBodyPath(dataDir, relPath);
  writeFileAtomic({
    finalPath: absPath,
    bytes: gzipSync(canonicalBytes),
    ...(faults !== undefined ? { faults } : {}),
  });
  return { relPath, absPath };
}

// ---------- CAS 冲突错误构造 ----------

/**
 * 409 NOTE_REVISION_CONFLICT + 当前版本摘要（_current：客户端据此提示
 * 「保留云端或将本地另存一份」，方案 §6.2 禁止自动覆盖/拼接）。
 */
function revisionConflict(db: Db, existing: NoteRow | undefined): HttpError {
  const currentRevision = existing?.currentRevision ?? 0;
  const head =
    existing?.currentVersionId === null || existing === undefined
      ? undefined
      : db
          .select({ hash: noteVersions.hash })
          .from(noteVersions)
          .where(eq(noteVersions.id, existing.currentVersionId))
          .get();
  return new HttpError(
    409,
    "NOTE_REVISION_CONFLICT",
    "草稿已在别处保存了更新的版本（其他标签页/设备），请刷新后选择保留哪一份",
    {
      _current: {
        noteId: existing?.id ?? null,
        revision: currentRevision,
        versionId: existing?.currentVersionId ?? null,
        hash: head?.hash ?? null,
        serverSavedAt: existing?.serverSavedAt ?? null,
      },
    },
  );
}

// ---------- 上传主入口（服务层；路由壳见 routes/student.ts） ----------

/**
 * 上传一版草稿正文，返回版本回执（契约 noteVersionReceiptSchema）。
 *
 * 顺序（方案 §6.2/§6.3；幂等检查先于冲突判断——已成功但丢回执的请求
 * 不能被误判成 409）：
 * 1. requireUsableAttempt（本人 + 来源访问权 + 懒冻结）→ draft 校验 →
 *    requireAttemptQuestion（题目属冻结集合，快照非空）；
 * 2. 解析限额 + 规范化 hash；
 * 3. 幂等查重：mutationId 全局命中且（同一 scratch 笔记 + 同正文 hash）→
 *    返回原回执（逐字段，savedAt 用行内原值）；命中但笔记不同或正文不同 →
 *    409 NOTE_MUTATION_MISMATCH（跨学生/跨 attempt 重放同走此拒绝，绝不
 *    把他人回执发回、也绝不在别人的笔记下关联版本）；
 * 4. CAS 预检：baseRevision ≠ 当前 head → 409 附 _current 摘要；
 * 5. 文件落位（唯一 tmp → rename 不可变路径）；
 * 6. 事务：CAS 复核 → scratch 先查后插（同 attempt 同题唯一，沿用服务层
 *    保证口径）→ 插 note_versions 不可变行 → 切 notes 头指针；
 * 7. 事务失败：删除刚落位的孤儿文件（事务已回滚，无行引用它；删除失败
 *    留给 GC 兜底），再抛原错误。
 *
 * faults 为测试故障注入专用（生产恒不传）：beforeTmpWrite/beforeRename/
 * afterRename 分别对应写临时文件前、rename 前、rename 后三个中断点。
 */
export function saveNoteVersion(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  questionId: string,
  bodyBytes: Uint8Array,
  meta: NoteUploadMeta,
  faults?: NoteWriteFaults,
): NoteVersionReceipt {
  // 1. 权限与冻结集合（T6R.3 统一门口；「冻结内容不冻结权限」——课程撤权
  //    等照常在 requireUsableAttempt 拦截）
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  if (attempt.status !== "draft") {
    throw new HttpError(
      409,
      "ALREADY_SUBMITTED",
      "这份作业已交卷，草稿已固定为原稿，不能再写入新版本",
    );
  }
  requireAttemptQuestion(db, attempt, questionId);
  const revisionRow = db
    .select({ id: responses.id })
    .from(responses)
    .where(
      and(
        eq(responses.attemptId, attempt.id),
        eq(responses.questionId, questionId),
      ),
    )
    .get();
  // requireAttemptQuestion 已保证快照非空的行存在；防御性兜底（fail closed）
  if (revisionRow === undefined) {
    throw new HttpError(
      404,
      "QUESTION_NOT_FOUND",
      "题目不存在或不属于这次练习",
    );
  }

  // 2. 解析 + 规范化 hash（先验后写）
  const doc = parseNoteBodyBytes(bodyBytes);
  const canonical = canonicalNoteJson(doc);
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  const { strokeCount, pointCount, paperHeight } = noteMetrics(doc);

  const scratchWhere = and(
    eq(notes.attemptId, attempt.id),
    eq(notes.questionId, questionId),
    eq(notes.phase, "scratch"),
  );

  // 3. 幂等查重（先于冲突判断）
  const existing = db.select().from(notes).where(scratchWhere).get();
  const replay = db
    .select()
    .from(noteVersions)
    .where(eq(noteVersions.mutationId, meta.mutationId))
    .get();
  if (replay !== undefined) {
    if (replay.noteId === existing?.id && replay.hash === hash) {
      // 同一笔记 + 同一正文：原回执逐字段返回（savedAt 为行内原确认时间）
      return {
        noteId: replay.noteId,
        revision: replay.revision,
        versionId: replay.id,
        hash: replay.hash,
        savedAt: replay.serverSavedAt,
      };
    }
    throw new HttpError(
      409,
      "NOTE_MUTATION_MISMATCH",
      "同一 mutationId 已绑定其他正文变更（或另一份草稿），请生成新的 mutationId 重试",
    );
  }

  // 4. CAS 预检（快失败：绝大多数冲突在这里挡掉，不写文件）
  const headRevision = existing?.currentRevision ?? 0;
  if (meta.baseRevision !== headRevision) {
    throw revisionConflict(db, existing);
  }

  // 5. 文件落位（路径三段全服务端生成；questionId 永不进路径）
  const noteId = existing?.id ?? randomUUID();
  const newRevision = headRevision + 1;
  const relPath = noteBodyRelPath(noteId, newRevision, hash);
  const now = new Date().toISOString();
  const versionId = randomUUID();

  try {
    writeNoteBodyFile(
      dataDir,
      noteId,
      newRevision,
      hash,
      Buffer.from(canonical, "utf8"),
      faults,
    );
    // 6. 事务：CAS 复核 + scratch 先查后插 + 不可变版本行 + 切头
    db.transaction((tx) => {
      const row = tx.select().from(notes).where(scratchWhere).get();
      if (row === undefined) {
        // 首版：先插 notes 行（头指针暂空，FK 要求版本行后切），
        // 再插版本行，最后回填头指针——同一事务内完成，外部不可见中间态
        if (meta.baseRevision !== 0) throw revisionConflict(db, undefined);
        tx.insert(notes)
          .values({
            id: noteId,
            attemptId: attempt.id,
            questionId,
            questionRevisionId: revisionRow.id,
            phase: "scratch",
            currentRevision: newRevision,
            currentVersionId: null,
            serverSavedAt: now,
            updatedAt: now,
          })
          .run();
      } else {
        // CAS 复核（同步事务内无交错，纯纵深防御）+ 笔记行身份一致
        if (row.currentRevision !== meta.baseRevision) {
          throw revisionConflict(db, row);
        }
        if (row.id !== noteId) {
          throw new HttpError(
            500,
            "INTERNAL",
            "笔记行身份不一致（防御性拒绝）",
          );
        }
      }
      tx.insert(noteVersions)
        .values({
          id: versionId,
          noteId,
          revision: newRevision,
          bodyPath: relPath,
          hash,
          strokeCount,
          pointCount,
          paperWidth: INK_LOGICAL_WIDTH,
          paperHeight,
          serverSavedAt: now,
          renderVersion: 1,
          mutationId: meta.mutationId,
        })
        .run();
      if (existing === undefined) {
        tx.update(notes)
          .set({ currentVersionId: versionId })
          .where(eq(notes.id, noteId))
          .run();
      } else {
        tx.update(notes)
          .set({
            currentRevision: newRevision,
            currentVersionId: versionId,
            serverSavedAt: now,
            updatedAt: now,
          })
          .where(
            and(eq(notes.id, noteId), eq(notes.currentRevision, headRevision)),
          )
          .run();
      }
    });
  } catch (err) {
    // 7. 失败清理：事务已回滚（或文件未落位），刚写的不可变文件无行引用，
    //    删除它；失败留给 GC 兜底。绝不清碰其它版本的文件（路径含本请求的
    //    revision+hash，唯一索引保证无已确认行占用同名路径）。
    try {
      unlinkSync(resolveNoteBodyPath(dataDir, relPath));
    } catch {
      // 文件未创建（写/rename 前失败）或已被删除——无需处理
    }
    throw err;
  }

  return { noteId, revision: newRevision, versionId, hash, savedAt: now };
}

// ---------- 读取（完整性口径；T6R.5 读路由复用） ----------

/** 已确认版本 → 正文文档 + 行内 hash + 按同一规范化规则重算的 hash */
export function readNoteVersionDoc(
  db: Db,
  dataDir: string,
  versionId: string,
): { doc: NoteDoc; rowHash: string; recomputedHash: string } {
  const row = db
    .select()
    .from(noteVersions)
    .where(eq(noteVersions.id, versionId))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "NOTE_NOT_FOUND", "笔记版本不存在");
  }
  let jsonText: string;
  try {
    jsonText = gunzipSync(
      readFileSync(resolveNoteBodyPath(dataDir, row.bodyPath)),
    ).toString("utf8");
  } catch {
    // 文件缺失（备份/GC 边界）：按不存在口径，不泄漏磁盘细节
    throw new HttpError(404, "NOTE_NOT_FOUND", "笔记正文文件缺失");
  }
  const parsed = noteDocSchema.safeParse(JSON.parse(jsonText) as unknown);
  if (!parsed.success) {
    throw new HttpError(
      500,
      "NOTE_BODY_UNREADABLE",
      "笔记正文文件损坏，请联系老师处理",
    );
  }
  return {
    doc: parsed.data,
    rowHash: row.hash,
    recomputedHash: noteDocSha256(parsed.data),
  };
}

// ---------- GC 骨架（未引用版本延迟回收；自动调度接线在 T6R.14） ----------

/** 安全窗口（毫秒）：版本/临时文件创建后至少保留这么久才可回收（暂定值） */
export const NOTE_GC_SAFETY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface NoteGcOptions {
  /** 回收判定时刻（默认当前时间；测试注入） */
  now?: Date;
  /** 安全窗口毫秒数（默认 NOTE_GC_SAFETY_WINDOW_MS；测试注入） */
  safetyWindowMs?: number;
}

/** GC 执行摘要（测试与运维观察口径） */
export interface NoteGcResult {
  /** 删除的 note_versions 行数（文件删除失败不影响此计数） */
  deletedVersionRows: number;
  /** 随版本连带删除的 note_images 行数 */
  deletedImageRows: number;
  /** 实际删除的正文文件数 */
  deletedFiles: number;
  /** 清扫的过期临时文件数 */
  sweptTmp: number;
  /** 清扫的超窗口无行孤儿正文文件数（崩溃/失败残留） */
  sweptOrphanFiles: number;
  /** 超窗口但被保留集合（头指针/证据引用）挡下的版本数 */
  keptByReference: number;
}

/**
 * 未引用版本延迟回收（方案 §6.3；本任务只提供函数与测试，**未接入任何
 * 自动调度**——备份引用保留清单在 T6R.14 落地前不开启自动 GC，不以节省
 * 空间破坏备份可恢复性）。
 *
 * 保留集合（绝不可删）：
 * - 所有 notes.currentVersionId（工作头/订正检查点头）；
 * - 所有 submission_evidence.version_id（提交原稿）；
 * - 安全窗口内创建的全部版本与临时文件（在途上传、丢回执重试窗口）。
 * 「正在生成图片的版本」：note_images 尚无生成通道（T6R.6），届时由生成
 * 流程把在途版本纳入保留；当前实现把派生图行/文件随所属版本一并回收。
 *
 * 删除顺序：先事务删行（FK 拒绝=仍有引用→跳过下轮再试），后删文件
 * （行已删，文件删除失败只是占空间的孤儿，不产生悬垂引用——坏方向是
 * 「行在文件无」，这里不会发生）。
 */
export function gcNoteVersions(
  db: Db,
  dataDir: string,
  options: NoteGcOptions = {},
): NoteGcResult {
  const now = options.now ?? new Date();
  const windowMs = options.safetyWindowMs ?? NOTE_GC_SAFETY_WINDOW_MS;
  const cutoffMs = now.getTime() - windowMs;
  const cutoff = new Date(cutoffMs).toISOString();
  const result: NoteGcResult = {
    deletedVersionRows: 0,
    deletedImageRows: 0,
    deletedFiles: 0,
    sweptTmp: 0,
    sweptOrphanFiles: 0,
    keptByReference: 0,
  };

  // 保留集合
  const keep = new Set<string>();
  for (const row of db
    .select({ id: notes.currentVersionId })
    .from(notes)
    .all()) {
    if (row.id !== null) keep.add(row.id);
  }
  for (const row of db
    .select({ id: submissionEvidence.versionId })
    .from(submissionEvidence)
    .all()) {
    if (row.id !== null) keep.add(row.id);
  }

  // 超窗口候选（serverSavedAt 为定长 UTC ISO，字典序即时间序）
  const candidates = db
    .select()
    .from(noteVersions)
    .where(lt(noteVersions.serverSavedAt, cutoff))
    .all();
  for (const row of candidates) {
    if (keep.has(row.id)) {
      result.keptByReference += 1;
      continue;
    }
    const images = db
      .select()
      .from(noteImages)
      .where(eq(noteImages.noteVersionId, row.id))
      .all();
    try {
      db.transaction((tx) => {
        // 先删派生图行（FK 指向版本行），再删版本行
        tx.delete(noteImages).where(eq(noteImages.noteVersionId, row.id)).run();
        tx.delete(noteVersions).where(eq(noteVersions.id, row.id)).run();
      });
    } catch {
      // FK 拒绝：仍被某处引用（竞态/未来新引用方）——保守跳过
      continue;
    }
    result.deletedVersionRows += 1;
    result.deletedImageRows += images.length;
    try {
      unlinkSync(resolveNoteBodyPath(dataDir, row.bodyPath));
      result.deletedFiles += 1;
    } catch {
      // 行已删，文件删除失败只是孤儿文件——下轮/运维处理
    }
    for (const img of images) {
      try {
        unlinkSync(resolveNoteBlobPath(dataDir, img.path, ".png"));
      } catch {
        // 同上
      }
    }
  }

  // 过期临时文件清扫（.tmp- 前缀 = writeNoteBodyFile 独有命名；窗口内
  // 的一律不碰——那是可能仍在途的请求或崩溃现场），以及超窗口的
  // **无行孤儿正文文件**清扫（「rename 完成、事务未提交」的崩溃残留：
  // 文件名合 v<rev>-<hash12>.json.gz 模式但不在任何 note_versions.body_path
  // 中；窗口内不碰——那可能是刚 rename、事务尚未提交的在途请求）。
  // 无行的图片文件不在此列：图片由 T6R.6 通道按自有协议产生，届时一并定。
  const notesRoot = resolve(dataDir, "blobs", "notes");
  if (existsSync(notesRoot)) {
    const liveBodyRel = new Set(
      db
        .select({ p: noteVersions.bodyPath })
        .from(noteVersions)
        .all()
        .map((row) => relative(notesRoot, resolve(dataDir, row.p))),
    );
    const bodyFilePattern = /^v\d+-[0-9a-f]{12}\.json\.gz$/;
    for (const entry of readdirSync(notesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(notesRoot, entry.name);
      for (const name of readdirSync(dir)) {
        const filePath = join(dir, name);
        try {
          if (statSync(filePath).mtimeMs >= cutoffMs) continue; // 窗口内不动
          if (name.startsWith(".tmp-")) {
            unlinkSync(filePath);
            result.sweptTmp += 1;
          } else if (
            bodyFilePattern.test(name) &&
            !liveBodyRel.has(join(entry.name, name))
          ) {
            unlinkSync(filePath);
            result.sweptOrphanFiles += 1;
          }
        } catch {
          // 文件恰好消失（在途请求刚 rename）——跳过
        }
      }
    }
  }
  return result;
}

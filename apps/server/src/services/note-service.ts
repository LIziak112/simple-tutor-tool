import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { NoteImageUploadMeta, NoteUploadMeta } from "@tutor/contract";
import {
  INK_LOGICAL_WIDTH,
  NOTE_BODY_DECOMPRESSED_MAX_BYTES,
  NOTE_BODY_GZIP_MAX_BYTES,
  NOTE_IMAGE_PNG_MAX_BYTES,
  NOTE_VERSION_IMAGES_MAX_BYTES,
  type NoteDoc,
  type NoteHeadData,
  type NoteImageMeta,
  type NoteVersionReceipt,
  noteDocSchema,
  noteImageMetaSchema,
  noteIssueIsLimit,
  noteRecordMetaSchema,
  noteRevisionConflictCurrentSchema,
  noteSubmissionEvidenceMetaSchema,
} from "@tutor/contract";
import { and, asc, eq, isNotNull, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  attempts,
  type NoteImageRow,
  type NoteRow,
  type NoteVersionRow,
  noteImages,
  notes,
  noteVersions,
  responses,
  students,
  submissionEvidence,
  type SubmissionEvidenceRow,
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
import { pngSize } from "./ink-service";
import { requireTeacherAttempt } from "./teacher-attempt-service";

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
  return resolveWithinRoot(dataDir, join("blobs", "notes"), relPath, {
    suffix: ".json.gz",
    violationCode: "NOTE_BODY_PATH_INVALID",
  });
}

/** 派生图等其它 notes 域内文件的边界校验（后缀可指定；T6R.6/GC 用） */
function resolveNoteBlobPath(
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

// ---------- CAS 冲突错误构造 ----------

/**
 * 409 NOTE_REVISION_CONFLICT + 当前版本摘要（_current：客户端据此提示
 * 「保留云端或将本地另存一份」，方案 §6.2 禁止自动覆盖/拼接）。
 */
function revisionConflict(db: Db, existing: NoteRow | undefined): HttpError {
  // 无 head（revision=0）时除 revision 外全空；有 head 时补版本 hash——
  // 组装经契约 noteRevisionConflictCurrentSchema.parse（复审⑤：摘要形态
  // 契约化，服务端与实现漂移即编程错误在这里当场暴露）
  const head = existing?.currentVersionId
    ? db
        .select({ hash: noteVersions.hash })
        .from(noteVersions)
        .where(eq(noteVersions.id, existing.currentVersionId))
        .get()
    : undefined;
  return new HttpError(
    409,
    "NOTE_REVISION_CONFLICT",
    "草稿已在别处保存了更新的版本（其他标签页/设备），请刷新后选择保留哪一份",
    {
      _current: noteRevisionConflictCurrentSchema.parse({
        noteId: existing?.id ?? null,
        revision: existing?.currentRevision ?? 0,
        versionId: existing?.currentVersionId ?? null,
        hash: head?.hash ?? null,
        serverSavedAt: existing?.serverSavedAt ?? null,
      }),
    },
  );
}
/** 版本行 → 回执（预检幂等命中与跨进程约束兜底共用一处组装） */
function receiptOf(row: NoteVersionRow): NoteVersionReceipt {
  return {
    noteId: row.noteId,
    revision: row.revision,
    versionId: row.id,
    hash: row.hash,
    savedAt: row.serverSavedAt,
  };
}

/** 删除本请求刚落位的孤儿正文文件（best-effort；失败留给 GC 兜底） */
function cleanupOrphanFile(dataDir: string, relPath: string): void {
  try {
    unlinkSync(resolveNoteBodyPath(dataDir, relPath));
  } catch {
    // 文件未创建（写/rename 前失败）或已被删除——无需处理
  }
}

/**
 * SQLITE_CONSTRAINT 唯一索引冲突的表内定位（跨进程兜底判定用）：
 * "mutation" = note_versions.mutation_id（幂等键竞争）；"revision" =
 * (note_id, revision)（CAS 竞争）；null = 非目标冲突/非约束错误。
 * 依据 better-sqlite3 的错误形态：code 为 SQLITE_CONSTRAINT 基码或其
 * 扩展码（如 SQLITE_CONSTRAINT_UNIQUE，13.x 实测），message 含
 * "UNIQUE constraint failed: <表.列>…"。
 */
function sqliteUniqueViolationOn(err: unknown): "mutation" | "revision" | null {
  const e = err as { code?: string; message?: string };
  if (!e?.code?.startsWith("SQLITE_CONSTRAINT")) return null;
  const message = String(e.message ?? "");
  if (message.includes("note_versions.mutation_id")) return "mutation";
  if (
    message.includes("note_versions.note_id") &&
    message.includes("note_versions.revision")
  ) {
    return "revision";
  }
  return null;
}

// ---------- 上传主入口（服务层；路由壳见 routes/student.ts） ----------

/**
 * 上传一版草稿正文，返回版本回执（契约 noteVersionReceiptSchema）。
 *
 * 顺序（方案 §6.2/§6.3；幂等检查先于冲突判断与状态门槛——已成功但丢回执
 * 的请求不能被误判成 409）：
 * 1. requireUsableAttempt（本人 + 来源访问权 + 懒冻结）→
 *    requireAttemptQuestion（题目属冻结集合，快照非空）；
 * 2. 解析限额 + 规范化 hash；
 * 3. 幂等查重（**前置于 draft 校验**——复审①裁决：mutationId+归属+hash
 *    匹配的重放在**任何 attempt 状态**（含已交卷）都返回原回执，丢回执的
 *    客户端在交卷后补传重试不被 409 挡；只有非重放才走 409）：
 *    mutationId 全局命中且（同一 scratch 笔记 + 同正文 hash）→ 返回原回执
 *    （逐字段，savedAt 用行内原值）；命中但笔记不同或正文不同 →
 *    409 NOTE_MUTATION_MISMATCH（跨学生/跨 attempt 重放同走此拒绝，绝不
 *    把他人回执发回、也绝不在别人的笔记下关联版本）；
 * 4. draft 校验（非重放写入）：已交卷 → 409 ALREADY_SUBMITTED；
 * 5. CAS 预检：baseRevision ≠ 当前 head → 409 附 _current 摘要；
 * 6. 文件落位（唯一 tmp → rename 不可变路径）；
 * 7. 事务：CAS 复核 → scratch 先查后插（同 attempt 同题唯一，沿用服务层
 *    保证口径）→ 插 note_versions 不可变行 → 切 notes 头指针；
 * 8. 事务失败：删除刚落位的孤儿文件（事务已回滚，无行引用它；删除失败
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
  faults?: AtomicFileFaults,
): NoteVersionReceipt {
  // 1. 权限与冻结集合（T6R.3 统一门口；「冻结内容不冻结权限」——课程撤权
  //    等照常在 requireUsableAttempt 拦截）
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  // 冻结集合校验即取题目版本引用（requireAttemptQuestion 返回行 id =
  // questionRevisionId，不必再回查 responses）
  const { id: questionRevisionId } = requireAttemptQuestion(
    db,
    attempt,
    questionId,
  );

  // 2. 解析 + 规范化 hash（先验后写；canonical 字符串只产一次——UTF-8 编码
  //    成 Buffer 后 hash 与落盘共用，避免二次编码拷贝）
  const doc = parseNoteBodyBytes(bodyBytes);
  const canonicalBytes = Buffer.from(canonicalNoteJson(doc), "utf8");
  const hash = createHash("sha256").update(canonicalBytes).digest("hex");
  const { strokeCount, pointCount, paperHeight } = noteMetrics(doc);

  const scratchWhere = and(
    eq(notes.attemptId, attempt.id),
    eq(notes.questionId, questionId),
    eq(notes.phase, "scratch"),
  );

  // 3. 幂等查重（先于冲突判断与 draft 状态门槛，见函数头注释）
  const existing = db.select().from(notes).where(scratchWhere).get();
  const replay = db
    .select()
    .from(noteVersions)
    .where(eq(noteVersions.mutationId, meta.mutationId))
    .get();
  if (replay !== undefined) {
    if (replay.noteId === existing?.id && replay.hash === hash) {
      // 同一笔记 + 同一正文：原回执逐字段返回（savedAt 为行内原确认时间）
      return receiptOf(replay);
    }
    throw new HttpError(
      409,
      "NOTE_MUTATION_MISMATCH",
      "同一 mutationId 已绑定其他正文变更（或另一份草稿），请生成新的 mutationId 重试",
    );
  }

  // 4. draft 校验（非重放的新写入才受交卷门槛约束）
  if (attempt.status !== "draft") {
    throw new HttpError(
      409,
      "ALREADY_SUBMITTED",
      "这份作业已交卷，草稿已固定为原稿，不能再写入新版本",
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
      canonicalBytes,
      faults,
    );
    // 6. 事务：CAS 复核 + scratch 先查后插 + 不可变版本行 + 统一守卫切头
    db.transaction((tx) => {
      const row = tx.select().from(notes).where(scratchWhere).get();
      if (row === undefined) {
        // 首版：先插 revision=0 的空白 notes 行（FK 要求版本行先于头指针
        // 存在），版本行插入后与既有笔记走**同一**守卫切头语句——中间态
        // 只在本事务内可见（revision=0 ⇔ 头指针/确认时间空，与契约一致）
        if (meta.baseRevision !== 0) throw revisionConflict(db, undefined);
        tx.insert(notes)
          .values({
            id: noteId,
            attemptId: attempt.id,
            questionId,
            questionRevisionId,
            phase: "scratch",
            currentRevision: 0,
            currentVersionId: null,
            serverSavedAt: null,
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
      // 统一切头（两条路径同一语句）：where 带 currentRevision 守卫——
      // 首版行刚以 revision=0 插入、既有行 CAS 复核过 =baseRevision，两者
      // 都等于 headRevision（预检口径），守卫语义一致。RETURNING 受影响行
      // 并校验命中（复审③闭合：单进程同步下恒命中；多进程下 CAS 落败时
      // 0 行→500 回滚，不产生「版本行在、头指针旧」的半切状态）
      const switched = tx
        .update(notes)
        .set({
          currentRevision: newRevision,
          currentVersionId: versionId,
          serverSavedAt: now,
          updatedAt: now,
        })
        .where(
          and(eq(notes.id, noteId), eq(notes.currentRevision, headRevision)),
        )
        .returning({ id: notes.id })
        .get();
      if (switched === undefined) {
        throw new HttpError(
          500,
          "INTERNAL",
          "草稿头指针切换未命中（并发写竞争，本次写入已回滚）",
        );
      }
    });
  } catch (err) {
    // 7. 失败清理与跨进程兜底（better-sqlite3 同步单进程下兜底分支不可达，
    //    为多进程化预留的纵深闭合，复审③）：
    //    a) mutation_id 唯一索引冲突 = 另一进程已提交同一 mutation。胜者
    //       (noteId, hash) 与本请求一致 → 按幂等语义返回**胜者的回执**，
    //       且**不清理文件**（胜者与本请求同 note+hash 时路径必相同、字节
    //       必相同；删了会砸掉胜者行的引用——revision 不同则路径不同，
    //       本请求文件留作孤儿由 GC 回收）；不一致 → 清理后 409
    //       NOTE_MUTATION_MISMATCH（与预检口径一致）。
    //    b) (note_id, revision) 唯一索引冲突 = 另一进程用不同 mutation 抢先
    //       切到同一 revision（CAS 竞争落败）→ 清理后 409
    //       NOTE_REVISION_CONFLICT（重读 head 组摘要，客户端可诊断重试）。
    //    其余错误：清理刚落位的孤儿文件（事务已回滚或文件未落位，无行引用
    //    它；删除失败留给 GC 兜底——绝不清碰其它版本的文件，路径含本请求
    //    的 revision+hash，唯一索引保证无已确认行占用同名路径）。
    const violation = sqliteUniqueViolationOn(err);
    if (violation === "mutation") {
      const winner = db
        .select()
        .from(noteVersions)
        .where(eq(noteVersions.mutationId, meta.mutationId))
        .get();
      if (
        winner !== undefined &&
        winner.noteId === noteId &&
        winner.hash === hash
      ) {
        return receiptOf(winner);
      }
      cleanupOrphanFile(dataDir, relPath);
      if (winner !== undefined) {
        throw new HttpError(
          409,
          "NOTE_MUTATION_MISMATCH",
          "同一 mutationId 已绑定其他正文变更（或另一份草稿），请生成新的 mutationId 重试",
        );
      }
      throw err;
    }
    cleanupOrphanFile(dataDir, relPath);
    if (violation === "revision") {
      throw revisionConflict(
        db,
        db.select().from(notes).where(scratchWhere).get(),
      );
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
    // 读侧同样带解压上限（复审②：备份植入高压缩比炸弹的防线）；机制与
    // 上传侧共用 lib/blob-io（gzip/原始 JSON 双兼容 + TextDecoder 免拷贝）
    jsonText = parseGzipOrJsonBytes(
      readFileSync(resolveNoteBodyPath(dataDir, row.bodyPath)),
      { maxDecompressed: NOTE_BODY_DECOMPRESSED_MAX_BYTES },
    );
  } catch (err) {
    // 边界校验的 HttpError 保持自身码重抛（不被吞成 404）；文件缺失/
    // 解压失败（含超上限）按不存在口径，不泄漏磁盘细节
    if (err instanceof HttpError) throw err;
    throw new HttpError(404, "NOTE_NOT_FOUND", "笔记正文文件缺失");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonText) as unknown;
  } catch {
    // JSON 非法（损坏/被篡改的落盘文件）：部署级损坏，500 而非裸 INTERNAL
    throw new HttpError(
      500,
      "NOTE_BODY_UNREADABLE",
      "笔记正文文件损坏，请联系老师处理",
    );
  }
  const parsed = noteDocSchema.safeParse(parsedJson);
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

// ---------- T6R.5：读侧投影、版本文档/图片直出与补图（方案 §8 路由表） ----------

/** 行 → 契约元信息投影（parse 兜底：行形态与契约漂移即编程错误当场暴露） */
function noteRecordMetaOf(row: NoteRow) {
  return noteRecordMetaSchema.parse({
    noteId: row.id,
    attemptId: row.attemptId,
    questionId: row.questionId,
    questionRevisionId: row.questionRevisionId,
    phase: row.phase,
    revision: row.currentRevision,
    currentVersionId: row.currentVersionId,
    serverSavedAt: row.serverSavedAt,
  });
}

function noteImageMetaOf(row: NoteImageRow) {
  return noteImageMetaSchema.parse({
    imageId: row.id,
    noteVersionId: row.noteVersionId,
    spec: row.spec,
    pageIndex: row.pageIndex,
    crop: { x: row.cropX, y: row.cropY, width: row.cropW, height: row.cropH },
    pixelWidth: row.pixelWidth,
    pixelHeight: row.pixelHeight,
    state: row.state,
    hash: row.hash,
  });
}

function noteEvidenceMetaOf(row: SubmissionEvidenceRow) {
  return noteSubmissionEvidenceMetaSchema.parse({
    attemptId: row.attemptId,
    questionId: row.questionId,
    state: row.state,
    versionId: row.versionId,
    recordedAt: row.recordedAt,
  });
}

/**
 * 头投影组装（①②⑥共用）：
 * - note：该 attempt 该题的 scratch 行（correction/supplement 是 T6R.15 的
 *   独立 NoteRecord，不进本投影）；无行 → null（契约显式空态 notCreated）；
 * - 生效版本：submission_evidence 指向的原稿版本优先（交卷冻结后即原稿，
 *   T6R.10 落写；未冻结/无证据行 → 工作头指针），images 聚合到该版本；
 * - evidence：证据行（交卷事务写入）；无行 → null（未交卷或旧客户端未采集）。
 */
function noteHeadOf(db: Db, attemptId: string, questionId: string): NoteHeadData {
  const note = db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.attemptId, attemptId),
        eq(notes.questionId, questionId),
        eq(notes.phase, "scratch"),
      ),
    )
    .get();
  const evidence = db
    .select()
    .from(submissionEvidence)
    .where(
      and(
        eq(submissionEvidence.attemptId, attemptId),
        eq(submissionEvidence.questionId, questionId),
      ),
    )
    .get();
  const operativeVersionId = evidence?.versionId ?? note?.currentVersionId ?? null;
  const imageRows = operativeVersionId
    ? db
        .select()
        .from(noteImages)
        .where(eq(noteImages.noteVersionId, operativeVersionId))
        .orderBy(asc(noteImages.spec), asc(noteImages.pageIndex))
        .all()
    : [];
  return {
    note: note === undefined ? null : noteRecordMetaOf(note),
    images: imageRows.map(noteImageMetaOf),
    evidence: evidence === undefined ? null : noteEvidenceMetaOf(evidence),
  };
}

/**
 * evidence 读取的题目成员资格（宽松口径，区别于写侧 requireAttemptQuestion）：
 * 只要求该 attempt 的 responses 行存在——不查 questions 当前存活（软删题历史
 * 证据可读），也不要求快照非空（升级前遗留卷的响应行仍可定位，返回空投影
 * 而非 404；证据/笔记行本就只可能由新代码写入，遗留卷恒为空态）。
 */
function requireAttemptQuestionRow(
  db: Db,
  attemptId: string,
  questionId: string,
): void {
  const hit = db
    .select({ id: responses.id })
    .from(responses)
    .where(
      and(eq(responses.attemptId, attemptId), eq(responses.questionId, questionId)),
    )
    .get();
  if (hit === undefined) {
    throw new HttpError(
      404,
      "QUESTION_NOT_FOUND",
      "题目不存在或不属于这次练习",
    );
  }
}

/** ① GET /api/student/attempts/:id/notes/:qid：工作稿头（本人 + attempt 可用 + 冻结集合严格口径） */
export function getStudentNoteHead(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
): NoteHeadData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  requireAttemptQuestion(db, attempt, questionId);
  return noteHeadOf(db, attempt.id, questionId);
}

/** ② GET /api/student/attempts/:id/evidence/:qid：只读证据（本人历史权限，宽松题目口径） */
export function getStudentNoteEvidence(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
): NoteHeadData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  requireAttemptQuestionRow(db, attempt.id, questionId);
  return noteHeadOf(db, attempt.id, questionId);
}

/** ⑥ GET /api/teacher/attempts/:id/evidence/:qid：域内只读证据（域外统一 404） */
export function getTeacherNoteEvidence(
  db: Db,
  teacherId: string,
  attemptId: string,
  questionId: string,
): NoteHeadData {
  const { attempt } = requireTeacherAttempt(db, teacherId, attemptId);
  requireAttemptQuestionRow(db, attempt.id, questionId);
  return noteHeadOf(db, attempt.id, questionId);
}

// ---------- 版本归属链（versionId/imageId 读侧授权，T6R.4 遗留验收） ----------

/** versionId → 版本行 + 笔记行（不存在 → 404 NOTE_NOT_FOUND，不暴露存在性） */
function requireNoteVersionChain(
  db: Db,
  versionId: string,
): { version: NoteVersionRow; note: NoteRow } {
  const version = db
    .select()
    .from(noteVersions)
    .where(eq(noteVersions.id, versionId))
    .get();
  if (version === undefined) {
    throw new HttpError(404, "NOTE_NOT_FOUND", "笔记版本不存在");
  }
  const note = db.select().from(notes).where(eq(notes.id, version.noteId)).get();
  if (note === undefined) {
    // 版本行在而笔记行缺（FK 保证不可达的防御分支）
    throw new HttpError(404, "NOTE_NOT_FOUND", "笔记版本不存在");
  }
  return { version, note };
}

/**
 * 学生读授权：note → attempt → requireUsableAttempt（本人 403/404 按既有
 * 惯例；course 来源 draft 复检可见性——撤权拒读拒写与 detail 口径一致，
 * 已交卷照常走历史权限）。
 */
function requireStudentNoteVersion(
  db: Db,
  studentId: string,
  versionId: string,
): { version: NoteVersionRow; note: NoteRow; attempt: Attempt } {
  const chain = requireNoteVersionChain(db, versionId);
  const attempt = requireUsableAttempt(db, studentId, chain.note.attemptId);
  return { ...chain, attempt };
}

/** 教师域授权：note → attempt → student.teacherId（域外 404 NOTE_NOT_FOUND，不暴露存在性） */
function requireTeacherNoteVersion(
  db: Db,
  teacherId: string,
  versionId: string,
): { version: NoteVersionRow; note: NoteRow } {
  const chain = requireNoteVersionChain(db, versionId);
  const row = db
    .select({ ownerTeacherId: students.teacherId })
    .from(attempts)
    .innerJoin(students, eq(attempts.studentId, students.id))
    .where(eq(attempts.id, chain.note.attemptId))
    .get();
  if (row === undefined || row.ownerTeacherId !== teacherId) {
    throw new HttpError(404, "NOTE_NOT_FOUND", "笔记版本不存在");
  }
  return chain;
}

/** 读取落盘文件为独立 ArrayBuffer（Buffer 视图 → 拷贝，Response BodyInit 友好） */
function readFileBytes(filePath: string): ArrayBuffer {
  const buf = readFileSync(filePath);
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

/** ③⑦ 版本文档 gzip 原字节直出（不解析——消费在前端渲染器，坏文件属部署级问题） */
export function readNoteVersionGzip(
  dataDir: string,
  version: NoteVersionRow,
): ArrayBuffer {
  try {
    return readFileBytes(resolveNoteBodyPath(dataDir, version.bodyPath));
  } catch (err) {
    // 边界校验 HttpError 保持自身码重抛；文件缺失按不存在口径（不泄漏磁盘细节）
    if (err instanceof HttpError) throw err;
    throw new HttpError(404, "NOTE_NOT_FOUND", "笔记正文文件缺失");
  }
}

/** 学生端 ③：GET /api/student/note-versions/:id/document */
export function getStudentNoteDocument(
  db: Db,
  dataDir: string,
  studentId: string,
  versionId: string,
): ArrayBuffer {
  return readNoteVersionGzip(
    dataDir,
    requireStudentNoteVersion(db, studentId, versionId).version,
  );
}

/** 教师端 ⑦：GET /api/teacher/note-versions/:id/document */
export function getTeacherNoteDocument(
  db: Db,
  dataDir: string,
  teacherId: string,
  versionId: string,
): ArrayBuffer {
  return readNoteVersionGzip(
    dataDir,
    requireTeacherNoteVersion(db, teacherId, versionId).version,
  );
}

/** imageId → 图片行 + 归属链（行不存在 → 404 NOTE_NOT_FOUND） */
function requireNoteImageChain(
  db: Db,
  versionId: string,
  imageId: string,
): { image: NoteImageRow; note: NoteRow } {
  const chain = requireNoteVersionChain(db, versionId);
  const image = db
    .select()
    .from(noteImages)
    .where(
      and(
        eq(noteImages.id, imageId),
        eq(noteImages.noteVersionId, chain.version.id),
      ),
    )
    .get();
  if (image === undefined) {
    throw new HttpError(404, "NOTE_NOT_FOUND", "笔记图片不存在");
  }
  return { image, note: chain.note };
}

/** 图片文件字节（权限已由调用方经归属链校验；行/文件不在或未就绪 → 404） */
function readNoteImagePng(dataDir: string, image: NoteImageRow): ArrayBuffer {
  if (image.state !== "ready") {
    // pending/failed/missing 均无可用文件（契约：仅 ready 保证 hash/path 可用）
    throw new HttpError(404, "NOTE_NOT_FOUND", "笔记图片不存在");
  }
  try {
    return readFileBytes(resolveNoteBlobPath(dataDir, image.path, ".png"));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(404, "NOTE_NOT_FOUND", "笔记图片不存在");
  }
}

/** 学生端 ④：GET /api/student/note-versions/:id/images/:imageId(.png) */
export function getStudentNoteImagePng(
  db: Db,
  dataDir: string,
  studentId: string,
  versionId: string,
  imageId: string,
): ArrayBuffer {
  const { image, note } = requireNoteImageChain(db, versionId, imageId);
  requireUsableAttempt(db, studentId, note.attemptId);
  return readNoteImagePng(dataDir, image);
}

/** 教师端 ⑦：GET /api/teacher/note-versions/:id/images/:imageId(.png) */
export function getTeacherNoteImagePng(
  db: Db,
  dataDir: string,
  teacherId: string,
  versionId: string,
  imageId: string,
): ArrayBuffer {
  const { image, note } = requireNoteImageChain(db, versionId, imageId);
  const row = db
    .select({ ownerTeacherId: students.teacherId })
    .from(attempts)
    .innerJoin(students, eq(attempts.studentId, students.id))
    .where(eq(attempts.id, note.attemptId))
    .get();
  if (row === undefined || row.ownerTeacherId !== teacherId) {
    throw new HttpError(404, "NOTE_NOT_FOUND", "笔记图片不存在");
  }
  return readNoteImagePng(dataDir, image);
}

// ---------- ⑤⑧ 补图上传（学生自产 / 教师重建；只能挂既定版本） ----------

/** 补图行为者：学生（本人 + attempt 可用）或教师（域链），授权语义见各分支 */
export type NoteImageActor =
  | { kind: "student"; id: string }
  | { kind: "teacher"; id: string };

/** 派生图文件相对路径：blobs/notes/<noteId>/img-<imageId>.png（id 全服务端生成） */
function noteImageRelPath(noteId: string, imageId: string): string {
  return ["blobs", "notes", noteId, `img-${imageId}.png`].join("/");
}

/**
 * 为既定版本补一张派生图（⑤学生自产 / ⑧教师重建共用）：
 * 1. versionId 归属链授权（学生 requireUsableAttempt——交卷后仍放行〔补图是
 *    恢复通道，不是新写正文〕，课程撤权 draft 拒绝；教师域链 404）；
 * 2. 单图字节限额（413）→ PNG 魔数与 IHDR 实际尺寸 = 声明尺寸（400，方案 §8
 *    「尺寸／规格／版本必须匹配」）；
 * 3. 同版本派生图聚合限额（其余槽位现有文件 + 本次 ≤ 8MiB → 413）；
 * 4. 写新文件（唯一 tmp → rename 不可变路径）→ 事务内删旧槽位行 + 插新行
 *    （(noteVersionId, spec, pageIndex) 唯一槽位 upsert，行 id 换新）→
 *    best-effort 删旧文件（失败留孤儿，无行引用）；
 * 5. 不触碰 note_versions / notes / submission_evidence 任何行——补图不能
 *    改正文与提交引用。
 */
export function attachNoteImage(
  db: Db,
  dataDir: string,
  actor: NoteImageActor,
  versionId: string,
  png: Uint8Array,
  meta: NoteImageUploadMeta,
): NoteImageMeta {
  // 1. 归属链授权
  const chain =
    actor.kind === "student"
      ? requireStudentNoteVersion(db, actor.id, versionId)
      : requireTeacherNoteVersion(db, actor.id, versionId);
  const { version, note } = chain;

  // 2. 字节限额 + PNG 完整性（先廉价后昂贵的顺序）
  if (png.byteLength > NOTE_IMAGE_PNG_MAX_BYTES) {
    throw new HttpError(
      413,
      "NOTE_LIMIT_EXCEEDED",
      `派生图超过 ${NOTE_IMAGE_PNG_MAX_BYTES / (1024 * 1024)}MiB 上传限额（暂定值），请降低分辨率后重试`,
    );
  }
  const actual = pngSize(png);
  if (actual === null) {
    throw new HttpError(
      400,
      "NOTE_VALIDATION_FAILED",
      "图片不是合法的 PNG 文档",
    );
  }
  if (actual.width !== meta.pixelWidth || actual.height !== meta.pixelHeight) {
    throw new HttpError(
      400,
      "NOTE_VALIDATION_FAILED",
      "图片实际尺寸与声明的像素宽高不一致",
    );
  }

  // 3. 聚合限额：其余槽位现有文件合计 + 本次上传
  const slotWhere = and(
    eq(noteImages.noteVersionId, version.id),
    eq(noteImages.spec, meta.spec),
    eq(noteImages.pageIndex, meta.pageIndex),
  );
  const others = db
    .select()
    .from(noteImages)
    .where(
      and(
        eq(noteImages.noteVersionId, version.id),
        eq(noteImages.spec, meta.spec),
      ),
    )
    .all()
    .filter((row) => row.pageIndex !== meta.pageIndex);
  let othersBytes = 0;
  for (const row of others) {
    try {
      othersBytes += statSync(
        resolveNoteBlobPath(dataDir, row.path, ".png"),
      ).size;
    } catch {
      // 文件缺失的行（损坏/被清）：按 0 计——它的槽位本来就待重建
    }
  }
  if (othersBytes + png.byteLength > NOTE_VERSION_IMAGES_MAX_BYTES) {
    throw new HttpError(
      413,
      "NOTE_LIMIT_EXCEEDED",
      `该版本派生图合计超过 ${NOTE_VERSION_IMAGES_MAX_BYTES / (1024 * 1024)}MiB 限额（暂定值），请精简切片后重试`,
    );
  }

  // 4. 落位 + 槽位 upsert
  const imageId = randomUUID();
  const relPath = noteImageRelPath(note.id, imageId);
  const hash = createHash("sha256").update(png).digest("hex");
  writeFileAtomic({
    finalPath: resolveNoteBlobPath(dataDir, relPath, ".png"),
    bytes: png,
  });
  const old = db.select().from(noteImages).where(slotWhere).get();
  try {
    db.transaction((tx) => {
      if (old !== undefined) {
        tx.delete(noteImages).where(eq(noteImages.id, old.id)).run();
      }
      tx.insert(noteImages)
        .values({
          id: imageId,
          noteVersionId: version.id,
          spec: meta.spec,
          pageIndex: meta.pageIndex,
          cropX: meta.crop.x,
          cropY: meta.crop.y,
          cropW: meta.crop.width,
          cropH: meta.crop.height,
          pixelWidth: meta.pixelWidth,
          pixelHeight: meta.pixelHeight,
          path: relPath,
          hash,
          state: "ready",
        })
        .run();
    });
  } catch (err) {
    // 事务失败：新文件成为孤儿（无行引用），清理后重抛
    try {
      unlinkSync(resolveNoteBlobPath(dataDir, relPath, ".png"));
    } catch {
      // 文件未落位或已被删——无需处理
    }
    throw err;
  }
  // 旧槽位文件 best-effort 回收（失败留孤儿文件，无行引用它）
  if (old !== undefined) {
    try {
      unlinkSync(resolveNoteBlobPath(dataDir, old.path, ".png"));
    } catch {
      // 同上
    }
  }
  return noteImageMetaSchema.parse({
    imageId,
    noteVersionId: version.id,
    spec: meta.spec,
    pageIndex: meta.pageIndex,
    crop: meta.crop,
    pixelWidth: meta.pixelWidth,
    pixelHeight: meta.pixelHeight,
    state: "ready",
    hash,
  });
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
  /**
   * 存量 bodyPath 形态异常（越出 blobs/notes 或文件名不合 v<rev>-<hash12>
   * 模式）的版本行数。>0 时本轮**放弃孤儿文件清扫**（保守不删，见下），
   * 计数暴露给运维排查——正常数据恒为 0。
   */
  malformedBodyPaths: number;
}

/**
 * 未引用版本延迟回收（方案 §6.3；本任务只提供函数与测试，**未接入任何
 * 自动调度**——备份引用保留清单在 T6R.14 落地前不开启自动 GC，不以节省
 * 空间破坏备份可恢复性）。
 *
 * 保留集合（绝不可删）：
 * - 所有 notes.currentVersionId（工作头/订正检查点头）；
 * - 所有 submission_evidence.version_id（提交原稿）；
 * - 安全窗口内创建的全部版本与临时文件（在途上传、丢回执重试窗口——
 *   后者即 mutationId 幂等窗口：版本行被回收后幂等记录随之消失，窗口外
 *   重放按 CAS 冲突可诊断处理，见 note_versions.mutation_id 列注释）。
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
    malformedBodyPaths: 0,
  };

  // 保留集合（isNotNull 在 SQL 层裁掉 NULL 头/无版本证据行，免空值入集合）
  const keep = new Set<string>();
  for (const row of db
    .select({ id: notes.currentVersionId })
    .from(notes)
    .where(isNotNull(notes.currentVersionId))
    .all()) {
    // isNotNull 已在 SQL 层裁 NULL；TS 侧守卫兜底（drizzle 不收窄字段类型）
    if (row.id !== null) keep.add(row.id);
  }
  for (const row of db
    .select({ id: submissionEvidence.versionId })
    .from(submissionEvidence)
    .where(isNotNull(submissionEvidence.versionId))
    .all()) {
    if (row.id !== null) keep.add(row.id);
  }

  // 超窗口候选（serverSavedAt 为定长 UTC ISO，字典序即时间序；列投影只取
  // 回收循环用到的两列——复审⑫）
  const candidates = db
    .select({ id: noteVersions.id, bodyPath: noteVersions.bodyPath })
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
    const bodyFilePattern = /^v\d+-[0-9a-f]{12}\.json\.gz$/;
    // live 匹配用**存储字符串集合**（快），但保留防御：存量 bodyPath 形态
    // 异常（越出根/文件名不合模式）时，其对应文件无法可靠对账——本轮放弃
    // 孤儿清扫（tmp 清扫不受影响），计数 malformedBodyPaths 暴露给运维。
    // 两位审查角的折中：不做逐行 resolve 校验（多数派：纯集合足够），也不
    // 无条件信任集合（少数派：异常数据宁可漏删不可误删）。
    // 匹配双方一律 toLowerCase：NTFS 大小写不敏感，手工迁移/改目录名大小写
    // 后磁盘目录名与 DB 路径可能仅大小写不同——不做归一会把活文件误判成
    // 孤儿误删（复审④）。malformed 判定（basename 模式）保持大小写敏感：
    // 非小写规范形态本就该按异常保守处理。
    let liveBodyRelSet: Set<string> | null = null;
    const liveBodyRel = (): Set<string> => {
      if (liveBodyRelSet === null) {
        liveBodyRelSet = new Set<string>();
        for (const row of db
          .select({ p: noteVersions.bodyPath })
          .from(noteVersions)
          .all()) {
          const rel = relative(notesRoot, resolve(dataDir, row.p));
          const base = rel.split(/[\\/]/).at(-1) ?? "";
          // rel===""（路径恰为根本身）不必单列：basename 不合模式必兜住
          if (
            rel.startsWith("..") ||
            isAbsolute(rel) ||
            !bodyFilePattern.test(base)
          ) {
            result.malformedBodyPaths += 1;
            continue;
          }
          // 键分隔符归一为 "/"：入库串用 "/"（复审⑦）而 path.relative 在
          // Windows 产 "\"，扫描侧统一拼 "/"——两侧一致才能对账
          liveBodyRelSet.add(rel.split(/[\\/]/).join("/").toLowerCase());
        }
      }
      return liveBodyRelSet;
    };
    // 单目录扫描：tmp 清扫全域通用；孤儿判定仅 notes 域启用（orphan 入参；
    // dirName 用于拼 live 集合的相对键 <noteId>/<文件名>）
    const sweepDir = (dir: string, dirName: string, orphan: boolean): void => {
      for (const name of readdirSync(dir)) {
        const filePath = join(dir, name);
        try {
          if (statSync(filePath).mtimeMs >= cutoffMs) continue; // 窗口内不动
          if (name.startsWith(".tmp-")) {
            unlinkSync(filePath);
            result.sweptTmp += 1;
          } else if (
            orphan &&
            bodyFilePattern.test(name) &&
            !liveBodyRel().has(`${dirName}/${name}`.toLowerCase()) &&
            result.malformedBodyPaths === 0
          ) {
            unlinkSync(filePath);
            result.sweptOrphanFiles += 1;
          }
        } catch {
          // 文件恰好消失（在途请求刚 rename）——跳过
        }
      }
    };
    // .tmp- 前缀 = lib/blob-io.writeFileAtomic 的独有命名（ink/media/note
    // 三通道共用，复审⑧起不再是 note 独有——ink/media 换用共享原语前的
    // 旧固定名 `<名>.tmp` 后缀残留不在此列，无清扫通道）；media 的最终文件
    // 直接在 blobs/media 根下（无子目录），故根级散文件也要扫 tmp
    const sweepRoot = (root: string, orphan: boolean): void => {
      if (!existsSync(root)) return;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          sweepDir(join(root, entry.name), entry.name, orphan);
        } else if (
          entry.name.startsWith(".tmp-") &&
          statSync(join(root, entry.name)).mtimeMs < cutoffMs
        ) {
          try {
            unlinkSync(join(root, entry.name));
            result.sweptTmp += 1;
          } catch {
            // 恰好消失——跳过
          }
        }
      }
    };
    sweepRoot(notesRoot, true);
    sweepRoot(resolve(dataDir, "blobs", "ink"), false);
    sweepRoot(resolve(dataDir, "blobs", "media"), false);
  }
  return result;
}

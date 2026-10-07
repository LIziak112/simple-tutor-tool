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
import type {
  CorrectionCreateRequest,
  CorrectionSealRequest,
  NoteImageUploadMeta,
  NoteRecordMeta,
  NoteSubmissionEvidenceMeta,
  NoteUploadMetaInput,
  StudentNotebookData,
} from "@tutor/contract";
import {
  INK_LOGICAL_WIDTH,
  NOTE_BODY_DECOMPRESSED_MAX_BYTES,
  NOTE_BODY_GZIP_MAX_BYTES,
  NOTE_IMAGE_PNG_MAX_BYTES,
  NOTE_RENDER_VERSION,
  NOTE_VERSION_IMAGES_MAX_BYTES,
  type NotebookRound,
  type NoteDoc,
  type NoteHeadData,
  type NoteHeadsData,
  type NoteImageMeta,
  type NoteVersionReceipt,
  noteDocSchema,
  noteImageMetaSchema,
  noteIssueIsLimit,
  noteRecordMetaSchema,
  noteRevisionConflictCurrentSchema,
  noteSubmissionEvidenceMetaSchema,
} from "@tutor/contract";
import { and, asc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  attempts,
  type NoteImageRow,
  type NoteRow,
  type NoteVersionRow,
  noteImages,
  notes,
  noteVersions,
  responses,
  type SubmissionEvidenceRow,
  submissionEvidence,
} from "../db/schema";
import {
  type AtomicFileFaults,
  parseGzipOrJsonBytes,
  readFileBytes,
  resolveWithinRoot,
  writeFileAtomic,
} from "../lib/blob-io";
import { HttpError } from "../lib/http-error";
import { pngIntact } from "../lib/png";
import {
  requireAttemptQuestion,
  requireAttemptQuestionRow,
  requireAttemptQuestions,
  requireUsableAttempt,
} from "./attempt-service";
import { collectBackupReferencedPaths } from "./backup-service";
import { studentTeacherIdOf } from "./student-course-service";
import {
  findTeacherAttempt,
  requireTeacherAttempt,
  sourceOf,
} from "./teacher-attempt-service";
import { roundSourceTitle } from "./wrong-questions";

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

/**
 * best-effort 删除 notes 域内文件（复审轮⑮参数化后缀，正文/图片三处共用）：
 * 文件未创建（写/rename 前失败）或已被删除时静默；域外路径仍会被
 * resolveNoteBlobPath 边界校验拦下（500 不吞）。
 */
function cleanupNoteFile(
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
 * T6R.15 三 phase 分派（meta.phase 缺省 scratch，旧客户端零变化）：
 * - scratch：本次工作稿。draft 可写、交卷后新写 409 ALREADY_SUBMITTED（原稿
 *   冻结）；题目门口走**严格** requireAttemptQuestion（快照非空）；
 * - correction：订正稿。必须已交卷（draft → 409 NOTE_NOT_SUBMITTED）；目标行
 *   = 该 (attempt,question) 的**未封存** correction 行（D1 未封存至多一行）；
 *   已封存行的写入 409 NOTE_CORRECTION_SEALED；题目门口走**宽松**
 *   requireAttemptQuestionRow（软删题历史材料照常可写）；
 * - supplement：交卷后找回的补充稿。门口同 correction（必须已交卷、宽松题目
 *   口径）；每 (attempt,question) 单行先查后插 + CAS，无封存语义。
 *
 * 顺序（方案 §6.2/§6.3；幂等检查先于冲突判断与状态门槛——已成功但丢回执
 * 的请求不能被误判成 409）：
 * 1. requireUsableAttempt（本人 + 来源访问权 + 懒冻结）→ 题目门口（按 phase
 *    严格/宽松分派，见上）；；
 * 2. 解析限额 + 规范化 hash；
 * 3. 幂等查重（**前置于状态门槛**——复审①裁决：mutationId+归属+hash 匹配的
 *    重放在**任何 attempt 状态**（含已交卷）都返回原回执，丢回执的客户端在
 *    交卷后补传重试不被 409 挡；只有非重放才走 409）：
 *    mutationId 全局命中且（同一 **phase 目标行** + 同正文 hash）→ 返回原回执
 *    （逐字段，savedAt 用行内原值）；命中但目标行不同（跨笔记/跨 phase）或
 *    正文不同 → 409 NOTE_MUTATION_MISMATCH（绝不把他人回执发回、也绝不在
 *    别的笔记下关联版本）；
 * 4. 状态门槛（非重放写入，按 phase 分派，见函数头上方）；
 * 5. CAS 预检：baseRevision ≠ 当前 head → 409 附 _current 摘要（correction
 *    在「无未封存行 + baseRevision>0」时先区分 SEALED/裸冲突，见实现内注释）；
 * 6. 文件落位（唯一 tmp → rename 不可变路径）；
 * 7. 事务：CAS 复核 → 目标行先查后插（同 attempt 同题同 phase 定位，沿用
 *    服务层保证口径）→ 插 note_versions 不可变行 → 切 notes 头指针；
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
  // T6R.15：入参用输入类型（phase 可缺省 = scratch，与契约缺省同语义——
  // 路由传入 parse 后的输出形态同样兼容）
  meta: NoteUploadMetaInput,
  faults?: AtomicFileFaults,
): NoteVersionReceipt {
  // 1. 权限与冻结集合（T6R.3 统一门口；「冻结内容不冻结权限」——课程撤权
  //    等照常在 requireUsableAttempt 拦截）。题目门口按 phase 分派：scratch
  //    严格（快照非空——requireAttemptQuestion 返回行 id 即 questionRevisionId）；
  //    correction/supplement 宽松（软删/历史缺失题的订正与补充照常可写）
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  const phase = meta.phase ?? "scratch";
  const { id: questionRevisionId } =
    phase === "scratch"
      ? requireAttemptQuestion(db, attempt, questionId)
      : requireAttemptQuestionRow(db, attempt.id, questionId);

  // 2. 解析 + 规范化 hash（先验后写；canonical 字符串只产一次——UTF-8 编码
  //    成 Buffer 后 hash 与落盘共用，避免二次编码拷贝）
  const doc = parseNoteBodyBytes(bodyBytes);
  const canonicalBytes = Buffer.from(canonicalNoteJson(doc), "utf8");
  const hash = createHash("sha256").update(canonicalBytes).digest("hex");
  const { strokeCount, pointCount, paperHeight } = noteMetrics(doc);

  // T6R.15：目标行定位 WHERE（scratchWhere 泛化为 phaseWhere）——scratch/
  // supplement 每 (attempt,question) 单行；correction 取**未封存**行（D1：
  // 已封存行永不再接受写入，再编辑 = 新开一行）
  const phaseWhere = and(
    eq(notes.attemptId, attempt.id),
    eq(notes.questionId, questionId),
    eq(notes.phase, phase),
    phase === "correction" ? isNull(notes.sealedAt) : undefined,
  );

  // 3. 幂等查重（先于冲突判断与状态门槛，见函数头注释）。判定目标行 = 该
  //    phase 的定位行——跨 phase 重放（scratch 的 mutationId 打订正等）与
  //    跨笔记重放同走 MISMATCH；封存后行的丢回执重试（目标行已不在定位集）
  //    亦 MISMATCH——客户端重铸 mutationId 后的新上传自然落到 SEALED/新行
  //    分支，可诊断且不产生错误状态
  const existing = db.select().from(notes).where(phaseWhere).get();
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

  // 4. 状态门槛（非重放的新写入才受交卷门槛约束）
  if (phase === "scratch") {
    if (attempt.status !== "draft") {
      throw new HttpError(
        409,
        "ALREADY_SUBMITTED",
        "这份作业已交卷，草稿已固定为原稿，不能再写入新版本",
      );
    }
  } else {
    // correction/supplement：只能写在已交卷（status 非 draft——含 submitted 与
    // graded）的作答上；draft → NOTE_NOT_SUBMITTED（D3 措辞修正的新码）
    if (attempt.status === "draft") {
      throw new HttpError(
        409,
        "NOTE_NOT_SUBMITTED",
        "这份作业尚未交卷，订正与补充稿只能在交卷后写入",
      );
    }
    // correction 专属分派（D1/D2）：无未封存行且 baseRevision>0——存在已封存
    // 行 → 409 NOTE_CORRECTION_SEALED（旧行已封存，客户端应新开一份，比裸
    // CAS 冲突更可诊断）；无任何 correction 行 → 现有 revisionConflict 口径
    // （revision 0 摘要，与 scratch「凭空 baseRevision>0」同诊断）
    if (
      phase === "correction" &&
      existing === undefined &&
      meta.baseRevision > 0
    ) {
      if (
        db
          .select({ id: notes.id })
          .from(notes)
          .where(
            and(
              eq(notes.attemptId, attempt.id),
              eq(notes.questionId, questionId),
              eq(notes.phase, "correction"),
              isNotNull(notes.sealedAt),
            ),
          )
          .get() !== undefined
      ) {
        throw new HttpError(
          409,
          "NOTE_CORRECTION_SEALED",
          "该题的上一份订正已保存（封存），再编辑请新开一份订正",
        );
      }
      throw revisionConflict(db, undefined);
    }
  }

  // 5. CAS 预检（快失败：绝大多数冲突在这里挡掉，不写文件）
  const headRevision = existing?.currentRevision ?? 0;
  if (meta.baseRevision !== headRevision) {
    throw revisionConflict(db, existing);
  }

  // 6. 文件落位（路径三段全服务端生成；questionId 永不进路径）
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
    // 7. 事务：CAS 复核 + 目标行先查后插 + 不可变版本行 + 统一守卫切头
    db.transaction((tx) => {
      const row = tx.select().from(notes).where(phaseWhere).get();
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
            phase,
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
          // 渲染器版本单一事实来源在契约（T6R.6 渲染器同口径引用）
          renderVersion: NOTE_RENDER_VERSION,
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
    // 8. 失败清理与跨进程兜底（better-sqlite3 同步单进程下兜底分支不可达，
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
      cleanupNoteFile(dataDir, relPath, ".json.gz");
      if (winner !== undefined) {
        throw new HttpError(
          409,
          "NOTE_MUTATION_MISMATCH",
          "同一 mutationId 已绑定其他正文变更（或另一份草稿），请生成新的 mutationId 重试",
        );
      }
      throw err;
    }
    cleanupNoteFile(dataDir, relPath, ".json.gz");
    if (violation === "revision") {
      throw revisionConflict(
        db,
        db.select().from(notes).where(phaseWhere).get(),
      );
    }
    throw err;
  }

  return { noteId, revision: newRevision, versionId, hash, savedAt: now };
}

// ---------- 读取（完整性口径；T6R.5 读路由复用） ----------

/**
 * 已确认版本 → 正文文档 + 行内 hash + 按同一规范化规则重算的 hash。
 * 消费方是测试/备份完整性与 hash 对账（复审轮⑰澄清：路由读走
 * readNoteVersionGzip 原字节直出，不经本函数解析）。
 */
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
    // T6R.15（D2/D6/D10）：封存与反思三字段随行投影（非 correction 行恒
    // null；correction 已封存行携带 seal 时刻与冻结反思）
    sealedAt: row.sealedAt,
    stuckAt: row.reflectionStuckAt,
    errorCause: row.reflectionErrorCause,
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
 * (attempt,question) 的证据行 + corrections/supplements 投影（T6R.15 D6）：
 * noteHeadOf（学生/教师 evidence、单题/批量头）与题目笔记本聚合共用同一组装
 * ——同一 (attempt,question) 的材料集合只此一份实现，不复制粘贴。
 * - corrections：全部订正行——已封存按 sealedAt 升序在前（同刻 attempt 内
 *   id 升序兜底稳定），未封存行殿后（serverSavedAt 升序兜底）；
 * - supplements：全部补充稿行（serverSavedAt 升序，id 兜底）。
 * evidenceRow 可由调用方预取传入（noteHeadOf 的生效版本判定同用该行，免双查）。
 */
function noteCollectionsOf(
  db: Db,
  attemptId: string,
  questionId: string,
  evidenceRow?: SubmissionEvidenceRow,
): {
  evidence: NoteSubmissionEvidenceMeta | null;
  corrections: NoteRecordMeta[];
  supplements: NoteRecordMeta[];
} {
  const evidence =
    evidenceRow !== undefined
      ? evidenceRow
      : db
          .select()
          .from(submissionEvidence)
          .where(
            and(
              eq(submissionEvidence.attemptId, attemptId),
              eq(submissionEvidence.questionId, questionId),
            ),
          )
          .get();
  const correctionRows = db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.attemptId, attemptId),
        eq(notes.questionId, questionId),
        eq(notes.phase, "correction"),
      ),
    )
    .all();
  const corrections = [
    // 已封存在前（sealedAt 升序——检查点时间线）；未封存最后（正在编辑的
    // 那份行恰至多一行，D1）
    ...correctionRows
      .filter((row) => row.sealedAt !== null)
      .sort(
        (a, b) =>
          (a.sealedAt ?? "").localeCompare(b.sealedAt ?? "") ||
          a.id.localeCompare(b.id),
      ),
    ...correctionRows
      .filter((row) => row.sealedAt === null)
      .sort(
        (a, b) =>
          (a.serverSavedAt ?? "").localeCompare(b.serverSavedAt ?? "") ||
          a.id.localeCompare(b.id),
      ),
  ].map(noteRecordMetaOf);
  const supplements = db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.attemptId, attemptId),
        eq(notes.questionId, questionId),
        eq(notes.phase, "supplement"),
      ),
    )
    .all()
    .sort(
      (a, b) =>
        (a.serverSavedAt ?? "").localeCompare(b.serverSavedAt ?? "") ||
        a.id.localeCompare(b.id),
    )
    .map(noteRecordMetaOf);
  return {
    evidence: evidence === undefined ? null : noteEvidenceMetaOf(evidence),
    corrections,
    supplements,
  };
}

/**
 * 头投影组装（①②⑥共用）：
 * - note：该 attempt 该题的 scratch 行（correction/supplement 是 T6R.15 的
 *   独立 NoteRecord，不进本投影）；无行 → null（契约显式空态 notCreated）；
 * - 生效版本：证据行存在即以其 versionId 为准（frozen→原稿版本；missing/
 *   none→null→images 恒空——**不回退工作头**，T6R.10 落写；仅无证据行
 *   （未交卷/旧客户端未采集）才取工作头 currentVersionId）；
 * - evidence / corrections / supplements：noteCollectionsOf 单点组装（证据行
 *   + 订正/补充集合，T6R.15 服务层单落地聚合）。
 */
function noteHeadOf(
  db: Db,
  attemptId: string,
  questionId: string,
): NoteHeadData {
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
  // 生效版本（复审轮①）：证据行**存在**即以其声明为准——missing/none 的
  // versionId=null → images 恒空（交卷后不再回退工作头，防止「缺稿交卷却
  // 显示出工作稿图片」的口径漂移）；仅**无证据行**（未交卷）才看工作头。
  const operativeVersionId =
    evidence !== undefined
      ? evidence.versionId
      : (note?.currentVersionId ?? null);
  const imageRows = operativeVersionId
    ? db
        .select()
        .from(noteImages)
        .where(eq(noteImages.noteVersionId, operativeVersionId))
        .orderBy(asc(noteImages.spec), asc(noteImages.pageIndex))
        .all()
    : [];
  const {
    evidence: evidenceMeta,
    corrections,
    supplements,
  } = noteCollectionsOf(db, attemptId, questionId, evidence);
  return {
    note: note === undefined ? null : noteRecordMetaOf(note),
    images: imageRows.map(noteImageMetaOf),
    evidence: evidenceMeta,
    corrections,
    supplements,
  };
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

/**
 * ①′ POST /api/student/attempts/:id/note-heads：批量头投影（T6R.14）。
 * 门口与单题 head 完全一致（requireUsableAttempt + 冻结集合严格口径——
 * requireAttemptQuestion 的 WHERE 三条件一次 inArray 批量判定，任一题目
 * 不在集合 → 404 QUESTION_NOT_FOUND 同码同文案整批拒绝，不静默剔除）；
 * questionIds 去重保序，响应顺序与请求一致。
 * 每条复用同一 noteHeadOf 投影（零泄露口径同单题：只含版本指针/计数/图片
 * 元信息，无正文与图片字节）。
 */
export function getStudentNoteHeads(
  db: Db,
  studentId: string,
  attemptId: string,
  questionIds: readonly string[],
): NoteHeadsData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  const uniqueIds = [...new Set(questionIds)];
  // 整批过题目门口（任一不在冻结集合即 404，不做半批响应）——批量兄弟
  // requireAttemptQuestions（与单题共享严格口径语义，C8）
  requireAttemptQuestions(db, attempt, uniqueIds);
  return {
    heads: uniqueIds.map((questionId) => ({
      questionId,
      head: noteHeadOf(db, attempt.id, questionId),
    })),
  };
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

// ---------- T6R.15：订正检查点（创建与封存，D1/D2/D3） ----------

/**
 * 创建订正记录（POST /api/student/attempts/:id/notes/:qid/corrections，D3）：
 * 1. 门口：requireUsableAttempt（本人 + 来源访问权 + 懒冻结）+
 *    requireAttemptQuestionRow（宽松口径——软删/历史缺失题的订正照常可创建）
 *    + attempt 已交卷（draft → 409 NOTE_NOT_SUBMITTED）；
 * 2. D1「未封存至多一行」：已存在未封存行 → 409 NOTE_CORRECTION_OPEN_EXISTS
 *    （应继续编辑既有行，不另起）；
 * 3. copyFromOriginal=true：读提交证据固定的原稿正文（evidence 行须 state=
 *    'frozen' 且 versionId 非空，否则 409 NOTE_ORIGINAL_UNAVAILABLE——
 *    missing/none/无行都无可复制的原稿）→ canonicalNoteJson 重规范化（同
 *    hash 口径，复制件与原稿同 hash）→ 唯一 tmp→rename 落**新行自己的**
 *    不可变文件 → 事务插 notes 行（currentRevision=1、head=新版本、
 *    sealed_at NULL）+ note_versions 行（mutationId 服务端 randomUUID——
 *    服务端发起的复制无客户端幂等键，铸随机值占全局唯一索引）；
 *    false → 只插 revision=0 空白行（客户端以 baseRevision=0 上传正文）；
 * 4. 事务内先查后插复核未封存行（与 scratch 同口径，不建 partial unique
 *    index——单进程同步下防并发纵深）；
 * 5. 响应 noteHeadData（noteHeadOf 单点组装，corrections 含新行）。
 * 原稿证据行与原稿版本行全程只读（原稿身份由交卷事务唯一铸成，D9——订正
 * 是学生自有材料，correction/supplement 结构上进不了 submission_evidence）。
 */
export function createCorrection(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  questionId: string,
  req: CorrectionCreateRequest,
): NoteHeadData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  const { id: questionRevisionId } = requireAttemptQuestionRow(
    db,
    attempt.id,
    questionId,
  );
  if (attempt.status === "draft") {
    throw new HttpError(
      409,
      "NOTE_NOT_SUBMITTED",
      "这份作业尚未交卷，订正只能在交卷后创建",
    );
  }
  const openWhere = and(
    eq(notes.attemptId, attempt.id),
    eq(notes.questionId, questionId),
    eq(notes.phase, "correction"),
    isNull(notes.sealedAt),
  );
  if (
    db.select({ id: notes.id }).from(notes).where(openWhere).get() !== undefined
  ) {
    throw new HttpError(
      409,
      "NOTE_CORRECTION_OPEN_EXISTS",
      "该题已有一份进行中的订正，请继续编辑它（保存后再新开一份）",
    );
  }
  const now = new Date().toISOString();
  const noteId = randomUUID();
  // 复制原稿：读 evidence.versionId 正文（复用读路径原语）→ 重规范化铸首版本
  let seeded:
    | {
        versionId: string;
        hash: string;
        relPath: string;
        canonicalBytes: Buffer;
        strokeCount: number;
        pointCount: number;
        paperHeight: number;
      }
    | undefined;
  if (req.copyFromOriginal) {
    const evidence = db
      .select()
      .from(submissionEvidence)
      .where(
        and(
          eq(submissionEvidence.attemptId, attempt.id),
          eq(submissionEvidence.questionId, questionId),
        ),
      )
      .get();
    if (
      evidence === undefined ||
      evidence.state !== "frozen" ||
      evidence.versionId === null
    ) {
      throw new HttpError(
        409,
        "NOTE_ORIGINAL_UNAVAILABLE",
        "没有可复制的原稿（交卷时未固定笔迹），请新建空白订正",
      );
    }
    const { doc } = readNoteVersionDoc(db, dataDir, evidence.versionId);
    const canonicalBytes = Buffer.from(canonicalNoteJson(doc), "utf8");
    const hash = createHash("sha256").update(canonicalBytes).digest("hex");
    const { strokeCount, pointCount, paperHeight } = noteMetrics(doc);
    seeded = {
      versionId: randomUUID(),
      hash,
      relPath: noteBodyRelPath(noteId, 1, hash),
      canonicalBytes,
      strokeCount,
      pointCount,
      paperHeight,
    };
  }
  try {
    if (seeded !== undefined) {
      writeNoteBodyFile(dataDir, noteId, 1, seeded.hash, seeded.canonicalBytes);
    }
    db.transaction((tx) => {
      // D1 先查后插（事务内复核；单进程同步下不可达，多进程纵深防御）
      if (
        tx.select({ id: notes.id }).from(notes).where(openWhere).get() !==
        undefined
      ) {
        throw new HttpError(
          409,
          "NOTE_CORRECTION_OPEN_EXISTS",
          "该题已有一份进行中的订正，请继续编辑它（保存后再新开一份）",
        );
      }
      // 插行骨架与 saveNoteVersion 同款（FK 要求版本行先于头指针存在）：
      // 先插 revision=0 空白行 → 插复制首版本行 → 统一守卫切头；中间态只在
      // 本事务内可见（revision=0 ⇔ 头指针/确认时间空，与契约一致）
      tx.insert(notes)
        .values({
          id: noteId,
          attemptId: attempt.id,
          questionId,
          questionRevisionId,
          phase: "correction",
          currentRevision: 0,
          currentVersionId: null,
          serverSavedAt: null,
          sealedAt: null,
          updatedAt: now,
        })
        .run();
      if (seeded !== undefined) {
        tx.insert(noteVersions)
          .values({
            id: seeded.versionId,
            noteId,
            revision: 1,
            bodyPath: seeded.relPath,
            hash: seeded.hash,
            strokeCount: seeded.strokeCount,
            pointCount: seeded.pointCount,
            paperWidth: INK_LOGICAL_WIDTH,
            paperHeight: seeded.paperHeight,
            serverSavedAt: now,
            renderVersion: NOTE_RENDER_VERSION,
            mutationId: randomUUID(),
          })
          .run();
        const switched = tx
          .update(notes)
          .set({
            currentRevision: 1,
            currentVersionId: seeded.versionId,
            serverSavedAt: now,
            updatedAt: now,
          })
          .where(and(eq(notes.id, noteId), eq(notes.currentRevision, 0)))
          .returning({ id: notes.id })
          .get();
        if (switched === undefined) {
          throw new HttpError(
            500,
            "INTERNAL",
            "订正头指针切换未命中（并发写竞争，本次创建已回滚）",
          );
        }
      }
    });
  } catch (err) {
    // 事务失败：复制文件成孤儿（无行引用），清理后重抛
    if (seeded !== undefined) {
      cleanupNoteFile(dataDir, seeded.relPath, ".json.gz");
    }
    throw err;
  }
  return noteHeadOf(db, attempt.id, questionId);
}

/**
 * 封存订正（POST …/corrections/seal，D2「保存订正」= 检查点）：
 * - 门口同 createCorrection（本人 + 宽松题目口径 + 已交卷：draft → 409
 *   NOTE_NOT_SUBMITTED）；
 * - 无未封存行 → 404 NOTE_NOT_FOUND（已全部封存或从未创建——中文文案说明
 *   无可保存订正，客户端据此引导新开或刷新）；
 * - CAS：req.baseRevision === currentRevision（契约已锁 ≥1；空白行 revision 0
 *   必不匹配 → 409 附 revision 0 摘要，可诊断「先上传正文再保存」）；
 * - 事务置 sealed_at=now + 两反思列（stuckAt/errorCause，缺省 null；D10 随
 *   seal 落列**冻结**——封存后行不再接受写入，反思不可改）；where 带
 *   「未封存 + currentRevision」双守卫（多进程纵深防御），未命中按 CAS
 *   冲突口径重抛；
 * - 响应 noteHeadData（封存行进入 corrections 的已封存段）。
 */
export function sealCorrection(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  req: CorrectionSealRequest,
): NoteHeadData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  requireAttemptQuestionRow(db, attempt.id, questionId);
  if (attempt.status === "draft") {
    throw new HttpError(
      409,
      "NOTE_NOT_SUBMITTED",
      "这份作业尚未交卷，不能保存订正",
    );
  }
  const open = db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.attemptId, attempt.id),
        eq(notes.questionId, questionId),
        eq(notes.phase, "correction"),
        isNull(notes.sealedAt),
      ),
    )
    .get();
  if (open === undefined) {
    throw new HttpError(
      404,
      "NOTE_NOT_FOUND",
      "该题当前没有进行中的订正可保存（未封存的订正不存在，可能已保存过）",
    );
  }
  if (req.baseRevision !== open.currentRevision) {
    throw revisionConflict(db, open);
  }
  const now = new Date().toISOString();
  const switched = db.transaction((tx) =>
    tx
      .update(notes)
      .set({
        sealedAt: now,
        reflectionStuckAt: req.stuckAt ?? null,
        reflectionErrorCause: req.errorCause ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(notes.id, open.id),
          eq(notes.currentRevision, req.baseRevision),
          isNull(notes.sealedAt),
        ),
      )
      .returning({ id: notes.id })
      .get(),
  );
  if (switched === undefined) {
    // 守卫未命中 = 另一并发封存/写入抢先（单进程同步下不可达的纵深分支）：
    // 按冲突口径重读组摘要，可诊断重试
    throw revisionConflict(
      db,
      db.select().from(notes).where(eq(notes.id, open.id)).get(),
    );
  }
  return noteHeadOf(db, attempt.id, questionId);
}

// ---------- T6R.15：题目笔记本聚合（D7——查询聚合，不建全局表） ----------

/**
 * 学生本人某题的跨来源历史轮次（GET /api/student/notebook/questions/:qid）：
 * - rounds = 该生该题全部**已交卷** attempt（status 非 draft，含 submitted 与
 *   graded；join responses 定题目成员——responses 行在即该卷含此题，wrong/
 *   course/assignment 三来源同口径），按 submittedAt 升序（同刻 attemptId
 *   升序兜底稳定，与错题本 rounds 同口径），roundOrdinal 从 1 递增；
 * - 每轮 sourceType/sourceLabel：复用 teacher-attempt-service.sourceOf +
 *   wrong-questions.roundSourceTitle 同一计算函数（作业 = 作业标题；课程
 *   练习 = 「单元标题 · 第 n 次」；错题重练 = 「错题重练 · 第 n 次」——
 *   AGENTS 第 1 条同一概念同一份定义，不复制粘贴逻辑）；
 * - questionVersion：responses.question_version 列（建卷冻结时的 questions.
 *   version 数字；契约注记口径为「冻结快照里的题目 version」——快照 JSON
 *   本身不含 version 字段，冻结版本号在 responses 行列上）。0（升级遗留
 *   未冻结语义）→ null，**绝不回填当前题库**；
 * - evidence/corrections/supplements：noteCollectionsOf 单点投影（与头投影
 *   同口径；该载荷零答案零题干，AGENTS 第 3 条——题目侧只有版本号数字）；
 * - 无轮次 → rounds=[]（不探测题目存在性——空数组即「没有历史」）。
 */
export function getStudentQuestionNotebook(
  db: Db,
  studentId: string,
  questionId: string,
): StudentNotebookData {
  const rows = db
    .select({
      attempt: attempts,
      questionVersion: responses.questionVersion,
    })
    .from(attempts)
    .innerJoin(
      responses,
      and(
        eq(responses.attemptId, attempts.id),
        eq(responses.questionId, questionId),
      ),
    )
    .where(and(eq(attempts.studentId, studentId), ne(attempts.status, "draft")))
    .orderBy(asc(attempts.submittedAt), asc(attempts.id))
    .all();
  if (rows.length === 0) {
    return { questionId, rounds: [] };
  }
  // 来源上下文的教师域（sourceOf 需域内查标题；D9 异常行 null → 空串域
  // 查询，与 student-records 同兜底口径）
  const teacherId = studentTeacherIdOf(db, studentId);
  const rounds: NotebookRound[] = rows.map((row, index) => {
    const source = sourceOf(db, row.attempt, teacherId ?? "");
    const { evidence, corrections, supplements } = noteCollectionsOf(
      db,
      row.attempt.id,
      questionId,
    );
    return {
      attemptId: row.attempt.id,
      sourceType: source.sourceType,
      sourceLabel: roundSourceTitle(source),
      // 非 draft 行 submittedAt 恒非空；防御回退 startedAt（契约 min(1)）
      submittedAt: row.attempt.submittedAt ?? row.attempt.startedAt,
      roundOrdinal: index + 1,
      questionVersion: row.questionVersion >= 1 ? row.questionVersion : null,
      evidence,
      corrections,
      supplements,
    };
  });
  return { questionId, rounds };
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
  const note = db
    .select()
    .from(notes)
    .where(eq(notes.id, version.noteId))
    .get();
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
): { version: NoteVersionRow; note: NoteRow } {
  const chain = requireNoteVersionChain(db, versionId);
  requireUsableAttempt(db, studentId, chain.note.attemptId);
  return chain;
}

/**
 * 教师域授权：note → attempt → student.teacherId（域外 404 NOTE_NOT_FOUND，
 * 不暴露存在性）。判定原语复用 teacher-attempt-service 的 findTeacherAttempt
 * （与教师作答接口同口径）；与 requireTeacherAttempt 保持两个薄抛层不直接
 * 合并——错误码区分是有意的（evidence 域外 ATTEMPT_NOT_FOUND vs 版本资源
 * NOTE_NOT_FOUND，复审确认保持）。
 */
function requireTeacherNoteVersion(
  db: Db,
  teacherId: string,
  versionId: string,
): { version: NoteVersionRow; note: NoteRow } {
  const chain = requireNoteVersionChain(db, versionId);
  if (findTeacherAttempt(db, teacherId, chain.note.attemptId) === null) {
    throw new HttpError(404, "NOTE_NOT_FOUND", "笔记版本不存在");
  }
  return chain;
}

/** ③⑦ 版本文档 gzip 原字节直出（不解析——消费在前端渲染器，坏文件属部署级问题） */
function readNoteVersionGzip(
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

/**
 * (versionId, imageId) → 图片行（行不存在 → 404 NOTE_NOT_FOUND）。
 * **授权由调用方先行完成**（requireStudentNoteVersion /
 * requireTeacherNoteVersion——先授权后查资源，权限失败不泄露行存在性；
 * T6R.5 复审②：本函数退化为纯行查找，不再自带归属链）。
 */
function requireNoteImageRow(
  db: Db,
  version: NoteVersionRow,
  imageId: string,
): NoteImageRow {
  const image = db
    .select()
    .from(noteImages)
    .where(
      and(eq(noteImages.id, imageId), eq(noteImages.noteVersionId, version.id)),
    )
    .get();
  if (image === undefined) {
    throw new HttpError(404, "NOTE_NOT_FOUND", "笔记图片不存在");
  }
  return image;
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
  const { version } = requireStudentNoteVersion(db, studentId, versionId);
  return readNoteImagePng(dataDir, requireNoteImageRow(db, version, imageId));
}

/** 教师端 ⑦：GET /api/teacher/note-versions/:id/images/:imageId(.png) */
export function getTeacherNoteImagePng(
  db: Db,
  dataDir: string,
  teacherId: string,
  versionId: string,
  imageId: string,
): ArrayBuffer {
  const { version } = requireTeacherNoteVersion(db, teacherId, versionId);
  return readNoteImagePng(dataDir, requireNoteImageRow(db, version, imageId));
}

// ---------- ⑤⑧ 补图上传（学生自产 / 教师重建；只能挂既定版本） ----------

/** 补图行为者：学生（本人 + attempt 可用）或教师（域链），授权语义见各分支 */
export type NoteImageActor =
  | { kind: "student"; id: string }
  | { kind: "teacher"; id: string };

/** 补图限额错误（单图/聚合两级 413 同码不同文案——复审轮⑬收敛为一个构造点） */
function noteImageLimitError(message: string): HttpError {
  return new HttpError(413, "NOTE_LIMIT_EXCEEDED", message);
}

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
 * 3. 同版本派生图聚合限额（**跨 spec 全槽位合计**——其余槽位 sum(byte_size)
 *    + 本次 ≤ 8MiB → 413；复审①：eq(spec) 只算同 spec 会跨规格漏算）；
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
    throw noteImageLimitError(
      `派生图超过 ${NOTE_IMAGE_PNG_MAX_BYTES / (1024 * 1024)}MiB 上传限额（暂定值），请降低分辨率后重试`,
    );
  }
  // 完整性口径 pngIntact（复审轮③）：魔数 + IHDR（长度恒 13）+ 尾部 IEND
  // 哨兵——截断/私造头部的文件在此被拒，比 ink 快照的 pngSize 宽松口径严一档
  const actual = pngIntact(png);
  if (actual === null) {
    throw new HttpError(
      400,
      "NOTE_VALIDATION_FAILED",
      "图片不是完整合法的 PNG 文档（魔数/IHDR/IEND 校验未通过）",
    );
  }
  if (actual.width !== meta.pixelWidth || actual.height !== meta.pixelHeight) {
    throw new HttpError(
      400,
      "NOTE_VALIDATION_FAILED",
      "图片实际尺寸与声明的像素宽高不一致",
    );
  }

  // 3. 聚合限额：同版本其余槽位现有文件合计 + 本次上传（复审①③：合计是
  //    **全版本跨 spec** 口径——槽位排除谓词（spec/pageIndex 任一不等即计入）
  //    下推 SQL，sum(byte_size) 一条聚合查询，不逐行取回、不 statSync）
  const sumRow = db
    .select({
      othersBytes: sql<number>`coalesce(sum(${noteImages.byteSize}), 0)`,
    })
    .from(noteImages)
    .where(
      and(
        eq(noteImages.noteVersionId, version.id),
        // 排除正被替换的目标槽位 (spec, pageIndex)——同 pageIndex 不同 spec
        // 是不同槽位，必须计入（ne(pageIndex) 单条件会把它们漏掉）
        or(
          ne(noteImages.spec, meta.spec),
          ne(noteImages.pageIndex, meta.pageIndex),
        ),
      ),
    )
    .get();
  const othersBytes = sumRow?.othersBytes ?? 0;
  if (othersBytes + png.byteLength > NOTE_VERSION_IMAGES_MAX_BYTES) {
    throw noteImageLimitError(
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
  const slotWhere = and(
    eq(noteImages.noteVersionId, version.id),
    eq(noteImages.spec, meta.spec),
    eq(noteImages.pageIndex, meta.pageIndex),
  );
  const old = db.select().from(noteImages).where(slotWhere).get();
  let inserted: NoteImageRow | undefined;
  try {
    inserted = db.transaction((tx) => {
      if (old !== undefined) {
        tx.delete(noteImages).where(eq(noteImages.id, old.id)).run();
      }
      return tx
        .insert(noteImages)
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
          byteSize: png.byteLength,
          hash,
          state: "ready",
        })
        .returning()
        .get();
    });
  } catch (err) {
    // 事务失败：新文件成为孤儿（无行引用），清理后重抛
    cleanupNoteFile(dataDir, relPath, ".png");
    throw err;
  }
  if (inserted === undefined) {
    // RETURNING 未命中：better-sqlite3 同步驱动下不可达，防御性闭合
    cleanupNoteFile(dataDir, relPath, ".png");
    throw new HttpError(500, "INTERNAL", "补图落库未返回行（防御性拒绝）");
  }
  // 旧槽位文件 best-effort 回收（失败留孤儿文件，无行引用它）；
  // 投影组装在事务提交之后（复审轮④：metaOf parse 失败不得落入删文件的
  // catch 域——已提交的新文件不能被回滚性清理删掉）
  if (old !== undefined) {
    cleanupNoteFile(dataDir, old.path, ".png");
  }
  return noteImageMetaOf(inserted);
}

// ---------- GC（未引用版本延迟回收 + 备份引用保留清单；自动调度本批未接线） ----------

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
   * 超窗口但被**备份引用保留清单**挡下的版本数（T6R.14：backups/ 快照 db
   * 引用的版本——当前库已无引用，删除会破坏该备份的恢复完整性）。
   */
  keptByBackup: number;
  /**
   * 不可读的备份快照数（损坏/非 SQLite 文件）。>0 时本轮**放弃版本删除与
   * 孤儿清扫**（不可读备份可能引用任何 blobs/notes 文件，保守不删）——
   * 正常部署恒为 0；持续 >0 需运维处理坏快照（轮转按 mtime 删除，
   * 坏文件不会自愈）。
   */
  unreadableBackupDbs: number;
  /**
   * 存量路径形态异常（复审轮⑥起含正文与图片两类）：bodyPath 越出 blobs/notes
   * 或文件名不合 v<rev>-<hash12>.json.gz 模式、imagePath 越出根或不合
   * img-<uuid>.png 模式。>0 时本轮**放弃孤儿文件清扫**（保守不删，见下），
   * 计数暴露给运维排查——正常数据恒为 0（字段名沿用 bodyPaths 兼容既有
   * 观测面，语义已扩为两类）。
   */
  malformedBodyPaths: number;
}

/**
 * 未引用版本延迟回收（方案 §6.3；备份引用保留清单已随 T6R.14 落地——见
 * 保留集合说明。**自动调度仍未接线**：A 批次保持保守，回收由运维显式调用
 * 或后续批次在保留清单验证充分后接线，不以节省空间破坏可恢复性）。
 *
 * 保留集合（绝不可删）：
 * - 所有 notes.currentVersionId（工作头/订正检查点头）；
 * - 所有 submission_evidence.version_id（提交原稿）；
 * - 安全窗口内创建的全部版本与临时文件（在途上传、丢回执重试窗口——
 *   后者即 mutationId 幂等窗口：版本行被回收后幂等记录随之消失，窗口外
 *   重放按 CAS 冲突可诊断处理，见 note_versions.mutation_id 列注释）；
 * - 全部 note_images 行引用的图片文件（被行引用即活文件——行随所属版本
 *   删除时才连带删文件；「正在生成图片的版本」的保留由图片行的存在性
 *   天然承载：T6R.6 生成通道只要先落行或落 .tmp 就不会被误清）；
 * - **备份引用保留清单**（T6R.14，方案 §6.3「保留中的数据库备份引用也要
 *   纳入保留集合」）：backups/ 下的快照 db 是整库时点拷贝，其
 *   note_versions/note_images 行指向的 blobs/notes 文件与当前库共享磁盘，
 *   回收会把「备份可恢复」变成「备份恢复出缺图」。每次 GC 现扫现存快照
 *   （只读打开逐个取 body_path/path），引用路径并入保留集合；快照按 14 份
 *   轮转删除后引用自然释放，下一轮 GC 即可回收。快照损坏不可读时**保守
 *   放弃本轮版本删除与孤儿清扫**（不可读备份可能引用任何文件——宁可漏删
 *   不可误删，与存量路径形态异常的既有口径一致；tmp 清扫不受影响）。
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
    keptByBackup: 0,
    unreadableBackupDbs: 0,
    malformedBodyPaths: 0,
  };
  const notesRoot = resolve(dataDir, "blobs", "notes");
  /**
   * relative + 越界判定的共同核（T4：relKeyOf/liveRel 共用）——返回原始
   * path.relative 结果（null = 越出根或恰为根本身）；分隔符/大小写归一与
   * 形态判定由两侧各自完成（见各自注释）。
   */
  const relWithinOf = (storedPath: string): string | null => {
    const rel = relative(notesRoot, resolve(dataDir, storedPath));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel;
  };
  /**
   * 存储路径 → notes 域内对账键（"/" 分隔、小写；越界 → null）。备份保留
   * 清单与版本删除判定共用同一归一（NTFS 大小写不敏感，复审④）；与孤儿
   * 清扫 liveRel 的差异仅在后者额外要求 basename 合模式（malformed 语义
   * 保留在 liveRel 侧，本函数不做形态判定）。
   */
  const relKeyOf = (storedPath: string): string | null => {
    const rel = relWithinOf(storedPath);
    return rel === null ? null : rel.split(/[\\/]/).join("/").toLowerCase();
  };

  /**
   * 备份引用保留清单（T6R.14）：快照扫描件在 backup-service.
   * collectBackupReferencedPaths（快照枚举/只读/坏件计数在其侧单测），
   * 这里只做 notes 域内的键归一并入保留集合。不可读快照计数触发本轮
   * 保守模式（版本删除与孤儿清扫全停）。
   */
  const backupKeepKeys = new Set<string>();
  const backupReferenced = collectBackupReferencedPaths(dataDir);
  result.unreadableBackupDbs = backupReferenced.unreadable;
  for (const storedPath of backupReferenced.paths) {
    const key = relKeyOf(storedPath);
    if (key !== null) backupKeepKeys.add(key);
  }
  // 保守模式：存在不可读快照时不删任何版本、不清任何孤儿（tmp 清扫不受影响）
  const conservative = result.unreadableBackupDbs > 0;

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

  // 单次全表拉取（复审轮⑯：候选筛选与 live 对账同一份数据，消双全表扫描）；
  // serverSavedAt 为定长 UTC ISO，字典序即时间序，内存过滤与 SQL lt 等价
  const versionRows = db
    .select({
      id: noteVersions.id,
      bodyPath: noteVersions.bodyPath,
      savedAt: noteVersions.serverSavedAt,
    })
    .from(noteVersions)
    .all();
  // 图片行单次全量拉取：候选版本的连带删除（消逐候选 N+1 查询）与
  // 孤儿对账 live 集合同源（复审轮⑥：图片文件纳入孤儿清扫框架）
  const imageRows = db
    .select({
      id: noteImages.id,
      noteVersionId: noteImages.noteVersionId,
      path: noteImages.path,
    })
    .from(noteImages)
    .all();
  const imagesByVersion = new Map<string, { id: string; path: string }[]>();
  for (const img of imageRows) {
    const list = imagesByVersion.get(img.noteVersionId);
    if (list === undefined) {
      imagesByVersion.set(img.noteVersionId, [img]);
    } else {
      list.push(img);
    }
  }

  for (const row of versionRows) {
    if (row.savedAt >= cutoff) continue; // 窗口内不动（在途/幂等窗口）
    if (keep.has(row.id)) {
      result.keptByReference += 1;
      continue;
    }
    if (conservative) continue; // 不可读快照在场：本轮不删（宁可漏删不可误删）
    const images = imagesByVersion.get(row.id) ?? [];
    // 备份引用保留清单：当前库无引用、但某快照引用的版本——删了会让该备份
    // 恢复出缺正文（方案 §6.3「保留中的数据库备份引用也要纳入保留集合」）。
    // C4：判定**同时看正文键与图片键**——bodyPath 形态异常（relKeyOf=null）
    // 的版本只查正文键会漏判，连带 unlink 掉快照引用的图片；任一键命中
    // 即整版本保守跳过（行与文件都不动）。
    const bodyKey = relKeyOf(row.bodyPath);
    const bodyKept = bodyKey !== null && backupKeepKeys.has(bodyKey);
    const imageKept = images.some((img) => {
      const key = relKeyOf(img.path);
      return key !== null && backupKeepKeys.has(key);
    });
    if (bodyKept || imageKept) {
      result.keptByBackup += 1;
      continue;
    }
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

  // 过期临时文件清扫（.tmp- 前缀 = writeFileAtomic 独有命名；窗口内
  // 一律不碰——那是可能仍在途的请求或崩溃现场），以及超窗口的
  // **无行孤儿文件**清扫（正文与图片同框架，复审轮⑥：rename/落位完成、
  // 事务未提交或行已删文件未清的崩溃残留——文件名合模式但不在任何
  // note_versions.body_path / note_images.path 中；窗口内不碰——那可能是
  // 刚落位、事务尚未提交的在途请求）。
  if (existsSync(notesRoot)) {
    const bodyFilePattern = /^v\d+-[0-9a-f]{12}\.json\.gz$/;
    const imageFilePattern = /^img-[0-9a-f-]{36}\.png$/;
    // live 对账集合（正文 + 图片两类行，均在上方单次拉取的数据上派生）。
    // 保留防御：存量路径形态异常（越出根/文件名不合模式）时，其对应文件
    // 无法可靠对账——本轮放弃孤儿清扫（tmp 清扫不受影响），计数
    // malformedBodyPaths 暴露给运维。匹配双方一律 toLowerCase：NTFS 大小写
    // 不敏感，手工迁移/改目录名大小写后磁盘目录名与 DB 路径可能仅大小写
    // 不同——不做归一会把活文件误判成孤儿误删（复审④）。malformed 判定
    // （basename 模式）保持大小写敏感：非小写规范形态本就该按异常保守处理。
    const liveRel = (storedPath: string, pattern: RegExp): string | null => {
      // 越界/根本身判定走共同核（T4）；basename 模式判定保持大小写敏感
      // （malformed 语义：非小写规范形态本就该按异常保守处理，复审④）
      const rel = relWithinOf(storedPath);
      if (rel === null) return null;
      const base = rel.split(/[\\/]/).at(-1) ?? "";
      if (!pattern.test(base)) return null;
      // 键分隔符归一为 "/"：入库串用 "/"（复审⑦）而 path.relative 在
      // Windows 产 "\"，扫描侧统一拼 "/"——两侧一致才能对账
      return rel.split(/[\\/]/).join("/").toLowerCase();
    };
    const liveSet = new Set<string>();
    for (const row of versionRows) {
      const key = liveRel(row.bodyPath, bodyFilePattern);
      if (key === null) {
        result.malformedBodyPaths += 1;
      } else {
        liveSet.add(key);
      }
    }
    for (const img of imageRows) {
      const key = liveRel(img.path, imageFilePattern);
      if (key === null) {
        result.malformedBodyPaths += 1;
      } else {
        liveSet.add(key);
      }
    }
    // 备份引用的文件并入 live 集合（T6R.14）：行已随当前库变化，但快照仍
    // 引用的文件不是孤儿。保守模式（存在不可读快照）下整个孤儿清扫本就
    // 放弃——此并入与之独立成立。
    for (const key of backupKeepKeys) liveSet.add(key);
    // tmp 清扫的最小共用件（复审轮⑮：两扫描器共用）
    const sweepTmpFile = (filePath: string): void => {
      try {
        unlinkSync(filePath);
        result.sweptTmp += 1;
      } catch {
        // 恰好消失——跳过
      }
    };
    // 单目录扫描：tmp 清扫全域通用；孤儿判定仅 notes 域启用（orphan 入参；
    // dirName 用于拼 live 集合的相对键 <noteId>/<文件名>）
    const sweepDir = (dir: string, dirName: string, orphan: boolean): void => {
      for (const name of readdirSync(dir)) {
        const filePath = join(dir, name);
        try {
          if (statSync(filePath).mtimeMs >= cutoffMs) continue; // 窗口内不动
          if (name.startsWith(".tmp-")) {
            sweepTmpFile(filePath);
          } else if (
            orphan &&
            !conservative && // 不可读快照在场：孤儿判定不可靠，本轮不清
            (bodyFilePattern.test(name) || imageFilePattern.test(name)) &&
            !liveSet.has(`${dirName}/${name}`.toLowerCase()) &&
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
        } else if (entry.name.startsWith(".tmp-")) {
          try {
            if (statSync(join(root, entry.name)).mtimeMs < cutoffMs) {
              sweepTmpFile(join(root, entry.name));
            }
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

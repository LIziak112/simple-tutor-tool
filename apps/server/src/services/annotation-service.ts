import { createHash, randomUUID } from "node:crypto";
import { statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type {
  AnnotationBaseImageMeta,
  AnnotationBaseImageReceipt,
  AnnotationBasePreviewData,
  AnnotationBaseRef,
  AnnotationDoc,
  AnnotationPhase,
  AnnotationReceipt,
  AnnotationSealData,
  AnnotationUploadMetaInput,
  AnnotationViewData,
} from "@tutor/contract";
import {
  ANNOTATION_BASE_MAX_HEIGHT_PX,
  ANNOTATION_BASE_PNG_MAX_BYTES,
  ANNOTATION_BASE_RENDER_VERSION,
  ANNOTATION_BASE_WIDTH_PX,
  ANNOTATION_BODY_DECOMPRESSED_MAX_BYTES,
  ANNOTATION_BODY_GZIP_MAX_BYTES,
  annotationConflictCurrentSchema,
  annotationDocSchema,
  annotationIssueIsLimit,
} from "@tutor/contract";
import { buildStaticQuestionMaterial } from "@tutor/md-dsl";
import { and, asc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type AnnotationBaseRow,
  type AnnotationRow,
  attempts as attemptsTable,
  type Attempt,
  annotationBases as annotationBasesTable,
  annotations as annotationsTable,
  questions as questionsTable,
  type ResponseRow,
  responses as responsesTable,
} from "../db/schema";
import {
  parseGzipOrJsonBytes,
  readFileBytes,
  resolveWithinRoot,
  writeFileAtomic,
} from "../lib/blob-io";
import { HttpError } from "../lib/http-error";
import { pngIntact } from "../lib/png";
import {
  attemptTeacherId,
  frozenRowsInDisplayOrder,
  questionOfRow,
  requireAttemptQuestion,
  requireOwnAttempt,
  requireUsableAttempt,
} from "./attempt-service";
import { knowledgeNamesByQuestion } from "./assignment-service";
import { materialOf, questionSnapshotHashOf } from "./question-evidence";
import { snapshotOfRow } from "./snapshot";
import { requireTeacherAttempt } from "./teacher-attempt-service";

/**
 * 题干标注服务（T6R.20，docs/题目草稿功能方案.md §10「固定底图＋独立矢量
 * 标注」；实施计划决策 1–10）：
 *
 * - **底图身份三要素**：annotation_bases 行持有 questionRevisionId（responses
 *   行 id，attempt 级冻结）＋ snapshotHash（canonicalJson→sha-256 题目内容
 *   身份，与 question-evidence 同一实现单源）＋ baseRenderVersion（契约常量，
 *   底图生成管线版本；不复用 note_versions.render_version——语义不同命名隔离）。
 *   同内容跨 attempt 不共享底图（归属按 attempt）。
 * - **「仅题干＋选项」载荷**：assembleAnnotationBase 走 materialOf(snapshot,
 *   student, "stem") 学生投影＋buildStaticQuestionMaterial——不拼「学生答案」
 *   节与任何教师节；materialOf 的 stemMdLeaksAnswers 哨兵（500
 *   EXPORT_ASSEMBLY_BROKEN）与 buildStaticQuestionMaterial 的第二道守卫都在
 *   本链路上生效（双检）。
 * - **底图存储**：PNG 内容寻址存 DATA_DIR/blobs/annotations/<sha256>.png；
 *   **绝不放 blobs/media/**（/blobs 伺服只放行 media/ 段且 requireAnySession
 *   会绕过题目可见性控制——泄露面）；伺服走 attempt 授权直出（学生
 *   requireOwnAttempt、教师 requireTeacherAttempt）。
 * - **两阶段 gate（没有可靠底图不能落墨）**：① preview 建 pending 行（幂等：
 *   ready 直返引用）→ ② 客户端栅格化单张 PNG 回传 registerBaseImage（服务端
 *   校验身份三要素＋宽度=maxWidthPx＋PNG 完整性）→ ready。putAnnotationDoc
 *   再校验底图行属同 attempt/question 且 ready——双保险。
 * - **正文协议**：CAS（baseRevision）＋ mutationId 幂等，与 note 上传协议
 *   同构；单行设计（annotations 无版本表），幂等窗口＝行仍持有该 mutationId。
 * - **交卷固定与订正**：sealAttemptAnnotations 置 sealedAt（幂等），此后 PUT
 *   → 409 ANNOTATION_SEALED；订正另开 phase=correction 记录（旧 scratch 只读，
 *   bytes 不变）。
 * - **stale 判定**：annotation_bases.snapshotHash ≠ 服务端现算该行快照 hash →
 *   回看载荷 base.stale=true（「旧版本题干的标注」；快照冻结后正常不可达，
 *   数据修复/异常行防御态，如实上报不静默）。
 */

// ---------- 规范化与路径 ----------

/**
 * 规范化序列化（固定键序重建对象树，同 canonicalNoteJson 口径）：
 * 顶层 {version, baseWidth, baseHeight}；每笔 {tool, color, weight, points}；
 * 每点 {x, y, p, t}。hash 与落盘字节都基于它——客户端 gzip 字节/键序不参与。
 */
export function canonicalAnnotationJson(doc: AnnotationDoc): string {
  return JSON.stringify({
    version: 1,
    baseWidth: doc.baseWidth,
    baseHeight: doc.baseHeight,
    strokes: doc.strokes.map((stroke) => ({
      tool: stroke.tool,
      color: stroke.color,
      weight: stroke.weight,
      points: stroke.points.map((p) => ({ x: p.x, y: p.y, p: p.p, t: p.t })),
    })),
  });
}

/** 底图 PNG 相对路径（DATA_DIR 内）：blobs/annotations/<sha256>.png（内容寻址） */
export function annotationBaseRelPath(hash: string): string {
  return ["blobs", "annotations", `${hash}.png`].join("/");
}

/** 标注正文相对路径（DATA_DIR 内）：blobs/annotation-bodies/<hash>.json.gz（内容寻址） */
export function annotationBodyRelPath(hash: string): string {
  return ["blobs", "annotation-bodies", `${hash}.json.gz`].join("/");
}

/** 底图路径边界校验（path.relative 强算法；500 内部码不进契约枚举——note 同款先例） */
function resolveAnnotationBasePath(dataDir: string, relPath: string): string {
  return resolveWithinRoot(dataDir, join("blobs", "annotations"), relPath, {
    suffix: ".png",
    violationCode: "ANNOTATION_PATH_INVALID",
  });
}

/** 标注正文路径边界校验（同上） */
function resolveAnnotationBodyPath(dataDir: string, relPath: string): string {
  return resolveWithinRoot(
    dataDir,
    join("blobs", "annotation-bodies"),
    relPath,
    { suffix: ".json.gz", violationCode: "ANNOTATION_PATH_INVALID" },
  );
}

// ---------- 正文解析与限额（413/400 分级） ----------

/**
 * 上传字节 → AnnotationDoc（先验后写，坏数据不落盘；同 parseNoteBodyBytes）：
 * gzip 后字节超限 → 413；解压超限（高压缩比炸弹）→ 413；解压失败 → 400；
 * JSON/schema 不合 → 400；限额类 issue（params.limit）→ 413。
 */
export function parseAnnotationBodyBytes(bytes: Uint8Array): AnnotationDoc {
  if (bytes.byteLength > ANNOTATION_BODY_GZIP_MAX_BYTES) {
    throw new HttpError(
      413,
      "ANNOTATION_LIMIT_EXCEEDED",
      `标注正文超过 ${ANNOTATION_BODY_GZIP_MAX_BYTES / 1024}KB 上传限额（暂定值），请精简后重试`,
    );
  }
  let jsonText: string;
  try {
    jsonText = parseGzipOrJsonBytes(bytes, {
      maxDecompressed: ANNOTATION_BODY_DECOMPRESSED_MAX_BYTES,
    });
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new HttpError(
        413,
        "ANNOTATION_LIMIT_EXCEEDED",
        "标注解压后超上限（高压缩比数据），请精简后重试",
      );
    }
    throw new HttpError(
      400,
      "ANNOTATION_VALIDATION_FAILED",
      "标注数据解压失败（不是合法的 gzip 文档）",
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonText) as unknown;
  } catch {
    throw new HttpError(
      400,
      "ANNOTATION_VALIDATION_FAILED",
      "标注正文不是合法的 JSON 文档",
    );
  }
  const parsed = annotationDocSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const limitIssue = parsed.error.issues.find(annotationIssueIsLimit);
    if (limitIssue !== undefined) {
      throw new HttpError(413, "ANNOTATION_LIMIT_EXCEEDED", limitIssue.message);
    }
    const first = parsed.error.issues[0]?.message ?? "AnnotationDoc 结构不合法";
    throw new HttpError(
      400,
      "ANNOTATION_VALIDATION_FAILED",
      `标注文档不合法：${first}`,
    );
  }
  return parsed.data;
}

/** 正文计数（annotations 行的 strokeCount/pointCount 来源） */
function annotationMetrics(doc: AnnotationDoc): {
  strokeCount: number;
  pointCount: number;
} {
  let pointCount = 0;
  for (const stroke of doc.strokes) pointCount += stroke.points.length;
  return { strokeCount: doc.strokes.length, pointCount };
}

// ---------- 行定位与投影 ----------

/**
 * 定位该 attempt 卷内的冻结行与卷内题号：展示序经 frozenRowsInDisplayOrder
 * （与结果视图/教师详情同口径）；快照缺失行不计数；目标行缺失或快照为空 →
 * 404 QUESTION_NOT_FOUND（严格口径同 requireAttemptQuestion——底图装配必须
 * 有可用快照）。
 */
function locateFrozenRow(
  db: Db,
  attempt: Attempt,
  questionId: string,
): { row: ResponseRow; no: number } {
  let no = 0;
  let hit: ResponseRow | undefined;
  for (const entry of frozenRowsInDisplayOrder(db, attempt)) {
    if (entry.row.questionSnapshotJson !== null) no += 1;
    if (entry.row.questionId === questionId) {
      hit = entry.row;
      break;
    }
  }
  if (hit === undefined || hit.questionSnapshotJson === null) {
    throw new HttpError(
      404,
      "QUESTION_NOT_FOUND",
      "题目不存在或不属于这次练习",
    );
  }
  return { row: hit, no };
}

/** 该 (attempt, question, phase) 的底图行（无则 undefined） */
function annotationBaseRowOf(
  db: Db,
  attemptId: string,
  questionId: string,
  phase: AnnotationPhase,
): AnnotationBaseRow | undefined {
  return db
    .select()
    .from(annotationBasesTable)
    .where(
      and(
        eq(annotationBasesTable.attemptId, attemptId),
        eq(annotationBasesTable.questionId, questionId),
        eq(annotationBasesTable.phase, phase),
      ),
    )
    .get();
}

/** 该 (attempt, question, phase) 的标注行（无则 undefined） */
function annotationRowOf(
  db: Db,
  attemptId: string,
  questionId: string,
  phase: AnnotationPhase,
): AnnotationRow | undefined {
  return db
    .select()
    .from(annotationsTable)
    .where(
      and(
        eq(annotationsTable.attemptId, attemptId),
        eq(annotationsTable.questionId, questionId),
        eq(annotationsTable.phase, phase),
      ),
    )
    .get();
}

/**
 * 底图身份是否落后于**题库当前内容**（stale 判定，审查修复 4 真化）：
 * 原实现与 attempt 冻结快照自比对恒 false（建卷后 responses 行永不重铸——
 * attempt-service「教师改题库只影响之后新建的卷」）。真化口径＝按建卷冻结
 * 同构路径（questionOfRow＋knowledgeNamesByQuestion）对题库当前行算 canonical
 * hash 与 base.snapshotHash 比对：
 * - 题目编辑 → 内容 hash 变化 → stale=true（旧圈仍锚定旧底图，如实横幅）；
 * - 题目软删 → stale=true；
 * - 题库行缺失（防御：正常流程建卷时必有 live 行；wrong 卷题目也来自题库）
 *   → 不指认改版（stale=false——「题目已改版」横幅需要证据）。
 * registerBaseImage 的身份校验仍与 attempt 冻结行比对不变（那是上传一致性，
 * 不是 staleness——两者口径刻意分离）。
 */
function baseIsStale(
  db: Db,
  base: AnnotationBaseRow,
  attempt: Attempt,
  questionId: string,
): boolean {
  const teacherId = attemptTeacherId(db, attempt);
  if (teacherId === null) return false;
  const liveRow = db
    .select()
    .from(questionsTable)
    .where(
      and(
        eq(questionsTable.teacherId, teacherId),
        eq(questionsTable.id, questionId),
      ),
    )
    .get();
  if (liveRow === undefined) return false;
  if (liveRow.deletedAt !== null) return true;
  const knowledge =
    knowledgeNamesByQuestion(db, teacherId, [liveRow.id]).get(liveRow.id) ?? [];
  try {
    const currentHash = questionSnapshotHashOf(questionOfRow(liveRow, knowledge));
    return currentHash !== null && base.snapshotHash !== currentHash;
  } catch {
    // questionOfRow 对异常行 parse 抛错：无据不指认改版（同「行缺失」口径）
    return false;
  }
}

/** 底图行 → 契约引用投影（downloadUrl 仅 ready 组装；stale 由调用方现算） */
function baseRefOf(
  base: AnnotationBaseRow,
  stale: boolean,
  downloadUrl: string | undefined,
): AnnotationBaseRef {
  return {
    baseId: base.id,
    state: base.state,
    stale,
    pixelWidth: base.pixelWidth,
    pixelHeight: base.pixelHeight,
    ...(base.state === "ready" && downloadUrl !== undefined
      ? { downloadUrl }
      : {}),
  };
}

// ---------- 底图装配载荷（决策 2/4①：仅题干＋选项的学生投影） ----------

/** 写入 phase 与 attempt 状态的对称门槛（审查修复 8：与 putAnnotationDoc 一致） */
function requirePhaseWritable(
  attempt: Attempt,
  phase: AnnotationPhase,
): void {
  if (phase === "scratch") {
    if (attempt.status !== "draft") {
      throw new HttpError(
        409,
        "ALREADY_SUBMITTED",
        "这份作业已交卷，作答期标注底图不能再生成或回传（回看请展开标注视图；订正请新开标注）",
      );
    }
  } else if (attempt.status === "draft") {
    throw new HttpError(
      409,
      "ANNOTATION_NOT_SUBMITTED",
      "这份作业尚未交卷，订正标注底图只能在交卷后生成",
    );
  }
}

/**
 * 取底图装配载荷（POST …/annotation/base）：幂等建 pending 行——已有行直接
 * 复用（ready 时载荷携带直出引用，客户端不再重生成）；无行则建（身份三要素
 * 服务端铸造）。载荷 = 学生 stem 级投影＋静态素材（不含学生答案节与任何
 * 教师节；materialOf 哨兵与 buildStaticQuestionMaterial 守卫双检）。
 */
export function assembleAnnotationBase(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  phase: AnnotationPhase = "scratch",
): AnnotationBasePreviewData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  requirePhaseWritable(attempt, phase);
  const { row, no } = locateFrozenRow(db, attempt, questionId);
  const snapshot = snapshotOfRow(row);
  const snapshotHash = questionSnapshotHashOf(snapshot);
  if (snapshot === null || snapshotHash === null) {
    // locateFrozenRow 已保证快照非空；此分支仅满足类型收窄（不可达）
    throw new HttpError(404, "QUESTION_NOT_FOUND", "题目快照缺失");
  }

  // 幂等定位/建行（同 notes scratch 先查后插口径；单进程同步无竞态）
  let base = annotationBaseRowOf(db, attempt.id, questionId, phase);
  if (base === undefined) {
    const now = new Date().toISOString();
    base = {
      id: randomUUID(),
      attemptId: attempt.id,
      questionId,
      questionRevisionId: row.id,
      phase,
      snapshotHash,
      baseRenderVersion: ANNOTATION_BASE_RENDER_VERSION,
      imagePath: null,
      imageHash: null,
      pixelWidth: null,
      pixelHeight: null,
      state: "pending",
      createdAt: now,
      updatedAt: now,
    };
    db.insert(annotationBasesTable).values(base).run();
  }

  // 学生 stem 级投影＋静态素材（双哨兵：materialOf 500 / buildStatic 抛错）
  const material = materialOf(snapshot, true, "stem");
  const staticMaterial = buildStaticQuestionMaterial({
    role: "student",
    stemMd: material.stemMd,
    ...(material.options !== undefined ? { options: material.options } : {}),
    questionNo: no,
  });

  return {
    base: baseRefOf(
      base,
      baseIsStale(db, base, attempt, questionId),
      base.state === "ready"
        ? `/api/student/attempts/${encodeURIComponent(attempt.id)}/annotation-base/${encodeURIComponent(base.id)}/image.png`
        : undefined,
    ),
    baseRenderVersion: ANNOTATION_BASE_RENDER_VERSION,
    maxWidthPx: ANNOTATION_BASE_WIDTH_PX,
    questionRevisionId: row.id,
    questionNo: no,
    questionMd: staticMaterial.markdown,
    mediaSrcs: [...staticMaterial.mediaSrcs],
    graphFigures: staticMaterial.graphFigures.map((figure) => ({
      fn: figure.fn,
      ...(figure.range !== undefined ? { range: figure.range } : {}),
    })),
    interactionNotes: [...staticMaterial.interactionNotes],
  };
}

// ---------- 底图 PNG 回传（决策 4②：身份校验＋落盘建行） ----------

/**
 * 回传底图 PNG（POST …/annotation/base/image）：服务端校验——
 * 1. 底图行存在（客户端必须先过 preview 建行）；
 * 2. 身份三要素一致：行内 questionRevisionId/snapshotHash/baseRenderVersion 与
 *    服务端现算当前值一致（快照冻结后正常不可达，防御态 409）；客户端回传的
 *    questionRevisionId/baseRenderVersion 与行一致（陈旧标签页 409）；
 * 3. PNG 完整（魔数＋IHDR＋IEND）且宽度＝ANNOTATION_BASE_WIDTH_PX、高度 ≤
 *    ANNOTATION_BASE_MAX_HEIGHT_PX、字节 ≤ ANNOTATION_BASE_PNG_MAX_BYTES；
 * 4. 落盘 blobs/annotations/<sha256>.png（内容寻址，同字节幂等）→ 行切 ready。
 * ready 后永不重生成：同字节重传幂等返回原回执；异字节 → 409
 * ANNOTATION_BASE_ALREADY_READY（客户端应重取 preview 拿引用）。
 */
export function registerBaseImage(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  questionId: string,
  pngBytes: Uint8Array,
  meta: AnnotationBaseImageMeta,
): AnnotationBaseImageReceipt {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  requirePhaseWritable(attempt, meta.phase);
  const { row } = locateFrozenRow(db, attempt, questionId);
  const base = annotationBaseRowOf(db, attempt.id, questionId, meta.phase);
  if (base === undefined) {
    throw new HttpError(
      404,
      "ANNOTATION_NOT_FOUND",
      "底图尚未创建（请先获取装配载荷）",
    );
  }

  // 身份三要素一致性（行 vs 服务端现算 + 客户端回传 vs 行）
  const currentHash = questionSnapshotHashOf(snapshotOfRow(row));
  if (
    base.questionRevisionId !== row.id ||
    base.snapshotHash !== currentHash ||
    base.baseRenderVersion !== ANNOTATION_BASE_RENDER_VERSION
  ) {
    throw new HttpError(
      409,
      "ANNOTATION_BASE_STALE",
      "底图身份与服务端当前题目版本不一致（数据异常），请刷新后重试",
    );
  }
  if (
    meta.questionRevisionId !== base.questionRevisionId ||
    meta.baseRenderVersion !== base.baseRenderVersion
  ) {
    throw new HttpError(
      409,
      "ANNOTATION_BASE_STALE",
      "客户端持有的题目版本与底图不一致（页面已过期），请重新进入标注模式",
    );
  }

  // PNG 完整性与几何（宽=载荷 maxWidthPx；高 ≤ 画布上限；字节限额）
  if (pngBytes.byteLength > ANNOTATION_BASE_PNG_MAX_BYTES) {
    throw new HttpError(
      413,
      "ANNOTATION_LIMIT_EXCEEDED",
      `底图 PNG 超过 ${ANNOTATION_BASE_PNG_MAX_BYTES / (1024 * 1024)}MiB 上传限额`,
    );
  }
  const size = pngIntact(pngBytes);
  if (size === null) {
    throw new HttpError(
      400,
      "ANNOTATION_BASE_IMAGE_INVALID",
      "底图不是完整的 PNG 文件",
    );
  }
  if (size.width !== ANNOTATION_BASE_WIDTH_PX) {
    throw new HttpError(
      400,
      "ANNOTATION_BASE_IMAGE_INVALID",
      `底图宽度必须等于 ${ANNOTATION_BASE_WIDTH_PX} 像素（当前 ${size.width}）`,
    );
  }
  if (size.height > ANNOTATION_BASE_MAX_HEIGHT_PX) {
    throw new HttpError(
      400,
      "ANNOTATION_BASE_IMAGE_INVALID",
      `底图高度超过 ${ANNOTATION_BASE_MAX_HEIGHT_PX} 像素上限（当前 ${size.height}）——超高题不支持标注`,
    );
  }

  const imageHash = createHash("sha256").update(pngBytes).digest("hex");
  const relPath = annotationBaseRelPath(imageHash);
  const now = new Date().toISOString();

  // ready 幂等/拒绝先行（不写文件）
  if (base.state === "ready") {
    if (base.imageHash === imageHash) {
      return {
        baseId: base.id,
        state: "ready",
        imageHash,
        pixelWidth: size.width,
        pixelHeight: size.height,
        updatedAt: base.updatedAt,
      };
    }
    throw new HttpError(
      409,
      "ANNOTATION_BASE_ALREADY_READY",
      "底图已就绪且永不重生成（同一份圈画不换底图）；如页面显示异常请重新获取底图引用",
    );
  }

  // 落盘（内容寻址：同字节同路径，覆盖无害）→ 事务内行级守卫切 ready
  writeFileAtomic({
    finalPath: resolveAnnotationBasePath(dataDir, relPath),
    bytes: pngBytes,
  });
  db.transaction((tx) => {
    const current = tx
      .select()
      .from(annotationBasesTable)
      .where(eq(annotationBasesTable.id, base.id))
      .get();
    if (current === undefined) {
      throw new HttpError(500, "INTERNAL", "底图行消失（内部错误）");
    }
    if (current.state === "ready") {
      if (current.imageHash === imageHash) return; // 并发同字节：幂等
      throw new HttpError(
        409,
        "ANNOTATION_BASE_ALREADY_READY",
        "底图已就绪且永不重生成；如页面显示异常请重新获取底图引用",
      );
    }
    tx.update(annotationBasesTable)
      .set({
        state: "ready",
        imagePath: relPath,
        imageHash,
        pixelWidth: size.width,
        pixelHeight: size.height,
        updatedAt: now,
      })
      .where(eq(annotationBasesTable.id, base.id))
      .run();
  });
  return {
    baseId: base.id,
    state: "ready",
    imageHash,
    pixelWidth: size.width,
    pixelHeight: size.height,
    updatedAt: now,
  };
}

// ---------- 正文写入（CAS＋幂等＋base ready gate＋sealed 拒绝） ----------

/** CAS 冲突错误（409 附 _current 摘要；组装经契约 parse 防漂移） */
function revisionConflict(existing: AnnotationRow | undefined): HttpError {
  const has = existing !== undefined && existing.revision > 0;
  return new HttpError(
    409,
    "ANNOTATION_REVISION_CONFLICT",
    "标注已在别处保存了更新的版本（其他标签页/设备），请刷新后选择保留哪一份",
    {
      _current: annotationConflictCurrentSchema.parse({
        annotationId: existing?.id ?? null,
        revision: existing?.revision ?? 0,
        hash: has ? (existing?.hash ?? null) : null,
        savedAt: has ? (existing?.updatedAt ?? null) : null,
      }),
    },
  );
}

/**
 * 孤儿正文文件清理（审查修复 9）：内容寻址路径 blobs/annotation-bodies/
 * <hash>.json.gz 可能被**多行**引用（同内容跨题/跨阶段各占一行）——删除前
 * 查 annotations 是否仍有他行引用同 hash（排除本次写入目标行），有则保留；
 * 导出供失败清理路径的直测（putAnnotationDoc 的 catch 分支在单进程同步下
 * 不可稳定触达）。
 */
export function removeAnnotationBodyIfUnreferenced(
  db: Db,
  hash: string,
  absBodyPath: string,
  /** 排除的行 id（本次写入目标——事务已回滚，其行未落地/未换版） */
  excludeAnnotationId: string,
): void {
  const referenced = db
    .select({ id: annotationsTable.id })
    .from(annotationsTable)
    .where(and(eq(annotationsTable.hash, hash), ne(annotationsTable.id, excludeAnnotationId)))
    .get();
  if (referenced !== undefined) return;
  try {
    unlinkSync(absBodyPath);
  } catch {
    // 文件未落位或已被删——无需处理
  }
}

/** 标注行 → 回执（revision≥1 的行必有 hash；缺即数据异常显式 500） */function receiptOf(row: AnnotationRow): AnnotationReceipt {
  if (row.hash === null || row.revision < 1) {
    throw new HttpError(
      500,
      "INTERNAL",
      "标注行缺少正文 hash（数据异常，无法组装回执）",
    );
  }
  return {
    annotationId: row.id,
    revision: row.revision,
    hash: row.hash,
    savedAt: row.updatedAt,
  };
}

/**
 * 写入一版标注正文（PUT …/annotation）：顺序（note 协议同构）——
 * 1. requireUsableAttempt＋严格题目门口（快照非空——没有快照就无法建底图，
 *    标注天然不可能）；
 * 2. 解析限额＋规范化 hash＋**坐标域=底图几何**校验（doc.baseWidth/baseHeight
 *    必须等于底图行 pixelWidth/pixelHeight——不接受文档域≠底图域的换算歧义）；
 * 3. 幂等查重（**先于 base gate 与状态门槛**：丢回执重试在任何 attempt 状态
 *    下返回原回执）：全局 mutationId 命中且（同 attempt/question/phase＋同
 *    正文 hash）→ 原回执；命中但归属/正文不同 → 409
 *    ANNOTATION_MUTATION_MISMATCH；
 * 4. base ready gate（「没有可靠底图不能落墨」的服务端闸门）：底图行存在且
 *    state=ready，否则 409 ANNOTATION_BASE_NOT_READY；
 * 5. sealed 拒绝：已封存行 → 409 ANNOTATION_SEALED（订正=新开 correction 行；
 *    行级封存先于 attempt 状态门槛——更精确的诊断）；
 * 6. 状态门槛：scratch 在已交卷 attempt 上新写 → 409 ALREADY_SUBMITTED；
 *    correction 在 draft 上 → 409 ANNOTATION_NOT_SUBMITTED；
 * 7. CAS 预检＋文件落位（blobs/annotation-bodies/<hash>.json.gz 不可变）＋
 *    事务（CAS 复核＋行先查后插/带 revision+sealed 守卫的更新）；
 * 8. 失败清理（内容寻址兜底：新 hash 与现存行 hash 相同时不删——行正在
 *    引用该文件）。
 */
export function putAnnotationDoc(
  db: Db,
  dataDir: string,
  studentId: string,
  attemptId: string,
  questionId: string,
  bodyBytes: Uint8Array,
  meta: AnnotationUploadMetaInput,
): AnnotationReceipt {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  const phase = meta.phase ?? "scratch";
  requireAttemptQuestion(db, attempt, questionId);

  const doc = parseAnnotationBodyBytes(bodyBytes);
  const canonicalBytes = Buffer.from(canonicalAnnotationJson(doc), "utf8");
  const hash = createHash("sha256").update(canonicalBytes).digest("hex");
  const { strokeCount, pointCount } = annotationMetrics(doc);

  // 3. 幂等查重（先于 base gate/状态门槛——丢回执重试不被误拒）
  const replay = db
    .select()
    .from(annotationsTable)
    .where(eq(annotationsTable.mutationId, meta.mutationId))
    .get();
  if (replay !== undefined) {
    if (
      replay.attemptId === attempt.id &&
      replay.questionId === questionId &&
      replay.phase === phase &&
      replay.hash === hash
    ) {
      return receiptOf(replay);
    }
    throw new HttpError(
      409,
      "ANNOTATION_MUTATION_MISMATCH",
      "同一 mutationId 已绑定其他标注变更，请生成新的 mutationId 重试",
    );
  }

  // 4. base ready gate：底图行必须在场且 ready（另一半在客户端：base 未
  //    ready 不挂画布——双保险）
  const base = annotationBaseRowOf(db, attempt.id, questionId, phase);
  if (base === undefined || base.state !== "ready") {
    throw new HttpError(
      409,
      "ANNOTATION_BASE_NOT_READY",
      "没有可靠的底图不能落墨（底图未生成或未就绪），请先生成并保存底图",
    );
  }
  if (
    doc.baseWidth !== base.pixelWidth ||
    doc.baseHeight !== base.pixelHeight
  ) {
    throw new HttpError(
      400,
      "ANNOTATION_VALIDATION_FAILED",
      `标注坐标域与底图几何不一致（文档 ${doc.baseWidth}×${doc.baseHeight}，底图 ${base.pixelWidth}×${base.pixelHeight}）`,
    );
  }

  const existing = annotationRowOf(db, attempt.id, questionId, phase);

  // 6. sealed 拒绝（先于状态门槛——行级封存是更精确的诊断；交卷/检查点后
  //    行只读，订正不改旧标注）
  if (existing !== undefined && existing.sealedAt !== null) {
    throw new HttpError(
      409,
      "ANNOTATION_SEALED",
      "该标注已随交卷/检查点封存，不能再修改（订正请新开标注）",
    );
  }

  // 5. 状态门槛（非重放的新写入才受约束）
  if (phase === "scratch") {
    if (attempt.status !== "draft") {
      throw new HttpError(
        409,
        "ALREADY_SUBMITTED",
        "这份作业已交卷，标注已随交卷固定，不能再写入（订正请新开标注）",
      );
    }
  } else if (attempt.status === "draft") {
    throw new HttpError(
      409,
      "ANNOTATION_NOT_SUBMITTED",
      "这份作业尚未交卷，订正标注只能在交卷后写入",
    );
  }

  // 7. CAS 预检（快失败，不写文件）
  const headRevision = existing?.revision ?? 0;
  if (meta.baseRevision !== headRevision) {
    throw revisionConflict(existing);
  }

  // 文件落位（内容寻址不可变路径；唯一 tmp → rename）
  const relPath = annotationBodyRelPath(hash);
  const absBodyPath = resolveAnnotationBodyPath(dataDir, relPath);
  const annotationId = existing?.id ?? randomUUID();
  const newRevision = headRevision + 1;
  const now = new Date().toISOString();
  try {
    writeFileAtomic({
      finalPath: absBodyPath,
      bytes: gzipSync(canonicalBytes),
    });
    db.transaction((tx) => {
      // 事务内定位（tx 是事务句柄非 Db——select 直查，同 saveNoteVersion 形态）
      const row = tx
        .select()
        .from(annotationsTable)
        .where(
          and(
            eq(annotationsTable.attemptId, attempt.id),
            eq(annotationsTable.questionId, questionId),
            eq(annotationsTable.phase, phase),
          ),
        )
        .get();
      if (row === undefined) {
        if (meta.baseRevision !== 0) throw revisionConflict(undefined);
        tx.insert(annotationsTable)
          .values({
            id: annotationId,
            attemptId: attempt.id,
            questionId,
            phase,
            baseId: base.id,
            revision: newRevision,
            bodyPath: relPath,
            hash,
            strokeCount,
            pointCount,
            sealedAt: null,
            updatedAt: now,
            mutationId: meta.mutationId,
          })
          .run();
      } else {
        // CAS 复核＋sealed 复核（同步事务内无交错，纵深防御）
        if (row.revision !== meta.baseRevision) throw revisionConflict(row);
        if (row.sealedAt !== null) {
          throw new HttpError(
            409,
            "ANNOTATION_SEALED",
            "该标注已随交卷/检查点封存，不能再修改（订正请新开标注）",
          );
        }
        if (row.id !== annotationId) {
          throw new HttpError(
            500,
            "INTERNAL",
            "标注行身份不一致（防御性拒绝）",
          );
        }
        const switched = tx
          .update(annotationsTable)
          .set({
            revision: newRevision,
            bodyPath: relPath,
            hash,
            strokeCount,
            pointCount,
            updatedAt: now,
            mutationId: meta.mutationId,
          })
          .where(
            and(
              eq(annotationsTable.id, annotationId),
              eq(annotationsTable.revision, headRevision),
              isNull(annotationsTable.sealedAt),
            ),
          )
          .returning({ id: annotationsTable.id })
          .get();
        if (switched === undefined) {
          throw new HttpError(
            500,
            "INTERNAL",
            "标注行更新未命中（并发写竞争，本次写入已回滚）",
          );
        }
      }
    });
  } catch (err) {
    // 唯一索引冲突（annotations_mutation_id_uk）兜底：单进程同步下不可达，
    // 多进程下胜者与本请求同归属同 hash → 幂等返回胜者回执（不清理文件）
    const winner = db
      .select()
      .from(annotationsTable)
      .where(eq(annotationsTable.mutationId, meta.mutationId))
      .get();
    if (
      winner !== undefined &&
      winner.attemptId === attempt.id &&
      winner.questionId === questionId &&
      winner.phase === phase &&
      winner.hash === hash
    ) {
      return receiptOf(winner);
    }
    // 孤儿文件清理（事务已回滚/文件未落位；审查修复 9：删前查引用——
    // annotations 仍有**他行**引用同 hash 时不删，那是别人正在引用的文件；
    // 删除失败留给部署侧兜底）
    if (existing?.hash !== hash) {
      removeAnnotationBodyIfUnreferenced(db, hash, absBodyPath, annotationId);
    }
    if (winner !== undefined) {
      throw new HttpError(
        409,
        "ANNOTATION_MUTATION_MISMATCH",
        "同一 mutationId 已绑定其他标注变更，请生成新的 mutationId 重试",
      );
    }
    throw err;
  }

  return { annotationId, revision: newRevision, hash, savedAt: now };
}

// ---------- 回看视图（双角色＋stale 判定） ----------

/** 视图/直出的请求主体：学生本人或教师域 */
export type AnnotationPrincipal =
  | { readonly kind: "student"; readonly id: string }
  | { readonly kind: "teacher"; readonly id: string };

/** 角色化底图直出 URL（学生走 attempt 前缀、教师走 annotation-bases 前缀） */
function baseDownloadUrlOf(
  principal: AnnotationPrincipal,
  attemptId: string,
  baseId: string,
): string {
  return principal.kind === "student"
    ? `/api/student/attempts/${encodeURIComponent(attemptId)}/annotation-base/${encodeURIComponent(baseId)}/image.png`
    : `/api/teacher/annotation-bases/${encodeURIComponent(baseId)}/image.png`;
}

/**
 * 回看视图（GET …/annotation）：学生走 requireUsableAttempt（本人＋来源访问
 * 权；已交卷可读）、教师走 requireTeacherAttempt（域外统一 404）。题目门口
 * 宽松口径（软删题历史标注可读）。base 为 null = 从未建过底图（显式空态）；
 * 有标注必有底图（契约 schema 锁定）。
 */
export function getAnnotationView(
  db: Db,
  dataDir: string,
  principal: AnnotationPrincipal,
  attemptId: string,
  questionId: string,
  phase: AnnotationPhase = "scratch",
): AnnotationViewData {
  let attempt: Attempt;
  if (principal.kind === "student") {
    attempt = requireUsableAttempt(db, principal.id, attemptId);
  } else {
    attempt = requireTeacherAttempt(db, principal.id, attemptId).attempt;
  }
  // 懒补封（审查修复 2②）：已交卷未封存的 scratch 行在读视图入口自愈
  lazilySealSubmittedScratch(db, [attempt.id]);
  // 宽松门口（软删题历史材料可读——同 note evidence 读口径）
  const row = db
    .select()
    .from(responsesTable)
    .where(
      and(
        eq(responsesTable.attemptId, attempt.id),
        eq(responsesTable.questionId, questionId),
      ),
    )
    .get();
  if (row === undefined) {
    throw new HttpError(
      404,
      "QUESTION_NOT_FOUND",
      "题目不存在或不属于这次练习",
    );
  }

  const base = annotationBaseRowOf(db, attempt.id, questionId, phase);
  const annotation = annotationRowOf(db, attempt.id, questionId, phase);
  const hasDoc = annotation !== undefined && annotation.revision > 0;

  return {
    base:
      base === undefined
        ? null
        : baseRefOf(
            base,
            baseIsStale(db, base, attempt, questionId),
            base.state === "ready"
              ? baseDownloadUrlOf(principal, attempt.id, base.id)
              : undefined,
          ),
    maxWidthPx: ANNOTATION_BASE_WIDTH_PX,
    doc:
      annotation !== undefined && hasDoc
        ? readAnnotationDoc(dataDir, annotation)
        : null,
    annotation:
      annotation !== undefined && hasDoc ? receiptToMeta(annotation) : null,
  };
}

/** 标注行 → 元信息投影（revision≥1 行必有 hash；缺即数据异常） */
function receiptToMeta(row: AnnotationRow): {
  annotationId: string;
  revision: number;
  hash: string;
  savedAt: string;
  sealedAt: string | null;
  strokeCount: number;
  pointCount: number;
} {
  if (row.hash === null) {
    throw new HttpError(
      500,
      "INTERNAL",
      "标注行缺少正文 hash（数据异常，无法组装视图）",
    );
  }
  return {
    annotationId: row.id,
    revision: row.revision,
    hash: row.hash,
    savedAt: row.updatedAt,
    sealedAt: row.sealedAt,
    strokeCount: row.strokeCount,
    pointCount: row.pointCount,
  };
}

/** 标注行 → AnnotationDoc（读正文文件解压解析；损坏抛 500 内部码不静默） */
function readAnnotationDoc(dataDir: string, row: AnnotationRow): AnnotationDoc {
  if (row.bodyPath === null) {
    throw new HttpError(
      500,
      "ANNOTATION_BODY_UNREADABLE",
      "标注行缺少正文路径（数据异常）",
    );
  }
  let text: string;
  try {
    const bytes = readFileBytes(
      resolveAnnotationBodyPath(dataDir, row.bodyPath),
    );
    text = new TextDecoder().decode(
      gunzipSync(new Uint8Array(bytes), {
        maxOutputLength: ANNOTATION_BODY_DECOMPRESSED_MAX_BYTES,
      }),
    );
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(
      `【数据异常】标注正文文件读取失败（annotationId=${row.id}）`,
      err,
    );
    throw new HttpError(
      500,
      "ANNOTATION_BODY_UNREADABLE",
      "标注正文文件读取失败（磁盘数据异常）",
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text) as unknown;
  } catch {
    parsedJson = undefined;
  }
  const parsed = annotationDocSchema.safeParse(parsedJson);
  if (!parsed.success) {
    console.error(
      `【数据异常】标注正文解析失败（annotationId=${row.id}）`,
      parsed.error.issues[0]?.message,
    );
    throw new HttpError(500, "ANNOTATION_BODY_UNREADABLE", "标注正文数据损坏");
  }
  return parsed.data;
}

// ---------- 底图直出（attempt 授权） ----------

/**
 * 底图 PNG 直出字节：学生端（attempt 路由）requireOwnAttempt＋base.attemptId
 * 一致；教师端（baseId 路由）requireTeacherAttempt 按 base 行归属推导。
 * 仅 ready 且文件在场可出（其余 404——与「没有可靠底图」口径一致）。
 */
export function annotationBaseImageBytes(
  db: Db,
  dataDir: string,
  principal: AnnotationPrincipal,
  /** 学生端路由的 attemptId（教师端忽略——由 base 行推导） */
  attemptId: string | undefined,
  baseId: string,
): ArrayBuffer {
  const base = db
    .select()
    .from(annotationBasesTable)
    .where(eq(annotationBasesTable.id, baseId))
    .get();
  if (base === undefined) {
    throw new HttpError(404, "ANNOTATION_NOT_FOUND", "底图不存在");
  }
  if (principal.kind === "student") {
    if (attemptId === undefined || base.attemptId !== attemptId) {
      throw new HttpError(404, "ANNOTATION_NOT_FOUND", "底图不存在");
    }
    requireOwnAttempt(db, principal.id, attemptId);
  } else {
    requireTeacherAttempt(db, principal.id, base.attemptId);
  }
  if (base.state !== "ready" || base.imagePath === null) {
    throw new HttpError(404, "ANNOTATION_NOT_FOUND", "底图尚未就绪");
  }
  try {
    return readFileBytes(resolveAnnotationBasePath(dataDir, base.imagePath));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(`【数据异常】底图文件读取失败（baseId=${base.id}）`, err);
    throw new HttpError(404, "ANNOTATION_NOT_FOUND", "底图文件缺失");
  }
}

// ---------- 封存（交卷固定 / 订正检查点） ----------

/**
 * 封存该 attempt 的指定 phase 标注（POST …/annotations/seal，决策 8）：
 * 幂等（已封存行不再变更，重放 sealedCount=0）；返回实际置封存的行数。
 *
 * 时序口径（审查修复 2）：scratch seal 只在**交卷之后**合法——客户端在交卷
 * 成功回调内补调（失败非阻断），draft 期调用 409（杀「确认弹层中止路径把
 * 未交卷 scratch 永久锁死」的自害自封）；correction seal 恒合法（订正检查点
 * 由前端在保存订正标注时调用）。封存后行只读（PUT → 409）。交卷后客户端
 * seal 失败/响应丢失的兜底＝读路径懒补封（lazilySealSubmittedScratch）。
 */
export function sealAttemptAnnotations(
  db: Db,
  studentId: string,
  attemptId: string,
  phase: AnnotationPhase = "scratch",
): AnnotationSealData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  if (phase === "scratch" && attempt.status === "draft") {
    throw new HttpError(
      409,
      "ANNOTATION_NOT_SUBMITTED",
      "这份作业尚未交卷，题干标注封存随交卷自动进行（不影响继续圈画；订正检查点不受此限）",
    );
  }
  const now = new Date().toISOString();
  const sealed = db
    .update(annotationsTable)
    .set({ sealedAt: now, updatedAt: now })
    .where(
      and(
        eq(annotationsTable.attemptId, attempt.id),
        eq(annotationsTable.phase, phase),
        isNull(annotationsTable.sealedAt),
      ),
    )
    .returning({ id: annotationsTable.id })
    .all();
  return { phase, sealedCount: sealed.length };
}

/**
 * 已交卷 attempt 的 scratch 行懒补封（审查修复 2②自愈，幂等）：
 * 客户端 seal 挪到交卷成功回调后非阻断执行——网络失败、或响应丢失重试撞
 * 409 ALREADY_SUBMITTED（不走 onSuccess）都会留下「已交卷但未封存」的行，
 * 而装配收录口径只认 sealedAt。故在 getAnnotationView /
 * assembleAnnotationPairs 入口现场补封（requireUsableAttempt 懒冻结同款
 * 「读路径自愈」先例）。scratch 在已交卷 attempt 上本就只读
 * （ALREADY_SUBMITTED 门槛），补封不改变任何可写性；correction 行**不**
 * 懒补封——封存是订正检查点语义，进行中的订正不能被读路径意外定格。
 */
function lazilySealSubmittedScratch(db: Db, attemptIds: readonly string[]): void {
  if (attemptIds.length === 0) return;
  const submittedIds = db
    .select({ id: attemptsTable.id })
    .from(attemptsTable)
    .where(
      and(
        inArray(attemptsTable.id, [...attemptIds]),
        ne(attemptsTable.status, "draft"),
      ),
    )
    .all()
    .map((row) => row.id);
  if (submittedIds.length === 0) return;
  const now = new Date().toISOString();
  db.update(annotationsTable)
    .set({ sealedAt: now, updatedAt: now })
    .where(
      and(
        inArray(annotationsTable.attemptId, submittedIds),
        eq(annotationsTable.phase, "scratch"),
        isNull(annotationsTable.sealedAt),
      ),
    )
    .run();
}

// ---------- 导出装配（成对文件；review-pack / 学习包共用，决策 9） ----------

/** 成对装配的单条底图文件信息（在场才有） */
export interface AnnotationPairBase {
  readonly absPath: string;
  readonly bytes: number;
}

/** 成对装配的单条（一个 (attempt, question, phase) 的已封存标注） */
export interface AnnotationPairItem {
  /** 包内编号（a001…；与 q/e 编号同风格的独立序列） */
  readonly ref: string;
  readonly attemptId: string;
  readonly questionId: string;
  readonly phase: AnnotationPhase;
  readonly sealedAt: string;
  /** 底图行 id（base 行缺失为 null——此时无下载 URL 可组装） */
  readonly baseId: string | null;
  /** 底图文件在场（含绝对路径/字节）；缺失为 null（此时 strokesJson 恒 null） */
  readonly base: AnnotationPairBase | null;
  /** 笔迹 JSON 文本（gzip 正文原样解压）；底图缺失时 null——**绝不导出孤立的圈** */
  readonly strokesJson: string | null;
  /** base 为 null 时的缺失原因（manifest.missing 用） */
  readonly missingReason?: string;
}

export interface AnnotationPairAssembly {
  readonly pairs: readonly AnnotationPairItem[];
  /** responses 行 id → 成对条目列表（按产出序）；zip/manifest 关联用 */
  readonly byResponseRowId: ReadonlyMap<string, readonly AnnotationPairItem[]>;
}

/** 底图行未就绪的缺失原因（ready 以外的可分辨态） */
const ANNOTATION_BASE_MISSING_REASONS: Record<"pending" | "failed", string> = {
  pending: "底图未回传（生成中断）",
  failed: "底图生成失败",
};

function packRefOfAnnotation(seq: number): string {
  return `a${String(seq).padStart(3, "0")}`;
}

/**
 * 已封存标注的成对装配（纯读）：scope = 各 attempt 的展示序 responses 行。
 * 收录口径——**只收 sealedAt 非空**的行（scratch=交卷固定、correction=检查点
 * 封存；进行中的标注不进包，与「订正只收已封存检查点」同哲学）。产出序 =
 * 查询序（attempt、question、sealedAt 升序）。成对原子性：底图文件在场且
 * 正文可读才出完整对（base.png + strokes.json）；任一缺失 → 该条整体进缺失
 * 清单（base/strokes 均不出，绝不导出孤立的圈，也避免半对歧义）。
 */
export function assembleAnnotationPairs(
  db: Db,
  dataDir: string,
  scope: ReadonlyArray<{ rows: readonly ResponseRow[] }>,
): AnnotationPairAssembly {
  const pairs: AnnotationPairItem[] = [];
  const byResponseRowId = new Map<string, AnnotationPairItem[]>();
  const attemptIds = [
    ...new Set(scope.flatMap((item) => item.rows.map((row) => row.attemptId))),
  ];
  if (attemptIds.length === 0) {
    return { pairs, byResponseRowId };
  }
  // 懒补封（审查修复 2②）：已交卷未封存的 scratch 行在装配入口自愈——
  // 否则客户端 seal 失败会让本应成对收录的材料静默缺席
  lazilySealSubmittedScratch(db, attemptIds);
  const annotationRows = db
    .select()
    .from(annotationsTable)
    .where(
      and(
        inArray(annotationsTable.attemptId, attemptIds),
        isNotNull(annotationsTable.sealedAt),
      ),
    )
    .orderBy(
      asc(annotationsTable.attemptId),
      asc(annotationsTable.questionId),
      asc(annotationsTable.sealedAt),
    )
    .all();
  if (annotationRows.length === 0) {
    return { pairs, byResponseRowId };
  }
  const baseById = new Map<string, AnnotationBaseRow>();
  for (const base of db
    .select()
    .from(annotationBasesTable)
    .where(
      inArray(
        annotationBasesTable.id,
        annotationRows.map((row) => row.baseId),
      ),
    )
    .all()) {
    baseById.set(base.id, base);
  }

  // 行索引：(attemptId, questionId) → responses 行 id（关联 byResponseRowId）
  const rowIdsByKey = new Map<string, string[]>();
  for (const item of scope) {
    for (const row of item.rows) {
      const key = `${row.attemptId}:${row.questionId}`;
      const list = rowIdsByKey.get(key);
      if (list === undefined) rowIdsByKey.set(key, [row.id]);
      else list.push(row.id);
    }
  }

  let seq = 0;
  for (const row of annotationRows) {
    const key = `${row.attemptId}:${row.questionId}`;
    if (!rowIdsByKey.has(key)) continue; // 不在 scope（防御——查询已按 attempt 过滤）
    const base = baseById.get(row.baseId);
    let baseInfo: AnnotationPairBase | null = null;
    let strokesJson: string | null = null;
    let missingReason: string | undefined;
    if (base === undefined) {
      missingReason = "底图行缺失（数据异常）";
    } else if (base.state !== "ready" || base.imagePath === null) {
      missingReason =
        base.state !== "ready"
          ? (ANNOTATION_BASE_MISSING_REASONS[base.state] ?? "底图未就绪")
          : "底图行缺少文件路径（数据异常）";
    } else {
      try {
        const absPath = resolveAnnotationBasePath(dataDir, base.imagePath);
        const stat = statSync(absPath);
        if (!stat.isFile()) {
          missingReason = "底图文件缺失（磁盘无此文件）";
        } else if (row.bodyPath === null) {
          missingReason = "标注行缺少正文路径（数据异常）";
        } else {
          strokesJson = new TextDecoder().decode(
            gunzipSync(
              new Uint8Array(
                readFileBytes(resolveAnnotationBodyPath(dataDir, row.bodyPath)),
              ),
              { maxOutputLength: ANNOTATION_BODY_DECOMPRESSED_MAX_BYTES },
            ),
          );
          baseInfo = { absPath, bytes: stat.size };
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        missingReason = "底图或标注正文文件读取失败（磁盘无此文件）";
      }
    }
    seq += 1;
    const pair: AnnotationPairItem = {
      ref: packRefOfAnnotation(seq),
      attemptId: row.attemptId,
      questionId: row.questionId,
      phase: row.phase,
      sealedAt: row.sealedAt ?? "",
      baseId: base?.id ?? null,
      base: baseInfo,
      strokesJson,
      ...(baseInfo === null && missingReason !== undefined
        ? { missingReason }
        : {}),
    };
    pairs.push(pair);
    for (const rowId of rowIdsByKey.get(key) ?? []) {
      const list = byResponseRowId.get(rowId);
      if (list === undefined) byResponseRowId.set(rowId, [pair]);
      else list.push(pair);
    }
  }
  return { pairs, byResponseRowId };
}

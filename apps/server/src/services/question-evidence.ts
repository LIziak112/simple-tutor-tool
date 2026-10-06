import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type {
  LearningPackEvidenceState,
  NoteCropRect,
  NotePhase,
  QuestionAnswers,
  QuestionType,
} from "@tutor/contract";
import { studentStemMd, stemMdLeaksAnswers } from "@tutor/md-dsl";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  type NoteImageRow,
  type NoteVersionRow,
  noteImages,
  noteVersions,
  type ResponseRow,
  submissionEvidence,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { extractMediaImageSrcs } from "./media-service";
import { snapshotOfRow } from "./snapshot";

/**
 * 题目证据共享装配（T6R.12，方案 §9.1「一个装配服务、三种用户入口」）：
 * 学生单题（T6R.13 review-pack）、教师单题（T6R.13）、教师批量（export-service
 * v2 / T6R.16 MCP）调用同一「取对应快照 → 角色投影 → 证据选择 → 附件清单」
 * 逻辑——授权先于敏感素材读取，角色投影先于素材装配。
 *
 * 核心口径（与契约 learning-pack.ts v2 注释一致）：
 * - **快照一一配对**：每条 response 行取**自己的** questionSnapshotJson（不是
 *   同 qid 最新快照）；同内容（规范化 JSON sha-256 相同）跨行去重共享一个
 *   q 条目，不同内容即使同 qid 也各占一条——修复 v1「改题后旧答案配新题目」
 *   的误诊面（方案 D6.x）；
 * - **去重键含教师域**（questionRevisionKey）：同内容跨教师永不合并条目，
 *   材料/媒体/证据归属按教师域隔离；
 * - **缺历史快照显式缺失**：present=false + 空题干，不回填当前题库内容
 *   （T6R.3 口径，本任务细化为结构化标记）；
 * - **角色投影先于素材装配**：学生角色（及教师「仅题干」层）的题干一律经
 *   studentStemMd 投影；answers/solutionMd 只在教师 answer/solution 层进入
 *   material，**媒体扫描也只扫投影后实际进包的文本**——解析里的图片引用
 *   绝不进入学生包的任何清单（含缺失清单与错误信息）；
 * - **证据**：submission_evidence 行如实呈现（frozen/missing/none/
 *   legacy_unverified；无行 = not_collected）；frozen 附版本摘要与 analysis
 *   规格分析图（缩略图低分辨率不进包）；未生成/失败/文件删除一律进缺失
 *   清单并带原因，不静默消失；
 * - **文件名不含真实 id**：证据图路径只有包内编号（evidence/e001-original-01.png）。
 */

/** 装配角色：teacher=教师域全量（按层级）/ student=学生端投影（忽略层级） */
export type EvidenceRole = "teacher" | "student";

/**
 * 题目条目的角色化素材（装配边界上的投影结果——学生角色的条目**结构上**
 * 不存在 answers/solutionMd 字段，调用方无从泄露）。
 */
export interface QuestionRevisionMaterial {
  readonly type: QuestionType;
  readonly difficulty: number;
  readonly knowledge: readonly string[];
  /** 题干（已按角色投影：stem 层与学生角色 = studentStemMd；answer/solution 层教师 = 原文） */
  readonly stemMd: string;
  /** 选项纯文本（仅 choice/multi；无正误信息） */
  readonly options?: readonly string[];
  /** 参考答案（仅教师 answer/solution 层） */
  readonly answers?: QuestionAnswers;
  /** 详解（仅教师 solution 层） */
  readonly solutionMd?: string;
}

/** 题目版本条目（q001…）：同内容共享、不同内容分立、缺失显式 */
export interface QuestionRevisionEntry {
  readonly ref: string;
  readonly questionId: string;
  /** 交卷快照是否存在（false = 历史缺失，stemMd 为空串不回填） */
  readonly present: boolean;
  /** 快照内容身份（缺失为 null） */
  readonly snapshotHash: string | null;
  /** 冻结时刻的单元归属（展示元信息；不参与内容身份） */
  readonly unitId: string | null;
  readonly material: QuestionRevisionMaterial;
}

/** 证据条目的分析图行（zip 文件或显式缺失） */
export interface EvidenceImageItem {
  readonly file: string;
  readonly spec: "analysis";
  readonly pageIndex: number;
  readonly crop: NoteCropRect;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly state: "ready" | "missing";
  /** ready：文件实测字节（zip 写入与大小预检用） */
  readonly bytes?: number;
  /** ready：绝对路径（zip 写入用；不进 pack.json） */
  readonly absPath?: string;
  /** missing：面向教师可读的缺失原因 */
  readonly reason?: string;
}

/** 证据条目（e001…）：一次作答一道题一条 */
export interface QuestionEvidenceEntry {
  readonly ref: string;
  readonly attemptId: string;
  readonly studentId: string;
  readonly questionId: string;
  readonly questionRef: string;
  readonly no: number;
  readonly phase: NotePhase;
  readonly state: LearningPackEvidenceState;
  readonly version?:
    | {
        readonly versionId: string;
        readonly savedAt: string;
        readonly strokeCount: number;
        readonly pointCount: number;
        readonly paperHeight: number;
      }
    | undefined;
  readonly images: readonly EvidenceImageItem[];
}

/** 装配结果（preview 与 zip 生成共用；export-service v2 / T6R.13 消费） */
export interface QuestionEvidenceAssembly {
  readonly revisions: readonly QuestionRevisionEntry[];
  /** responses 行 id（= questionRevisionId）→ q 条目编号 */
  readonly refByResponseRowId: ReadonlyMap<string, string>;
  readonly evidence: readonly QuestionEvidenceEntry[];
  /** responses 行 id → e 条目编号（includeEvidence=false 时为空 Map） */
  readonly evidenceRefByResponseRowId: ReadonlyMap<string, string>;
  /** 已落盘的媒体附件（zip 写入；questionRefs = 引用它的 q 条目） */
  readonly media: ReadonlyArray<{
    readonly src: string;
    readonly absPath: string;
    readonly bytes: number;
    readonly questionRefs: readonly string[];
  }>;
  /** 引用了但缺失的媒体（不静默消失；进 manifest.missing） */
  readonly missingMedia: ReadonlyArray<{
    readonly src: string;
    readonly reason: string;
    readonly questionRefs: readonly string[];
  }>;
  /** 证据图缺失清单（未生成/失败/文件删除；进 manifest.missing） */
  readonly missingEvidenceImages: ReadonlyArray<{
    readonly file: string;
    readonly reason: string;
    readonly evidenceRef: string;
  }>;
}

/** 装配选项 */
export interface QuestionEvidenceOptions {
  readonly role: EvidenceRole;
  /** 教师角色的题目层级（缺省 stem=最小权限）；学生角色忽略（恒学生端投影） */
  readonly questionLevel?: "stem" | "answer" | "solution";
  /** 是否装配证据（submission_evidence + 分析图）；默认 false */
  readonly includeEvidence?: boolean;
}

/** scope 条目：attempt + 该卷展示序 responses 行（frozenRowsInDisplayOrder 口径，调用方排序） */
export interface QuestionEvidenceScopeItem {
  readonly attempt: Attempt;
  readonly rows: readonly ResponseRow[];
}

// ---------- 纯函数（可测的身份与命名口径） ----------

/**
 * 题目版本去重键：**教师域 + 内容身份**。同 hash 同内容在本包内共享条目、
 * 跨教师永不合并（「同内容去重不串教师」——两个教师各自库里的同内容题，
 * 材料/媒体/证据归属仍按域隔离）；快照缺失（hash=null）按教师+题目落
 * 「显式缺失」占位键（同题多处缺失共享一个空条目，不伪造内容）。
 */
export function questionRevisionKey(
  teacherId: string,
  snapshotHash: string | null,
  questionId?: string,
): string {
  return snapshotHash !== null
    ? `${teacherId}:hash:${snapshotHash}`
    : `${teacherId}:missing:${questionId ?? ""}`;
}

/** 包内编号（q001/e001；>999 自然增长为 4 位，正则 \d{3,} 同口径） */
function packRefOf(prefix: "q" | "e", seq: number): string {
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

/** 证据阶段 → 文件名标签（scratch=original 原稿；correction/supplement 为 T6R.15 预留） */
export function evidenceImageFileName(
  ref: string,
  phase: NotePhase,
  pageIndex: number,
): string {
  const label =
    phase === "scratch"
      ? "original"
      : phase === "correction"
        ? "correction"
        : "supplement";
  return `evidence/${ref}-${label}-${String(pageIndex + 1).padStart(2, "0")}.png`;
}

/** sha-256 hex（快照内容身份：对规范化序列化 JSON 计算） */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 角色化素材：投影与层级切片都在这一处完成（学生角色结构性无答案字段）。
 * **服务端泄露哨兵（编排者复审 A1）**：学生角色投影后仍命中
 * stemMdLeaksAnswers（可触达形态：fill 题不带 options 字段但题干内嵌任务
 * 列表——studentStemMd 只在有 options 时剥列表，`- [x]` 正确项标记原样
 * 保留）→ 500 EXPORT_ASSEMBLY_BROKEN 拒绝装配。防未来学生端路由直返
 * material 绕过投影不变量；前端 question-materials 的同款守卫是纵深防御。
 */
function materialOf(
  snapshot: ReturnType<typeof snapshotOfRow>,
  studentRole: boolean,
  level: "stem" | "answer" | "solution",
): QuestionRevisionMaterial {
  if (snapshot === null) {
    // 历史快照缺失：显式缺失形态（空题干、缺省元信息），不回填当前题库
    return { type: "fill", difficulty: 2, knowledge: [], stemMd: "" };
  }
  // stem 层与学生角色：题干经 studentStemMd（[[答案]]→[[]] 脱敏 + 选项列表剥除，
  // 选项以纯文本数组另行携带）；教师 answer/solution 层保留快照原文
  const projectedStem =
    level === "stem" || studentRole ? studentStemMd(snapshot) : snapshot.stemMd;
  if (studentRole && stemMdLeaksAnswers(projectedStem)) {
    throw new HttpError(
      500,
      "EXPORT_ASSEMBLY_BROKEN",
      "学生端题干投影后仍含答案标记（任务列表或非空 [[…]]），拒绝装配——请检查快照内容与投影链路",
    );
  }
  return {
    type: snapshot.type,
    difficulty: snapshot.difficulty,
    knowledge: snapshot.knowledge,
    stemMd: projectedStem,
    ...(snapshot.options !== undefined
      ? { options: snapshot.options.map((option) => option.text) }
      : {}),
    ...(!studentRole && level !== "stem" && snapshot.answers !== undefined
      ? { answers: snapshot.answers }
      : {}),
    ...(!studentRole &&
    level === "solution" &&
    snapshot.solutionMd !== undefined
      ? { solutionMd: snapshot.solutionMd }
      : {}),
  };
}

/** inArray 分块（SQLite 变量上限防御，与 export-service 同款） */
function chunk<T>(items: readonly T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** 证据图缺失原因（note_images.state 三态 + ready 行文件丢失） */
function evidenceImageMissingReason(imageState: string): string {
  if (imageState === "pending") return "分析图未生成（排队/生成中）";
  if (imageState === "failed") return "分析图生成失败";
  if (imageState === "missing") return "分析图文件缺失";
  return "图片文件缺失（磁盘无此文件）";
}

// ---------- 装配主入口 ----------

/**
 * 共享装配（T6R.12）：按 scope 顺序（调用方给出的 attempt 序 + 卷内展示序）
 * 逐行分配 q 条目（内容身份去重）、装配证据（e 条目）与媒体附件清单。
 * 纯读操作（DB select + 文件 stat），不写任何数据。
 */
export function assembleQuestionEvidence(
  db: Db,
  dataDir: string,
  teacherId: string,
  scope: readonly QuestionEvidenceScopeItem[],
  options: QuestionEvidenceOptions,
): QuestionEvidenceAssembly {
  const studentRole = options.role === "student";
  // 学生角色忽略层级（恒最小权限）；教师缺省 stem
  const level = studentRole ? "stem" : (options.questionLevel ?? "stem");

  const revisions: QuestionRevisionEntry[] = [];
  const revisionByKey = new Map<string, QuestionRevisionEntry>();
  const refByResponseRowId = new Map<string, string>();

  const evidence: QuestionEvidenceEntry[] = [];
  const evidenceRefByResponseRowId = new Map<string, string>();
  const missingEvidenceImages: Array<{
    file: string;
    reason: string;
    evidenceRef: string;
  }> = [];

  // 证据行批量预取（(attemptId, questionId) 唯一）
  const evidenceRowByKey = new Map<
    string,
    typeof submissionEvidence.$inferSelect
  >();
  const includeEvidence = options.includeEvidence === true;
  if (includeEvidence && scope.length > 0) {
    for (const ids of chunk(scope.map((item) => item.attempt.id))) {
      for (const row of db
        .select()
        .from(submissionEvidence)
        .where(inArray(submissionEvidence.attemptId, ids))
        .all()) {
        evidenceRowByKey.set(`${row.attemptId}:${row.questionId}`, row);
      }
    }
  }

  // —— 第一遍：q 条目分配（内容身份去重）+ e 条目装配 ——
  let qSeq = 0;
  let eSeq = 0;
  for (const { attempt, rows } of scope) {
    let no = 0;
    for (const row of rows) {
      no += 1;
      const snapshot = snapshotOfRow(row);
      const snapshotHash =
        snapshot === null ? null : sha256Hex(JSON.stringify(snapshot));
      const key = questionRevisionKey(teacherId, snapshotHash, row.questionId);
      let revision = revisionByKey.get(key);
      if (revision === undefined) {
        qSeq += 1;
        revision = {
          ref: packRefOf("q", qSeq),
          questionId: row.questionId,
          present: snapshot !== null,
          snapshotHash,
          unitId: row.unitId,
          material: materialOf(snapshot, studentRole, level),
        };
        revisionByKey.set(key, revision);
        revisions.push(revision);
      }
      refByResponseRowId.set(row.id, revision.ref);

      if (!includeEvidence) continue;
      eSeq += 1;
      const eRef = packRefOf("e", eSeq);
      const evidenceRow = evidenceRowByKey.get(
        `${attempt.id}:${row.questionId}`,
      );
      // frozen 的版本摘要与分析图先算后装（保持条目一次性构造，无中途突变）
      let versionSummary:
        | NonNullable<QuestionEvidenceEntry["version"]>
        | undefined;
      const evidenceImages: EvidenceImageItem[] = [];
      if (evidenceRow?.state === "frozen" && evidenceRow.versionId !== null) {
        const version = db
          .select()
          .from(noteVersions)
          .where(eq(noteVersions.id, evidenceRow.versionId))
          .get();
        if (version !== undefined) {
          versionSummary = {
            versionId: version.id,
            savedAt: version.serverSavedAt,
            strokeCount: version.strokeCount,
            pointCount: version.pointCount,
            paperHeight: version.paperHeight,
          };
          const { images, missing } = analysisImagesOf(
            db,
            dataDir,
            eRef,
            version,
          );
          evidenceImages.push(...images);
          missingEvidenceImages.push(...missing);
        } else {
          // FK 保证不可达的防御分支：版本行缺失按显式缺失报出，不吞
          missingEvidenceImages.push({
            file: evidenceImageFileName(eRef, "scratch", 0),
            reason: "被固定的版本行缺失（数据异常）",
            evidenceRef: eRef,
          });
        }
      }
      evidence.push({
        ref: eRef,
        attemptId: attempt.id,
        studentId: attempt.studentId,
        questionId: row.questionId,
        questionRef: revision.ref,
        no,
        // 交卷证据当前只可能来自 scratch 工作稿（correction/supplement 由
        // T6R.15 另起记录，届时以独立证据条目扩展）
        phase: "scratch",
        state: evidenceRow?.state ?? "not_collected",
        ...(versionSummary !== undefined ? { version: versionSummary } : {}),
        images: evidenceImages,
      });
      evidenceRefByResponseRowId.set(row.id, eRef);
    }
  }

  // —— 第二遍：媒体附件（只扫实际进包的投影文本；学生角色不扫解析） ——
  const mediaOut: Array<{
    src: string;
    absPath: string;
    bytes: number;
    questionRefs: string[];
  }> = [];
  const missingMediaOut: Array<{
    src: string;
    reason: string;
    questionRefs: string[];
  }> = [];
  {
    // 解析（solutionMd）只在教师 solution 层进包——扫描范围与包内容严格一致
    const scanSolution = !studentRole && level === "solution";
    const srcRefs = new Map<string, string[]>();
    for (const revision of revisions) {
      const texts = [revision.material.stemMd];
      if (scanSolution) texts.push(revision.material.solutionMd ?? "");
      for (const src of extractMediaImageSrcs(texts)) {
        const refs = srcRefs.get(src);
        if (refs === undefined) srcRefs.set(src, [revision.ref]);
        else if (!refs.includes(revision.ref)) refs.push(revision.ref);
      }
    }
    const mediaRoot = resolve(dataDir, "blobs", "media");
    for (const [src, questionRefs] of srcRefs) {
      const absPath = resolve(dataDir, ...src.split("/"));
      // 严格契约形态无穿越空间；越界按缺失处理（与 export-service 同口径）
      if (!absPath.startsWith(mediaRoot)) {
        missingMediaOut.push({
          src,
          reason: "媒体路径非法",
          questionRefs,
        });
        continue;
      }
      try {
        const bytes = statSync(absPath).size;
        mediaOut.push({ src, absPath, bytes, questionRefs });
      } catch {
        missingMediaOut.push({
          src,
          reason: "图片文件缺失（未上传或已清理）",
          questionRefs,
        });
      }
    }
  }

  return {
    revisions,
    refByResponseRowId,
    evidence,
    evidenceRefByResponseRowId,
    media: mediaOut,
    missingMedia: missingMediaOut,
    missingEvidenceImages,
  };
}

/**
 * frozen 版本的分析图装配：analysis 规格逐页登记（ready 附文件字节与绝对
 * 路径；其余状态/文件丢失进缺失清单）；缩略图（thumbnail）不进包；版本
 * 一张分析图都没有时以预测路径报「未生成」。纯读，结果由调用方合并。
 */
function analysisImagesOf(
  db: Db,
  dataDir: string,
  eRef: string,
  version: NoteVersionRow,
): {
  images: EvidenceImageItem[];
  missing: Array<{ file: string; reason: string; evidenceRef: string }>;
} {
  const missing: Array<{ file: string; reason: string; evidenceRef: string }> =
    [];
  const images: EvidenceImageItem[] = [];
  const notesRoot = resolve(dataDir, "blobs", "notes");
  const imageRows: NoteImageRow[] = db
    .select()
    .from(noteImages)
    .where(
      and(
        eq(noteImages.noteVersionId, version.id),
        eq(noteImages.spec, "analysis"),
      ),
    )
    .orderBy(asc(noteImages.pageIndex))
    .all();
  for (const image of imageRows) {
    const file = evidenceImageFileName(eRef, "scratch", image.pageIndex);
    const crop: NoteCropRect = {
      x: image.cropX,
      y: image.cropY,
      width: image.cropW,
      height: image.cropH,
    };
    const base = {
      file,
      spec: "analysis" as const,
      pageIndex: image.pageIndex,
      crop,
      pixelWidth: image.pixelWidth,
      pixelHeight: image.pixelHeight,
    };
    if (image.state === "ready") {
      const absPath = resolve(dataDir, image.path);
      if (absPath.startsWith(notesRoot)) {
        try {
          const bytes = statSync(absPath).size;
          images.push({ ...base, state: "ready", bytes, absPath });
          continue;
        } catch {
          // 文件丢失：落入下方缺失登记
        }
      }
      const reason = absPath.startsWith(notesRoot)
        ? "图片文件缺失（磁盘无此文件）"
        : "图片路径非法";
      images.push({ ...base, state: "missing", reason });
      missing.push({ file, reason, evidenceRef: eRef });
    } else {
      const reason = evidenceImageMissingReason(image.state);
      images.push({ ...base, state: "missing", reason });
      missing.push({ file, reason, evidenceRef: eRef });
    }
  }
  if (imageRows.length === 0) {
    missing.push({
      file: evidenceImageFileName(eRef, "scratch", 0),
      reason: "该版本尚无分析图（未生成）",
      evidenceRef: eRef,
    });
  }
  return { images, missing };
}

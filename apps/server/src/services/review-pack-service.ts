import type {
  LearningPackManifest,
  LearningPackManifestMissing,
  QuestionAnswers,
  ReviewPack,
  ReviewPackAttachment,
  ReviewPackPreviewData,
  ReviewPackPreviewFile,
} from "@tutor/contract";
import {
  renderReviewPackPrompt,
  REVIEW_PACK_MAX_BYTES,
  reviewPackJsonSchema,
  reviewPackPreviewDataSchema,
  reviewPackSchema,
} from "@tutor/contract";
import { buildStaticQuestionMaterial } from "@tutor/md-dsl";
import { ZipArchive } from "archiver";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { type Attempt, type ResponseRow, assignments } from "../db/schema";
import { HttpError } from "../lib/http-error";
import {
  answerOf,
  answersReleased,
  attemptTeacherId,
  frozenRowsInDisplayOrder,
  requireUsableAttempt,
} from "./attempt-service";
import { beijingExportStampOf } from "./export-csv";
import { serializeStudentAnswer } from "./mark-response";
import { assembleQuestionEvidence } from "./question-evidence";
import { requireTeacherAttempt } from "./teacher-attempt-service";

/**
 * 单题完整导出服务（T6R.13，方案 §8/§9.1「一个装配服务、三种用户入口」的
 * 学生单题与教师单题两入口）：
 *
 * - **默认取当前 attempt 的指定题**：路径参数 attemptId + questionId 定位
 *   （前端从结果页/教师详情页进入，天然是当前卷）；
 * - **复用共享装配**：assembleQuestionEvidence（T6R.12）做角色投影（学生
 *   经 studentStemMd + 服务端哨兵）、证据选择（frozen/missing/none/…）、
 *   媒体附件清单；题目文字经 buildStaticQuestionMaterial（md-dsl 单一实现，
 *   与前端静态素材同一模块）——图表参数化说明、交互容器显式标注、LaTeX 与
 *   表格逐字保留；
 * - **角色/答案公布门控在服务端执行**：学生角色结构性无 answers/solutionMd/
 *   判定/评语（materialOf 学生角色 + reviewPackSchema superRefine 双层保证）；
 *   after_due 截止前的 assignment 来源学生包照常（本就无答案），review.md
 *   注明「无判定属正常」；教师包为教师域文档，照常携带真实 id 与答案；
 * - **学生包 id 剥离（安全审查留档硬要求）**：pack.json/review.md/全部文件名
 *   不携带 attemptId/studentId/questionId/versionId 等定位键（预览响应的
 *   downloadUrl 属学生本人已授权的交互端点，不在包内）；
 * - **缺失显式**：分析图未生成/文件删除、媒体缺失 → manifest.missing +
 *   complete=false + review.md「材料不完整」；绝不静默消失或自动声称可诊断；
 * - **生成期间状态变化**：装配（stat）与 zip 写入分离（assembleReviewPack /
 *   zipReviewPack 两段）——写 zip 时文件已消失则显式 500
 *   EXPORT_ASSEMBLY_BROKEN，不产出与清单不符的静默缺件 zip；完整重请求按
 *   当前状态重装配。
 *
 * preview 与 zip 共用同一装配函数；reviewMd 在预览响应与 zip 内逐字节一致
 * （复制文字与下载交付的是同一份文本）。now 可注入（确定性测试）。
 */

/** 请求主体：学生本人或教师域 */
export type ReviewPackPrincipal =
  | { readonly kind: "student"; readonly id: string }
  | { readonly kind: "teacher"; readonly id: string };

/** 服务选项：now 注入测试时刻；maxBytes 注入缩小的上限（预检用例） */
export interface ReviewPackServiceOptions {
  readonly now?: Date | string;
  readonly maxBytes?: number;
}

/** 装配结果（preview 与 zip 写入共用；两段分离是「生成期间状态变化」测试缝） */
export interface ReviewPackAssembly {
  readonly packJson: string;
  readonly reviewMd: string;
  /** zip 内 schema.json 文本（与 schema:export 产物逐字节一致） */
  readonly schemaJson: string;
  /** questions/q001/stem.md 文本 */
  readonly questionMd: string;
  readonly questionEntry: string;
  /** 媒体附件（::image 引用、已落盘核对；条目名 = 契约 src 相对路径） */
  readonly mediaEntries: ReadonlyArray<{
    readonly entry: string;
    readonly absPath: string;
    readonly bytes: number;
  }>;
  /** 证据分析图（ready 状态、文件在场） */
  readonly evidenceEntries: ReadonlyArray<{
    readonly entry: string;
    readonly absPath: string;
    readonly bytes: number;
    readonly ref: string;
  }>;
  readonly manifest: LearningPackManifest;
  /** 文件清单（含 pack.json 实测；预览与预检共用） */
  readonly files: readonly ReviewPackPreviewFile[];
  readonly missing: readonly LearningPackManifestMissing[];
  /** 逐张图片附件（下载入口 + 缺失标记） */
  readonly attachments: readonly ReviewPackAttachment[];
  readonly preview: ReviewPackPreviewData;
  readonly totalBytes: number;
}

/** zip 构建结果（内存字节，路由层直出） */
export interface ReviewPackZip {
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** 下载文件名（review-pack-q<N>-<北京时间戳>.zip；不含真实 id） */
  readonly filename: string;
}

// ---------- 授权与定位 ----------

/**
 * 定位单题行：学生走 requireUsableAttempt（本人 + 来源访问权 + 懒冻结，
 * 403/404 既有口径）；教师走 requireTeacherAttempt（域外统一 404）。
 * 题目按 attempt 自有冻结行宽判定（软删题历史可导），展示序与题号走
 * frozenRowsInDisplayOrder（与学情数据包逐题行同口径）。
 */
function requireReviewScope(
  db: Db,
  principal: ReviewPackPrincipal,
  attemptId: string,
  questionId: string,
): {
  attempt: Attempt;
  row: ResponseRow;
  no: number;
  teacherId: string;
} {
  let attempt: Attempt;
  let teacherId: string;
  if (principal.kind === "student") {
    attempt = requireUsableAttempt(db, principal.id, attemptId);
    const owner = attemptTeacherId(db, attempt);
    if (owner === null) {
      throw new HttpError(
        500,
        "EXPORT_ASSEMBLY_BROKEN",
        "作答归属教师缺失（学生行不存在），无法装配",
      );
    }
    teacherId = owner;
  } else {
    attempt = requireTeacherAttempt(db, principal.id, attemptId).attempt;
    teacherId = principal.id;
  }
  let no = 0;
  let row: ResponseRow | undefined;
  for (const entry of frozenRowsInDisplayOrder(db, attempt)) {
    no += 1;
    if (entry.row.questionId === questionId) {
      row = entry.row;
      break;
    }
  }
  if (row === undefined) {
    throw new HttpError(404, "QUESTION_NOT_FOUND", "该题不在这份作答中");
  }
  return { attempt, row, no, teacherId };
}

/** 学生视角答案公布态（教师恒 true；course/wrong 恒公布；assignment 按作业行） */
function releasedOf(
  db: Db,
  principal: ReviewPackPrincipal,
  attempt: Attempt,
  now: Date,
): boolean {
  if (principal.kind === "teacher") return true;
  if (attempt.sourceType !== "assignment" || attempt.assignmentId === null) {
    return true;
  }
  const assignment = db
    .select()
    .from(assignments)
    .where(eq(assignments.id, attempt.assignmentId))
    .get();
  // 作业行缺失（数据异常）按已公布处理：学生包本就无答案，无泄露面
  return assignment === undefined ? true : answersReleased(assignment, now);
}

// ---------- 教师侧文本辅助（题面附加节） ----------

/** 选项字母（A…Z、AA 起；与序列化侧同口径的本地实现——QuestionAnswers 用） */
function letterOf(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * 参考答案 → 文本（教师 stem.md「参考答案」节；与显示侧
 * formatReferenceAnswers 语义一致但**不包 $**——裸 LaTeX 原样保留对 AI 更友好，
 * mathify 是渲染管线专属行为，不在服务端复刻）。
 */
function reviewAnswersText(answers: QuestionAnswers): string {
  switch (answers.kind) {
    case "judge":
      return answers.value ? "对" : "错";
    case "choice":
      return letterOf(answers.index);
    case "multi":
      return [...answers.indexes]
        .sort((a, b) => a - b)
        .map(letterOf)
        .join("");
    case "fill":
      return answers.blanks
        .map((blank) => blank.join(" 或 "))
        .join("；");
    case "final":
      return answers.answer;
  }
}

// ---------- 装配 ----------

/**
 * 装配单题包（preview 与 zip 的共用核心；纯读，不写任何数据）。
 * 输出经 reviewPackSchema / reviewPackPreviewDataSchema 服务端自检——
 * 学生包的 id 剥离与答案剔除在装配层与 schema 层双重锁定。
 */
export function assembleReviewPack(
  db: Db,
  dataDir: string,
  principal: ReviewPackPrincipal,
  attemptId: string,
  questionId: string,
  options: ReviewPackServiceOptions = {},
): ReviewPackAssembly {
  const nowDate =
    options.now === undefined
      ? new Date()
      : typeof options.now === "string"
        ? new Date(Date.parse(options.now))
        : options.now;
  const nowIso = nowDate.toISOString();
  const role = principal.kind;
  const teacherRole = role === "teacher";
  const { attempt, row, no, teacherId } = requireReviewScope(
    db,
    principal,
    attemptId,
    questionId,
  );
  const released = releasedOf(db, principal, attempt, nowDate);

  // —— 共享证据装配（单行 scope；教师取 solution 层全量、学生恒学生端投影） ——
  const asm = assembleQuestionEvidence(
    db,
    dataDir,
    teacherId,
    [{ attempt, rows: [row] }],
    {
      role,
      ...(teacherRole ? { questionLevel: "solution" } : {}),
      includeEvidence: true,
      assembleMedia: true,
    },
  );
  const revision = asm.revisions[0];
  const evidenceEntry = asm.evidence[0];
  if (revision === undefined || evidenceEntry === undefined) {
    // 单行 scope 必产单条目；缺即装配不变量破坏
    throw new HttpError(
      500,
      "EXPORT_ASSEMBLY_BROKEN",
      "单题装配缺少题目/证据条目（内部不变量破坏）",
    );
  }
  const qRef = revision.ref;
  const eRef = evidenceEntry.ref;
  const material = revision.material;
  const answerText = serializeStudentAnswer(answerOf(row.answerJson));

  // —— 题目文字（questions/q001/stem.md）：静态素材单一实现（md-dsl） ——
  const staticMaterial = buildStaticQuestionMaterial({
    role,
    stemMd: material.stemMd,
    ...(material.options !== undefined
      ? { options: material.options }
      : {}),
    ...(answerText !== null ? { answerText } : {}),
    questionNo: no,
  });
  const stemSections = [staticMaterial.markdown.trimEnd()];
  if (teacherRole) {
    if (material.answers !== undefined) {
      stemSections.push(`**参考答案**：${reviewAnswersText(material.answers)}`);
    }
    if (material.solutionMd !== undefined) {
      stemSections.push(`**详解**\n\n${material.solutionMd}`);
    }
    const verdict = row.finalCorrect ?? row.autoCorrect;
    stemSections.push(
      `**判定**：${verdict === null ? "待批" : verdict ? "对" : "错"}`,
    );
    if (row.teacherComment !== null) {
      stemSections.push(`**老师评语**：${row.teacherComment}`);
    }
  }
  const questionMd = `${stemSections.join("\n\n")}\n`;
  const questionEntry = `questions/${qRef}/stem.md`;

  // —— 附件（媒体 + 证据分析图）与缺失清单 ——
  const mediaEntries = asm.media.map((medium) => ({
    entry: medium.src,
    absPath: medium.absPath,
    bytes: medium.bytes,
  }));
  const evidenceEntries = [];
  for (const image of evidenceEntry.images) {
    if (image.state === "ready" && image.absPath !== undefined) {
      evidenceEntries.push({
        entry: image.file,
        absPath: image.absPath,
        bytes: image.bytes ?? 0,
        ref: eRef,
      });
    }
  }
  const missing: LearningPackManifestMissing[] = [
    ...asm.missingMedia.map((miss) => ({
      path: miss.src,
      kind: "media" as const,
      reason: miss.reason,
      refs: [...miss.questionRefs],
    })),
    ...asm.missingEvidenceImages.map((miss) => ({
      path: miss.file,
      kind: "evidence-image" as const,
      reason: miss.reason,
      refs: [miss.evidenceRef],
    })),
  ];

  // —— 固定文件 ——
  const schemaJson = `${JSON.stringify(reviewPackJsonSchema(), null, 2)}\n`;

  // —— review.md（共享提示词基础；附件清单不含 review.md/pack.json 自身） ——
  const promptFiles = [
    { path: questionEntry, bytes: Buffer.byteLength(questionMd, "utf8") },
    ...mediaEntries.map((medium) => ({
      path: medium.entry,
      bytes: medium.bytes,
    })),
    ...evidenceEntries.map((image) => ({
      path: image.entry,
      bytes: image.bytes,
    })),
  ];
  const reviewMd = renderReviewPackPrompt({
    role,
    questionNo: no,
    evidenceState: evidenceEntry.state,
    released,
    answersIncluded: teacherRole,
    files: promptFiles,
    missing: missing.map((miss) => ({
      path: miss.path,
      reason: miss.reason,
    })),
    imageCount: mediaEntries.length + evidenceEntries.length,
    graphFigureCount: staticMaterial.graphFigures.length,
    interactionNotes: staticMaterial.interactionNotes,
  });

  // —— manifest（pack.json 同时为清单；pack.json 自身不列） ——
  const contextNotes: string[] = [];
  if (!revision.present) {
    contextNotes.push(
      "本题历史快照缺失（题目已删除或升级遗留）：题干为空，不回填当前题库内容。",
    );
  }
  if (staticMaterial.graphFigures.length > 0) {
    contextNotes.push(
      `函数图表 ${staticMaterial.graphFigures.length} 处以参数化文本说明导出（未附静态图）。`,
    );
  }
  if (role === "student") {
    contextNotes.push(
      "学生包按学生端投影生成：不含参考答案/判定/评语/解析，也不携带作答/学生/题目/版本定位 id。",
    );
  }
  const manifest: LearningPackManifest = {
    files: [
      {
        path: "review.md",
        kind: "prompt",
        bytes: Buffer.byteLength(reviewMd, "utf8"),
        refs: [],
      },
      {
        path: "schema.json",
        kind: "schema",
        bytes: Buffer.byteLength(schemaJson, "utf8"),
        refs: [],
      },
      { path: questionEntry, kind: "question", bytes: promptFiles[0]?.bytes ?? 0, refs: [qRef] },
      ...mediaEntries.map((medium) => ({
        path: medium.entry,
        kind: "media" as const,
        bytes: medium.bytes,
        refs: [qRef],
      })),
      ...evidenceEntries.map((image) => ({
        path: image.entry,
        kind: "evidence" as const,
        bytes: image.bytes,
        refs: [image.ref],
      })),
    ],
    missing,
    contextNotes,
  };

  // —— pack.json（角色化；服务端 schema 自检——学生域键在 schema 层再拦一道） ——
  const packDraft: ReviewPack = {
    kind: "review-pack",
    version: 1,
    role,
    generatedAt: nowIso,
    question: {
      ref: qRef,
      no,
      present: revision.present,
      snapshotHash: revision.snapshotHash,
      type: material.type,
      difficulty: material.difficulty,
      knowledge: [...material.knowledge],
      stemMd: material.stemMd,
      ...(material.options !== undefined
        ? { options: [...material.options] }
        : {}),
      // —— 教师域键（学生包 schema superRefine 拒绝携带） ——
      ...(teacherRole ? { questionId: row.questionId } : {}),
      ...(teacherRole && material.answers !== undefined
        ? { answers: material.answers }
        : {}),
      ...(teacherRole && material.solutionMd !== undefined
        ? { solutionMd: material.solutionMd }
        : {}),
    },
    response: {
      no,
      answerText,
      ...(teacherRole
        ? {
            attemptId: attempt.id,
            studentId: attempt.studentId,
            autoCorrect: row.autoCorrect,
            finalCorrect: row.finalCorrect,
            teacherMark:
              row.teacherMark === "correct" || row.teacherMark === "wrong"
                ? row.teacherMark
                : null,
            teacherComment: row.teacherComment,
          }
        : {}),
    },
    evidence: {
      ref: eRef,
      phase: evidenceEntry.phase,
      state: evidenceEntry.state,
      images: evidenceEntry.images.map((image) => ({
        file: image.file,
        pageIndex: image.pageIndex,
        crop: { ...image.crop },
        pixelWidth: image.pixelWidth,
        pixelHeight: image.pixelHeight,
        state: image.state,
      })),
      ...(teacherRole
        ? {
            attemptId: attempt.id,
            studentId: attempt.studentId,
            questionId: row.questionId,
            ...(evidenceEntry.version !== undefined
              ? { version: evidenceEntry.version }
              : {}),
          }
        : {}),
    },
    manifest,
  };
  reviewPackSchema.parse(packDraft);
  const packJson = `${JSON.stringify(packDraft, null, 2)}\n`;

  // —— 预览文件清单（zip 条目全集 = manifest.files + pack.json） ——
  /** manifest kind → 预览分类（review-pack 的 manifest 只产右表五种 kind） */
  const PREVIEW_KIND_OF: Record<
    "prompt" | "schema" | "question" | "media" | "evidence",
    ReviewPackPreviewFile["kind"]
  > = {
    prompt: "review",
    schema: "schema",
    question: "question-md",
    media: "media",
    evidence: "evidence",
  };
  const files: ReviewPackPreviewFile[] = [
    {
      path: "pack.json",
      kind: "pack",
      bytes: Buffer.byteLength(packJson, "utf8"),
      refs: [],
    },
    ...manifest.files.map((file) => ({
      path: file.path,
      kind: PREVIEW_KIND_OF[file.kind as keyof typeof PREVIEW_KIND_OF],
      bytes: file.bytes,
      refs: [...file.refs],
    })),
  ];

  // —— 逐张图片附件（downloadUrl 按角色走既有授权直出端点） ——
  const attachments: ReviewPackAttachment[] = [];
  for (const medium of mediaEntries) {
    attachments.push({
      path: medium.entry,
      kind: "media",
      state: "ready",
      bytes: medium.bytes,
      // 媒体经公开 /blobs 伺服（内容寻址，src 前加 / 即 URL——媒体管线口径）
      downloadUrl: `/${medium.entry}`,
    });
  }
  for (const miss of asm.missingMedia) {
    attachments.push({
      path: miss.src,
      kind: "media",
      state: "missing",
      bytes: 0,
      reason: miss.reason,
    });
  }
  const versionId = evidenceEntry.version?.versionId;
  for (const image of evidenceEntry.images) {
    if (image.state === "ready" && versionId !== undefined) {
      attachments.push({
        path: image.file,
        kind: "evidence",
        state: "ready",
        bytes: image.bytes ?? 0,
        // 学生/教师各自的 note-versions 图片直出端点（已授权链）
        downloadUrl: `/api/${role}/note-versions/${encodeURIComponent(
          versionId,
        )}/images/${encodeURIComponent(image.imageId)}.png`,
      });
    } else {
      attachments.push({
        path: image.file,
        kind: "evidence",
        state: "missing",
        bytes: 0,
        ...(image.reason !== undefined ? { reason: image.reason } : {}),
      });
    }
  }

  const preview: ReviewPackPreviewData = reviewPackPreviewDataSchema.parse({
    role,
    questionNo: no,
    questionPresent: revision.present,
    evidenceState: evidenceEntry.state,
    released,
    answersIncluded: teacherRole,
    complete: missing.length === 0,
    files,
    missing,
    attachments,
    reviewMd,
  });

  return {
    packJson,
    reviewMd,
    schemaJson,
    questionMd,
    questionEntry,
    mediaEntries,
    evidenceEntries,
    manifest,
    files,
    missing,
    attachments,
    preview,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

/** POST …/review-pack/preview：预览数据（附件清单 + 缺失 + reviewMd 全文） */
export function previewReviewPack(
  db: Db,
  dataDir: string,
  principal: ReviewPackPrincipal,
  attemptId: string,
  questionId: string,
  options: ReviewPackServiceOptions = {},
): ReviewPackPreviewData {
  return assembleReviewPack(
    db,
    dataDir,
    principal,
    attemptId,
    questionId,
    options,
  ).preview;
}

// ---------- zip 写入（与装配分离——「生成期间状态变化」显式失败缝） ----------

/**
 * 把装配结果写成 zip（内存 Buffer）。**装配与写入分离**：装配阶段 stat 过的
 * 文件在写入阶段消失（GC/并发删除）时，archiver 报错 → 显式 500
 * EXPORT_ASSEMBLY_BROKEN——绝不产出与 manifest 不符的静默缺件 zip；调用方
 * （路由）可让用户重试，重试将按当前状态重新装配并把该文件列入缺失清单。
 */
export async function zipReviewPack(
  assembly: ReviewPackAssembly,
): Promise<Uint8Array<ArrayBuffer>> {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", () => resolve());
    archive.on("error", (err: Error) => reject(err));
  });
  // archiver 对消失的文件只发 warning 并**静默跳过条目**（core.js 的 lstat
  // 错误路径 emit("warning") + _entriesCount--）——这里必须把 warning 当
  // 装配破坏处理，否则会产出与 manifest 不符的缺件 zip（测试锁定的行为）
  let writeBroken: Error | null = null;
  archive.on("warning", (err: Error) => {
    writeBroken ??= err;
  });
  try {
    archive.append(Buffer.from(assembly.reviewMd, "utf8"), {
      name: "review.md",
    });
    archive.append(Buffer.from(assembly.packJson, "utf8"), {
      name: "pack.json",
    });
    archive.append(Buffer.from(assembly.schemaJson, "utf8"), {
      name: "schema.json",
    });
    archive.append(Buffer.from(assembly.questionMd, "utf8"), {
      name: assembly.questionEntry,
    });
    for (const entry of assembly.mediaEntries) {
      archive.file(entry.absPath, { name: entry.entry });
    }
    for (const entry of assembly.evidenceEntries) {
      archive.file(entry.absPath, { name: entry.entry });
    }
    await archive.finalize();
    await done;
    if (writeBroken !== null) {
      throw writeBroken;
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new HttpError(
      500,
      "EXPORT_ASSEMBLY_BROKEN",
      `单题包写入失败（生成期间文件状态可能已变化）：${detail}。请重试；重试将按当前状态重新装配并标记缺失文件。`,
    );
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * POST …/review-pack：装配 + 上限预检（超限 413 EXPORT_TOO_LARGE）+ 打包。
 * 文件名 review-pack-q<N>-<北京时间戳>.zip（题号非真实 id，化名口径）。
 */
export async function buildReviewPackZip(
  db: Db,
  dataDir: string,
  principal: ReviewPackPrincipal,
  attemptId: string,
  questionId: string,
  options: ReviewPackServiceOptions = {},
): Promise<ReviewPackZip> {
  const limitBytes = options.maxBytes ?? REVIEW_PACK_MAX_BYTES;
  const assembly = assembleReviewPack(
    db,
    dataDir,
    principal,
    attemptId,
    questionId,
    options,
  );
  if (assembly.totalBytes > limitBytes) {
    throw new HttpError(
      413,
      "EXPORT_TOO_LARGE",
      `单题包预估 ${(assembly.totalBytes / (1024 * 1024)).toFixed(
        1,
      )} MB，超过 ${Math.round(limitBytes / (1024 * 1024))} MB 上限，请精简附件后重试。`,
    );
  }
  const bytes = await zipReviewPack(assembly);
  const nowDate =
    options.now === undefined
      ? new Date()
      : typeof options.now === "string"
        ? new Date(Date.parse(options.now))
        : options.now;
  return {
    bytes,
    filename: `review-pack-q${assembly.preview.questionNo}-${beijingExportStampOf(nowDate)}.zip`,
  };
}

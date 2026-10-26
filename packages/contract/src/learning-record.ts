import { z } from "zod";
import { annotationSurfaceLayoutSchema } from "./annotation.ts";
import {
  attemptSourceSchema,
  attemptStatusSchema,
  questionRevisionIdSchema,
} from "./attempt.ts";
import { questionAnswersSchema } from "./content.ts";
import { studentAnswerSchema } from "./grading.ts";
import {
  inkDeletedStrokeSchema,
  inkStrokeIdSchema,
  inkStrokeSchema,
} from "./ink.ts";
import { noteBackgroundSchema, notePhaseSchema } from "./note.ts";
import { questionNodeKeySchema, questionNodeSchema } from "./question-node.ts";
import { selfReviewStateSchema } from "./self-review.ts";
import { aiMaterialKindSchema } from "./student-ai.ts";

/**
 * 学习记录模型契约（LR-PR1，学习记录模型设计稿 §3 起为权威定义）。
 *
 * `LearningRecord` 是**服务端装配的只读聚合**（不是新的写入载体）：由既有表
 * 与 blob 现算（identity/question/answer/ink/timeline/grading 六个面），渲染、
 * 导出、AI 上下文都改为它的投影（P1：记录是事实源，渲染是投影）。写入侧只在
 * 三份文档契约上加字段（ink.ts LR-1/LR-2、annotation.ts LR-2/LR-4/LR-5），
 * 不改表、不动版本链与 CAS、不动 GC。
 *
 * 设计原则（设计稿 §2）：P1 记录是事实源；P2 只增不改；P3 过程先于结果；
 * P4 锚语义不锚像素；P5 AI 吃结构化、图作附件；P6 防泄露与角色投影同口径；
 * P7 坐标与时间都可脱离浏览器解释。装配逻辑（服务端现算）在 LR-PR3。
 */

/** 记录结构版本：六面形状变更即递增 */
export const LEARNING_RECORD_VERSION = 1;

/** 投影角色：决定各面的裁剪（装配层按角色取数；学生禁携清单见 superRefine） */
export const learningRecordRoleSchema = z.enum(["student", "teacher", "ai"]);

// ---------- 身份面 identity（§3.2） ----------

export const learningRecordIdentitySchema = z.object({
  /** 唯一必带的定位键（= responses.id；学生视角本就下发） */
  questionRevisionId: questionRevisionIdSchema,
  /** 卷内题号（冻结序，1 起） */
  questionNo: z.number().int().min(1),
  // —— 教师域键（仅 teacher/ai(授权) 携带；student superRefine 禁携） ——
  attemptId: z.uuid().optional(),
  studentId: z.uuid().optional(),
  questionId: z.string().min(1).optional(),
  attemptStatus: attemptStatusSchema,
  source: attemptSourceSchema,
});

// ---------- 题面面 question（§3.3） ----------

export const questionFacetSchema = z.object({
  /** 冻结快照是否存在（升级遗留缺失行为 false，不回填） */
  snapshotPresent: z.boolean(),
  /** 来自快照（题型标识 / 难度 1–5 / 考点列表） */
  type: z.string().min(1),
  difficulty: z.number().int().min(1).max(5).nullable().optional(),
  knowledge: z.array(z.string()).optional(),
  /**
   * 按角色投影（装配层职责）：student/ai 用 studentStemMd 与纯文本选项，
   * teacher 原文。nodes[] 两种角色**同一份键序列**——都从公开投影枚举
   * （questionNodesOf），保证锚点跨角色可互认（§3.3）。
   */
  stemMd: z.string().min(1),
  options: z.array(z.string()).optional(),
  // —— 教师域键（student superRefine 禁携；ai 仅授权时带，missingNote 口径） ——
  answers: questionAnswersSchema.optional(),
  solutionMd: z.string().optional(),
  hints: z.array(z.string()).optional(),
  /** 节点枚举算法版本（questionNodesOf 的 QUESTION_NODES_VERSION） */
  nodesVersion: z.number().int().min(1),
  nodes: z.array(questionNodeSchema).min(1),
});

// ---------- 作答面 answer（§3.4） ----------

/** 作答修改史条目：由 events.answer_change 现算；无事件为 [] */
export const answerHistoryEntrySchema = z.object({
  at: z.number().int().positive(),
  from: z.union([studentAnswerSchema, z.null()]).optional(),
  to: z.union([studentAnswerSchema, z.null()]).optional(),
});

export const answerFacetSchema = z.object({
  /** 学生自己的答案（非秘密，两角色都带）；null = 未作答 */
  current: z.union([studentAnswerSchema, z.null()]),
  /** 人类可读序列化（复用 review-pack 的 answerText 实现） */
  answerText: z.string().nullable(),
  answerRevision: z.number().int().min(0),
  submittedAt: z.string().min(1).nullable().optional(),
  /** 学生题目标记（responses 行） */
  studentFlag: z.boolean().nullable().optional(),
  history: z.array(answerHistoryEntrySchema),
});

// ---------- 材料面 ink（§3.5）：三类材料 annotation / draft / formal_ink ----------

/** 材料定位版本：teacher 必带；student 剥离 id 只留 revision/hash（P6） */
export const inkMaterialVersionSchema = z
  .object({
    revision: z.number().int().min(0),
    hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    versionId: z.uuid().optional(),
    savedAt: z.string().optional(),
    sealedAt: z.string().nullable().optional(),
  })
  .optional();

/** 材料坐标系：纸面（逻辑宽 1000，草稿/正式手写）或底图像素域（圈画） */
export const inkMaterialFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("paper"),
    width: z.literal(1000),
    height: z.number().int().positive(),
    background: noteBackgroundSchema.optional(),
  }),
  z.object({
    kind: z.literal("base"),
    pixelWidth: z.number().int().positive(),
    pixelHeight: z.number().int().positive(),
    /** 含 blocks[].node 时即可做节点重投影（LR-5/LR-6） */
    layout: annotationSurfaceLayoutSchema.optional(),
    /** 已锚定笔画占比（0 = 旧稿无锚） */
    anchoredRatio: z.number().min(0).max(1),
  }),
]);

/** 派生图引用：投影缓存，不是事实（P1）——只是附件引用 */
export const inkMaterialImageSchema = z.object({
  kind: z.enum(["snapshot", "analysis", "thumbnail", "base", "composite"]),
  pageIndex: z.number().int().min(0),
  pixelWidth: z.number().int().positive(),
  pixelHeight: z.number().int().positive(),
  /** 角色化直出 URL（复用既有端点） */
  downloadUrl: z.string().optional(),
  state: z.enum(["ready", "missing"]),
});

export const inkMaterialFacetSchema = z.object({
  kind: aiMaterialKindSchema,
  present: z.boolean(),
  phase: notePhaseSchema.optional(),
  version: inkMaterialVersionSchema,
  frame: inkMaterialFrameSchema,
  /** 活笔画（含 id/startedAt 等可选新字段；旧稿不含） */
  strokes: z.array(inkStrokeSchema),
  /** 墓碑（LR-2）；旧稿恒 [] */
  deleted: z.array(inkDeletedStrokeSchema),
  /** 仅 annotation：笔画 → 题面语义节点键 */
  anchors: z.record(inkStrokeIdSchema, questionNodeKeySchema).optional(),
  stats: z.object({
    /** 活笔画数（与表列同口径） */
    strokeCount: z.number().int().min(0),
    pointCount: z.number().int().min(0),
    deletedCount: z.number().int().min(0),
    /** epoch ms；无 startedAt 的旧稿为 null */
    firstAt: z.number().int().nullable(),
    lastAt: z.number().int().nullable(),
    /** Σ 每笔 (last t)，纯书写时长；无时序旧稿为 null */
    writingMs: z.number().int().nullable(),
    /** ≥ INK_PAUSE_THRESHOLD_MS 的笔间停顿（派生值，不落盘，§6.2） */
    pauses: z.array(
      z.object({
        afterStrokeId: inkStrokeIdSchema,
        ms: z.number().int().positive(),
      }),
    ),
    /** 时间字段覆盖度，AI 提示词据此措辞（§6.2：旧数据如实告知） */
    timingCoverage: z.enum(["full", "partial", "none"]),
  }),
  images: z.array(inkMaterialImageSchema),
});

// ---------- 时间线面 timeline（§3.6 / §6） ----------

/**
 * 时间线条目种类（§6.1）。v1 不产出 teacher_mark：responses 现无教师标记
 * 时间列，`teacher_marked_at` 可选迁移**不做**（拍板 D2：不做也不影响主线；
 * teacherMark 值只出现在 grading 面）。后续若做迁移，在此**追加**枚举值。
 */
export const timelineKindSchema = z.enum([
  "view",
  "focus",
  "blur",
  "hidden",
  "visible",
  "idle_start",
  "idle_end",
  "answer_change",
  "hint_open",
  "directive_interact",
  "stroke",
  "erase",
  "clear",
  "undo",
  "note_version",
  "seal",
  "question_submit",
  "submit",
  "graded",
  "self_review",
  "ai_task",
  "ai_reply",
]);

export const timelineEntrySchema = z.strictObject({
  /** epoch ms（客户端时钟；serverSkewMs 供校正提示，服务端不改写时间） */
  at: z.number().int().positive(),
  kind: timelineKindSchema,
  source: z.enum([
    "event",
    "ink",
    "note",
    "annotation",
    "grading",
    "ai",
    "attempt",
  ]),
  material: aiMaterialKindSchema.optional(),
  strokeIds: z.array(inkStrokeIdSchema).optional(),
  /** 只放 id/序号/计数/枚举，不放内容（§3.6） */
  detail: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .optional(),
});

export const timelineFacetSchema = z.object({
  /** 按 at 升序（排序由装配层保证） */
  entries: z.array(timelineEntrySchema),
  clock: z.object({
    basis: z.literal("client"),
    serverSkewMs: z.number().int().nullable(),
  }),
  /** 超过 TIMELINE_MAX_ENTRIES 时尾部截断并置 true */
  truncated: z.boolean(),
});

// ---------- 判定面 grading（§3.7） ----------

export const gradingFacetSchema = z.object({
  answered: z.boolean(),
  // 判定域：teacher 全带；student 仅在「已公布」时带 autoCorrect/finalCorrect
  //（与结果页同一公布 gate——公布与否由装配层裁决，schema 不区分）
  autoCorrect: z.boolean().nullable().optional(),
  finalCorrect: z.boolean().nullable().optional(),
  reviewSource: selfReviewStateSchema.shape.source.optional(),
  selfCorrect: z.boolean().nullable().optional(),
  reviewedAt: z.string().min(1).nullable().optional(),
  // —— 教师域键（student superRefine 禁携） ——
  teacherMark: z.enum(["correct", "wrong"]).nullable().optional(),
  teacherComment: z.string().nullable().optional(),
  /** 学生自己的行为，两角色都带 */
  hintsUsed: z.number().int().min(0),
  hintsOpened: z.array(z.number().int().min(0)),
});

// ---------- 根对象（§3.1） ----------

export const learningRecordSchema = z
  .object({
    recordVersion: z.literal(LEARNING_RECORD_VERSION),
    role: learningRecordRoleSchema,
    /** UTC ISO（装配时刻） */
    generatedAt: z.string().min(1),
    identity: learningRecordIdentitySchema,
    question: questionFacetSchema,
    answer: answerFacetSchema,
    /** 三类材料各一项，缺则 present:false */
    ink: z.array(inkMaterialFacetSchema),
    timeline: timelineFacetSchema,
    grading: gradingFacetSchema,
  })
  .superRefine((record, ctx) => {
    // P6：学生视角禁携清单（与 reviewPackSchema superRefine 同口径——
    // attemptId/studentId/questionId/snapshotHash/answers/solutionMd/判定/评语；
    // snapshotHash 本 schema 不设字段，天然不携带）。
    if (record.role !== "student") return;
    const forbidden: Array<[unknown, string[]]> = [
      [record.identity.attemptId, ["identity", "attemptId"]],
      [record.identity.studentId, ["identity", "studentId"]],
      [record.identity.questionId, ["identity", "questionId"]],
      [record.question.answers, ["question", "answers"]],
      [record.question.solutionMd, ["question", "solutionMd"]],
      [record.question.hints, ["question", "hints"]],
      [record.grading.teacherMark, ["grading", "teacherMark"]],
      [record.grading.teacherComment, ["grading", "teacherComment"]],
      [record.grading.reviewSource, ["grading", "reviewSource"]],
    ];
    for (const [value, path] of forbidden) {
      if (value !== undefined && value !== null) {
        ctx.addIssue({
          code: "custom",
          path,
          message: `学生视角记录禁携 ${path.join(".")}（P6，与 reviewPackSchema 同口径）`,
        });
      }
    }
  });

export type LearningRecord = z.infer<typeof learningRecordSchema>;
export type LearningRecordRole = z.infer<typeof learningRecordRoleSchema>;
export type InkMaterialFacet = z.infer<typeof inkMaterialFacetSchema>;
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

// ---------- 过程 / AI 常量（§6.2 / §7.3；拍板见 PR 描述） ----------

/** 笔间停顿阈值（§6.2）：≥ 该值的笔间间隙进 ink[].stats.pauses。**暂定，可调** */
export const INK_PAUSE_THRESHOLD_MS = 2000;

/** 时间线条目上限（§6.2）：超出截尾并置 timeline.truncated=true。**暂定** */
export const TIMELINE_MAX_ENTRIES = 5000;

/**
 * AI 视图单材料点数上限（§7.3；§10-8 拍板 D3 采纳设计初值 6000）：RDP 简化后
 * 仍超则按笔均匀抽稀并置 compacted:true。小模型通道可按连接配置调低。
 */
export const AI_MAX_POINTS_PER_MATERIAL = 6000;

/** AI 视图 RDP 简化 ε（§7.3，按坐标域比例 0.3%：纸面逻辑宽 1000 → 3 逻辑单位） */
export const AI_STROKE_EPSILON_RATIO = 0.003;

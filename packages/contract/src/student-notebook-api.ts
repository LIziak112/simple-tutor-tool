import { z } from "zod";
import { attemptSourceSchema } from "./attempt.ts";
import {
  noteRecordMetaSchema,
  noteSubmissionEvidenceMetaSchema,
} from "./note.ts";

/**
 * 学生端「题目笔记本」聚合契约（T6R.15 起为权威定义，方案 §5.2「按题笔记本
 * 通过查询聚合得到」、D7——不建全局表，跨 attempt 查询聚合）：
 * - GET /api/student/notebook/questions/:questionId：学生本人该题的跨来源
 *   （作业 + 课程练习 + 错题重练）历次作答轮次。
 *
 * 安全口径（AGENTS.md 第 3 条，硬性规则 3）：
 * - 本契约**不含答案/详解/提示内容**，也不含题干正文——题目侧内容只有
 *   questionVersion 一个**版本号数字**（冻结快照里的题目 version，供「题目
 *   改版了」对照提示），绝不返回题干/答案/解析文本；
 * - 轮次聚合**仅收录已交卷 attempt**（draft 不进 rounds，防进行中状态侧漏）；
 * - 学生本人数据（归属由会话推定），无跨生内容。
 *
 * 约定（与 student-records-api.ts 一致）：
 * - 本文件只定义 data 部分；响应壳 { ok, data } 由 index.ts 统一描述，
 *   此处仅用局部 helper 具体化成功壳（避免循环依赖）；
 * - 时间一律 UTC ISO 字符串；
 * - 来源上下文对齐 student-records-api 的既有口径（同一概念同一份定义，
 *   AGENTS 第 1 条）：sourceType 复用 attempt.ts 的 attemptSourceSchema，
 *   sourceLabel 为服务端算好的展示串（作业 = 作业标题；课程练习 =
 *   「单元标题 · 第 n 次」，与 wrongQuestionRoundSchema.sourceTitle 同口径），
 *   不重复手写来源结构。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

/**
 * 笔记本单轮（notebookRound）：该生该题的一次**已交卷**作答及其笔记材料。
 * - roundOrdinal：该生该题按提交时间排序的轮次号（从 1 递增；同刻按
 *   attemptId 升序兜底稳定，与错题本 rounds 排序同口径）；
 * - evidence：该轮逐题提交证据行；null = 无证据行（旧客户端兼容交卷，
 *   与 state='none'〔明确空稿〕区分）；
 * - corrections / supplements：该轮的订正记录（含已封存与未封存）与交卷后
 *   找回的补充稿（noteRecordMeta 形状，见 note.ts T6R.15 段）。
 */
export const notebookRoundSchema = z.object({
  /** 该轮作答 id（attempts.id） */
  attemptId: z.uuid(),
  /** 该轮作答来源（复用 attemptSourceSchema：assignment | course | wrong） */
  sourceType: attemptSourceSchema,
  /**
   * 该轮来源标题（服务端口径：作业 = 作业标题；课程练习 = 「单元标题 ·
   * 第 n 次」；错题重练 = 「错题重练」——与 wrongQuestionRoundSchema.
   * sourceTitle 同一计算函数，无教师侧敏感键）
   */
  sourceLabel: z.string().min(1),
  /** 该轮交卷时间（attempt 的 submittedAt）：UTC ISO */
  submittedAt: z.string().min(1),
  /** 该生该题按提交时间排序的轮次号（从 1 递增） */
  roundOrdinal: z.number().int().min(1),
  /**
   * 冻结快照里的题目 version 号（questions.version 数字）；快照缺失或
   * 无版本字段为 null。**只有版本号数字**——题干正文/答案/解析一律不进
   * 本契约（AGENTS 第 3 条），改版对照由前端据数字提示，内容回源各自的
   * 结果视图读取。
   */
  questionVersion: z.number().int().min(1).nullable(),
  /** 该轮提交证据行；null = 无证据行（旧客户端兼容交卷） */
  evidence: noteSubmissionEvidenceMetaSchema.nullable(),
  /** 该轮订正记录（phase='correction' 行，含已封存与未封存） */
  corrections: z.array(noteRecordMetaSchema),
  /** 该轮补充稿（phase='supplement' 行，交卷后找回） */
  supplements: z.array(noteRecordMetaSchema),
});

/**
 * GET /api/student/notebook/questions/:questionId 响应 data：
 * - rounds 按提交时间升序（roundOrdinal 与之一致递增）；
 * - questionId 无已交卷轮次 → rounds=[] 照常 200（**不做题目存在性探测**，
 *   空数组即「没有历史」，与错题本的空态同口径）。
 */
export const studentNotebookDataSchema = z.object({
  /** 题目 id（questions.id，来自 DSL；路径参数） */
  questionId: z.string().min(1),
  /** 已交卷轮次列表（升序；无轮次为空数组） */
  rounds: z.array(notebookRoundSchema),
});

// ---------- 具体化的成功壳 ----------

/** 携带题目笔记本的成功响应壳 */
export const studentNotebookOkSchema = apiOkExtend(studentNotebookDataSchema);

// ---------- 推断类型导出 ----------

export type NotebookRound = z.infer<typeof notebookRoundSchema>;
export type StudentNotebookData = z.infer<typeof studentNotebookDataSchema>;

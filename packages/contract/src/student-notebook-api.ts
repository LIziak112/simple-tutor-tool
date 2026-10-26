import { z } from "zod";
import { attemptQuestionPublicSchema, attemptSourceSchema } from "./attempt.ts";
import { questionAnswersSchema } from "./content.ts";
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
 * - 题面使用**冻结快照的公开白名单投影**（attemptQuestionPublicSchema，
 *   stemMd 经 studentStemMd 脱敏——[[答案]] 剥标记、内嵌选项剥除），与取卷/
 *   结果视图同一份投影（单一出处，不重定义）；快照缺失/损坏 → question:
 *   null，绝不回填 live 题库；
 * - 答案/详解按**各来源公布 gate 受控下发**（release 块，fail-closed）：
 *   assignment 依 answersReleased（on_submit 交卷即公布 / after_due 到截止
 *   才公布），course/wrong 恒交卷即公布，lesson 按题级 submittedAt；未公布
 *   → release: null，服务端不输出该题答案/详解文本；
 * - 轮次聚合**仅收录已交卷 attempt**（draft 不进 rounds，防进行中状态侧漏）；
 * - 教师评语（teacherComment）、批注（teacherMark）、判定（finalCorrect/
 *   autoCorrect）与提示内容**结构性禁入**本契约；
 * - 题干形态与错题本（wrongQuestionCardSchema 快照原文）**有意不同**：错题
 *   本入口自带「已判定 + 公布 gate」双重上游过滤，本文用脱敏投影 + 独立
 *   release——更严一档，勿向错题本口径「对齐」时连公布 gate 一起丢掉；
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
 * 该轮受控解析（release）：参考答案 + 详解，**只在所属来源公布 gate 放行时
 * 非空**（fail-closed——未公布时整个 release 为 null，服务端不构造本对象）。
 * - answers：快照 QuestionAnswers（与 wrongQuestionCardSchema.answers 同口径；
 *   无标准答案的主观题为 null，由老师批改）；
 * - solutionMd：快照详解 Markdown；题库未提供为 null。
 */
export const notebookRoundReleaseSchema = z.object({
  answers: questionAnswersSchema.nullable(),
  solutionMd: z.string().nullable(),
});

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
  /** 该轮作答来源（复用 attemptSourceSchema：assignment | course | wrong | lesson，lesson 为 2026-10 新增） */
  sourceType: attemptSourceSchema,
  /**
   * 该轮来源标题（服务端口径：作业 = 作业标题；课程练习 = 「单元标题 ·
   * 第 n 次」；错题重练 = 「错题重练 · 第 n 次」——与 wrongQuestionRoundSchema.
   * sourceTitle 同一计算函数，无教师侧敏感键）
   */
  sourceLabel: z.string().min(1),
  /** 该轮交卷时间（attempt 的 submittedAt）：UTC ISO */
  submittedAt: z.string().min(1),
  /** 该生该题按提交时间排序的轮次号（从 1 递增） */
  roundOrdinal: z.number().int().min(1),
  /**
   * 冻结快照里的题目 version 号（questions.version 数字）；快照缺失或
   * 无版本字段为 null。改版对照由前端据数字提示；题面内容经下方 question
   * 的脱敏投影下发，答案/详解按 release 的公布 gate 受控下发。
   */
  questionVersion: z.number().int().min(1).nullable(),
  /**
   * 该轮冻结题的公开题面（publicOfSnapshot 白名单投影，stemMd 已经
   * studentStemMd 脱敏）；null = 遗留未冻结轮次或快照损坏，**不回填 live 题**
   * （与 questionVersion 的注释口径一致：版本对照数字仍可独立成立）。
   */
  question: attemptQuestionPublicSchema.nullable(),
  /** 该轮当题参考答案与详解；null = 未公布（fail-closed，见模块头安全口径） */
  release: notebookRoundReleaseSchema.nullable(),
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

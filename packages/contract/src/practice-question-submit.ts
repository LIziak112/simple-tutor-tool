import { z } from "zod";
import {
  attemptResultQuestionSchema,
  attemptSummarySchema,
  questionRevisionIdSchema,
  submitEvidenceDeclarationSchema,
} from "./attempt.ts";
import {
  practiceQuestionProgressSchema,
  practiceRestrictionReasonSchema,
  practiceWorkflowSchema,
} from "./practice-workflow.ts";

/**
 * M2 逐题提交与题级反馈契约（2026-10-22 计划 §6.1/§10.1–§10.4）：
 * - POST /api/student/attempts/:id/questions/:questionId/submit 的**新协议**
 *   请求体与回执（lesson 旧协议沿用 attempt.ts 的 lessonQuestionSubmit* 契约，
 *   服务端按请求形态分流，两套契约互不放宽）；
 * - GET /api/student/attempts/:id/questions/:questionId/feedback 的响应 data；
 * - 刷新当前题、回看已提交题、提交回执三者**共用同一个授权投影**
 *   （practiceQuestionFeedbackSchema，单一 schema 对象防漂移成两套）；
 * - 无秘密态绝不携带参考答案/详解/判定（§10.4 答案边界）；纯状态字段不夹带
 *   autoCorrect、得分或可反推答案的摘要（§6.1 白名单纪律）。
 * 本文件依赖 attempt.ts / practice-workflow.ts（不反向引用，无循环导入）；
 * 所有对外类型由 Zod 推导，禁止前后端各自抄写。
 */

/**
 * 单题授权反馈投影（提交回执 / 题级反馈读取 / 刷新当前题共用，判别二态
 * 而非可选堆叠——授权与待公布是互斥形态，不靠字段缺省表达）：
 * - released：**已授权**——本题已由服务端确认提交、本卷逐题反馈获准且当前
 *   教师规则允许释放（§10.4）。question 为整卷结果视图的单题同构形态
 *   （attemptResultQuestion：判定 autoCorrect/finalCorrect、参考答案 answers、
 *   详解 solutionMd；提交瞬间教师批改必空，之后重读随行）。stemMd 是作答时
 *   原文（含 [[答案]] 标记），服务端下发前一律经 studentStemMd 学生端投影
 *   包装（与 lesson 单题提交同一出口，不得各自手写）；
 * - not_submitted：该题尚未单题提交（无任何题目秘密；提交事实以
 *   questionProgress 的 submittedAt 为准）；
 * - pending_attempt：本题已提交，但本卷反馈节奏为交卷后统一公布
 *   （after_attempt）——待整卷收尾/公布后经既有结果视图或本端点读取；
 * - restricted：当前教师规则/历史协议不允许逐题反馈（教师收紧后已提交题
 *   重取同样落到本态，§5.4——已下发内容不宣称撤回，后续读取按当前 gate）。
 *   restrictionReason 复用 M1 practiceRestrictionReasonSchema，不造第二套。
 * 服务端按**读取时刻**的当前规则裁决状态（教师改设置立即生效）；同卷同题
 * 不同时刻的两次读取状态可以不同，不缓存旧投影正文原样重放。
 */
export const practiceQuestionFeedbackSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("released"),
      /** 本题授权结果（整卷结果单题同构；唯一携带答案解析的形态） */
      question: attemptResultQuestionSchema,
    })
    .strict(),
  z.object({ status: z.literal("not_submitted") }).strict(),
  z.object({ status: z.literal("pending_attempt") }).strict(),
  z
    .object({
      status: z.literal("restricted"),
      /** 受限原因（M1 既有枚举：教师交卷后/教师截止后/历史旧协议） */
      restrictionReason: practiceRestrictionReasonSchema,
    })
    .strict(),
]);

/**
 * POST /api/student/attempts/:id/questions/:questionId/submit 请求体
 * （M2 新协议普通逐题卷；strict、未知字段拒绝、缺省拒绝——新协议没有旧客户端
 * 兼容分支：缺 workflowVersion 的请求被服务端拒绝并提示刷新，不退回整卷
 * 无版本写入，§5.3）：
 * - workflowVersion：协议门禁，恒 1（zod literal，升级时整体失效）；
 * - workflowRevision：客户端所见 practiceWorkflow.revision（草稿视图/上次回执），
 *   服务端在提交事务内与 attempts.workflowRevision 比对，陈旧 409
 *   WORKFLOW_REVISION_STALE——工作流改动与首题提交的竞态凭它拒绝陈旧请求
 *   （§10.2 第 4 步、§10.3 末条；任一提交后节奏冻结，比对恒命中）；
 * - questionRevisionId：建卷下发的该题版本引用（responses 行 id），错版 409
 *   QUESTION_REVISION_STALE（与整卷/lesson 同口径）；
 * - expectedAnswerRevision：**学生答案**的预期服务器版本（草稿视图
 *   draftRevisions 的该题值），服务端在提交事务内与实际读取版本比较——
 *   questionRevisionId 只锚定题目版本，不能替代答案版本 CAS（§10.2）；
 * - submissionMutationId：幂等键（客户端 crypto.randomUUID）——结果未知时
 *   固定复用；同 id 同请求摘要重试返回同一提交事实，同 id 异摘要 409（§10.3）；
 * - evidence：本题证据声明，**必填**（frozen/none/missing 三态语义完整复用
 *   整卷 submitEvidenceDeclarationSchema，不重复定义；其内 questionId 须与
 *   路径一致，由服务端校验——与 lesson 单题提交同口径；新协议不提供缺省
 *   = 旧客户端的兼容放行，声明空稿必须显式 none/missing）。
 */
export const practiceQuestionSubmitRequestSchema = z
  .object({
    workflowVersion: z.literal(1),
    workflowRevision: z.number().int().nonnegative(),
    questionRevisionId: questionRevisionIdSchema,
    expectedAnswerRevision: z.number().int().nonnegative(),
    submissionMutationId: z.uuid(),
    evidence: submitEvidenceDeclarationSchema,
  })
  .strict();

/**
 * 逐题提交回执 data（M2 新协议；strict 白名单）：本题安全反馈 + 本题与全卷
 * 题级进度 + 最新 attempt 摘要 + 工作流裁决投影，四键之外不夹带得分/对错
 * 汇总（邻题对错不可反推，§6.1/§10.4——整卷汇总仍走既有结果视图）。
 * - feedback：共用授权投影——正常 per_question 授权下为 released；教师在该题
 *   事务提交后、响应投影前收紧的竞态下按当前 gate 返回受限态（回执不重放
 *   带答案的旧正文，§10.3），故此处允许全部四种状态；
 * - questionProgress：全卷题级进度白名单（M1 practiceQuestionProgress，
 *   含本题最新提交事实），与草稿视图/PATCH workflow 回执同口径；
 * - attempt：最新摘要（最后一题提交触发自动收尾后即为 submitted/graded）；
 * - practiceWorkflow：提交后的裁决投影（任一提交后 canChangeFeedback=false）。
 * 响应须带 Cache-Control: private, no-store（§10.1）。
 */
export const practiceQuestionSubmitDataSchema = z
  .object({
    feedback: practiceQuestionFeedbackSchema,
    questionProgress: z.array(practiceQuestionProgressSchema),
    attempt: attemptSummarySchema,
    practiceWorkflow: practiceWorkflowSchema,
  })
  .strict();

/**
 * GET /api/student/attempts/:id/questions/:questionId/feedback 响应 data
 * （M2 新增；strict）：仅承载共用授权投影本体——归属校验失败/作废/课程失权
 * 走既有错误码（403/404/409，不进 200 data）；工作流与全卷进度刷新经草稿
 * 视图，不在本端点复制第二份。feedback 与提交回执引用同一 schema 对象。
 * 响应须带 Cache-Control: private, no-store（§10.1）。
 */
export const practiceQuestionFeedbackDataSchema = z
  .object({
    feedback: practiceQuestionFeedbackSchema,
  })
  .strict();

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

/** 携带逐题提交回执的成功响应壳（M2 新协议） */
export const practiceQuestionSubmitOkSchema = apiOkExtend(
  practiceQuestionSubmitDataSchema,
);
/** 携带题级反馈的成功响应壳（M2 新增端点） */
export const practiceQuestionFeedbackOkSchema = apiOkExtend(
  practiceQuestionFeedbackDataSchema,
);

// ---------- 推断类型导出 ----------

/** 单题授权反馈（共用投影的判别联合） */
export type PracticeQuestionFeedback = z.infer<
  typeof practiceQuestionFeedbackSchema
>;
/** M2 新协议逐题提交请求体 */
export type PracticeQuestionSubmitRequest = z.infer<
  typeof practiceQuestionSubmitRequestSchema
>;
/** M2 逐题提交回执 */
export type PracticeQuestionSubmitData = z.infer<
  typeof practiceQuestionSubmitDataSchema
>;
/** M2 题级反馈响应 data */
export type PracticeQuestionFeedbackData = z.infer<
  typeof practiceQuestionFeedbackDataSchema
>;

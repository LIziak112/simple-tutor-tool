import { z } from "zod";
import { studentAnswerSchema } from "./grading.ts";

/**
 * 学习痕迹事件契约（T2.10 起为权威定义）：事件类型枚举、单条事件形状、
 * 批量上报请求与响应。依据：docs/技术架构与实施方案.md §5.5（学习痕迹采集：
 * 事件类型 / 5 秒批量 / sendBeacon / 离线 IndexedDB / 服务端计算每题有效用时）、
 * §5.2（events 表）、§5.3（lecture_expand：讲义折叠与逐步揭晓的展开上报）、
 * docs/开发任务清单.md T2.10。
 *
 * 时间戳约定：clientTs 为客户端毫秒时间戳（epoch ms 的正整数，前端 Date.now()）；
 * 服务端入库时补 serverTs（UTC ISO 字符串，§0.3 时间约定）。毫秒整数只出现在
 * 传输与计算层（focus/blur 区间运算需要毫秒精度），落库的 serverTs 仍是 ISO。
 *
 * 安全口径（AGENTS.md 第 3 条——事件接口也是学生端接口）：
 * - 事件 payload 只存元信息，不携带任何题目侧内容（答案/详解/提示正文）：
 *   - answer_change 的 from/to 是「学生自己输入的答案值」（不是标准答案），
 *     键名刻意避开 assertNoLeak 默认禁用的 answer/answers（from/to 不在集合内）；
 *   - hint_open 只存 index（第几条提示，不存提示内容）；
 *   - ink_stroke_batch 只存本批笔画数（不存笔迹数据本体，笔迹走 T2.8 通道）；
 *   - lecture_expand 只存讲义 id 与指令名/序号（不存指令内容）。
 * - 事件上报接口的响应只回 accepted 计数，任何错误信息不含题目侧内容。
 */

/** 事件类型（§5.5 全部 11 种；attempt 上下文 10 种 + 无 attempt 的 lecture_expand） */
export const learningEventTypeSchema = z.enum([
  "attempt_start",
  "question_view",
  "question_focus",
  "question_blur",
  "answer_change",
  "hint_open",
  "ink_stroke_batch",
  "page_hidden",
  "page_visible",
  "submit",
  "lecture_expand",
]);

/** 客户端毫秒时间戳（epoch ms 正整数） */
const clientTsSchema = z
  .number()
  .int()
  .positive({ message: "clientTs 必须是毫秒时间戳（正整数）" });

/** 题目 id（DSL 字符串，可能含中文/点/连字符） */
const questionIdSchema = z.string().min(1, "questionId 不能为空");

/** 进入答题页/开始一次作答会话（每次进入答题页一条） */
export const attemptStartEventSchema = z.object({
  type: z.literal("attempt_start"),
  clientTs: clientTsSchema,
});

/** 题目进入视口（每题首次进入报一次） */
export const questionViewEventSchema = z.object({
  type: z.literal("question_view"),
  clientTs: clientTsSchema,
  questionId: questionIdSchema,
});

/** 题目获得焦点（「当前聚焦题」= 最近交互的题，视口占比最大兜底，§5.5） */
export const questionFocusEventSchema = z.object({
  type: z.literal("question_focus"),
  clientTs: clientTsSchema,
  questionId: questionIdSchema,
});

/** 题目失去焦点（跨题切换时由前端显式补发，服务端也按隐式切换处理） */
export const questionBlurEventSchema = z.object({
  type: z.literal("question_blur"),
  clientTs: clientTsSchema,
  questionId: questionIdSchema,
});

/**
 * 答案变化（每次有效修改报一条；from/to 为该题上一次/本次的学生答案值，
 * 是学生自己的输入而非标准答案）。from 缺省 = 首次作答（无前值）；
 * to 缺省 = 清空（本地存草稿时可能先清后填，不强制）。
 */
export const answerChangeEventSchema = z.object({
  type: z.literal("answer_change"),
  clientTs: clientTsSchema,
  questionId: questionIdSchema,
  from: studentAnswerSchema.optional(),
  to: studentAnswerSchema.optional(),
});

/** 打开第 index 条提示（只存序号，提示内容按需下发是 T2.11 的事） */
export const hintOpenEventSchema = z.object({
  type: z.literal("hint_open"),
  clientTs: clientTsSchema,
  questionId: questionIdSchema,
  /** 提示序号（对齐 T1.8 指令 index：文档顺序编号，从 1 起；未编号为 0） */
  index: z.number().int().min(0),
});

/** 一批手写笔画结束（只存本批笔画数；笔迹本体走 T2.8 multipart 通道） */
export const inkStrokeBatchEventSchema = z.object({
  type: z.literal("ink_stroke_batch"),
  clientTs: clientTsSchema,
  questionId: questionIdSchema,
  /** 本批新增笔画数（页内每笔结束为 1；全屏退出等批量场景可 >1） */
  strokes: z.number().int().min(1),
});

/** 页面隐藏（visibilitychange → hidden；隐藏期间不计时，服务端口径） */
export const pageHiddenEventSchema = z.object({
  type: z.literal("page_hidden"),
  clientTs: clientTsSchema,
});

/** 页面重新可见（visibilitychange → visible） */
export const pageVisibleEventSchema = z.object({
  type: z.literal("page_visible"),
  clientTs: clientTsSchema,
});

/** 交卷（前端在 POST submit 之前上报；服务端计算用时的截止事件） */
export const submitEventSchema = z.object({
  type: z.literal("submit"),
  clientTs: clientTsSchema,
});

/**
 * 讲义展开（§5.3：例题解析折叠/逐步揭晓，每次展开都上报）。
 * 无 attempt 上下文（学生读讲义不一定在做题）→ 走 POST /api/student/events，
 * events 表该类行 attemptId/questionId 均为 null，归属信息在 payload 里。
 */
export const lectureExpandEventSchema = z.object({
  type: z.literal("lecture_expand"),
  clientTs: clientTsSchema,
  /** 讲义 id（lectures.id） */
  lectureId: z.string().min(1, "lectureId 不能为空"),
  /** 被展开的指令名（注册表主名：solution/fold/hint/step…） */
  directive: z.string().min(1, "directive 不能为空"),
  /** 该指令在文档中的顺序编号（T1.8 DirectiveProps.index） */
  index: z.number().int().min(0),
});

/** attempt 上下文事件（10 种；POST /api/student/attempts/:id/events 的元素） */
export const attemptEventSchema = z.discriminatedUnion("type", [
  attemptStartEventSchema,
  questionViewEventSchema,
  questionFocusEventSchema,
  questionBlurEventSchema,
  answerChangeEventSchema,
  hintOpenEventSchema,
  inkStrokeBatchEventSchema,
  pageHiddenEventSchema,
  pageVisibleEventSchema,
  submitEventSchema,
]);

/** 无 attempt 上下文事件（POST /api/student/events 的元素；目前只有 lecture_expand） */
export const lectureEventSchema = z.discriminatedUnion("type", [
  lectureExpandEventSchema,
]);

/** 全部 11 种事件的联合（供服务端入库与计算层使用） */
export const learningEventSchema = z.discriminatedUnion("type", [
  ...attemptEventSchema.options,
  ...lectureEventSchema.options,
]);

/** 批量上报的单次上限（§T2.10：≤200 条/次，超出 400） */
export const LEARNING_EVENTS_BATCH_MAX = 200;

/** POST /api/student/attempts/:id/events 请求体（1–200 条，逐条校验 type/payload） */
export const attemptEventBatchRequestSchema = z.object(
  {
    events: z
      .array(attemptEventSchema)
      .min(1, "events 至少 1 条")
      .max(LEARNING_EVENTS_BATCH_MAX, "每次最多上报 200 条事件"),
  },
  { message: "请求体需为 { events: […] }" },
);

/** POST /api/student/events 请求体（讲义等无 attempt 上下文的事件批量） */
export const lectureEventBatchRequestSchema = z.object(
  {
    events: z
      .array(lectureEventSchema)
      .min(1, "events 至少 1 条")
      .max(LEARNING_EVENTS_BATCH_MAX, "每次最多上报 200 条事件"),
  },
  { message: "请求体需为 { events: […] }" },
);

/** 批量上报成功响应 data（只回计数，绝不回显事件内容） */
export const learningEventBatchDataSchema = z.object({
  /** 本次落库的事件条数 */
  accepted: z.number().int().min(1),
});

// ---------- 推断类型导出 ----------

export type LearningEventType = z.infer<typeof learningEventTypeSchema>;
export type AttemptEvent = z.infer<typeof attemptEventSchema>;
export type LectureEvent = z.infer<typeof lectureEventSchema>;
export type LearningEvent = z.infer<typeof learningEventSchema>;
export type AttemptEventBatchRequest = z.infer<
  typeof attemptEventBatchRequestSchema
>;
export type LectureEventBatchRequest = z.infer<
  typeof lectureEventBatchRequestSchema
>;
export type LearningEventBatchData = z.infer<
  typeof learningEventBatchDataSchema
>;

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
 *   - lecture_expand 只存讲义 id 与指令名/序号（不存指令内容）；
 *   - T4.0a 新增事件同口径：id / 序号（headingIndex、index、step）/ 计数 /
 *     布尔 / 枚举（host、action），无一含内容（方案 §4.3 隐私对照）。
 * - 事件上报接口的响应只回 accepted 计数，任何错误信息不含题目侧内容。
 * - studentId / lectureId 归属列由**服务端**从会话 / payload 顶层提取落库
 *   （方案 §4.2，防伪造）——契约层不收 studentId 字段（多余键被 Zod 剥离）。
 */

/**
 * 事件类型（§5.5 既有 11 种零变化 + T4.0a 新增 11 种，共 22 种）：
 * - attempt 上下文（既有 10 种 + T4.0a 的交互族 question/result 宿主、
 *   ink_edit_batch / ink_fullscreen、环境族 net / idle）；
 * - 无 attempt 上下文（讲义域：既有 lecture_expand + T4.0a 的环境族讲义版、
 *   位置族、交互族 lecture 宿主）。
 * 语义只增不改（Phase4 §0.2 / 方案 §4.1-1）：既有事件的 payload 结构与
 * activeSec 计算口径零变化；新事件对不产生它们的旧客户端零影响。
 */
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
  // ---------- T4.0a 新增（环境族 / 位置族 / 交互族，方案 §4.3） ----------
  "lecture_visible",
  "lecture_hidden",
  "net_offline",
  "net_online",
  "idle_start",
  "idle_end",
  "lecture_section_focus",
  "lecture_toc_jump",
  "directive_interact",
  "ink_edit_batch",
  "ink_fullscreen",
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
 *
 * T4.0a（方案 §6 决策 1）：schema 与语义零变化继续接收（PWA 的 SW 缓存可能
 * 让旧前端多活几天），**新客户端不再产生**（改发 directive_interact）；读侧把
 * 存量行归一为 directive_interact{action:"open"}。
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

// ---------- T4.0a 新增事件（方案 §4.3 三族；payload 全部为 id/序号/计数/布尔/枚举，无一含内容） ----------

/** 讲义 id（讲义域事件 payload 顶层字段） */
const lectureIdSchema = z.string().min(1, "lectureId 不能为空");

/**
 * 阅读会话标识：每次讲义页加载生成的随机串（不含任何内容）。解决双标签页
 * 同开、iPad Safari 被系统回收重开导致的区间交错——聚合按 viewId 配对、
 * 再对同一学生 × 讲义的区间求并集（方案 §4.3.1）。
 */
const viewIdSchema = z.string().min(1, "viewId 不能为空").max(64);

/**
 * 讲义页可见 / 隐藏（lecture scope 的 page_visible/page_hidden 讲义版，
 * 队列层注入）：进入讲义页（初始可见）报 lecture_visible，切后台/离开报
 * lecture_hidden。visibilitychange 与 pagehide 双兜底**允许双发 hidden**
 * （先到的先入队），服务端聚合按「重复 hidden 忽略」容错（与 active-time
 * 规则 3 同构），前端不做防重锁（§5.0-A4）。
 */
export const lectureVisibleEventSchema = z.object({
  type: z.literal("lecture_visible"),
  clientTs: clientTsSchema,
  lectureId: lectureIdSchema,
  viewId: viewIdSchema,
});

export const lectureHiddenEventSchema = z.object({
  type: z.literal("lecture_hidden"),
  clientTs: clientTsSchema,
  lectureId: lectureIdSchema,
  viewId: viewIdSchema,
});

/**
 * 网络断开 / 恢复标记（两 scope 均注入，队列层 window online/offline 驱动）。
 * 口径（§5.0-A3，写死在此防误读）：navigator.onLine 只反映网络接口连接
 * （连上路由器即 online，**不代表服务器可达**）——offlineShare 语义 =
 * 「设备联网状态」，与学生顶栏三态所见一致，这是有意选择不是缺陷；
 * 服务不可达的时段不标 offline。scope 创建时若已离线主动补一条
 * net_offline（离线打开 PWA 壳没有翻转事件可听）。
 */
export const netOfflineEventSchema = z.object({
  type: z.literal("net_offline"),
  clientTs: clientTsSchema,
});

export const netOnlineEventSchema = z.object({
  type: z.literal("net_online"),
  clientTs: clientTsSchema,
});

/**
 * 空闲开始 / 结束（两 scope 均注入，队列层按「上次活动时间戳」惰性判定，
 * 不依赖 interval 心跳——iOS 后台 timer 被限 1Hz/挂起，靠心跳必错，§5.0-A2）。
 * 阈值分域（方案 §6 决策 2）：attempt 90s / lecture 300s（阅读是零交互行为，
 * 秒级阈值会系统性低估阅读时长）；每个空闲期只一对。只供新指标扣减，
 * **不进 activeSec 计算**（既有 26 条时间规则用例锁定口径零变化）。
 */
export const idleStartEventSchema = z.object({
  type: z.literal("idle_start"),
  clientTs: clientTsSchema,
});

export const idleEndEventSchema = z.object({
  type: z.literal("idle_end"),
  clientTs: clientTsSchema,
});

/**
 * 讲义分节聚焦（页面层 hook 注入）：「当前阅读节」切换时一条，口径与
 * 「当前聚焦题 = 视口占比最大」对称；替代滚动深度（折叠架构下百分比会倒退，
 * 方案 §6）。事件量 = 标题数，节流天然满足。
 */
export const lectureSectionFocusEventSchema = z.object({
  type: z.literal("lecture_section_focus"),
  clientTs: clientTsSchema,
  lectureId: lectureIdSchema,
  /** H2/H3 目录序号（0 起，与前端 extractOutline 列表下标同源；不含标题文字） */
  headingIndex: z.number().int().min(0),
});

/** 目录跳转（页面层目录点击注入）；headingIndex 口径同 lecture_section_focus */
export const lectureTocJumpEventSchema = z.object({
  type: z.literal("lecture_toc_jump"),
  clientTs: clientTsSchema,
  lectureId: lectureIdSchema,
  headingIndex: z.number().int().min(0),
});

/**
 * 指令交互统一事件（组件层传感器 → 页面层入队，方案 §4.3.3）：一个交互一个
 * 事件、指标在服务端拼；name 用注册表主名（别名已归一），新增指令自动获得
 * 采集能力。action：open=收起→展开、close=展开→收起、reveal=steps「显示下一步」。
 *
 * **两套编号必须分清（§5.0-B8，聚合只用容器 index + step）**：
 * - index = DirectiveProps.index，**文档全局指令序号**（step 指令自身也有）；
 * - step = 容器内步序号（第几步，从 1 起），仅 action=reveal 时携带，
 *   且 reveal 仅 host=lecture（答题页/结果页无 steps 容器语义）。
 */
const directiveNameSchema = z.string().min(1, "name 不能为空");
const directiveIndexSchema = z.number().int().min(0);

/** host=lecture：讲义域（讲义端点接收） */
export const directiveInteractLectureToggleEventSchema = z.object({
  type: z.literal("directive_interact"),
  clientTs: clientTsSchema,
  host: z.literal("lecture"),
  lectureId: lectureIdSchema,
  name: directiveNameSchema,
  index: directiveIndexSchema,
  action: z.enum(["open", "close"]),
});

export const directiveInteractLectureRevealEventSchema = z.object({
  type: z.literal("directive_interact"),
  clientTs: clientTsSchema,
  host: z.literal("lecture"),
  lectureId: lectureIdSchema,
  name: directiveNameSchema,
  index: directiveIndexSchema,
  action: z.literal("reveal"),
  /** 容器内步序号（从 1 起）；与文档全局 index 是两套编号，见上 */
  step: z.number().int().min(1),
});

/** host=question：答题页提示解锁（attempt 端点接收；与 hint_open 服务端直记一一配对） */
export const directiveInteractQuestionEventSchema = z.object({
  type: z.literal("directive_interact"),
  clientTs: clientTsSchema,
  host: z.literal("question"),
  questionId: questionIdSchema,
  name: directiveNameSchema,
  index: directiveIndexSchema,
  action: z.enum(["open", "close"]),
});

/** host=result：结果页复盘（attempt 端点接收；补齐「错后有没有看解析」缺口） */
export const directiveInteractResultEventSchema = z.object({
  type: z.literal("directive_interact"),
  clientTs: clientTsSchema,
  host: z.literal("result"),
  attemptId: z.string().min(1, "attemptId 不能为空"),
  questionId: questionIdSchema,
  name: directiveNameSchema,
  index: directiveIndexSchema,
  action: z.enum(["open", "close"]),
});

/** 讲义域 directive_interact（open/close 与 reveal 两形态） */
export const directiveInteractLectureEventSchema = z.discriminatedUnion(
  "action",
  [
    directiveInteractLectureToggleEventSchema,
    directiveInteractLectureRevealEventSchema,
  ],
);

/** directive_interact 全量联合（按 host 分支；reveal 仅 lecture 且带 step，§5.0-B8） */
export const directiveInteractEventSchema = z.discriminatedUnion("host", [
  directiveInteractLectureEventSchema,
  directiveInteractQuestionEventSchema,
  directiveInteractResultEventSchema,
]);

/**
 * 手写编辑批次（橡皮/撤销/重做/清空的聚合计数，与 ink_stroke_batch 同一
 * 防抖窗口聚合，页面层注入）：四个计数一条事件，杜绝逐操作上报。
 */
export const inkEditBatchEventSchema = z.object({
  type: z.literal("ink_edit_batch"),
  clientTs: clientTsSchema,
  questionId: questionIdSchema,
  /** 本批橡皮（整笔）次数 */
  erase: z.number().int().min(0),
  /** 本批撤销次数 */
  undo: z.number().int().min(0),
  /** 本批重做次数 */
  redo: z.number().int().min(0),
  /** 本批清空次数 */
  clear: z.number().int().min(0),
});

/** 手写全屏进出（一个事件带布尔，不拆 enter/exit；页面层注入） */
export const inkFullscreenEventSchema = z.object({
  type: z.literal("ink_fullscreen"),
  clientTs: clientTsSchema,
  questionId: questionIdSchema,
  on: z.boolean(),
});

/**
 * attempt 上下文事件（POST /api/student/attempts/:id/events 的元素）：
 * 既有 10 种 + T4.0a 增收（方案 §4.2）：交互族 host=question/result、
 * ink_edit_batch、ink_fullscreen、环境族 net / idle（lecture_visible/hidden
 * 与 host=lecture 的 directive_interact 不在本端点——讲义域走 POST /events）。
 *
 * 外层用 z.union 而非 discriminatedUnion：directive_interact 的 question /
 * result 两形态共用同一 type 字面量（Zod 4 判别联合不允许重复判别值），
 * 按 host 的精确分支在 directiveInteractEventSchema（discriminatedUnion）。
 */
export const attemptEventSchema = z.union([
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
  directiveInteractQuestionEventSchema,
  directiveInteractResultEventSchema,
  inkEditBatchEventSchema,
  inkFullscreenEventSchema,
  netOfflineEventSchema,
  netOnlineEventSchema,
  idleStartEventSchema,
  idleEndEventSchema,
]);

/**
 * 无 attempt 上下文事件（POST /api/student/events 的元素）：
 * T4.0a 起接收讲义域事件组（方案 §4.2）：环境族（lecture_visible/hidden、
 * net、idle）+ 位置族（section_focus / toc_jump）+ 交互族 host=lecture；
 * **lecture_expand 继续接收**（旧前端 SW 缓存兼容，语义零变化）。
 * 外层 z.union 的原因同 attemptEventSchema（reveal 与 open/close 共用 type）。
 */
export const lectureEventSchema = z.union([
  lectureExpandEventSchema,
  lectureVisibleEventSchema,
  lectureHiddenEventSchema,
  lectureSectionFocusEventSchema,
  lectureTocJumpEventSchema,
  directiveInteractLectureToggleEventSchema,
  directiveInteractLectureRevealEventSchema,
  netOfflineEventSchema,
  netOnlineEventSchema,
  idleStartEventSchema,
  idleEndEventSchema,
]);

/** 全部 22 种事件的联合（供服务端入库与计算层使用） */
export const learningEventSchema = z.union([
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
/** 讲义域 directive_interact（open/close 与 reveal 两形态的联合） */
export type DirectiveInteractLectureEvent = z.infer<
  typeof directiveInteractLectureEventSchema
>;
/** directive_interact 全量事件（host=lecture|question|result） */
export type DirectiveInteractEvent = z.infer<
  typeof directiveInteractEventSchema
>;
export type AttemptEventBatchRequest = z.infer<
  typeof attemptEventBatchRequestSchema
>;
export type LectureEventBatchRequest = z.infer<
  typeof lectureEventBatchRequestSchema
>;
export type LearningEventBatchData = z.infer<
  typeof learningEventBatchDataSchema
>;

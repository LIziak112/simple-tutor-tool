import { z } from "zod";

/**
 * 题内活动用时（个人学习迭代模块 2 第二刀，2026-11-09）——学习者面的逐题用时
 * 口径，与考试时钟（限时 / 截止）分开显示，也与教师面既有 `activeSec`
 * （焦点口径：聚焦即计时）并存：旧统计保留原口径，新口径单独标版本号。
 *
 * v1 口径（服务端按原始事件序列现算，不存新列、不信任客户端汇总）：
 * - **有动作才归题**：一次聚焦时段里出现过题级动作（答案变更 / 笔迹批 / 打开
 *   提示 / 逐题提交 / 题内指令交互）才计 activeSec；只看过没动作的时段计
 *   observedSec（「可观察到的动作」，不算作答）；
 * - **页面隐藏与空闲不计**：page_hidden→page_visible、idle_start→idle_end 区间
 *   从时段中扣除；
 * - **多端重叠不归属**：同一作答在两台设备 / 两个标签页同时聚焦不同题的重叠
 *   时段计 unattributedSec，不归任何题；同时聚焦同一题只算一次；
 * - **离线补发去重**：完全相同的事件（类型 / 时刻 / 题 / 会话）只算一条；
 * - **交卷即全卷截止**：按服务端接收时刻比较，真正交卷后到达的所有会话事件均不计；
 *   失败或中止的客户端 submit 只结束当次聚焦。缺少服务端交卷时刻时才退回首个 submit；
 * - **服务端直记的动作并入会话**：question_submit / hint_open 由服务端落库、
 *   服务器时钟、没有会话标识，按「最近聚焦该题的会话」归入，只把那次聚焦标为
 *   有动作，不另开时段、不与客户端时钟的事件混排；
 * - **信息不足如实标**：没有任何事件的题不出现在 byQuestion（前端标「无可用
 *   记录」）；只有进入视野（question_view）没聚焦的题 viewed=true、时长 0。
 */
export const ATTEMPT_ACTIVITY_VERSION = 1;

export const questionActivitySchema = z.object({
  /** 有题级动作的前台聚焦时段合计（秒） */
  activeSec: z.number().int().min(0),
  /** 只看过、没动作的前台聚焦时段合计（秒） */
  observedSec: z.number().int().min(0),
  /** 题级动作条数（答案变更 / 笔迹批 / 提示 / 逐题提交 / 指令交互） */
  actions: z.number().int().min(0),
  /** 进入过视野（question_view 或任一聚焦 / 动作） */
  viewed: z.boolean(),
});
export type QuestionActivity = z.infer<typeof questionActivitySchema>;

export const attemptActivitySchema = z.object({
  version: z.literal(ATTEMPT_ACTIVITY_VERSION),
  byQuestion: z.record(z.string(), questionActivitySchema),
  /** 全部题 activeSec 之和（秒） */
  activeSecTotal: z.number().int().min(0),
  /** 全部题 observedSec 之和（秒） */
  observedSecTotal: z.number().int().min(0),
  /** 多端同时聚焦不同题的重叠时段（秒），不归任何题 */
  unattributedSec: z.number().int().min(0),
  /** 参与计算的作答页会话数（1 = 单端；缺会话标识的旧事件合并为一组） */
  sessions: z.number().int().min(1),
  /**
   * 同一时刻同时在前台聚焦的会话数峰值（1 = 从未同开；刷新 / 换设备先后打开
   * 的会话不算同开）——「N 端同开」的展示口径（审查 #100-04）。
   */
  concurrentSessionsMax: z.number().int().min(1),
});
export type AttemptActivity = z.infer<typeof attemptActivitySchema>;

/** 计入「题级动作」的事件类型（有 questionId 的交互事件；focus/view 不算） */
export const QUESTION_ACTIVITY_ACTION_TYPES: ReadonlySet<string> = new Set([
  "answer_change",
  "ink_stroke_batch",
  "ink_edit_batch",
  "hint_open",
  "question_submit",
  "directive_interact",
]);

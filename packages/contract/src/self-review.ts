import { z } from "zod";

// 仅类型导入（编译期擦除，不构成运行时循环）；attempt.ts 反向值引用本文件
import type { TeacherMark } from "./attempt.ts";
import type { Question, QuestionType } from "./content.ts";

/**
 * 自评与判定状态契约（TT-05a 域③，决策记录 §5.5 定稿，QM-01 落地）。
 *
 * 三源分立（D7）：autoCorrect / teacherMark / 自评记录各自独立存储，
 * **禁止一个布尔兼任所有来源**；finalCorrect 持久语义冻结为
 * teacherMark ?? autoCorrect（教师权威判定线，D3 既有口径），学生侧另设
 * 有效判定投影 effectiveVerdict（三层回落：教师 > 自评 > 自动）——两条线
 * 不混用：graded 状态、教师批改队列消费 finalCorrect/教师待处理谓词，
 * **不被自评推动**（自评完成不改变 graded 触发、不是可信成绩）。
 *
 * 自评不写 teacherMark、不写 finalCorrect：自评是本人声明，不能伪装成教师
 * 或自动判定。服务端校验链与路由落地在 TT-09（QM-10）；本文件是契约层
 * 单一出处（schema + 纯推导函数），发布顺序见 §5.5.1。
 *
 * 依赖方向（TT-09b 起）：本文件不依赖 attempt.ts（selfReviewDataSchema
 * 因 attemptScoreSummarySchema 移驻 attempt.ts，消除循环导入），attempt.ts
 * 反向引用本文件的记录 schema 与策略枚举——结果单题投影携带自评状态
 * （QM-11）。
 */

/** 判定来源三值（AI 评判接入时另行扩展，本轮不预设——设计方案 §6.2） */
export const verdictSourceSchema = z.enum(["auto", "teacher", "self"]);
export type VerdictSource = z.infer<typeof verdictSourceSchema>;

/**
 * 自评状态（合并基线共享 schema：v2 学习记录 learning-record 的 reviewSource
 * 复用其 source 三值；QM-11 重写侧未再使用，按 LR 合并基线保留）。
 */
export const selfReviewStateSchema = z
  .object({
    mark: z.boolean().nullable(),
    revision: z.number().int().min(0),
    reviewedAt: z.string().nullable(),
    source: z
      .enum(["teacher", "self", "automatic"])
      .nullable()
      .describe("判定来源；学生自评不能作为独立完成或客观能力的证明"),
    canReview: z.boolean(),
    awaitingSelfReview: z.boolean(),
  })
  .strict();
export type SelfReviewState = z.infer<typeof selfReviewStateSchema>;

/**
 * 自评 verdict：correct/wrong 是判断；undecided = 撤回自评（回到暂不判断）。
 * 「暂不判断」不是一次写入——undecided 是清除自评记录的幂等写（revision
 * 递增）；从未自评的行天然处于暂不判断。
 */
export const selfReviewVerdictSchema = z.enum([
  "correct",
  "wrong",
  "undecided",
]);
export type SelfReviewVerdict = z.infer<typeof selfReviewVerdictSchema>;

/** 自评记录（只存实际判断，correct/wrong；at 为 UTC ISO） */
export const selfReviewRecordSchema = z.object({
  verdict: z.enum(["correct", "wrong"]),
  at: z.string().min(1),
  /** 修订版本（CAS 基线；清除亦递增） */
  revision: z.number().int().nonnegative(),
});
export type SelfReviewRecord = z.infer<typeof selfReviewRecordSchema>;

/**
 * POST /api/student/attempts/:id/questions/:questionId/self-review 请求体
 * （TT-09 落地路由；沿用本站幂等回执先例 routes/student.ts:167）。
 * 服务端依次裁决：登录本人 → 行属本 attempt → 行已提交 → 公布 gate
 * （resolvePracticeQuestionFeedbackState=released，单一出处复用）→ 教师未判
 * （已判 409 SELF_REVIEW_TEACHER_MARKED）→ baseRevision CAS → 事务写入。
 */
export const selfReviewRequestSchema = z.object({
  verdict: selfReviewVerdictSchema,
  /** 自评记录基线（CAS；首次自评为 0） */
  baseRevision: z.number().int().nonnegative(),
  /** 幂等键（网络重试同键不重复写） */
  mutationId: z.string().uuid(),
});
export type SelfReviewRequest = z.infer<typeof selfReviewRequestSchema>;

/** 有效判定投影（学生侧展示/记录/错题本消费；携带来源徽章） */
export const effectiveVerdictSchema = z.object({
  source: verdictSourceSchema,
  value: z.boolean(),
});
export type EffectiveVerdict = z.infer<typeof effectiveVerdictSchema>;

/** 409 SELF_REVIEW_REVISION_CONFLICT 附 _current：最新自评与 revision */
export const selfReviewConflictCurrentSchema = z.object({
  selfReview: selfReviewRecordSchema.nullable(),
  revision: z.number().int().nonnegative(),
});
export type SelfReviewConflictCurrent = z.infer<
  typeof selfReviewConflictCurrentSchema
>;

// ---------- 纯推导函数（服务端 TT-09 消费的单一出处） ----------

/**
 * finalCorrect 的持久语义（D3/D7 冻结，提交/批改事务写入）：
 * teacherMark ?? autoCorrect。教师清除 = 撤回 teacherMark → 本函数回落
 * autoCorrect（null 即 null）；**自评不进本函数**（不写 finalCorrect）。
 */
export function finalCorrectOf(
  teacherMark: TeacherMark | null,
  autoCorrect: boolean | null,
): boolean | null {
  if (teacherMark === "correct") return true;
  if (teacherMark === "wrong") return false;
  return autoCorrect;
}

/**
 * 学生侧有效判定投影（§5.5.2/§5.5.4）：teacherMark ?? selfReview ?? autoCorrect
 * 三层回落（教师 > 自评 > 自动），全无返回 null（未判断）。
 * 教师清除后自评恢复生效（回落表 ✱ 行）；scoreFinal 等「教师权威口径」继续
 * 消费 finalCorrect，与本投影分开。
 */
export function effectiveVerdictOf(
  autoCorrect: boolean | null,
  teacherMark: TeacherMark | null,
  selfReview: SelfReviewRecord | null,
): EffectiveVerdict | null {
  if (teacherMark === "correct") return { source: "teacher", value: true };
  if (teacherMark === "wrong") return { source: "teacher", value: false };
  if (selfReview?.verdict === "correct") return { source: "self", value: true };
  if (selfReview?.verdict === "wrong") return { source: "self", value: false };
  if (autoCorrect !== null) return { source: "auto", value: autoCorrect };
  return null;
}

/**
 * 单题推导状态机（§5.5.3 表；服务端 resolveSelfReviewState / pendingMark 谓词
 * 共用，TT-09 落地——完成态单源纪律同 phaseOfRows，不各写 sourceType 分支）：
 * - not_submitted：行未提交；
 * - pending_release：已提交未公布（不显示答案、无自评入口；教师可读可批）；
 * - teacher_judged：教师判定（优先于自动）；
 * - auto_judged：自动判定（旧客观题，现状不变）；
 * - self_pending：有参考答案、未自评——待自评，**不入教师必批队列**；
 * - self_reviewed：已自评（可修正）；
 * - teacher_pending：无参考答案（manual_only）且教师未判——判定来源枯竭，
 *   **进必批队列**（唯一判定出口是教师）。
 *
 * 批改状态不阻止提交完成：self_pending/teacher_pending 都不阻塞交卷、回看、
 * 订正与记录——「完成作答」与「已判断」独立（设计方案 §1）。hasReference 的
 * 行级判定 = gradingPolicy === "reference_self"（§5.6 衔接：行上直接可判，
 * 不必反解快照 answers）。
 */
export type SelfReviewQuestionState =
  | "not_submitted"
  | "pending_release"
  | "teacher_judged"
  | "auto_judged"
  | "self_pending"
  | "self_reviewed"
  | "teacher_pending";

export interface SelfReviewStateInput {
  readonly submitted: boolean;
  /** 公布 gate 四态是否为 released（resolvePracticeQuestionFeedbackState 单一出处） */
  readonly released: boolean;
  readonly autoCorrect: boolean | null;
  readonly teacherMark: TeacherMark | null;
  readonly selfReview: SelfReviewRecord | null;
  readonly hasReference: boolean;
}

export function resolveSelfReviewState(
  input: SelfReviewStateInput,
): SelfReviewQuestionState {
  if (!input.submitted) return "not_submitted";
  if (!input.released) return "pending_release";
  if (input.teacherMark !== null) return "teacher_judged";
  if (input.autoCorrect !== null) return "auto_judged";
  if (input.hasReference) {
    return input.selfReview === null ? "self_pending" : "self_reviewed";
  }
  return "teacher_pending";
}

/** 教师待处理谓词（§5.5.3：必批队列的唯一定义） */
export function isTeacherPendingState(state: SelfReviewQuestionState): boolean {
  return state === "teacher_pending";
}

// ---------- 新作答策略冻结（§5.6，D11：判分策略按 response 行冻结，不全局改 grade） ----------

/** 行级判分策略（responses.gradingPolicy，可空列；NULL=旧行旧语义） */
export const gradingPolicySchema = z.enum([
  "auto",
  "reference_self",
  "manual_only",
]);
export type GradingPolicy = z.infer<typeof gradingPolicySchema>;

/**
 * 开卷冻结规则（§5.6 表）：新建 attempt 每一行按**题目快照内容**写入策略——
 * 旧客观题恒 auto；主观题型按「有参考答案」二分（有=reference_self：grade 恒
 * null 不进 autoCorrect，公布后开放自评；无=manual_only：grade 恒 null，教师
 * 待处理）。判分策略迁移与发布开关解耦（迁移加列可空，旧行 NULL 不依赖开关；
 * 新策略写入只发生在开关开启后导入的题目开卷时）。服务端写入在 QM-06（TT-07
 * 冻结闭包）接线；本函数是单一出处。
 */
export function gradingPolicyOf(
  question: Pick<Question, "type" | "answers">,
): GradingPolicy {
  switch (question.type) {
    case "judge":
    case "choice":
    case "multi":
      return "auto";
    case "fill":
    case "solve":
    case "apply":
    case "find-error":
    case "response":
    case "matching":
    case "ordering":
      return question.answers === undefined ? "manual_only" : "reference_self";
  }
}

/**
 * 行级判分语义读取规则（单一出处，TT-09/QM-10 消费）：
 * - 新行按冻结值直读（gradingPolicy 非 null）；
 * - 旧行 NULL 按**题型能力表旧语义**解释——历史不重算、不重释（禁止全局改
 *   grade 后意外重释历史）：judge/choice/multi 走既有自动判定；fill 恒 null
 *   进待批（2026-10-02 决策）；solve/apply/find-error 走 final 等价比较
 *   （新开卷行自本契约起冻结为 reference_self，此后不再自动比较）；
 * - 新题型行 NULL 只可能是异常数据（开卷即冻结）：兜底 manual_only——
 *   判定来源枯竭，唯一出口是教师，不伪造自动判定。
 */
export type RowGradingSemantics =
  | { readonly kind: "auto" }
  | { readonly kind: "reference_self" }
  | { readonly kind: "manual_only" }
  | { readonly kind: "legacy_fill_manual" }
  | { readonly kind: "legacy_final_equivalence" };

export function resolveRowGradingSemantics(
  gradingPolicy: GradingPolicy | null,
  snapshotType: QuestionType,
): RowGradingSemantics {
  if (gradingPolicy !== null) return { kind: gradingPolicy };
  switch (snapshotType) {
    case "judge":
    case "choice":
    case "multi":
      return { kind: "auto" };
    case "fill":
      return { kind: "legacy_fill_manual" };
    case "solve":
    case "apply":
    case "find-error":
      return { kind: "legacy_final_equivalence" };
    case "response":
    case "matching":
    case "ordering":
      return { kind: "manual_only" };
  }
}

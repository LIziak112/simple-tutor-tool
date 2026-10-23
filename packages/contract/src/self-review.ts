import { z } from "zod";

import {
  attemptScoreSummarySchema,
  teacherMarkSchema,
  type TeacherMark,
} from "./attempt.ts";

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
 */

/** 判定来源三值（AI 评判接入时另行扩展，本轮不预设——设计方案 §6.2） */
export const verdictSourceSchema = z.enum(["auto", "teacher", "self"]);
export type VerdictSource = z.infer<typeof verdictSourceSchema>;

/**
 * 自评 verdict：correct/wrong 是判断；undecided = 撤回自评（回到暂不判断）。
 * 「暂不判断」不是一次写入——undecided 是清除自评记录的幂等写（revision
 * 递增）；从未自评的行天然处于暂不判断。
 */
export const selfReviewVerdictSchema = z.enum(["correct", "wrong", "undecided"]);
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

/** 自评响应 data：本题有效判定 + 卷汇总刷新（汇总口径沿 attemptScoreSummary） */
export const selfReviewDataSchema = z.object({
  selfReview: selfReviewRecordSchema.nullable(),
  effective: effectiveVerdictSchema.nullable(),
  summary: attemptScoreSummarySchema,
});

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
  if (selfReview?.verdict === "correct")
    return { source: "self", value: true };
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
export function isTeacherPendingState(
  state: SelfReviewQuestionState,
): boolean {
  return state === "teacher_pending";
}

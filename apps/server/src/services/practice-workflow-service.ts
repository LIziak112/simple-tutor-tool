import {
  type AssignmentAnswerRelease,
  type AttemptSource,
  type PracticeFeedbackMode,
  type PracticeRestrictionReason,
  type PracticeWorkflow,
  practiceWorkflowSchema,
  type TeacherPracticeFeedbackPolicy,
} from "@tutor/contract";

/**
 * 学生端做题反馈节奏纯裁决器（M1a，2026-10-22 计划 §5/§6.1）：
 * 不读库、不开事务——输入由调用方（M1b 建卷/读侧服务）组装，输出经
 * practiceWorkflowSchema 校验的投影（输出不能冒充授权依据，授权事实
 * 仍以服务端持久化行为准）。lesson 来源不适用本规则（保留独立适配）。
 */

/** 普通来源白名单（lesson 独立适配；运行时未知来源一律抛错 fail closed） */
export type PracticeWorkflowSource = Exclude<AttemptSource, "lesson">;

const PRACTICE_WORKFLOW_SOURCES: readonly PracticeWorkflowSource[] = [
  "course",
  "assignment",
  "wrong",
];

/**
 * 已存卷的工作流事实（feedbackMode/revision 复用契约投影类型，不手抄）。
 * - null：历史旧协议卷（无工作流版本）——恒整卷旧语义，不可升级；
 * - 对象：续作——保持 stored.feedbackMode（教师放宽不改写已选节奏）。
 */
export interface StoredPracticeWorkflow
  extends Pick<PracticeWorkflow, "feedbackMode" | "revision"> {
  /** 本卷是否已有任一题级提交事实（首题提交后节奏冻结） */
  hasSubmittedQuestion: boolean;
  /** 本卷是否已整卷提交 */
  attemptSubmitted: boolean;
}

/** assignment 来源的教师授权（作业行两字段，同事务更新） */
export interface AssignmentFeedbackGrant {
  answerRelease: AssignmentAnswerRelease;
  allowPerQuestionFeedback: boolean;
}

/** lifecycle 与来源无关的公共输入（调用方组装，M1b 建卷/读侧负责） */
interface ResolvePracticeWorkflowCommon {
  sourceType: PracticeWorkflowSource;
  /** 当前时刻（保留给读侧截止判定；本裁决不据 now 放宽任何限制） */
  now?: string;
  /** 可公开的截止时间（仅复制到 releaseAt，不携带答案） */
  dueAt?: string | null;
  /** assignment 来源必填（缺省抛错，不猜测授权） */
  assignment?: AssignmentFeedbackGrant | null;
  /** course/wrong 来源的教师默认策略（未配置按 student_choice） */
  teacherPolicy?: TeacherPracticeFeedbackPolicy | null;
}

/**
 * 新建新协议卷：按教师规则 + 学生选择/缺省推荐裁决；不得携带 stored
 * （运行时携带即抛错，防伪造已存事实骗授权）。
 * 调用样例：{ sourceType: "course", lifecycle: "new", studentChoice: "per_question" }
 */
export interface ResolveNewPracticeWorkflowInput
  extends ResolvePracticeWorkflowCommon {
  lifecycle: "new";
  stored?: never;
  /** 学生本次明确选择 / 持久偏好（新建卷用；不放宽教师限制） */
  studentChoice?: PracticeFeedbackMode | null;
}

/**
 * 已存卷（续作或历史）：必须显式给 stored 对象或 null（缺省/非法抛错）；
 * 不接受 studentChoice——不得改写既存事实。
 * 调用样例（续作）：{ sourceType: "course", lifecycle: "existing", stored: { feedbackMode: "per_question", revision: 0, hasSubmittedQuestion: false, attemptSubmitted: false } }
 * 调用样例（legacy）：{ sourceType: "assignment", lifecycle: "existing", stored: null, assignment: {...} }
 */
export interface ResolveExistingPracticeWorkflowInput
  extends ResolvePracticeWorkflowCommon {
  lifecycle: "existing";
  stored: StoredPracticeWorkflow | null;
  studentChoice?: never;
}

export type ResolvePracticeWorkflowInput =
  | ResolveNewPracticeWorkflowInput
  | ResolveExistingPracticeWorkflowInput;

/** 是否允许逐题反馈（教师规则维度，与学生已选节奏无关） */
function perQuestionAllowed(input: ResolvePracticeWorkflowInput): boolean {
  if (input.sourceType === "assignment") {
    const grant = input.assignment;
    if (!grant) {
      throw new Error("assignment 来源缺少反馈授权事实（fail closed）");
    }
    // after_due + true 为写入侧已拒绝的异常组合；读侧 fail closed 禁止逐题
    return (
      grant.answerRelease === "on_submit" && grant.allowPerQuestionFeedback
    );
  }
  // 自由练习：教师未配置缺省 student_choice（仅对新普通练习生效）
  return (input.teacherPolicy ?? "student_choice") === "student_choice";
}

export function resolvePracticeWorkflow(
  input: ResolvePracticeWorkflowInput,
): PracticeWorkflow {
  // 来源白名单 fail closed：未知来源（含 lesson）不进普通规则，不猜测语义
  if (!PRACTICE_WORKFLOW_SOURCES.includes(input.sourceType)) {
    throw new Error(
      `来源 ${String(input.sourceType)} 不适用普通练习工作流裁决（白名单仅 course/assignment/wrong）`,
    );
  }

  // lifecycle 判别：缺省/非法一律拒绝；新卷与已存卷必须显式区分，
  // 不能靠 stored 缺省默认按新建授权（运行时绕过 TS 同样拦截）
  const lifecycle = (input as { lifecycle?: unknown }).lifecycle;
  if (lifecycle !== "new" && lifecycle !== "existing") {
    throw new Error("lifecycle 必须显式为 new 或 existing（fail closed）");
  }
  const stored = (input as { stored?: StoredPracticeWorkflow | null }).stored;
  if (lifecycle === "existing" && stored === undefined) {
    throw new Error("existing 卷必须显式携带 stored（对象或 null）");
  }
  if (
    lifecycle === "existing" &&
    stored !== null &&
    (typeof stored !== "object" || Array.isArray(stored))
  ) {
    throw new Error("existing 卷的 stored 必须为对象或 null");
  }
  if (lifecycle === "new" && stored !== undefined) {
    throw new Error("new 卷不得携带 stored（不得伪造已存事实）");
  }

  // 历史卷（显式 null）：无工作流版本恒整卷旧协议，不可升级、不可逐题
  if (stored === null) {
    return practiceWorkflowSchema.parse({
      version: 1,
      feedbackMode: "after_attempt",
      revision: 0,
      canChangeFeedback: false,
      allowedFeedbackModes: ["after_attempt"],
      canSubmitQuestion: false,
      restrictionReason: "legacy_attempt",
      releaseAt: input.dueAt ?? null,
    });
  }

  const allowPerQuestion = perQuestionAllowed(input);
  const allowedFeedbackModes: PracticeFeedbackMode[] = allowPerQuestion
    ? ["per_question", "after_attempt"]
    : ["after_attempt"];

  const restrictionReason: PracticeRestrictionReason | null =
    input.sourceType === "assignment" &&
    input.assignment?.answerRelease === "after_due"
      ? "teacher_after_due"
      : allowPerQuestion
        ? null
        : "teacher_after_attempt";

  // 节奏决定：续作（stored 存在）保持 stored.feedbackMode（教师放宽不改写，
  // existing 不读 studentChoice 不改写既存事实；收紧见下）；新建先取学生
  // 明确选择（不得越权到不允许项），否则未受限时默认 per_question（§5.3）。
  const frozen = stored
    ? stored.hasSubmittedQuestion || stored.attemptSubmitted
    : false;
  const effectiveMode: PracticeFeedbackMode = stored
    ? stored.feedbackMode
    : allowedFeedbackModes.includes(input.studentChoice ?? "per_question")
      ? (input.studentChoice ?? "per_question")
      : "after_attempt";

  return practiceWorkflowSchema.parse({
    version: 1,
    feedbackMode: effectiveMode,
    revision: stored?.revision ?? 0,
    // 首次任何题级/整卷提交前可改；教师限制到单一模式时也无可改空间
    canChangeFeedback: !frozen && allowedFeedbackModes.length > 1,
    allowedFeedbackModes,
    canSubmitQuestion:
      allowPerQuestion &&
      effectiveMode === "per_question" &&
      !stored?.attemptSubmitted,
    restrictionReason,
    releaseAt: input.dueAt ?? null,
  });
}

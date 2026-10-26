import {
  type AssignmentAnswerRelease,
  type AttemptSource,
  type PracticeFeedbackMode,
  type PracticeRecommendation,
  type PracticeRestrictionReason,
  type PracticeWorkflow,
  practiceRecommendationSchema,
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
 * 新建新协议卷：按教师规则 + 学生选择/文档推荐/缺省裁决；不得携带 stored
 * （运行时携带即抛错，防伪造已存事实骗授权）。
 * 调用样例：{ sourceType: "course", lifecycle: "new", studentChoice: "per_question" }
 */
export interface ResolveNewPracticeWorkflowInput
  extends ResolvePracticeWorkflowCommon {
  lifecycle: "new";
  stored?: never;
  /** 学生本次明确选择 / 持久偏好（新建卷用；不放宽教师限制） */
  studentChoice?: PracticeFeedbackMode | null;
  /**
   * 文档推荐档（M5-D2，frontmatter `practice:` 的 feedback 值，装配层读
   * units.practiceDefaultsJson 聚合后传入）：学生未设置偏好时才生效——
   * 决定链 studentChoice ?? unitRecommendation ?? "per_question"，整体仍被
   * allowedFeedbackModes 收敛（推荐不能越权，教师限制最终裁决）。续作不读
   * 推荐（existing 保持 stored.feedbackMode）。
   */
  unitRecommendation?: PracticeFeedbackMode | null;
}

/**
 * 已存卷（续作或历史）：必须显式给 stored 对象或 null（缺省/非法抛错）；
 * 不接受 studentChoice / unitRecommendation——不得改写既存事实，续作不读推荐。
 * 调用样例（续作）：{ sourceType: "course", lifecycle: "existing", stored: { feedbackMode: "per_question", revision: 0, hasSubmittedQuestion: false, attemptSubmitted: false } }
 * 调用样例（legacy）：{ sourceType: "assignment", lifecycle: "existing", stored: null, assignment: {...} }
 */
export interface ResolveExistingPracticeWorkflowInput
  extends ResolvePracticeWorkflowCommon {
  lifecycle: "existing";
  stored: StoredPracticeWorkflow | null;
  studentChoice?: never;
  unitRecommendation?: never;
}

export type ResolvePracticeWorkflowInput =
  | ResolveNewPracticeWorkflowInput
  | ResolveExistingPracticeWorkflowInput;

/**
 * units.practiceDefaultsJson 列值 → 契约推荐（全服务端唯一实现，M5 simplify
 * 闸门收敛——此前 wiring 聚合/landing 下发/导出回写三处平行 safeParse，口径
 * 靠注释维系必然漂移）：坏 JSON/契约失败 → null + console.warn 留痕不抛
 * （单行脏数据不打挂建卷/落地/导出，也不把原文下发学生端）。写侧恒过契约，
 * 走到 warn 说明数据被外力破坏。
 */
export function practiceDefaultsOf(
  column: string | null,
): PracticeRecommendation | null {
  if (column === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(column);
  } catch (err) {
    console.warn(
      "practiceDefaultsOf: practiceDefaultsJson 不是合法 JSON，按无推荐处理",
      err,
    );
    return null;
  }
  const parsed = practiceRecommendationSchema.safeParse(data);
  if (!parsed.success) {
    console.warn(
      "practiceDefaultsOf: practiceDefaultsJson 不合契约，按无推荐处理",
      parsed.error.issues[0]?.message,
    );
    return null;
  }
  return parsed.data;
}

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

// ---------- 答案公布 gate（T2A.8 判定纯函数，2026-10-22 起随工作流裁决同居） ----------

/**
 * 答案是否已公布（T2A.8，D11 的判定纯函数，服务测试单测覆盖）：
 * - on_submit（默认）恒已公布；course 来源不适用本函数（D11 恒交卷即公布）；
 * - after_due：now ≥ dueAt 才公布（**读时比较，无定时任务**——截止后下一次
 *   请求自然恢复完整结果视图）；
 * - after_due 而 dueAt 缺失：按未公布处理（fail closed）。该状态被
 *   assignment-service 的 create/PATCH 组合校验 400 拦截，正常不可达，
 *   防御性口径取不泄露的一侧。
 * 原定义在 attempt-service，M2 起题级反馈四态裁决（下方）与 wiring 的题级
 * 进度可读性都要消费它，移到纯裁决器层避免反向依赖；attempt-service
 * re-export 保持既有导入路径不变。
 */
export function answersReleased(
  assignment: {
    answerRelease: AssignmentAnswerRelease;
    dueAt: string | null;
  },
  now: Date | string = new Date(),
): boolean {
  if (assignment.answerRelease !== "after_due") return true;
  if (assignment.dueAt === null) return false;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  return Date.parse(assignment.dueAt) <= nowMs;
}

/**
 * 已收尾卷的答案公布 gate 单一公式（M2 收敛：题级反馈四态的 published 与
 * wiring 题级进度 feedbackReadable 共用——此前两处 status/submittedAt 双判别
 * 键、requireAssignmentRow 整行/授权投影双取数源，异常行上同一端点会给出
 * 矛盾结论）：
 * - 进行中卷（未收尾）无公布 gate——题级状态由 workflow 裁决
 *   （canSubmitQuestion ⟹ per_question），恒 true；
 * - 非作业来源已收尾：交卷即公布（D11，与结果视图同口径）；
 * - 作业来源已收尾：answersReleased 读时比较（after_due 截止后下一次读取
 *   自动恢复）；
 * - 作业公布事实缺失（授权行悬挂等异常数据，FK 正常不可达）：fail closed
 *   未公布（题目笔记本同口径取严）——不把读取打成 404/500。
 * now 由调用方穿透（同一请求内 feedback 状态与题级进度可读性必须同一时钟）。
 */
export function attemptAnswersPublished(
  input: {
    /** 已收尾（attempts.status !== "draft"，单一判别键——勿再用 submittedAt 代理） */
    attemptSubmitted: boolean;
    sourceType: AttemptSource;
    /** 作业公布事实；非作业来源传 null（已收尾缺失才 fail closed） */
    release: {
      answerRelease: AssignmentAnswerRelease;
      dueAt: string | null;
    } | null;
  },
  now: Date | string = new Date(),
): boolean {
  if (!input.attemptSubmitted || input.sourceType !== "assignment") return true;
  return input.release !== null && answersReleased(input.release, now);
}

// ---------- M2 题级反馈四态纯裁决（2026-10-22 计划 §10.1/§10.4） ----------

/** 题级反馈授权四态（判别键与契约 practiceQuestionFeedbackSchema 同构；
 * released 态的题目投影由调用方组装——本裁决只出状态，不碰题目内容） */
export type PracticeQuestionFeedbackState =
  | { status: "not_submitted" }
  | { status: "pending_attempt" }
  | { status: "restricted"; restrictionReason: PracticeRestrictionReason }
  | { status: "released" };

/**
 * 单题反馈授权的纯裁决器（M2 收敛点：提交回执的 feedback、feedback GET、
 * 题级进度 feedbackReadable 三处共用同一实现——此前 wiring 自写谓词与
 * attempt-service 内联分支是两套公式，最后一题收尾回执会出现 released
 * 与 feedbackReadable=false 自相矛盾）：
 * - not_submitted：行未提交（无任何题目秘密，提交事实以 submittedAt 为准）；
 * - 已收尾卷（attemptSubmitted）：published（公布 gate，与结果视图
 *   answersReleased 同口径读时比较）决定 released / pending_attempt；
 * - 进行中卷：canSubmitQuestion（resolver 语义 = 教师允许逐题 × 本卷节奏
 *   per_question）→ released；节奏 after_attempt（学生自选或教师限定）→
 *   pending_attempt；其余（教师收紧，§5.4）→ restricted；
 * - workflow 为 null（读侧异常降级——如作业授权行悬挂按「缺失=旧协议」）→
 *   restricted(legacy_attempt) fail closed，不把异常数据打成 500。
 */
export function resolvePracticeQuestionFeedbackState(input: {
  /** 本题 responses 行是否已提交 */
  submitted: boolean;
  /** 本卷是否已整卷收尾（attempts.status ≠ draft） */
  attemptSubmitted: boolean;
  /** 已收尾卷的公布 gate（assignment answersRelease / course·wrong 恒 true）；
   * 进行中卷忽略本入参 */
  published: boolean;
  /** 读侧工作流投影（进行中卷裁决用；已收尾卷不用，可传 null） */
  workflow: PracticeWorkflow | null;
}): PracticeQuestionFeedbackState {
  if (!input.submitted) {
    return { status: "not_submitted" };
  }
  if (input.attemptSubmitted) {
    return input.published
      ? { status: "released" }
      : { status: "pending_attempt" };
  }
  const workflow = input.workflow;
  if (workflow === null) {
    return { status: "restricted", restrictionReason: "legacy_attempt" };
  }
  if (workflow.canSubmitQuestion) {
    return { status: "released" };
  }
  if (workflow.feedbackMode === "after_attempt") {
    return { status: "pending_attempt" };
  }
  return {
    status: "restricted",
    // resolver 语义下本分支 restrictionReason 恒非空（allowPerQuestion=false
    // 必携带原因）；兜底取保守枚举值
    restrictionReason: workflow.restrictionReason ?? "teacher_after_attempt",
  };
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
  // existing 不读 studentChoice/unitRecommendation，不改写既存事实；收紧见下）；
  // 新建按 学生明确选择 > 文档推荐（M5-D2，学生未设置偏好时才生效）> 缺省
  // per_question（§5.3/§5.4 档 2、3），整体不得越权到不允许项（推荐与选择
  // 同样被 allowedFeedbackModes 收敛——教师限制最终裁决）。
  const frozen = stored
    ? stored.hasSubmittedQuestion || stored.attemptSubmitted
    : false;
  // unitRecommendation 与 studentChoice 同款 never 声明（existing 误传编译期
  // 拦截）；preferred 只在新建分支被消费（stored 短路见下方 effectiveMode）
  const preferred =
    input.studentChoice ?? input.unitRecommendation ?? "per_question";
  const effectiveMode: PracticeFeedbackMode = stored
    ? stored.feedbackMode
    : allowedFeedbackModes.includes(preferred)
      ? preferred
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

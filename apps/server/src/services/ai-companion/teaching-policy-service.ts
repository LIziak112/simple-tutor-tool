import type {
  AiPolicyInheritableMode,
  AiPolicyResolution,
  AiTeachingMode,
} from "@tutor/contract";
import { DEFAULT_AI_TEACHER_MODE } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import type { Attempt, ResponseRow } from "../../db/schema.ts";
import { responses } from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";
import {
  attemptTeacherId,
  lessonQuestionSubmitted,
  requireUsableAttempt,
} from "../attempt-service.ts";
import {
  isPerQuestionV1Attempt,
  practiceProtocolOf,
} from "../practice-workflow-wiring.ts";

/**
 * SAI-04 统一教学策略裁决（B02）：唯一 AI 权限口径，创建、领取、回信交付、
 * 正文/附件/降级出口等全部通道后续必须经本模块裁决，不得各自抄判断。
 * 依据：技术实施方案 §2（两步合并算法 + 阶段识别）、需求规格 §2–§3、
 * 契约 packages/contract/src/student-ai-policy.ts（B01 已验收，输出结构即
 * aiPolicyResolutionSchema——usable=false 不携带回答尺度，true 必带）。
 *
 * 两层拆分：
 * - `resolveAiPolicy` 纯配置裁决——不读库、不读全局时钟（时间与状态全部由
 *   调用方参数化传入，确定性测试锁定 48 组合矩阵）；
 * - `questionPhaseOf` 阶段识别——读既有 attempts/responses 行判完成态，
 *   不新建任何表（AI 配置存储 SAI-05 落地，本模块经 AiPolicyConfigSource
 *   接口注入读取实现）。
 *
 * 复用不重造：作答归属/作废/课程失权鉴权全部走 `requireUsableAttempt`
 * （404 ATTEMPT_NOT_FOUND / 403 FORBIDDEN / 403 COURSE_ACCESS_DENIED /
 * 409 ATTEMPT_ABANDONED 口径不漂移）；`answersReleased` 与普通结果权限
 * 不被本模块触碰（AI 完成态与普通答案公布时间相互独立，需求 §2.3）。
 */

// ---------- 配置读取接口（SAI-05 落 ai_teacher_settings / ai_policy_overrides 实现） ----------

/**
 * 三层教学配置的读取接口。SAI-04 只定义协议并以测试夹具注入；
 * SAI-05 起提供唯一数据库实现 sqliteAiPolicyConfigSource
 * （ai-policy-config-source.ts，通道不得旁路）。
 *
 * 无行语义（与技术方案 §2.1 存储形态一致，由实现方保证）：
 * - teacherDefaultMode：无行 = 未设置 → 返回 DEFAULT_AI_TEACHER_MODE（open_study）；
 * - studentOverrideMode / assignmentOverrideMode：无行 = 继承 → 返回 "inherit"。
 */
export interface AiPolicyConfigSource {
  teacherDefaultMode(db: Db, teacherId: string): AiTeachingMode;
  studentOverrideMode(db: Db, studentId: string): AiPolicyInheritableMode;
  assignmentOverrideMode(db: Db, assignmentId: string): AiPolicyInheritableMode;
}

// ---------- 第一层：纯配置裁决（技术方案 §2.2 两步合并算法） ----------

/** resolveAiPolicy 输入：三层配置（已按无行语义归一化）+ 本题是否完成（服务端口径） */
export interface AiPolicyConfigInput {
  teacherDefault: AiTeachingMode;
  studentMode: AiPolicyInheritableMode;
  assignmentMode: AiPolicyInheritableMode;
  completed: boolean;
}

/**
 * 两步合并算法（27 组合规范式的全 48 组合实现，需求 §3.2）：
 *
 * 0. 本题完成后 → 一律 open_study 复盘（reason=completed，作答中不可用的题
 *    完成后自动开放，无需重连；"仅启发"的尺度限制同时解除）。
 * 1. 作答中可用性：学生或作业任一**明确** post_submit_only → 不可用，另一处
 *    的开放设置不能绕过；两者皆继承且教师默认 post_submit_only → 不可用
 *    （继承默认生效——继承 ≠ 明确 open，显式学生/作业设置可覆盖此默认）。
 * 2. 回答尺度（仅可用时）：显式作业 > 显式学生 > 教师默认（> open_study 兜底，
 *    由存储归一化保证 teacherDefault 恒为三显式值）。
 *
 * reason 在多来源同时关闭时取最具体来源（学生 > 作业 > 教师默认继承），
 * 配置页与学生端侧栏据此展示有效模式与关闭原因，无"默认看前端"分支。
 */
export function resolveAiPolicy(
  input: AiPolicyConfigInput,
): AiPolicyResolution {
  // 第 0 步：完成态恒开放复盘（需求 §2.1/§3.2 表末行）
  if (input.completed) {
    return { usable: true, mode: "open_study", reason: "completed" };
  }
  // 第一步：明确关闭不可被绕过（学生 > 作业 > 继承的教师默认）
  if (input.studentMode === "post_submit_only") {
    return { usable: false, reason: "student_closed" };
  }
  if (input.assignmentMode === "post_submit_only") {
    return { usable: false, reason: "assignment_closed" };
  }
  if (
    input.studentMode === "inherit" &&
    input.assignmentMode === "inherit" &&
    input.teacherDefault === "post_submit_only"
  ) {
    return { usable: false, reason: "teacher_default_closed" };
  }
  // 第二步：回答尺度（显式作业 > 显式学生 > 教师默认）
  if (input.assignmentMode !== "inherit") {
    return {
      usable: true,
      mode: input.assignmentMode,
      reason: "assignment_override",
    };
  }
  if (input.studentMode !== "inherit") {
    return {
      usable: true,
      mode: input.studentMode,
      reason: "student_override",
    };
  }
  return {
    usable: true,
    mode: input.teacherDefault,
    reason: "teacher_default",
  };
}

// ---------- 第二层：阶段识别（技术方案 §2.3 "本题完成"） ----------

/** 题目作答阶段：answering=作答中，completed=本题完成（AI 复盘口径） */
export type AiQuestionPhase = "answering" | "completed";

/**
 * 取 attempt 内本题的冻结 response 行（无行 → 404 QUESTION_NOT_FOUND，
 * 文案与 attempt-service 既有口径一致）。AI 裁决按 response 绑定冻结题：
 * questionId 必须属于本 attempt 自己的 responses 行——双教师同 questionId
 * 与跨学生场景由 (attemptId, questionId) 定位天然隔离，不读当前题库。
 */
function requireAttemptResponse(
  db: Db,
  attemptId: string,
  questionId: string,
): ResponseRow {
  const row = db
    .select()
    .from(responses)
    .where(
      and(
        eq(responses.attemptId, attemptId),
        eq(responses.questionId, questionId),
      ),
    )
    .get();
  if (row === undefined) {
    throw new HttpError(
      404,
      "QUESTION_NOT_FOUND",
      "题目不存在或不属于这次练习",
    );
  }
  return row;
}

/**
 * 按 attempt 行与 response 行判阶段（questionPhaseOf 的内部单源，供两处共用）：
 * - lesson：题级 submittedAt ≠ null 即完成——邻题提交不解锁本题，
 *   整卷收尾对剩余行写交卷时刻（正常不存在 status=submitted 而行空值；
 *   口径按题级行值锁定，不回看 attempt 级状态）；
 * - v1 逐题卷（M4-D1，总计划 §12.2）：与 lesson 同语义，行级 submittedAt
 *   ≠ null 即完成——本题真正单题提交（落库）才进入复盘；邻题提交、已选
 *   选项、切题、网络提交未知都不算完成；整卷收尾同样对剩余行写交卷时刻
 *   （同 lesson，见 attempt-service rowSubmittedAtPatch）。post_submit_only
 *   下提交后本题开放复盘、邻题仍按作答中裁决；guided_only 完成后同样按
 *   open_study 复盘尺度；
 * - v1 after_attempt 卷与历史旧协议卷：attempt.status ∈ {submitted, graded}
 *   即完成——填完/交卷失败/收起纸面/到截止（draft 恒未完成）、以前做过同题
 *   （wrong 新卷按本次状态）均不算；行级残留值不改变整卷语义。
 * 协议形态经 practiceProtocolOf / isPerQuestionV1Attempt 单一出处判别，
 * 不在本模块另写 sourceType 分支；不读时钟、不做归属校验（归属/作废/课程
 * 失权由 requireUsableAttempt 把关）。
 */
function phaseOfRows(attempt: Attempt, response: ResponseRow): AiQuestionPhase {
  if (
    practiceProtocolOf(attempt) === "lesson" ||
    isPerQuestionV1Attempt(attempt)
  ) {
    return lessonQuestionSubmitted(response) ? "completed" : "answering";
  }
  return attempt.status === "submitted" || attempt.status === "graded"
    ? "completed"
    : "answering";
}

/**
 * "本题完成"判定（服务端唯一口径，技术方案 §2.3 表逐行实现；M4-D1 起 v1
 * 逐题卷按行级 submittedAt——见 phaseOfRows）。题目不在本卷 → 404
 * QUESTION_NOT_FOUND；作废卷（abandonedAt ≠ null）的一切 AI 读写拒绝由
 * 调用方经 requireUsableAttempt 前置把关（ATTEMPT_ABANDONED）。
 */
export function questionPhaseOf(
  db: Db,
  attempt: Attempt,
  questionId: string,
): AiQuestionPhase {
  const response = requireAttemptResponse(db, attempt.id, questionId);
  return phaseOfRows(attempt, response);
}

// ---------- 统一裁决入口（创建 / 领取 / 回信交付 / 正文 / 附件 / 降级出口共用） ----------

/** 统一入口返回：裁决结果 + 完成态 + 后续通道所需定位信息 */
export interface AttemptQuestionAiPolicy {
  /** 有效裁决（契约 aiPolicyResolutionSchema，服务端单源推导） */
  resolution: AiPolicyResolution;
  /** 本题是否完成（questionPhaseOf 口径） */
  completed: boolean;
  /** 鉴权后的 attempt 行（懒冻结后的最新行，通道复用不再自查） */
  attempt: Attempt;
  /** 冻结 response 行 id（即对外 questionRevisionId，SAI-12 任务创建直接使用） */
  responseId: string;
}

/**
 * 学生侧 AI 权限统一裁决：归属/可用性（requireUsableAttempt，含作废/课程失权/
 * 懒冻结）→ 冻结题绑定与完成态（questionPhaseOf）→ 三层配置合并
 * （resolveAiPolicy）。每次出站或返回内容前的"当前模式与完成态重校验"
 * （教师刚改设置立即生效）就是重新调用本函数，通道不得缓存结果跨事件使用。
 *
 * 配置来源由 configSource 注入（SAI-05 前以夹具实现）；assignmentMode 仅
 * assignment 来源读作业覆盖（attempt.assignmentId，不接受客户端指定），
 * course / wrong / lesson 恒按 inherit（无作业配置，需求 §3.1）。
 * 无教师域异常学生行：教师默认回落 DEFAULT_AI_TEACHER_MODE（无配置=开放伴学，
 * 与 D9 防御口径同精神——该形态回填后不应存在，不按关闭侧处理）。
 */
export function resolveAttemptQuestionAiPolicy(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  configSource: AiPolicyConfigSource,
): AttemptQuestionAiPolicy {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  const response = requireAttemptResponse(db, attempt.id, questionId);
  const completed = phaseOfRows(attempt, response) === "completed";
  const teacherId = attemptTeacherId(db, attempt);
  const teacherDefault =
    teacherId === null
      ? DEFAULT_AI_TEACHER_MODE
      : configSource.teacherDefaultMode(db, teacherId);
  const studentMode = configSource.studentOverrideMode(db, attempt.studentId);
  const assignmentMode =
    attempt.sourceType === "assignment" && attempt.assignmentId !== null
      ? configSource.assignmentOverrideMode(db, attempt.assignmentId)
      : "inherit";
  const resolution = resolveAiPolicy({
    teacherDefault,
    studentMode,
    assignmentMode,
    completed,
  });
  return { resolution, completed, attempt, responseId: response.id };
}

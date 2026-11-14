import type {
  AttemptResultQuestion,
  PracticeQuestionFeedback,
  PracticeQuestionFeedbackData,
  Question,
} from "@tutor/contract";
import type { Db } from "../db/client";
import { type Attempt, type ResponseRow, responses } from "../db/schema";
import { HttpError } from "../lib/http-error";
import {
  assignmentReleaseByIds,
  buildAttemptQuestionWhere,
  questionNotFound,
  requireUsableAttempt,
} from "./attempt-access.ts";
import {
  materialSlotOrderOf,
  resultQuestionOf,
  studentFacingResultOf,
} from "./attempt-question-projection.ts";
import {
  attemptAnswersPublished,
  resolvePracticeQuestionFeedbackState,
} from "./practice-workflow-service";
import {
  type AttemptWorkflowView,
  attemptWorkflowView,
  practiceProtocolOf,
} from "./practice-workflow-wiring";
import { snapshotOfRow } from "./snapshot";

// ---------- GET /api/student/attempts/:id/questions/:questionId/feedback（M2 题级反馈，2026-10-22 计划 §10.1/§10.4） ----------

/** released 态进行中卷的教师域字段置 null 投影（M2 派单：attempt 未交卷期间
 * teacherMark/teacherComment/finalCorrect 恒 null——公布 gate 截止前/收尾前
 * 不下发教师域判定；库值保留，收尾公布后随行） */
function nullTeacherFieldsOf(
  item: AttemptResultQuestion,
): AttemptResultQuestion {
  return {
    ...item,
    teacherMark: null,
    teacherComment: null,
    finalCorrect: null,
  };
}

/**
 * 单题授权反馈的共用投影（M2 单一实现——提交回执的 feedback 字段与 feedback
 * GET 的 data.feedback 都是它，防两套投影漂移）：按**读取时刻**的当前规则
 * 裁决四态（裁决本体在 practice-workflow-service 的
 * resolvePracticeQuestionFeedbackState——与 wiring 的题级进度
 * feedbackReadable 同一纯函数，防两套公式漂移），不缓存旧投影正文原样重放
 * （§10.3——教师收紧后重试同样受限）：
 * - not_submitted：行未提交（无任何题目秘密，提交事实以 questionProgress
 *   的 submittedAt 为准）；
 * - pending_attempt：本题已提交但公布条件未满足——进行中卷的 after_attempt
 *   节奏（学生自选/教师限定）或已收尾卷的 after_due 截止前（公布 gate 与结果
 *   视图 answersReleased 同口径，读时比较，截止后下一次请求自动恢复）；
 * - restricted：当前教师规则不允许逐题反馈（收紧后已提交题重取同样受限，
 *   §5.4——已下发内容不宣称撤回，后续读取按当前 gate；原因复用 M1 枚举；
 *   读侧工作流投影缺失的异常数据降级为 legacy_attempt fail closed）；
 * - released：已提交且当前授权——question 为整卷结果单题同构
 *   （attemptResultQuestion；stemMd 一律经 studentStemMd 学生端投影，与
 *   lesson 单题提交同一出口）。
 * 快照按需解析（snapshotOf 惰性求值）：只有 released 态需要题目内容，
 * 其余三态不付整份快照的解析校验成本（题级反馈读取是可轮询路径）。
 * view 是调用方已算好的读侧工作流投影（提交回执复用省一次重复投影），
 * 缺省（GET 路径）在进行中卷分支内现算。
 */
export function practiceQuestionFeedbackOf(
  db: Db,
  attempt: Attempt,
  row: ResponseRow,
  snapshotOf: () => Question | null,
  now: Date | string = new Date(),
  view?: AttemptWorkflowView | null,
): PracticeQuestionFeedback {
  const state = practiceQuestionFeedbackStateOf(db, attempt, row, now, view);
  if (state.status !== "released") {
    return state;
  }
  const snapshot = snapshotOf();
  if (snapshot === null) {
    // 已提交行的快照损坏：不静默降级成无秘密态（与未提交读区分）
    throw questionNotFound();
  }
  const question = studentFacingResultOf(
    resultQuestionOf(row, snapshot, {
      materialSlots: materialSlotOrderOf(db, attempt.id),
      db,
    }),
  );
  return {
    status: "released",
    // 进行中卷教师域字段恒 null（收尾公布后随行）；已收尾卷按结果视图原样
    question:
      attempt.status === "draft" ? nullTeacherFieldsOf(question) : question,
  };
}

/**
 * 单题反馈四态的门控组装单一出处（M2 收敛点提炼：题级反馈投影
 * practiceQuestionFeedbackOf 与学生自评 gate——self-review-service——共用，
 * release 查询与公式不复制）。普通来源交 resolvePracticeQuestionFeedbackState
 * 纯裁决（同款输入组装）；lesson 独立适配：恒 on_submit 题级释放（提交即
 * 公布，submitLessonQuestion 同源语义），只有未提交/已释放两态——无
 * pending_release/restricted 中间态，不适用普通四态裁决器的进行中分支。
 */
export function practiceQuestionFeedbackStateOf(
  db: Db,
  attempt: Attempt,
  row: Pick<ResponseRow, "submittedAt">,
  now: Date | string = new Date(),
  view?: AttemptWorkflowView | null,
): ReturnType<typeof resolvePracticeQuestionFeedbackState> {
  const finalized = attempt.status !== "draft";
  // 已收尾卷的行按已提交语义进四态（旧行无行级 submittedAt——整卷交卷即
  // 全部判分行已交；行级判别只服务进行中卷。v1/lesson 已收尾行本就带
  // submittedAt，行为不变；QM-10 自评 gate 对历史卷由本口径放行到策略检查）
  const submitted = row.submittedAt !== null || finalized;
  if (attempt.sourceType === "lesson") {
    return submitted ? { status: "released" } : { status: "not_submitted" };
  }
  // 已收尾作业卷的公布事实：assignmentReleaseByIds 含软删（作答记录不随作业
  // 软删消失）；行悬挂（异常数据）Map 无键 → null → 单一公式 fail closed 未
  // 公布，不把读取裸抛成 404（与草稿态 restricted(legacy_attempt)、回执态
  // 409 WORKFLOW_LEGACY 同一降级家族）
  const release =
    finalized && attempt.sourceType === "assignment"
      ? (assignmentReleaseByIds(db, [attempt.assignmentId ?? ""]).get(
          attempt.assignmentId ?? "",
        ) ?? null)
      : null;
  return resolvePracticeQuestionFeedbackState({
    submitted,
    attemptSubmitted: finalized,
    published: attemptAnswersPublished(
      { attemptSubmitted: finalized, sourceType: attempt.sourceType, release },
      now,
    ),
    workflow: finalized
      ? null
      : ((view ?? attemptWorkflowView(db, attempt, now))?.practiceWorkflow ??
        null),
  });
}

/**
 * M2 题级反馈读取（GET /attempts/:id/questions/:questionId/feedback）：
 * 归属/作废/课程失权（requireUsableAttempt，与取卷同口径）+ 协议形态（lesson
 * 当题释放走 lesson/start 投影、历史卷走整卷结果视图——都不在本端点复制第二
 * 份，409 WORKFLOW_LEGACY）+ 题目属冻结集合（404）。四态按读取时刻裁决
 * （practiceQuestionFeedbackOf），未授权形态零题目秘密。
 */
export function getPracticeQuestionFeedback(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  now: Date | string = new Date(),
): PracticeQuestionFeedbackData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  if (practiceProtocolOf(attempt) !== "v1") {
    throw new HttpError(
      409,
      "WORKFLOW_LEGACY",
      "这份作答不支持题级反馈读取（旧协议或讲练作答）",
    );
  }
  const row = db
    .select()
    .from(responses)
    .where(buildAttemptQuestionWhere(attemptId, questionId))
    .get();
  if (row === undefined) {
    throw questionNotFound();
  }
  // 快照惰性解析（仅 released 态反馈需要题目内容，未授权态不付解析成本；
  // 已提交行快照损坏时由投影层按 404 拒绝，不静默降级）
  return {
    feedback: practiceQuestionFeedbackOf(
      db,
      attempt,
      row,
      () => snapshotOfRow(row),
      now,
    ),
  };
}

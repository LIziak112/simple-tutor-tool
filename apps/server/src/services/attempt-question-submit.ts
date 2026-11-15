import { randomUUID } from "node:crypto";
import {
  type LessonQuestionSubmitData,
  type LessonQuestionSubmitRequest,
  lessonQuestionSubmitDataSchema,
} from "@tutor/contract";
import { gradeResponseRow, isUnanswered } from "@tutor/grading";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts, ink, responses, submissionEvidence } from "../db/schema";
import { HttpError } from "../lib/http-error";
import {
  buildAttemptQuestionWhere,
  questionAlreadySubmitted,
  questionNotFound,
  requireUsableAttempt,
} from "./attempt-access.ts";
import { touchAttemptActivity } from "./attempt-activity";
import { autoFinishPerQuestionAttempt } from "./attempt-auto-finish.ts";
import {
  materialSlotOrderOf,
  resultQuestionOf,
  studentFacingResultOf,
} from "./attempt-question-projection.ts";
import { lessonLiveSummaryOf } from "./attempt-score-summary.ts";
import { buildSingleQuestionEvidence } from "./attempt-submit-evidence.ts";
import {
  assertSubmissionAnswerRevision,
  revisionStale,
} from "./attempt-submit-revisions.ts";
import { attemptSummaryOf } from "./attempt-summary.ts";
import { sealResponseTimeWithin } from "./attempt-time-seal";
import {
  recordQuestionSubmitEvent,
  submissionActivityOf,
} from "./event-service";
import { practiceProtocolOf } from "./practice-workflow-wiring";
import { answerOf, snapshotOfRow } from "./snapshot";
import { submittedTimePatchOf } from "./submission-time.ts";

/**
 * 单题提交（2026-10 讲练一体，方案「作答服务」节 + 决策 3——既有交卷管线的
 * 单题化）：lesson 来源 draft 卷的逐题即时反馈，单事务完成
 * 「CAS 校验 → 判分 → 冻结证据 → （最后一题）自动收尾」。
 *
 * - 归属与状态：requireUsableAttempt（404/403；lesson 永不失权——无课程分态
 *   重校验）；非 lesson 来源 → 404 NOT_FOUND（单题提交是讲练专属入口，其余
 *   来源仍走整卷交卷）；已离开 draft → 409 ALREADY_SUBMITTED；
 * - 题目与版本：该题冻结行（严格口径：快照非空，缺失 → 404
 *   QUESTION_NOT_FOUND）；questionRevisionId 与行 id 精确比对（错版 409
 *   QUESTION_REVISION_STALE，与整卷同口径）；行内 submittedAt 已非空 →
 *   409 QUESTION_ALREADY_SUBMITTED（幂等拒绝，前端据此锁定题卡）；
 * - 判分：草稿答案已在行内（无 = 未作答提交，按 D1 客观题判 false）；
 *   grade(snapshot, answer)（@tutor/grading 复用，不复制判分逻辑）写
 *   autoCorrect 与 finalCorrect（不可自动判 → 两者留 null 进教师待批——
 *   D4 谓词按「卷非 draft 或行已提交」收录，见 pending-mark.ts）；行内
 *   teacherMark 必空（draft 卷不可批注），finalCorrect = autoCorrect；
 * - submittedAt = now（该行的提交时刻）；hints/ink/answerJson/changeCount
 *   等其余列不动；
 * - 笔记证据（T6R.10 单题化）：req.evidence 经 buildSingleQuestionEvidence
 *   验证（frozen CAS / none / missing / 缺省旧客户端），通过则同事务写
 *   submission_evidence（(attempt, question) 唯一——每题至多一条，整卷收尾
 *   不再为已提交题补写）；
 * - **自动收尾（最后一题，方案决策 5）**：事务内重读全部冻结行（快照非空），
 *   若全部 submittedAt 非空 → attempt 置 submitted/graded（finalScoreOf，
 *   有待批 = submitted、全判完 = graded）并写 scoreAuto（scoreAutoOf）/
 *   scoreFinal——与整卷交卷同口径复用计算函数；并发双收尾（整卷与本接口
 *   同刻）由「事务内复核 attempt 仍 draft + 行仍 null」保证后到者 409 幂等
 *   （better-sqlite3 同步事务天然串行）；
 * - 成功后直记 question_submit 事件（payload 仅 questionId；拒绝路径不记）；
 * - 响应（lessonQuestionSubmitData）：**只含该题**的 result 投影（提交即释放
 *   参考答案/详解/判定——stemMd 经 studentStemMd 学生端投影）+ 现算 summary
 *   （lessonLiveSummaryOf）+ attempt 摘要（自动收尾后为新状态）；其他未提交
 *   题的答案/详解/提示内容绝不出现（泄露矩阵见 routes/student-lesson.test.ts）。
 *
 * now 可注入（测试；默认当前时刻，行 submittedAt 亦取该时刻）。
 */
export function submitLessonQuestion(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  req: LessonQuestionSubmitRequest,
  now: Date | string = new Date(),
): LessonQuestionSubmitData {
  const result = db.transaction(
    () =>
      lessonQuestionSubmitDataSchema.parse(
        finalizeLessonQuestion(db, studentId, attemptId, questionId, req, now),
      ),
    { behavior: "immediate" },
  );
  return result;
}

function finalizeLessonQuestion(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  req: LessonQuestionSubmitRequest,
  now: Date | string,
): LessonQuestionSubmitData {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  if (attempt.sourceType !== "lesson") {
    // M2 协议分流（2026-10-22 计划 §5.3/§10.1）：新协议普通卷收到旧协议形态
    // → 拒绝并提示刷新，不退回整卷无版本写入；历史卷维持 404（讲练专属入口，
    // 不暴露差异）
    if (practiceProtocolOf(attempt) === "v1") {
      throw new HttpError(
        409,
        "WORKFLOW_PROTOCOL_MISMATCH",
        "这份练习需要新版做题流程，请刷新页面后重试",
      );
    }
    throw new HttpError(404, "NOT_FOUND", "这份练习不是讲练练习，不能逐题提交");
  }
  if (attempt.status !== "draft") {
    throw new HttpError(
      409,
      "ALREADY_SUBMITTED",
      "这份练习已经完成，不能再提交",
    );
  }

  // 冻结行（严格口径：快照非空）——行 id 即对外下发的 questionRevisionId
  const row = db
    .select()
    .from(responses)
    .where(buildAttemptQuestionWhere(attemptId, questionId))
    .get();
  if (row === undefined) {
    throw questionNotFound();
  }
  if (row.id !== req.questionRevisionId) {
    throw revisionStale();
  }
  if (row.submittedAt !== null) {
    throw questionAlreadySubmitted();
  }
  assertSubmissionAnswerRevision(row, req.expectedAnswerRevision);
  const snapshot = snapshotOfRow(row);
  if (snapshot === null) {
    // 理论不可达（严格口径已保证快照非空）；防御性兜底不静默
    throw questionNotFound();
  }
  // 草稿答案已在行内（无 = 未作答提交，grade 按 D1 客观题判 false）。
  // QM-10 细项1：行级判分走 gradeResponseRow——lesson 新冻结行同样不自动匹配
  const answer = answerOf(row.answerJson) ?? undefined;
  const autoCorrect = gradeResponseRow(row.gradingPolicy, snapshot, answer);

  // #6980-4（2026-10-25 主人口径）：空提交 =「不会，提交并看解析」——学生
  // 已读题、承认不会、当场看解析，按做错结算：自动标「不会」进错题本。
  // 判定 = 无文本作答（isUnanswered）且无正式笔迹（ink 表 (attemptId,
  // questionId) 唯一键，responses.inkId 为 T2.8 遗留列恒空）
  const unsureOnEmpty =
    isUnanswered(answer) &&
    db
      .select({ id: ink.id })
      .from(ink)
      .where(
        and(
          eq(ink.attemptId, attemptId),
          eq(ink.questionId, questionId),
          gt(ink.strokeCount, 0),
        ),
      )
      .get() === undefined;

  // 单题证据与判分由同一事务验证和写入。
  const evidenceRow = buildSingleQuestionEvidence(
    db,
    attemptId,
    questionId,
    req.evidence,
  );

  const nowIso = new Date(now).toISOString();
  db.update(responses)
    .set({
      autoCorrect,
      // D3：提交时 teacherMark 必空（draft 卷不可批注）→ finalCorrect = autoCorrect
      finalCorrect: autoCorrect,
      // #6980-3：是否有实际作答——单题主动提交即显式交锋，恒记 true
      //（2026-10-25 主人口径：提交 = 已读题交锋；被动跳过才冷处理；
      // 「不会，提交并看解析」的空提交也计已答，unsure 标注随 #6980-4 落库）
      answered: true,
      // #6980-4（主人口径）：空提交自动标「不会」；有答案/笔迹的提交不覆盖
      // 既有标注（学生可先自标「不会」再作答，标注保留）
      studentFlag: unsureOnEmpty ? "unsure" : (row.studentFlag ?? null),
      submittedAt: nowIso,
      ...submittedTimePatchOf(
        submissionActivityOf(db, attemptId).activeSecByQuestion,
        questionId,
      ),
    })
    .where(eq(responses.id, row.id))
    .run();
  sealResponseTimeWithin(db, attemptId, [row.id], nowIso);
  if (evidenceRow !== null) {
    db.insert(submissionEvidence)
      .values({
        id: randomUUID(),
        attemptId,
        questionId: evidenceRow.questionId,
        state: evidenceRow.state,
        versionId: evidenceRow.versionId,
        recordedAt: nowIso,
      })
      .run();
  }
  // 自动收尾：全部冻结行都已提交 → 最后一题，共同收尾函数（lesson 与 M2
  // 新协议逐题提交同一实现；返回瘦行集出事务即 lessonLiveSummaryOf 的输入，
  // 与开卷链路同一口径，不复制谓词）
  touchAttemptActivity(db, attemptId, nowIso);
  recordQuestionSubmitEvent(db, studentId, attemptId, questionId, nowIso);
  const summaryRows = autoFinishPerQuestionAttempt(db, attemptId, nowIso).rows;

  // 响应组装：该题 result 投影（stemMd 经学生端投影）+ 现算 summary + 最新
  // attempt 摘要（自动收尾后为新状态）。提交行按主键取一行（快照复用事务前
  // 已 parse 的同一份）；summary 消费收尾查询得到的瘦行集
  const freshAttempt = db
    .select()
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .get();
  const freshRow = db
    .select()
    .from(responses)
    .where(eq(responses.id, row.id))
    .get();
  if (freshAttempt === undefined || freshRow === undefined) {
    // 理论不可达（事务刚写完）；防御性兜底不让接口 500 无信息
    throw new HttpError(500, "INTERNAL", "提交失败，请刷新页面后重试");
  }
  return {
    question: studentFacingResultOf(
      resultQuestionOf(freshRow, snapshot, {
        materialSlots: materialSlotOrderOf(db, attemptId),
        db,
      }),
    ),
    summary: lessonLiveSummaryOf(summaryRows, freshAttempt),
    attempt: attemptSummaryOf(freshAttempt),
  };
}

export { submitPracticeQuestion } from "./attempt-practice-submit.ts";

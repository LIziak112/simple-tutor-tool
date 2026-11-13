import { createHash, randomUUID } from "node:crypto";
import {
  type LessonQuestionSubmitData,
  type LessonQuestionSubmitRequest,
  lessonQuestionSubmitDataSchema,
  type PracticeQuestionSubmitData,
  type PracticeQuestionSubmitWithAnswer,
} from "@tutor/contract";
import { gradeResponseRow, isUnanswered } from "@tutor/grading";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  type Attempt,
  attempts,
  ink,
  responses,
  submissionEvidence,
} from "../db/schema";
import { canonicalJsonOf } from "../lib/canonical-json";
import { HttpError } from "../lib/http-error";
import {
  buildAttemptQuestionWhere,
  questionAlreadySubmitted,
  questionNotFound,
  requireUsableAttempt,
} from "./attempt-access.ts";
import { touchAttemptActivity } from "./attempt-activity";
import {
  attemptFinalOutcomeOf,
  hasUsableQuestionSnapshotSql,
  scoreAutoOf,
} from "./attempt-final-outcome.ts";
import { practiceQuestionFeedbackOf } from "./attempt-question-feedback.ts";
import {
  assertFrozenAnswerShape,
  materialSlotOrderOf,
  resultQuestionOf,
  studentFacingResultOf,
} from "./attempt-question-projection.ts";
import {
  lessonLiveSummaryOf,
  type ScoreSummaryRow,
} from "./attempt-score-summary.ts";
import { buildSingleQuestionEvidence } from "./attempt-submit-evidence.ts";
import {
  assertSubmissionAnswerRevision,
  revisionStale,
} from "./attempt-submit-revisions.ts";
import { attemptSummaryOf } from "./attempt-summary.ts";
import { assertAttemptNotTimedOut } from "./attempt-timing";
import {
  recordConfirmedSubmit,
  recordQuestionSubmitEvent,
} from "./event-service";
import {
  assertDraftCourseVisible,
  attemptWorkflowView,
  practiceProtocolOf,
  requireOwnActiveAttempt,
} from "./practice-workflow-wiring";
import { answerOf, snapshotOfRow } from "./snapshot";

/**
 * 单题提交链路共用的整卷自动收尾（2026-10 lesson 与 M2 新协议逐题提交同一
 * 实现，从 submitLessonQuestion 收尾块抽取——计划 §10.2 第 6 步「最后一题
 * 调用共同收尾函数，避免重复公式与双写统计」）：事务内重读全部冻结行（瘦列
 * 投影，不含每题数 KB 的快照原文），全部已提交才收尾——scoreAuto/scoreFinal/
 * status 与整卷交卷同口径复用 scoreAutoOf / attemptFinalOutcomeOf；收尾 UPDATE 带
 * WHERE status='draft' 真实 CAS，逐题与整卷并发收尾只成功一次（后到者 no-op，
 * 行集照常返回）。返回瘦行集供 lesson 现算 summary / 题级进度消费，并带回
 * 收尾后的 attempt 新行（no-op 时 null——调用方回落事务内已读行，同步单
 * 连接下两者等价，省一次收尾后重读）。
 */
function autoFinishPerQuestionAttempt(
  tx: Pick<Db, "select" | "update" | "insert">,
  attemptId: string,
  nowIso: string,
): { rows: ScoreSummaryRow[]; attempt: Attempt | null } {
  const rowsAfter = tx
    .select({
      // 在数据库连接内核对快照，仅返回是否可用
      // mapWith(Boolean)：better-sqlite3 对该表达式返回 0/1 整数，归一为真
      // 布尔——严格比较（仓库布尔列惯例）与真值判断都安全
      hasSnapshot: hasUsableQuestionSnapshotSql.mapWith(Boolean),
      answerJson: responses.answerJson,
      submittedAt: responses.submittedAt,
      autoCorrect: responses.autoCorrect,
      finalCorrect: responses.finalCorrect,
      // QM-10 细项7：收尾判定与 lesson 汇总的 pendingCount 需要（§5.5.5）
      gradingPolicy: responses.gradingPolicy,
      teacherMark: responses.teacherMark,
      // QM-12：汇总核心的有效判定需要自评记录（reference_self 行回落）
      selfReviewVerdict: responses.selfReviewVerdict,
      selfReviewAt: responses.selfReviewAt,
      selfReviewRevision: responses.selfReviewRevision,
      // #6980-3：已答口径统一 responses.answered（判分写点落库）
      answered: responses.answered,
    })
    .from(responses)
    .where(eq(responses.attemptId, attemptId))
    .all();
  const gradable = rowsAfter.filter((r) => r.hasSnapshot);
  if (gradable.every((r) => r.submittedAt !== null)) {
    // 正在收尾 → finalized（与上方 gate 同刻事实，口径见 attemptFinalOutcomeOf）
    const { status, scoreFinal } = attemptFinalOutcomeOf(gradable, {
      finalized: true,
    });
    const attempt = tx
      .update(attempts)
      .set({
        status,
        submittedAt: nowIso,
        scoreAuto: scoreAutoOf(gradable),
        scoreFinal,
      })
      .where(and(eq(attempts.id, attemptId), eq(attempts.status, "draft")))
      .returning()
      .get();
    if (attempt) recordConfirmedSubmit(tx, attempt, nowIso);
    return { rows: rowsAfter, attempt: attempt ?? null };
  }
  return { rows: rowsAfter, attempt: null };
}

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
    })
    .where(eq(responses.id, row.id))
    .run();
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

// ---------- POST /api/student/attempts/:id/questions/:questionId/submit（M2 新协议普通逐题，2026-10-22 计划 §5.3/§10.1–§10.4） ----------

/**
 * 逐题提交请求摘要（M2 §10.3 幂等配对）：对影响判分与证据固定的请求字段做
 * 确定性拼接后 sha256——同 mutationId 重试必须携带同一摘要；任何字段变化都是
 * 不同请求（409，不能复用幂等键覆盖提交）。submissionMutationId 本身是配对
 * 键不进摘要；workflowVersion 恒 1（协议门禁，不是请求身份）。
 */
function practiceRequestDigestOf(
  attemptId: string,
  questionId: string,
  req: PracticeQuestionSubmitWithAnswer,
): string {
  const evidence = `${req.evidence.state}\u0001${req.evidence.versionId ?? ""}\u0001${req.evidence.revision ?? ""}\u0001${req.evidence.questionId}`;
  return createHash("sha256")
    .update(
      [
        "practice-submit-v1",
        attemptId,
        questionId,
        String(req.workflowRevision),
        req.questionRevisionId,
        String(req.expectedAnswerRevision),
        evidence,
        ...(req.answer === undefined ? [] : [canonicalJsonOf(req.answer)]),
      ].join("\u0000"),
    )
    .digest("hex");
}

/**
 * M2 新协议逐题提交（submitAttemptQuestion 的普通练习实现；lesson 走上方
 * submitLessonQuestion 独立适配）。单事务完成 §10.2 必要顺序：归属（404/403
 * 不暴露差异）→ 作废 409 → 课程失权（requireVisibleCourseUnit）→ 协议形态
 * （lesson / 历史卷 409）→ **幂等与已提交裁决**（§10.3：同 mutationId 同摘要
 * 返回同一提交事实；同 id 异摘要 409 WORKFLOW_MUTATION_CONFLICT；异 mutationId
 * 含整卷已收尾 → 409 QUESTION_ALREADY_SUBMITTED）→ 当前 resolver 裁决
 * （canSubmitQuestion=false → 409 WORKFLOW_RESTRICTED，幂等重放先于它）→
 * workflowRevision CAS（陈旧 409）→ questionRevisionId 版本（409）→
 * **expectedAnswerRevision 与事务内实际答案版本比对**（不一致 409
 * ANSWER_REVISION_CONFLICT 附 _current）→ 证据声明核对
 * （buildSingleQuestionEvidence，与 lesson 同一实现）→ 判分（**事务内**读冻结
 * 快照与答案）→ 行级真实 CAS 写入（WHERE submittedAt IS NULL）→ 最后一题调用
 * autoFinishPerQuestionAttempt（并发下整卷只收尾一次）。
 *
 * 响应（practiceQuestionSubmitData 四键白名单，§6.1）：feedback 授权投影 +
 * questionProgress + 最新 attempt 摘要 + 工作流裁决投影，全部在事务后按**读取
 * 时刻**的当前规则组装（§10.3）。成功路径记 question_submit 事件（重放不重复记）。
 */
export function submitPracticeQuestion(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  req: PracticeQuestionSubmitWithAnswer,
  now: Date | string = new Date(),
): PracticeQuestionSubmitData {
  const nowIso = new Date(now).toISOString();
  const digest = practiceRequestDigestOf(attemptId, questionId, req);
  const outcome = db.transaction((tx) => {
    // 归属（不存在/跨学生统一 404）+ 作废 409：写路径共用前导（与 PATCH
    // workflow 同一实现）
    const attempt = requireOwnActiveAttempt(tx, studentId, attemptId);
    // 课程失权分态校验（403/404），与取卷同口径（同步连接，事务内读一致）
    assertDraftCourseVisible(db, studentId, attempt);
    // 新协议路径仅普通来源的新协议卷：lesson 独立适配 → 协议不匹配；历史卷 → legacy（§5.3）
    const protocol = practiceProtocolOf(attempt);
    if (protocol === "lesson") {
      throw new HttpError(
        409,
        "WORKFLOW_PROTOCOL_MISMATCH",
        "这份作答是讲练练习，请刷新页面后按讲练流程提交",
      );
    }
    if (protocol === "legacy") {
      throw new HttpError(
        409,
        "WORKFLOW_LEGACY",
        "历史作答不支持逐题提交，请整卷交卷",
      );
    }

    const row = tx
      .select()
      .from(responses)
      .where(buildAttemptQuestionWhere(attemptId, questionId))
      .get();
    if (row === undefined) {
      throw questionNotFound();
    }

    // 幂等与已提交裁决（§10.3）——先于一切可变拒绝：结果未知的重试按当前规则
    // 投影返回同一提交事实；异 mutationId（含整卷已收尾）→ 可诊断已提交
    if (row.submittedAt !== null) {
      if (row.practiceMutationId === req.submissionMutationId) {
        if (row.practiceRequestDigest !== digest) {
          throw new HttpError(
            409,
            "WORKFLOW_MUTATION_CONFLICT",
            "同一提交标识的请求内容不一致，请刷新页面后重试",
          );
        }
        return { replayed: true as const, row, attempt };
      }
      throw questionAlreadySubmitted();
    }
    if (attempt.status !== "draft") {
      throw new HttpError(
        409,
        "ALREADY_SUBMITTED",
        "这份练习已经完成，不能再提交",
      );
    }

    // 当前 resolver 裁决：教师收紧立即生效（§5.4），收紧后拒绝进一步逐题提交
    //（学生按「继续完成剩余题目并交卷」收敛；已提交行与成绩保留）
    assertAttemptNotTimedOut(attempt, nowIso, "running");
    const view = attemptWorkflowView(db, attempt, now);
    if (view === null) {
      // M1 加固语义（v2 d7c84b89）：读侧视图缺失＝授权事实异常（如作业授权
      // 行悬挂按「缺失=旧协议」降级）——按旧协议 409 拒绝，不把异常数据打成 500
      throw new HttpError(
        409,
        "WORKFLOW_LEGACY",
        "这份作答的工作流数据异常，按旧协议处理",
      );
    }
    if (!view.practiceWorkflow.canSubmitQuestion) {
      throw new HttpError(
        409,
        "WORKFLOW_RESTRICTED",
        "当前规则不允许逐题提交，请继续完成剩余题目并交卷",
      );
    }

    // 工作流 CAS：节奏修改与首题提交的竞态拒绝陈旧请求（§10.3 末条；任一
    // 提交后节奏冻结，比对恒命中）
    if (attempt.workflowRevision !== req.workflowRevision) {
      throw new HttpError(
        409,
        "WORKFLOW_REVISION_STALE",
        "做题设置已在其他设备修改，请刷新后重试",
      );
    }
    // 题目版本（与整卷/lesson 同口径）
    if (row.id !== req.questionRevisionId) {
      throw revisionStale();
    }
    // 学生答案版本（§10.2 末段：不是题目版本——他端又存了一版答案即拒绝，
    // 复用既有答案冲突协议与 _current 形态）
    assertSubmissionAnswerRevision(row, req.expectedAnswerRevision);

    // 判分输入在事务内读取（M0 风险 1 窗口关闭）：冻结快照 + 行内草稿答案
    const snapshot = snapshotOfRow(row);
    if (snapshot === null) {
      throw questionNotFound();
    }
    if (req.answer !== undefined)
      assertFrozenAnswerShape(db, row, snapshot, req.answer);
    const answer = req.answer ?? answerOf(row.answerJson) ?? undefined;
    const answerJson =
      req.answer === undefined ? row.answerJson : JSON.stringify(req.answer);
    // QM-10 细项1：行级判分走 gradeResponseRow（新策略行不自动匹配）
    const autoCorrect = gradeResponseRow(row.gradingPolicy, snapshot, answer);

    // #6980-4（2026-10-25 主人口径）：空提交 =「不会，提交并看解析」——学生
    // 已读题、承认不会、当场看解析，按做错结算：自动标「不会」进错题本。
    // 判定 = 无文本作答（isUnanswered）且无正式笔迹（ink 表 (attemptId,
    // questionId) 唯一键；responses.inkId 为 T2.8 遗留列恒空）
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

    // 证据声明核对（frozen/none/missing，与 lesson 单题提交同一实现）
    const evidenceRow = buildSingleQuestionEvidence(
      db,
      attemptId,
      questionId,
      req.evidence,
    );

    // 行级真实 CAS：已提交行不可覆盖（UPDATE 带 WHERE submittedAt IS NULL）
    const written = tx
      .update(responses)
      .set({
        ...(answerJson === row.answerJson
          ? {}
          : {
              answerJson,
              answerRevision: row.answerRevision + 1,
              answerMutationId: req.submissionMutationId,
              changeCount: row.changeCount + 1,
            }),
        autoCorrect,
        // 提交时 teacherMark 必空（draft 卷不可批注）→ finalCorrect = autoCorrect
        finalCorrect: autoCorrect,
        // #6980-3：是否有实际作答——单题主动提交即显式交锋，恒记 true
        //（2026-10-25 主人口径：提交 = 已读题交锋；被动跳过才冷处理；
        // 「不会，提交并看解析」的空提交也计已答，unsure 标注随 #6980-4 落库）
        answered: true,
        // #6980-4（主人口径）：空提交自动标「不会」；有答案/笔迹的提交不覆盖
        // 既有标注（学生可先自标「不会」不覆盖）
        studentFlag: unsureOnEmpty ? "unsure" : (row.studentFlag ?? null),
        submittedAt: nowIso,
        practiceMutationId: req.submissionMutationId,
        practiceRequestDigest: digest,
      })
      .where(and(eq(responses.id, row.id), isNull(responses.submittedAt)))
      .returning()
      .get();
    if (written === undefined) {
      // 事务内复核已拦截同进程并发；防御多进程竞态的后到者按已提交语义收敛
      throw questionAlreadySubmitted();
    }
    if (evidenceRow !== null) {
      tx.insert(submissionEvidence)
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
    // 最后一题：共同收尾函数（与 lesson 同一实现；并发下整卷只收尾一次）。
    // 收尾 RETURNING 带回顾卷新行；no-op（他方已收尾）时回落事务内已读行
    //（同步单连接下与事务后重读恒等）
    touchAttemptActivity(tx, attemptId, nowIso);
    recordQuestionSubmitEvent(tx, studentId, attemptId, questionId, nowIso);
    const finished = autoFinishPerQuestionAttempt(tx, attemptId, nowIso);
    // 有效提交在事务内记事件（重放分支不会到这——§10.3 不重复写；与提交
    // 原子落库，省一次独立 autocommit 的 fsync，不留「提交已持久、事件丢失」
    // 崩溃窗口。lesson 路径的事件仍在事务外属既有模式）
    return {
      replayed: false as const,
      row: written,
      attempt: finished.attempt ?? attempt,
      snapshot,
    };
  });

  // 响应组装：读取时刻投影（§10.3 不重放旧正文）。行与 attempt 直接用事务
  // 产物（同步单连接：事务后重读与事务内已读恒等，省两次整行 SELECT——
  // 含每题数 KB 快照原文的行）；快照只解析一次——非重放路径复用事务内判分
  // 已解析对象（UPDATE 不触快照列，字节恒等），重放路径才惰性解析（仅
  // released 反馈需要整份快照的解析校验）
  const view = attemptWorkflowView(db, outcome.attempt, now);
  if (view === null) {
    // 与事务内 gate 同款降级（异常数据不打 500；提交事实已在库）。注：并发
    // 破坏授权事实触发本 409 时，同 mutationId 重试（重放分支）同样在本段
    // 被拒——该 mutation 的回执需异常数据修复后才能取回；届时整卷读取面已
    // 同步降级 legacy（全库一致口径，非本端点孤例）
    throw new HttpError(
      409,
      "WORKFLOW_LEGACY",
      "这份作答的工作流数据异常，按旧协议处理",
    );
  }
  return {
    feedback: practiceQuestionFeedbackOf(
      db,
      outcome.attempt,
      outcome.row,
      () =>
        "snapshot" in outcome ? outcome.snapshot : snapshotOfRow(outcome.row),
      now,
      view,
    ),
    questionProgress: view.questionProgress,
    attempt: attemptSummaryOf(outcome.attempt),
    practiceWorkflow: view.practiceWorkflow,
  };
}

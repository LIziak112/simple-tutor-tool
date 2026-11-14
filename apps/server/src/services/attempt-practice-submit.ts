import { randomUUID } from "node:crypto";
import type {
  PracticeQuestionSubmitData,
  PracticeQuestionSubmitWithAnswer,
  PracticeSubmissionOrigin,
} from "@tutor/contract";
import { gradeResponseRow, isUnanswered } from "@tutor/grading";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { ink, responses, submissionEvidence } from "../db/schema";
import { HttpError } from "../lib/http-error";
import {
  buildAttemptQuestionWhere,
  questionAlreadySubmitted,
  questionNotFound,
} from "./attempt-access.ts";
import { touchAttemptActivity } from "./attempt-activity";
import { autoFinishPerQuestionAttempt } from "./attempt-auto-finish.ts";
import { practiceQuestionFeedbackOf } from "./attempt-question-feedback.ts";
import { assertFrozenAnswerShape } from "./attempt-question-projection.ts";
import { buildSingleQuestionEvidence } from "./attempt-submit-evidence.ts";
import {
  assertSubmissionAnswerRevision,
  revisionStale,
} from "./attempt-submit-revisions.ts";
import { attemptSummaryOf } from "./attempt-summary.ts";
import { sealResponseTimeWithin } from "./attempt-time-seal";
import { assertAttemptNotTimedOut } from "./attempt-timing";
import {
  recordQuestionSubmitEvent,
  submissionActivityOf,
} from "./event-service";
import { practiceRequestDigestOf } from "./practice-submit-intent.ts";
import {
  assertDraftCourseVisible,
  attemptWorkflowView,
  practiceProtocolOf,
  requireOwnActiveAttempt,
} from "./practice-workflow-wiring";
import { answerOf, snapshotOfRow } from "./snapshot";
import { submittedTimePatchOf } from "./submission-time.ts";

export function commitPracticeQuestion(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  req: PracticeQuestionSubmitWithAnswer,
  now: Date | string = new Date(),
  options: {
    beforeFirstSubmission?: () => void;
    origin?: PracticeSubmissionOrigin;
    settlement?: boolean;
    activeSecByQuestion?: Readonly<Record<string, number>>;
    deferTimeSeal?: boolean;
  } = {},
) {
  const nowIso = new Date(now).toISOString();
  const digest = practiceRequestDigestOf(attemptId, questionId, req);
  const outcome = db.transaction(
    (tx) => {
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

      options.beforeFirstSubmission?.();

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
      if (
        !(options.settlement
          ? view.practiceWorkflow.canSettlePartially
          : view.practiceWorkflow.canSubmitQuestion)
      ) {
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
          ...submittedTimePatchOf(
            options.activeSecByQuestion ??
              submissionActivityOf(db, attemptId).activeSecByQuestion,
            questionId,
          ),
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
      if (!options.deferTimeSeal)
        sealResponseTimeWithin(db, attemptId, [row.id], nowIso);
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
      recordQuestionSubmitEvent(
        tx,
        studentId,
        attemptId,
        questionId,
        nowIso,
        options.origin,
      );
      const finished = options.settlement
        ? { attempt: null }
        : autoFinishPerQuestionAttempt(tx, attemptId, nowIso);
      // 有效提交在事务内记事件（重放分支不会到这——§10.3 不重复写；与提交
      // 原子落库，省一次独立 autocommit 的 fsync，不留「提交已持久、事件丢失」
      // 崩溃窗口。lesson 路径的事件仍在事务外属既有模式）
      return {
        replayed: false as const,
        row: written,
        attempt: finished.attempt ?? attempt,
        snapshot,
      };
    },
    { behavior: "immediate" },
  );

  return outcome;
}

/** HTTP 旧回执仍按读取时刻的授权投影反馈；MCP事实回执直接消费提交结果。 */
export function submitPracticeQuestion(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  req: PracticeQuestionSubmitWithAnswer,
  now: Date | string = new Date(),
): PracticeQuestionSubmitData {
  const outcome = commitPracticeQuestion(
    db,
    studentId,
    attemptId,
    questionId,
    req,
    now,
  );
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

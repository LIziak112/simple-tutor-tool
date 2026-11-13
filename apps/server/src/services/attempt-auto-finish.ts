import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { type Attempt, attempts, responses } from "../db/schema";
import {
  attemptFinalOutcomeOf,
  hasUsableQuestionSnapshotSql,
  scoreAutoOf,
} from "./attempt-final-outcome.ts";
import type { ScoreSummaryRow } from "./attempt-score-summary.ts";
import { recordConfirmedSubmit } from "./event-service";
import { recordedActiveSecTotal } from "./submission-time.ts";

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
export function autoFinishPerQuestionAttempt(
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
      activeSec: responses.activeSec,
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
        activeSec: recordedActiveSecTotal(gradable),
      })
      .where(and(eq(attempts.id, attemptId), eq(attempts.status, "draft")))
      .returning()
      .get();
    if (attempt) recordConfirmedSubmit(tx, attempt, nowIso);
    return { rows: rowsAfter, attempt: attempt ?? null };
  }
  return { rows: rowsAfter, attempt: null };
}

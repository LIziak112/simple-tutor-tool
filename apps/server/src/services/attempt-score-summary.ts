import {
  type AttemptResultQuestion,
  type AttemptScoreSummary,
  effectiveVerdictOf,
  type GradingPolicy,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { type Attempt, responses } from "../db/schema";
import {
  hasUsableQuestionSnapshotSql,
  needsTeacherMark,
} from "./attempt-final-outcome.ts";
import { effectiveVerdictOfRow } from "./response-verdict.ts";

// ---------- POST /api/student/attempts/:id/questions/:questionId/submit（2026-10） ----------

/**
 * attempt 级得分汇总的读侧现算（QM-10 / TT-09a：自评响应的 summary 消费；
 * 结果视图的完整汇总仍走 buildResultData 的公布感知投影——本函数只服务
 * 「已过公布 gate」的回执场景，不做受限形态投影）：
 * - QM-12（TT-09c）起 correct/wrong/pending 为**有效判定口径**（教师判 >
 *   自评 > 自动——自评对/错计入，未自评 reference_self 行计 pending），
 *   与结果视图 scoreSummaryOf、讲练 lessonLiveSummaryOf 同一核心；
 * - scoreFinal 读 attempt 行（自评不推动 graded/scoreFinal——教师权威线）；
 * - pendingCount 是 D4 教师待批计数（排除 reference_self 行；快照缺失的历史
 *   行跳过——与判分/视图口径一致）。
 */
export function attemptScoreSummaryOf(
  db: Db,
  attempt: Pick<Attempt, "id" | "status"> & { scoreFinal: number | null },
): AttemptScoreSummary {
  // P3-1（TT-09a 审查遗留，本单定夺=对齐）：与 lessonLiveSummaryOf 共用同一
  // 计数核心（scoreSummaryCoreOf）。非 draft 卷按已收尾口径整卷计数（行为与
  // 旧实现一致）；draft 卷（lesson / v1 逐题进行中）只计已单题提交的行——
  // 修复前该函数整卷计数，与讲练开卷投影/单题提交响应的 lessonLive 口径
  // 漂移（草稿答案也计入 answered、未提交行计入 pending）。
  const rows = db
    .select({
      hasSnapshot: hasUsableQuestionSnapshotSql.mapWith(Boolean),
      answerJson: responses.answerJson,
      submittedAt: responses.submittedAt,
      autoCorrect: responses.autoCorrect,
      finalCorrect: responses.finalCorrect,
      gradingPolicy: responses.gradingPolicy,
      teacherMark: responses.teacherMark,
      selfReviewVerdict: responses.selfReviewVerdict,
      selfReviewAt: responses.selfReviewAt,
      selfReviewRevision: responses.selfReviewRevision,
      answered: responses.answered,
    })
    .from(responses)
    .where(eq(responses.attemptId, attempt.id))
    .all();
  return {
    ...scoreSummaryCoreOf(rows, {
      finalized: attempt.status !== "draft",
    }),
    scoreFinal: attempt.scoreFinal,
  };
}

/**
 * 得分汇总的统一计数核心（QM-12 / TT-09c，P3-1 对齐的落点）：correct/wrong/
 * pending 为**有效判定口径**（教师判 > 自评 > 自动，effectiveVerdictOfRow
 * 单一出处）；pendingCount 恒 D4 教师待批（finalCorrect IS NULL 且非
 * reference_self 行——与 pending-mark.ts 谓词同口径，快照空行已由 hasSnapshot
 * 排除）。attemptScoreSummaryOf（自评回执）与 lessonLiveSummaryOf（讲练开卷
 * 投影/单题提交响应）共用本核心，两函数只差行集来源：
 * - finalized=false（进行中卷）：仅**已提交行**（responses.submittedAt 非空）
 *   计入对错与 answered，未提交行只进 total/unanswered——「提交瞬间看到部分
 *   汇总、刷新 start 又变」两者永不漂移；
 * - finalized=true（已收尾卷）：整卷口径（legacy 协议行不写行级 submittedAt，
 *   与 attemptFinalOutcomeOf 的 finalized 归一同口径）。
 * 快照缺失的历史行跳过（与判分/视图口径一致）。
 */

/** 汇总核心的判定输入行（M2 起快照列降为存在性布尔——汇总判定只需要
 *  「快照非空」与判定计数，不再搬运每题数 KB 的快照原文；单题提交事务带出
 *  的行集即此形态，开卷链路用完整行按此映射） */
export interface ScoreSummaryRow {
  hasSnapshot: boolean;
  answerJson: string | null;
  submittedAt: string | null;
  autoCorrect: boolean | null;
  finalCorrect: boolean | null;
  /** QM-10：pendingCount 排除 reference_self 行（教师必批谓词同口径） */
  gradingPolicy: GradingPolicy | null;
  teacherMark: string | null;
  /** QM-12：有效判定需要自评记录（teacherMark 与 autoCorrect 均空时回落） */
  selfReviewVerdict: "correct" | "wrong" | null;
  selfReviewAt: string | null;
  selfReviewRevision: number;
  /** #6980-3：判分写点落库的「是否有实际作答」（单题提交恒 true；未提交行 false）。
   *  与判定维度正交——answered 只数「答了」，correct/wrong/pending 仍按有效判定 */
  answered: boolean;
}

export function scoreSummaryCoreOf(
  rows: readonly ScoreSummaryRow[],
  opts: { finalized: boolean },
): Omit<AttemptScoreSummary, "scoreFinal"> {
  let total = 0;
  let answered = 0;
  let correct = 0;
  let wrong = 0;
  let pending = 0;
  let pendingCount = 0;
  let judged = 0;
  for (const row of rows) {
    if (!row.hasSnapshot) continue;
    total += 1;
    if (row.submittedAt === null && !opts.finalized) continue;
    // #6980-3（审查修复 P1-4）：已答口径统一 responses.answered（判分写点
    // 落库），不再按 answer != null 现算——空结构答案与「不会」空提交口径不分裂
    if (row.answered) answered += 1;
    const effective = effectiveVerdictOfRow(row);
    if (effective === null) pending += 1;
    else {
      // 可判分分母与答错门正交（v2 口径）：未做判错仍进分母，不计错次
      judged += 1;
      if (effective.value) correct += 1;
      // #6980-3：未做不计错次，留在 unanswered（与教师详情/错题本同口径）
      else if (row.answered) wrong += 1;
    }
    // D4 教师待批：finalCorrect IS NULL 且非 reference_self 行（pending-mark.ts
    // 谓词同口径；null 策略旧行不受影响）
    if (needsTeacherMark(row)) pendingCount += 1;
  }
  return {
    total,
    answered,
    correct,
    wrong,
    pending,
    unanswered: total - answered,
    autoGradable: judged,
    pendingCount,
  };
}

/**
 * lesson 卷的读侧现算汇总（2026-10 讲练一体；lesson-service 开卷投影与
 * submitLessonQuestion 响应共用同一口径，单一出处；QM-12 起计数核心与
 * attemptScoreSummaryOf 统一为 scoreSummaryCoreOf——P3-1 口径并存的兜底
 * 定夺即「对齐到同一核心」）。进行中卷恒 finalized=false（调用方只在
 * draft 卷消费本函数；已收尾卷的结果视图走 buildResultData）。
 */
export function lessonLiveSummaryOf(
  rows: readonly ScoreSummaryRow[],
  attempt: Pick<Attempt, "scoreFinal">,
): AttemptScoreSummary {
  return {
    ...scoreSummaryCoreOf(rows, { finalized: false }),
    scoreFinal: attempt.scoreFinal,
  };
}

/** 得分汇总的判定计数部分（QM-12 起有效判定口径：教师判 > 自评 > 自动——
 *  与逐题徽章 verdictBadgeDisplayOf 同一显示口径，汇总与徽章不再漂移；
 *  未公布的受限形态由 buildResultData 覆写不泄露对错）。D9 的 scoreFinal/
 *  pendingCount 不在此算——前者取 attempt 行、后者走 pendingMarkCount
 *  （D4 共享谓词），由 buildResultData 组装进完整 AttemptScoreSummary */
export function scoreSummaryOf(
  rows: readonly AttemptResultQuestion[],
): Omit<AttemptScoreSummary, "scoreFinal" | "pendingCount"> {
  const total = rows.length;
  // #6980-3（审查修复 P1-4）：已答口径统一 responses.answered（判分写点落库），
  // 与题卡灰显「未做」、错题本入本同一事实；correct/wrong/pending 仍按 QM-12
  // 有效判定（教师判 > 自评 > 自动）——answered 与判定两维度正交
  const answered = rows.filter((r) => r.answered).length;
  let correct = 0;
  let wrong = 0;
  let pending = 0;
  let judged = 0;
  for (const item of rows) {
    // 有效判定（公布 gate 已过：selfReview/teacherMark/autoCorrect 均为真实值；
    // 未公布形态的覆写在 buildResultData）
    const effective = effectiveVerdictOf(
      item.autoCorrect,
      item.teacherMark,
      item.selfReview?.record ?? null,
    );
    if (effective === null) pending += 1;
    else {
      // 可判分分母与答错门正交（v2 口径）：未做判错仍进分母，不计错次
      judged += 1;
      if (effective.value) correct += 1;
      // #6980-3：未做不计错次，留在 unanswered（与教师详情/错题本同口径）
      else if (item.answered) wrong += 1;
    }
  }
  const autoGradable = judged;
  return {
    total,
    answered,
    correct,
    wrong,
    pending,
    unanswered: total - answered,
    autoGradable,
  };
}

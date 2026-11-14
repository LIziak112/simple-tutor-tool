import type {
  AttemptActivity,
  AttemptResultQuestion,
  AttemptResultUnit,
} from "@tutor/contract";
import { type ReviewGroupStats, reviewRetrainableOf } from "@tutor/contract";
import { reviewQuestionState } from "./result-review-model";

/**
 * 按模块（单元）看结果（2026-11-09 个人学习迭代模块 7 第一刀）：行测整卷模考
 * 以单元为模块，结果页按模块列「答对 / 作答 / 跳过 / 不确定但答对 / 活动用时 /
 * 参考配额」。全部由结果视图既有字段现算：
 * - 判定走 reviewQuestionState / verdictBadgeDisplayOf（与逐题徽章、汇总计数
 *   同一出处；未公布时对错一律 null，只给作答 / 跳过）；
 * - 「不确定但答对」= 做题时自标「不会」（studentFlag=unsure）且有效判定为对；
 * - 活动用时 = 模块内各题 activity.activeSec 之和（口径 v1）；卷无事件、或本
 *   模块没有任何题命中 activity.byQuestion（#101-01：别的模块有事件时本模块
 *   不能显示成 0 秒）都为 null，与逐题徽标「无可用记录」同口径；只看过另计
 *   observedSec；
 * - 参考配额 = 单元 practice.timeLimitMinutes 当前值（服务端随单元下发，可缺）。
 * 不在客户端判分，不新增任何实体。
 */
export interface ModuleResultStats {
  unitId: string;
  title: string;
  total: number;
  answered: number;
  /** 跳过 = 未作答（与题卡「未作答」同一事实 answered=false） */
  skipped: number;
  /** 以下三项未公布时为 null */
  correct: number | null;
  wrong: number | null;
  pending: number | null;
  /** 不确定但答对（studentFlag=unsure 且判对）；未公布 null */
  unsureCorrect: number | null;
  /** 题内活动用时合计（秒）；卷无事件、或本模块无任何题有事件记录为 null */
  activeSec: number | null;
  legacyTime?: boolean;
  observedSec: number;
  timeQuotaMinutes: number | null;
  /** 本模块可重练的题（已判定轮中：有效判定为错且已作答 / 教师已判 / 自评有记录，或标过不会） */
  wrongQuestionIds: string[];
  correctRate?: number | null;
  objectiveCount?: number;
  rubricAverages?: ReviewGroupStats["rubricAverages"];
}

/**
 * 该题在本卷是否已形成「已判定轮」——镜像服务端错题本的候选谓词
 * （wrong-questions.ts judgedRoundsByQuestion：finalCorrect 非空，或自评
 * verdict 与 at 均非空）。读侧 selfReviewRecordOf 已把「verdict 非空而 at
 * 缺失」的脏行降级为 record=null，所以 record 非空即两者齐备。
 */
export function isRetrainable(question: AttemptResultQuestion): boolean {
  return reviewRetrainableOf({
    ...question,
    selfReviewVerdict: question.selfReview?.record?.verdict ?? null,
  });
}

export function moduleResultStatsOf(
  unit: AttemptResultUnit,
  released: boolean,
  activity: AttemptActivity | undefined,
): ModuleResultStats {
  let answered = 0;
  let correct = 0;
  let wrong = 0;
  let pending = 0;
  let unsureCorrect = 0;
  let activeSec = 0;
  let observedSec = 0;
  // 本模块是否有任一题命中事件记录（没有 → 用时 null，不显示 0 秒）
  let hasActivity = false;
  const wrongQuestionIds: string[] = [];
  for (const question of unit.questions) {
    const state = reviewQuestionState(question, released);
    if (!state.unanswered) answered++;
    if (released) {
      if (state.verdict === true) {
        correct++;
        if (question.studentFlag === "unsure") unsureCorrect++;
      } else if (state.verdict === false) {
        if (!state.unanswered) wrong++;
      } else pending++;
      if (isRetrainable(question)) wrongQuestionIds.push(question.questionId);
    }
    const entry =
      question.time?.metric === "question_activity_sealed"
        ? question.time.value.state === "available"
          ? question.time.value
          : undefined
        : question.time?.metric === "legacy_focus"
          ? question.time.activeSec === null
            ? undefined
            : { activeSec: question.time.activeSec, observedSec: 0 }
          : activity?.byQuestion[question.questionId];
    if (entry !== undefined) {
      hasActivity = true;
      activeSec += entry.activeSec;
      observedSec += entry.observedSec;
    }
  }
  return {
    legacyTime: unit.questions.some((q) => q.time?.metric === "legacy_focus"),
    unitId: unit.id,
    title: unit.title,
    total: unit.questions.length,
    answered,
    skipped: unit.questions.length - answered,
    correct: released ? correct : null,
    wrong: released ? wrong : null,
    pending: released ? pending : null,
    unsureCorrect: released ? unsureCorrect : null,
    activeSec:
      hasActivity &&
      unit.questions.every(
        (q) =>
          !q.time ||
          (q.time.metric === "question_activity_sealed"
            ? q.time.value.state === "available"
            : q.time.activeSec !== null),
      )
        ? activeSec
        : null,
    observedSec,
    timeQuotaMinutes: unit.timeQuotaMinutes ?? null,
    wrongQuestionIds,
  };
}

import type {
  AttemptActivity,
  AttemptResultQuestion,
  AttemptResultUnit,
} from "@tutor/contract";
import { reviewQuestionState } from "./result-review-model";
import { verdictBadgeDisplayOf } from "./self-review-display";

/**
 * 按模块（单元）看结果（2026-11-09 个人学习迭代模块 7 第一刀）：行测整卷模考
 * 以单元为模块，结果页按模块列「答对 / 作答 / 跳过 / 不确定但答对 / 活动用时 /
 * 参考配额」。全部由结果视图既有字段现算：
 * - 判定走 reviewQuestionState / verdictBadgeDisplayOf（与逐题徽章、汇总计数
 *   同一出处；未公布时对错一律 null，只给作答 / 跳过）；
 * - 「不确定但答对」= 做题时自标「不会」（studentFlag=unsure）且有效判定为对；
 * - 活动用时 = 模块内各题 activity.activeSec 之和（口径 v1，卷无事件为 null）；
 *   只看过另计 observedSec；
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
  /** 题内活动用时合计（秒）；卷无事件记录为 null */
  activeSec: number | null;
  observedSec: number;
  timeQuotaMinutes: number | null;
  /** 本模块可重练的题（有效判定为错且已作答 / 教师已判 / 自评有记录，或标过不会） */
  wrongQuestionIds: string[];
}

/** 与结果页「练习本卷错题」同一圈题口径（AttemptResultView wrongQuestionIds） */
export function isRetrainable(question: AttemptResultQuestion): boolean {
  if (question.studentFlag === "unsure") return true;
  const badge = verdictBadgeDisplayOf(question);
  if (badge.verdict !== false) return false;
  return (
    question.answered ||
    question.teacherMark !== null ||
    (question.selfReview?.record?.verdict ?? null) !== null
  );
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
    const entry = activity?.byQuestion[question.questionId];
    if (entry !== undefined) {
      activeSec += entry.activeSec;
      observedSec += entry.observedSec;
    }
  }
  return {
    unitId: unit.id,
    title: unit.title,
    total: unit.questions.length,
    answered,
    skipped: unit.questions.length - answered,
    correct: released ? correct : null,
    wrong: released ? wrong : null,
    pending: released ? pending : null,
    unsureCorrect: released ? unsureCorrect : null,
    activeSec: activity === undefined ? null : activeSec,
    observedSec,
    timeQuotaMinutes: unit.timeQuotaMinutes ?? null,
    wrongQuestionIds,
  };
}

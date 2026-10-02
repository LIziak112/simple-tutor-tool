import type { WrongQuestionCard } from "@tutor/contract";

/**
 * 错题本攻克标准（2026-10 产品决策，与用户确认）：
 * - 学生自选，存**本设备 localStorage**（服务端不下发判定规则）；
 * - 宽松（lenient）= 做对 1 次即攻克（最后一轮 correct）；
 * - 严格（strict，默认）= 连续 2 次做对才攻克（最后两轮都 correct 且轮次 ≥2；
 *   两次在不同练习中——一次练习一题只答一次，天然满足，页面文案写清即可；
 *   中间做错重新计数）；
 * - /s/wrong 页的 tab 归属与首页概览卡计数**共用本模块同一数据源**
 * （全量形态 includeResolved=true），两处口径一致；做对的题永远不删，
 * 进「已攻克」分区随时可翻看。
 */

/** 攻克标准 */
export type WrongMasteryStandard = "strict" | "lenient";

/** localStorage 键（错题本攻克标准，本设备） */
export const WRONG_MASTERY_STORAGE_KEY = "tutor.wrong-mastery-standard";

/** 默认标准：严格（连续做对 2 次） */
export const DEFAULT_WRONG_MASTERY_STANDARD: WrongMasteryStandard = "strict";

/** 读取本设备攻克标准（坏值/未设置回退默认严格；localStorage 不可用时也回退） */
export function loadWrongMasteryStandard(): WrongMasteryStandard {
  try {
    const raw = window.localStorage.getItem(WRONG_MASTERY_STORAGE_KEY);
    if (raw === "strict" || raw === "lenient") return raw;
  } catch {
    // 隐私模式等场景 localStorage 抛异常：按默认口径继续，不打挂页面
  }
  return DEFAULT_WRONG_MASTERY_STANDARD;
}

/** 保存本设备攻克标准（坏环境静默失败——下次进页面仍按可读值/default） */
export function saveWrongMasteryStandard(standard: WrongMasteryStandard): void {
  try {
    window.localStorage.setItem(WRONG_MASTERY_STORAGE_KEY, standard);
  } catch {
    // 同上：存储不可用只影响「本设备记忆」，不影响本次会话内的切换
  }
}

/**
 * 是否已攻克：按标准从轮次史（rounds，服务端保证按时间升序）计算。
 * 空 rounds（防御，正常数据不会出现）恒未攻克。
 */
export function isConquered(
  question: Pick<WrongQuestionCard, "rounds">,
  standard: WrongMasteryStandard,
): boolean {
  const rounds = question.rounds;
  const last = rounds[rounds.length - 1];
  if (last === undefined) return false;
  if (standard === "lenient") return last.correct;
  const prev = rounds[rounds.length - 2];
  return last.correct && (prev?.correct ?? false);
}

/** 按攻克标准分流（待复习 / 已攻克）；组内顺序保持入参顺序（页面自行排序） */
export function splitByMastery(
  questions: WrongQuestionCard[],
  standard: WrongMasteryStandard,
): { pending: WrongQuestionCard[]; conquered: WrongQuestionCard[] } {
  const pending: WrongQuestionCard[] = [];
  const conquered: WrongQuestionCard[] = [];
  for (const question of questions) {
    if (isConquered(question, standard)) conquered.push(question);
    else pending.push(question);
  }
  return { pending, conquered };
}

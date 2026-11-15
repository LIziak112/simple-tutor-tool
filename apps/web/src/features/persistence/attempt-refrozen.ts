import type { AttemptSummary } from "@tutor/contract";

/**
 * 这份卷是不是被按新题目重冻过（卷号不变、冻结时刻前进）。
 *
 * 「冻结时刻不等于开卷时刻」有两种来历：没动过的卷再次进入时按新题目重冻；
 * 或者是 2026-10 升级前建的卷，升级后第一次打开才补的冻结（详情里
 * legacyUnverified 为真）。后一种服务端从不重冻、也不向它要版本凭据，题面
 * 没有变过，不能当成重冻——否则做过它的设备会一直停在「练习内容已更新」上。
 *
 * 只对已激活的遗留卷这样认。未激活的遗留卷加上本机稿仍按重冻处理：隔离，
 * 不凭这份本机稿去激活它。
 */
export function attemptRefrozen(
  attempt: AttemptSummary,
  legacyUnverified = false,
): boolean {
  if (activatedLegacy(attempt, legacyUnverified)) return false;
  return attempt.frozenAt != null && attempt.frozenAt !== attempt.startedAt;
}

/** 已激活的遗留懒冻结卷：题面从补冻结起没有变过。 */
export function activatedLegacy(
  attempt: AttemptSummary,
  legacyUnverified: boolean,
): boolean {
  return legacyUnverified && attempt.activatedAt != null;
}

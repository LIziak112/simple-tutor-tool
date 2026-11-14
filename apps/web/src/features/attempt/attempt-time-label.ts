import type { AttemptTime, ResponseTime } from "@tutor/contract";
import { formatActivitySec } from "./QuestionActivity";
/** 所有最终出口使用服务端封存值；历史和缺证必须可辨。 */
export function attemptTimeLabel(time: AttemptTime | undefined): string {
  if (!time) return "用时无可用记录";
  if (time.metric === "legacy_focus")
    return `历史焦点用时 ${time.activeSec === null ? "无可用记录" : formatActivitySec(time.activeSec)}`;
  return time.activeSec === null
    ? `活动用时未完整记录（${time.knownCount}/${time.memberCount} 题；已知 ${formatActivitySec(time.knownActiveSec)}）`
    : `活动用时 ${formatActivitySec(time.activeSec)}`;
}
export function responseTimeLabel(time: ResponseTime | undefined): string {
  if (!time) return "用时无可用记录";
  if (time.metric === "legacy_focus")
    return `历史焦点用时 ${time.activeSec === null ? "无可用记录" : formatActivitySec(time.activeSec)}`;
  return time.value.state === "unknown"
    ? "活动用时未记录"
    : `活动用时 ${formatActivitySec(time.value.activeSec)}`;
}

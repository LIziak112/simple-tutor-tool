import type { AttemptActivity, QuestionActivity } from "@tutor/contract";

/**
 * 题内活动用时（2026-11-09 个人学习迭代模块 2 补刀；口径 v1 见
 * packages/contract/src/attempt-activity.ts）的结果页呈现：
 * - 卷级一行（ResultActivityLine）：活动合计 / 只看过合计 / 未归属，与考试时钟
 *   （ResultTimeLimitLine）分开显示，不混算；
 * - 题级一枚（QuestionActivityBadge）：活动用时 / 看过（无作答动作）/ 看到过
 *   无作答记录 / 无可用记录。
 * 全部按服务端现算结果渲染，前端不做二次推断；旧卷无事件 → 「无可用记录」。
 */

/** 口径说明（title 提示 + 卷级行括注共用） */
export const ACTIVITY_CALIBER_LABEL =
  "口径 v1：前台聚焦且有作答动作的时段；页面隐藏、长时间无操作不计；多端同时作答不同题的重叠时段记未归属";

/** 秒 → 「X 分 Y 秒」/「Y 秒」/「X 分钟」（整分省秒；0 → 「0 秒」） */
export function formatActivitySec(sec: number): string {
  const whole = Math.max(0, Math.round(sec));
  if (whole < 60) return `${whole} 秒`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`;
}

/** 题级文案（纯函数，便于测试与复用） */
export function questionActivityLabel(
  activity: QuestionActivity | undefined,
): string {
  if (activity === undefined) return "无可用记录";
  if (activity.activeSec > 0) {
    return `活动用时 ${formatActivitySec(activity.activeSec)}`;
  }
  if (activity.observedSec > 0) {
    return `看过 ${formatActivitySec(activity.observedSec)}（无作答动作）`;
  }
  if (activity.actions > 0) return "有作答动作，用时不足 1 秒";
  return activity.viewed ? "看到过，无作答记录" : "无可用记录";
}

/** 题级徽标：挂在结果题卡标题行末；卷无事件（attempt 级缺省）时不渲染 */
export function QuestionActivityBadge({
  activity,
}: {
  activity: QuestionActivity | undefined;
}) {
  return (
    <span
      data-slot="question-activity"
      title={ACTIVITY_CALIBER_LABEL}
      className="rounded-full bg-muted px-2.5 py-1 text-xs tabular-nums text-muted-foreground"
    >
      {questionActivityLabel(activity)}
    </span>
  );
}

/** 卷级一行：无事件（undefined）也渲染，标「无可用记录」，让旧卷与新卷口径可辨 */
export function ResultActivityLine({
  activity,
}: {
  activity: AttemptActivity | undefined;
}) {
  if (activity === undefined) {
    return (
      <p
        data-testid="result-activity"
        className="text-sm leading-relaxed text-muted-foreground"
      >
        题内活动用时：无可用记录
      </p>
    );
  }
  const parts = [`题内活动合计 ${formatActivitySec(activity.activeSecTotal)}`];
  if (activity.observedSecTotal > 0) {
    parts.push(`只看过 ${formatActivitySec(activity.observedSecTotal)}`);
  }
  if (activity.unattributedSec > 0) {
    parts.push(
      `未归属 ${formatActivitySec(activity.unattributedSec)}（最多 ${activity.concurrentSessionsMax} 端同开）`,
    );
  }
  return (
    <p
      data-testid="result-activity"
      title={ACTIVITY_CALIBER_LABEL}
      className="text-sm leading-relaxed text-muted-foreground"
    >
      {parts.join(" · ")}
      <span className="text-xs">（口径 v1）</span>
    </p>
  );
}

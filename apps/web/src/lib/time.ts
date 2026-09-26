import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import relativeTime from "dayjs/plugin/relativeTime";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);

/** 界面统一显示时区（§0.3：库存/传输 UTC，显示 Asia/Shanghai） */
export const DISPLAY_TZ = "Asia/Shanghai";

/** UTC ISO 字符串 → Asia/Shanghai 本地格式 */
export function formatCnTime(utcIso: string): string {
  return dayjs.utc(utcIso).tz(DISPLAY_TZ).format("YYYY年M月D日 HH:mm:ss");
}

/**
 * UTC ISO 字符串 → 中文相对时间（"3 分钟前"，UI 约定：相对时间优先）。
 * now 可注入以便测试；缺省当前时间。
 */
export function formatRelativeTime(
  utcIso: string,
  now: Date = new Date(),
): string {
  return dayjs
    .utc(utcIso)
    .tz(DISPLAY_TZ)
    .locale("zh-cn")
    .from(dayjs(now), false);
}

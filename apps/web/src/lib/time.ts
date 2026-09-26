import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

dayjs.extend(utc);
dayjs.extend(timezone);

/** 界面统一显示时区（§0.3：库存/传输 UTC，显示 Asia/Shanghai） */
export const DISPLAY_TZ = "Asia/Shanghai";

/** UTC ISO 字符串 → Asia/Shanghai 本地格式 */
export function formatCnTime(utcIso: string): string {
  return dayjs.utc(utcIso).tz(DISPLAY_TZ).format("YYYY年M月D日 HH:mm:ss");
}

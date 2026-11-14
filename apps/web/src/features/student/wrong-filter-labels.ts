export const WRONG_DAYS_OPTIONS = [7, 30, 90] as const;
export const WRONG_DAYS_LABELS: Record<
  (typeof WRONG_DAYS_OPTIONS)[number],
  string
> = {
  7: "最近 7 天",
  30: "最近 30 天",
  90: "最近 90 天",
};
export function wrongDaysLabel(days: number): string {
  return (
    WRONG_DAYS_LABELS[days as (typeof WRONG_DAYS_OPTIONS)[number]] ??
    `最近 ${days} 天`
  );
}
export const WRONG_MIN_OPTIONS = [2, 3] as const;
export const WRONG_MIN_LABELS: Record<
  (typeof WRONG_MIN_OPTIONS)[number],
  string
> = {
  2: "错 2 次及以上",
  3: "错 3 次及以上",
};
export function wrongMinLabel(min: number): string {
  return (
    WRONG_MIN_LABELS[min as (typeof WRONG_MIN_OPTIONS)[number]] ??
    `错 ${min} 次及以上`
  );
}

/** 重试退避基数：nextRunAt = 失败时刻 + base × 2^retryCount（封顶 MAX） */
export const AI_TASK_RETRY_BACKOFF_BASE_MS = 30_000;

/** 重试退避封顶（10 分钟） */
export const AI_TASK_RETRY_BACKOFF_MAX_MS = 10 * 60 * 1000;

/** 退避毫秒：失败时 retryCount 越多重试等待越久（封顶 MAX） */
export function retryBackoffMs(retryCountAtFailure: number): number {
  return Math.min(
    AI_TASK_RETRY_BACKOFF_BASE_MS * 2 ** retryCountAtFailure,
    AI_TASK_RETRY_BACKOFF_MAX_MS,
  );
}

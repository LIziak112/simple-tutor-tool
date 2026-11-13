export class RequestDeadlineError extends Error {
  constructor(operation: string) {
    super(`${operation}超时，请检查网络后重试`);
    this.name = "RequestDeadlineError";
  }
}

/** 期限覆盖连接与响应体。主动中止和超时沿用各自的错误身份。 */
export function withRequestDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
  operation: string,
  upstream?: AbortSignal,
  timeoutError: () => Error = () => new RequestDeadlineError(operation),
): Promise<T> {
  const aborted = () => new DOMException(`${operation}已取消`, "AbortError");
  if (upstream?.aborted) return Promise.reject(aborted());
  const controller = new AbortController();
  let stop: (reason: Error) => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = (reason) => {
      reject(reason);
      controller.abort();
    };
  });
  const onAbort = () => stop(aborted());
  upstream?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop(timeoutError()), 30_000);
  const response = new Promise<T>((resolve) =>
    resolve(request(controller.signal)),
  );
  return Promise.race([response, stopped]).finally(() => {
    clearTimeout(timer);
    upstream?.removeEventListener("abort", onAbort);
  });
}

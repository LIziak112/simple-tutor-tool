import { replaceEqualDeep } from "@tanstack/react-query";
import type { AttemptDetailData } from "@tutor/contract";

// 版本只与持有的响应对象同寿命，清理账号查询时无需另清一份缓存。
const attemptDetailEtags = new WeakMap<object, string>();

export function shareAttemptDetail(previous: unknown, next: unknown): unknown {
  const shared = replaceEqualDeep(previous, next);
  if (
    typeof next === "object" &&
    next !== null &&
    typeof shared === "object" &&
    shared !== null
  ) {
    const etag = attemptDetailEtags.get(next);
    if (etag === undefined) attemptDetailEtags.delete(shared);
    else attemptDetailEtags.set(shared, etag);
  }
  return shared;
}

export class AttemptDetailReadTimeoutError extends Error {
  constructor() {
    super("读取练习超时，请检查网络后重试");
    this.name = "AttemptDetailReadTimeoutError";
  }
}

/** 同一个期限覆盖响应头和完整响应体。 */
function withAttemptDetailDeadline<T>(
  signal: AbortSignal | undefined,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const aborted = () => new DOMException("练习读取已取消", "AbortError");
  if (signal?.aborted) return Promise.reject(aborted());
  const controller = new AbortController();
  let rejectStopped: (reason: Error) => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  const stop = (reason: Error) => {
    if (controller.signal.aborted) return;
    rejectStopped(reason);
    controller.abort();
  };
  const onAbort = () => stop(aborted());
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => stop(new AttemptDetailReadTimeoutError()),
    30_000,
  );
  return Promise.race([request(controller.signal), stopped]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  });
}

export function readAttemptDetail(
  attemptId: string,
  signal: AbortSignal | undefined,
  cached: AttemptDetailData | undefined,
  send: (init: RequestInit) => Promise<Response>,
  decode: (
    request: () => Promise<Response>,
    reuse: (response: Response) => AttemptDetailData | undefined,
  ) => Promise<AttemptDetailData>,
): Promise<AttemptDetailData> {
  const etag =
    cached?.attempt.id === attemptId
      ? attemptDetailEtags.get(cached)
      : undefined;
  return withAttemptDetailDeadline(signal, async (signal) => {
    const headers = new Headers();
    if (etag !== undefined) headers.set("If-None-Match", etag);
    let responseTag: string | null = null;
    const detail = await decode(
      () => send({ signal, cache: "no-store", headers }),
      (response) => {
        responseTag = response.headers.get("ETag");
        return response.status === 304 &&
          etag !== undefined &&
          responseTag === etag
          ? cached
          : undefined;
      },
    );
    if (responseTag !== null) attemptDetailEtags.set(detail, responseTag);
    return detail;
  });
}

/** 手动桥接以覆盖仍受支持、没有AbortSignal.any的浏览器。 */
export function combineScopeSignal(
  owner: AbortSignal,
  caller: AbortSignal | null,
) {
  if (caller === null || caller === owner)
    return { signal: owner, finish: () => {} };
  const controller = new AbortController();
  const finish = () => {
    owner.removeEventListener("abort", fromOwner);
    caller.removeEventListener("abort", fromCaller);
  };
  const abort = (signal: AbortSignal) => {
    controller.abort(signal.reason);
    finish();
  };
  const fromOwner = () => abort(owner);
  const fromCaller = () => abort(caller);
  if (owner.aborted) abort(owner);
  else if (caller.aborted) abort(caller);
  else {
    owner.addEventListener("abort", fromOwner, { once: true });
    caller.addEventListener("abort", fromCaller, { once: true });
  }
  return { signal: controller.signal, finish };
}
async function readWhileCurrent(
  operation: () => Promise<unknown>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let onAbort = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([operation(), stopped]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
function guardedBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  finish: () => void,
) {
  const reader = body.getReader();
  let ended = false;
  let sink: ReadableStreamDefaultController<Uint8Array> | undefined;
  const settle = () => {
    ended = true;
    signal.removeEventListener("abort", abort);
    finish();
  };
  const abort = () => {
    if (ended) return;
    void reader.cancel(signal.reason).catch(() => {});
    sink?.error(signal.reason);
    settle();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      if (ended) return;
      try {
        signal.throwIfAborted();
        const next = await reader.read();
        signal.throwIfAborted();
        if (next.done) {
          controller.close();
          settle();
        } else controller.enqueue(next.value);
      } catch (error) {
        if (!ended) {
          controller.error(signal.aborted ? signal.reason : error);
          settle();
        }
      }
    },
    cancel(reason) {
      settle();
      return reader.cancel(reason);
    },
  });
}
/** fetch只保证响应头已到；正文消费与原始流同样必须受主体租约保护。 */
export function guardScopeResponse(
  response: Response,
  owner: AbortSignal,
  caller: AbortSignal | null,
  finish: () => void,
): Response {
  owner.throwIfAborted();
  caller?.throwIfAborted();
  let stream: ReadableStream<Uint8Array> | null | undefined;
  if (response.body === null) finish();
  return new Proxy(response, {
    get(target, key) {
      if (key === "body") {
        owner.throwIfAborted();
        caller?.throwIfAborted();
        if (stream === undefined) {
          const body = target.body;
          if (body === null) stream = null;
          else {
            const current = combineScopeSignal(owner, caller);
            stream = guardedBody(body, current.signal, () => {
              current.finish();
              finish();
            });
          }
        }
        return stream;
      }
      if (key === "clone")
        return () => guardScopeResponse(target.clone(), owner, caller, finish);
      const value: unknown = Reflect.get(target, key, target);
      if (
        ["json", "text", "blob", "arrayBuffer", "formData", "bytes"].includes(
          String(key),
        ) &&
        typeof value === "function"
      )
        return async () => {
          const current = combineScopeSignal(owner, caller);
          try {
            return await readWhileCurrent(
              () => value.call(target),
              current.signal,
            );
          } finally {
            current.finish();
            finish();
          }
        };
      owner.throwIfAborted();
      caller?.throwIfAborted();
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

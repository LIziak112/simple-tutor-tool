import { combineScopeSignal, guardScopeResponse } from "./response-scope";
export interface SubjectIdentity {
  readonly type: "student" | "teacher";
  readonly id: string;
  readonly portal?: string;
  readonly pairedSubjectId?: string;
}
/** 每个已确认主体独占不可重绑租约；切账号仅关闭旧租约，不替换其客户端。 */
export function createSubjectScope(
  subject: SubjectIdentity,
  send: typeof fetch,
) {
  const controller = new AbortController();
  let holders = 0;
  const close = () =>
    controller.abort(
      Object.assign(new Error("账号或门户已变化"), { name: "AbortError" }),
    );
  const retain = () => {
    holders++;
    return () => {
      holders--;
      queueMicrotask(() => {
        if (holders === 0) close();
      });
    };
  };
  const assertCurrent = () => controller.signal.throwIfAborted();
  const scopedFetch: typeof fetch = async (input, init) => {
    assertCurrent();
    const caller =
      init?.signal ?? (input instanceof Request ? input.signal : null);
    const { signal, finish } = combineScopeSignal(controller.signal, caller);
    try {
      signal.throwIfAborted();
      const response = await send(input, { ...init, signal });
      signal.throwIfAborted();
      return guardScopeResponse(response, controller.signal, caller, finish);
    } catch (error) {
      finish();
      throw error;
    }
  };
  const xhr = () => {
    assertCurrent();
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    controller.signal.addEventListener("abort", abort, { once: true });
    request.addEventListener(
      "loadend",
      () => controller.signal.removeEventListener("abort", abort),
      { once: true },
    );
    const send = request.send.bind(request);
    request.send = (body) => {
      assertCurrent();
      send(body);
    };
    return request;
  };
  return Object.freeze({
    subject: Object.freeze({ ...subject }),
    signal: controller.signal,
    fetch: scopedFetch,
    xhr,
    assertCurrent,
    close,
    retain,
  });
}
export type SubjectScope = ReturnType<typeof createSubjectScope>;

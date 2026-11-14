import { describe, expect, it, vi } from "vitest";
import { createSubjectScope } from "./subject-scope";

describe("门户请求捕获不可变主体租约", () => {
  it("旧主体关闭后拒绝新请求，绝不借用后来主体", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const old = createSubjectScope({ type: "student", id: "old" }, send);
    old.close();
    const current = createSubjectScope({ type: "student", id: "new" }, send);
    await expect(old.fetch("/api/student/me")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(send).not.toHaveBeenCalled();
    await current.fetch("/api/student/me");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("即使底层忽略abort，旧请求迟到回执也不返回给调用方", async () => {
    let finish: ((response: Response) => void) | undefined;
    const scope = createSubjectScope(
      { type: "student", id: "old" },
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = scope.fetch("/api/student/me");
    scope.close();
    finish?.(new Response("{}"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
  it("保留调用者abort且不会把只读主体身份作为认证凭据发送", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const scope = createSubjectScope({ type: "teacher", id: "t" }, send);
    const caller = new AbortController();
    await scope.fetch("/api/teacher/me", { signal: caller.signal });
    const init = send.mock.calls[0]?.[1];
    expect(init?.signal).not.toBe(caller.signal);
    caller.abort();
    expect(init?.signal?.aborted).toBe(true);
    expect(new Headers(init?.headers).has("x-user-id")).toBe(false);
  });
});
it("响应头先到而JSON正文迟到时仍拒绝旧主体数据", async () => {
  let finish = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      finish = () => {
        controller.enqueue(new TextEncoder().encode('{"data":"旧主体"}'));
        controller.close();
      };
    },
  });
  const scope = createSubjectScope(
    { type: "student", id: "old" },
    async () => new Response(body),
  );
  const response = await scope.fetch("/api/student/me");
  const pending = response.json();
  scope.close();
  try {
    finish();
  } catch {
    /* 底层已被取消时不再投递 */
  }
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});
it("原始正文流也不能在主体关闭后继续交付字节", async () => {
  let close = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => controller.close();
    },
  });
  const scope = createSubjectScope(
    { type: "student", id: "old" },
    async () => new Response(body),
  );
  const response = await scope.fetch("/api/student/doc");
  const pending = response.body?.getReader().read();
  scope.close();
  try {
    close();
  } catch {
    /* 已取消 */
  }
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});
it("不依赖较新浏览器的AbortSignal.any仍合并主体和调用方取消", async () => {
  const unsupported = vi.spyOn(AbortSignal, "any").mockImplementation(() => {
    throw new Error("旧浏览器没有此能力");
  });
  try {
    const scope = createSubjectScope(
      { type: "student", id: "s" },
      async () => new Response("{}"),
    );
    const caller = new AbortController();
    const response = await scope.fetch("/api/student/me", {
      signal: caller.signal,
    });
    caller.abort();
    await expect(response.json()).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    unsupported.mockRestore();
  }
});
it("StrictMode释放后同步重新持有不会关闭，新持有结束后才关闭", async () => {
  const scope = createSubjectScope(
    { type: "student", id: "s" },
    async () => new Response("{}"),
  );
  const release = scope.retain();
  release();
  const second = scope.retain();
  await Promise.resolve();
  expect(scope.signal.aborted).toBe(false);
  second();
  await Promise.resolve();
  expect(scope.signal.aborted).toBe(true);
});
it("消费一个副本结束传输后，其他副本仍不能绕过主体关闭", async () => {
  const scope = createSubjectScope(
    { type: "student", id: "s" },
    async () => new Response('{"secret":"旧主体"}'),
  );
  const caller = new AbortController();
  const response = await scope.fetch("/api/student/me", {
    signal: caller.signal,
  });
  const second = response.clone();
  await response.json();
  scope.close();
  await expect(second.json()).rejects.toMatchObject({ name: "AbortError" });
});
it("无正文的条件命中回执也不能在主体切换后复用旧缓存", async () => {
  const scope = createSubjectScope(
    { type: "student", id: "s" },
    async () => new Response(null, { status: 304 }),
  );
  const response = await scope.fetch("/api/student/attempt");
  scope.close();
  expect(() => response.status).toThrow();
});

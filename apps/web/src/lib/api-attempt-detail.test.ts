import { afterEach, describe, expect, it, vi } from "vitest";
import { AttemptDetailReadTimeoutError, fetchAttemptApi } from "./api";
import { shareAttemptDetail } from "./attempt-detail-read";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("练习详情读取期限", () => {
  it("结构共享保留新响应的版本，即使复用相同的旧对象", async () => {
    const response = (etag: string) =>
      new Response(
        JSON.stringify({ ok: true, data: { attempt: { id: "a" } } }),
        { headers: { ETag: etag } },
      );
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(response('W/"one"'))
      .mockResolvedValueOnce(response('W/"two"'))
      .mockResolvedValueOnce(
        new Response(null, { status: 304, headers: { ETag: 'W/"two"' } }),
      );
    vi.stubGlobal("fetch", fetchSpy);
    const previous = await fetchAttemptApi("a");
    const refreshed = await fetchAttemptApi("a", undefined, previous);
    expect(shareAttemptDetail(previous, refreshed)).toBe(previous);
    expect(await fetchAttemptApi("a", undefined, previous)).toBe(previous);
    const options = fetchSpy.mock.calls[2]?.[1] as RequestInit;
    expect(new Headers(options.headers).get("if-none-match")).toBe('W/"two"');
  });

  it("仅对持有的详情发送版本，304 复用原详情对象", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, data: { attempt: { id: "a" } } }),
          { headers: { ETag: 'W/"draft-a"' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 304, headers: { ETag: 'W/"draft-a"' } }),
      );
    vi.stubGlobal("fetch", fetchSpy);
    const cached = await fetchAttemptApi("a");
    expect(await fetchAttemptApi("a", undefined, cached)).toBe(cached);
    const options = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(options.headers).get("if-none-match")).toBe(
      'W/"draft-a"',
    );
  });

  it("请求已发出但 headers 永不返回时，终止本轮并允许新一轮读取", async () => {
    vi.useFakeTimers();
    let resolveOld: ((response: Response) => void) | undefined;
    const fetchSpy = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, data: { attempt: { id: "new" } } }),
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);
    let outcome = "pending";
    let failure: unknown;
    void fetchAttemptApi("a").then(
      () => {
        outcome = "unexpected-success";
      },
      (error: unknown) => {
        failure = error;
        outcome = error instanceof Error ? error.message : String(error);
      },
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(outcome).toMatch(/读取练习超时/);
    expect(failure).toBeInstanceOf(AttemptDetailReadTimeoutError);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal?.aborted).toBe(true);
    const fresh = await fetchAttemptApi("a");
    expect(fresh.attempt.id).toBe("new");
    resolveOld?.(
      new Response(
        JSON.stringify({ ok: true, data: { attempt: { id: "old" } } }),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toMatch(/读取练习超时/);
    expect(fresh.attempt.id).toBe("new");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("收到 headers 但响应体永不结束时，同一期限仍结束读取", async () => {
    vi.useFakeTimers();
    const response = new Response("{}", { status: 200 });
    vi.spyOn(response, "json").mockImplementation(
      () => new Promise<never>(() => {}),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    let outcome = "pending";
    let failure: unknown;
    void fetchAttemptApi("a").then(
      () => {
        outcome = "unexpected-success";
      },
      (error: unknown) => {
        failure = error;
        outcome = error instanceof Error ? error.message : String(error);
      },
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(outcome).toMatch(/读取练习超时/);
    expect(failure).toBeInstanceOf(AttemptDetailReadTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("响应体等待期间取消旧账号读取，旧结果晚到也不能接管新读取", async () => {
    vi.useFakeTimers();
    let resolveBody: ((value: unknown) => void) | undefined;
    const oldResponse = new Response("{}", { status: 200 });
    const oldJson = vi.spyOn(oldResponse, "json").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBody = resolve;
        }),
    );
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(oldResponse)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, data: { attempt: { id: "new" } } }),
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);
    const oldController = new AbortController();
    const oldRead = fetchAttemptApi("same-attempt", oldController.signal);
    await vi.waitFor(() => expect(oldJson).toHaveBeenCalled());
    oldController.abort();
    await expect(oldRead).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
    const oldInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(oldInit?.signal?.aborted).toBe(true);

    const fresh = await fetchAttemptApi("same-attempt");
    expect(fresh.attempt.id).toBe("new");
    resolveBody?.({ ok: true, data: { attempt: { id: "old" } } });
    await vi.advanceTimersByTimeAsync(0);
    await expect(oldRead).rejects.toMatchObject({ name: "AbortError" });
    expect(fresh.attempt.id).toBe("new");
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PersonalSessionData } from "@tutor/contract";
import { expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-response";
import {
  createTestRuntime,
  TestPortalProvider,
  testClientServices,
} from "@/test/portal-fixture";
import { act, renderHook, waitFor } from "@/test/render-with-portal";
import { useApplyPersonalAuthed } from "./teacher-auth";
import { usePersonalPair } from "./use-personal-pair";

const pair = {
  teacher: { id: "t", accountKind: "personal" },
  student: { id: "s", accountKind: "personal" },
} as PersonalSessionData;
it("同账号的新租约重新核验，旧租约迟到不能认证新门户", async () => {
  let resolveFirst: ((value: PersonalSessionData | null) => void) | undefined;
  const first = {
    ...testClientServices,
    checkPersonalSessionApi: vi.fn(
      () =>
        new Promise<PersonalSessionData | null>((resolve) => {
          resolveFirst = resolve;
        }),
    ),
  };
  const second = {
    ...testClientServices,
    checkPersonalSessionApi: vi.fn(async () => pair),
  };
  let runtime = createTestRuntime({ clients: first });
  const accepted = vi.fn();
  const cache = new QueryClient();
  cache.setQueryData(["student", "me"], pair.student);
  cache.setQueryData(["teacher", "me"], pair.teacher);
  const result = renderHook(() => usePersonalPair("student", "s", accepted), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={cache}>
        <TestPortalProvider runtime={runtime}>{children}</TestPortalProvider>
      </QueryClientProvider>
    ),
  });
  expect(result.result.current.status).toBe("pending");
  runtime = createTestRuntime({ clients: second });
  result.rerender();
  await waitFor(() => expect(result.result.current.status).toBe("verified"));
  await act(async () => resolveFirst?.(null));
  expect(result.result.current.status).toBe("verified");
  expect(accepted).toHaveBeenCalledTimes(1);
  runtime = createTestRuntime({ clients: first });
  result.rerender();
  expect(result.result.current.status).toBe("pending");
});
it("双会话不配对或返回另一主体时不展示门户", async () => {
  let response: PersonalSessionData | null = null;
  const clients = {
    ...testClientServices,
    checkPersonalSessionApi: vi.fn(async () => response),
  };
  const accepted = vi.fn();
  const runtime = createTestRuntime({ clients });
  const cache = new QueryClient();
  cache.setQueryData(["student", "me"], pair.student);
  cache.setQueryData(["teacher", "me"], pair.teacher);
  const result = renderHook(() => usePersonalPair("student", "s", accepted), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={cache}>
        <TestPortalProvider runtime={runtime}>{children}</TestPortalProvider>
      </QueryClientProvider>
    ),
  });
  await waitFor(() => expect(result.result.current.status).toBe("login"));
  response = pair;
  await act(async () => result.result.current.retry());
  await waitFor(() => expect(result.result.current.status).toBe("verified"));
  response = { ...pair, student: { ...pair.student, id: "other" } };
  await act(async () => result.result.current.retry());
  await waitFor(() => expect(result.result.current.status).toBe("error"));
  expect(accepted).toHaveBeenCalledTimes(1);
});

for (const timing of ["before-result", "after-own-commit"] as const)
  it(`pair恢复${timing}外部身份变化不得认领verified`, async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    cache.setQueryData(["student", "me"], pair.student);
    cache.setQueryData(
      ["teacher", "me"],
      timing === "after-own-commit"
        ? { ...pair.teacher, id: "old-t" }
        : pair.teacher,
    );
    let release: (data: PersonalSessionData) => void = () => {};
    const clients = {
      ...testClientServices,
      checkPersonalSessionApi: vi.fn(
        () =>
          new Promise<PersonalSessionData>((resolve) => {
            release = resolve;
          }),
      ),
    };
    let changed = false;
    const stop = cache.getQueryCache().subscribe((event) => {
      if (
        timing === "after-own-commit" &&
        event.type === "updated" &&
        event.action.type === "success" &&
        event.query.queryKey[0] === "teacher" &&
        (event.query.state.data as { id: string })?.id === pair.teacher.id &&
        !changed
      ) {
        changed = true;
        queueMicrotask(() =>
          cache.setQueryData(["teacher", "me"], pair.teacher),
        );
      }
    });
    const result = renderHook(
      () => {
        const apply = useApplyPersonalAuthed();
        return usePersonalPair(
          "student",
          pair.student.id,
          async (data, operation) => {
            await apply(data, operation);
          },
        );
      },
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={cache}>
            <TestPortalProvider runtime={createTestRuntime({ clients })}>
              {children}
            </TestPortalProvider>
          </QueryClientProvider>
        ),
      },
    );
    await waitFor(() =>
      expect(clients.checkPersonalSessionApi).toHaveBeenCalled(),
    );
    await act(async () => {
      if (timing === "before-result")
        cache.setQueryData(["teacher", "me"], {
          ...pair.teacher,
          id: "external-b",
        });
      release(pair);
    });
    await waitFor(() => expect(result.result.current.status).toBe("error"));
    if (timing === "before-result")
      expect(cache.getQueryData<{ id: string }>(["teacher", "me"])?.id).toBe(
        "external-b",
      );
    stop();
    result.unmount();
    cache.clear();
  });

for (const outcome of ["null", "401"] as const)
  it(`pair ${outcome}排队登录在最终消费前同ID写入后不得导航，且可重试`, async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    cache.setQueryData(["student", "me"], pair.student);
    cache.setQueryData(["teacher", "me"], pair.teacher);
    let fail = true;
    const clients = {
      ...testClientServices,
      checkPersonalSessionApi: vi.fn(async () => {
        if (!fail) return pair;
        if (outcome === "401")
          throw new ApiError("UNAUTHORIZED", "真实401", 401);
        return null;
      }),
    };
    const runtime = createTestRuntime({ clients });
    const view = renderHook(() => usePersonalPair("student", "s", vi.fn()), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={cache}>
          <TestPortalProvider runtime={runtime}>{children}</TestPortalProvider>
        </QueryClientProvider>
      ),
    });
    await waitFor(() => expect(view.result.current.status).toBe("login"));
    const navigate = vi.fn();
    act(() => {
      cache.setQueryData(["teacher", "me"], pair.teacher);
      view.result.current.consumeLogin(navigate);
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(view.result.current.status).toBe("error");
    fail = false;
    act(() => view.result.current.retry());
    await waitFor(() => expect(view.result.current.status).toBe("verified"));
    view.unmount();
    cache.clear();
  });
it("当前有效pair401消费正常登录且释放操作监听", async () => {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  cache.setQueryData(["student", "me"], pair.student);
  cache.setQueryData(["teacher", "me"], pair.teacher);
  const runtime = createTestRuntime({
    clients: {
      ...testClientServices,
      checkPersonalSessionApi: vi.fn(async () => {
        throw new ApiError("UNAUTHORIZED", "真实401", 401);
      }),
    },
  });
  const view = renderHook(() => usePersonalPair("student", "s", vi.fn()), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={cache}>
        <TestPortalProvider runtime={runtime}>{children}</TestPortalProvider>
      </QueryClientProvider>
    ),
  });
  await waitFor(() => expect(view.result.current.status).toBe("login"));
  const navigate = vi.fn();
  act(() => view.result.current.consumeLogin(navigate));
  expect(navigate).toHaveBeenCalledOnce();
  expect(cache.getQueryCache().hasListeners()).toBe(false);
  view.unmount();
  cache.clear();
});

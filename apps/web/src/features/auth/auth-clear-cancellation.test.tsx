import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import {
  createTestRuntime,
  TestPortalProvider,
  testClientServices,
} from "@/test/portal-fixture";
import { act, renderHook, waitFor } from "@/test/render-with-portal";
import { useLogoutPersonal } from "./personal-auth";
import { useClearStudentSession, useLogoutStudent } from "./student-auth";
import { useClearTeacherSession, useLogoutTeacher } from "./teacher-auth";

for (const kind of [
  "clear-student",
  "clear-teacher",
  "logout-student",
  "logout-teacher",
  "logout-paired",
  "logout-single",
] as const)
  it(`${kind}等待清理期间被外部B替换，不reset不onCleared`, async () => {
    const cache = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    cache.setQueryData(["student", "me"], { id: "sa" });
    cache.setQueryData(["teacher", "me"], { id: "ta" });
    let release = () => {};
    const cancel = vi.spyOn(cache, "cancelQueries").mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const done = vi.fn();
    const reset = vi.spyOn(cache, "resetQueries");
    const clients = {
      ...testClientServices,
      logoutStudentApi: vi.fn(async () => null),
      logoutTeacher: vi.fn(async () => null),
      logoutPersonalApi: vi.fn(async () => ({
        paired: kind === "logout-paired",
      })),
    };
    const view = renderHook(
      () => {
        const cs = useClearStudentSession(),
          ct = useClearTeacherSession(),
          ls = useLogoutStudent(done),
          lt = useLogoutTeacher(done),
          lp = useLogoutPersonal("teacher", done);
        return {
          "clear-student": () => cs(done),
          "clear-teacher": () => ct(done),
          "logout-student": () => ls.mutateAsync(),
          "logout-teacher": () => lt.mutateAsync(),
          "logout-paired": () => lp.mutateAsync(),
          "logout-single": () => lp.mutateAsync(),
        }[kind];
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
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = view.result.current().catch((error) => error);
    });
    await waitFor(() => expect(cancel).toHaveBeenCalled());
    let result: unknown;
    await act(async () => {
      cache.setQueryData(["student", "me"], { id: "sb" });
      cache.setQueryData(["teacher", "me"], { id: "tb" });
      cache.setQueryData(["student", "private-b"], "B");
      cache.setQueryData(["teacher", "private-b"], "B");
      release();
      result = await pending;
    });
    expect(result).toMatchObject({ name: "AuthCancelledError" });
    expect(done).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(cache.getQueryData(["student", "me"])).toEqual({ id: "sb" });
    expect(cache.getQueryData(["teacher", "me"])).toEqual({ id: "tb" });
    expect(cache.getQueryData(["student", "private-b"])).toBe("B");
    expect(cache.getQueryData(["teacher", "private-b"])).toBe("B");
    view.unmount();
    cache.clear();
  });
it("服务端paired=false只清当前角色，另一角色的并行更新不被清理", async () => {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  cache.setQueryData(["student", "me"], { id: "s" });
  cache.setQueryData(["teacher", "me"], { id: "t" });
  cache.setQueryData(["student", "private"], "keep");
  const done = vi.fn();
  const clients = {
    ...testClientServices,
    logoutPersonalApi: vi.fn(async () => ({ paired: false })),
  };
  const view = renderHook(() => useLogoutPersonal("teacher", done), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={cache}>
        <TestPortalProvider runtime={createTestRuntime({ clients })}>
          {children}
        </TestPortalProvider>
      </QueryClientProvider>
    ),
  });
  await act(async () => {
    await view.result.current.mutateAsync();
  });
  expect(done).toHaveBeenCalledTimes(1);
  expect(cache.getQueryData(["student", "private"])).toBe("keep");
  expect(cache.getQueryData(["student", "me"])).toEqual({ id: "s" });
  view.unmount();
  cache.clear();
});
it("正常退出自己的导航卸载不伪报认证取消", async () => {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  cache.setQueryData(["student", "me"], { id: "s" });
  let unmount = () => {};
  const done = vi.fn(() => unmount());
  const clients = {
    ...testClientServices,
    logoutStudentApi: vi.fn(async () => null),
  };
  const view = renderHook(() => useLogoutStudent(done), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={cache}>
        <TestPortalProvider runtime={createTestRuntime({ clients })}>
          {children}
        </TestPortalProvider>
      </QueryClientProvider>
    ),
  });
  unmount = view.unmount;
  await act(async () => {
    await expect(view.result.current.mutateAsync()).resolves.toBeNull();
  });
  expect(done).toHaveBeenCalledTimes(1);
  cache.clear();
});

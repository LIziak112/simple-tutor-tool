import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  PersonalSessionData,
  StudentMeData,
  TeacherInfo,
} from "@tutor/contract";
import { expect, it, vi } from "vitest";
import {
  createTestRuntime,
  TestPortalProvider,
  testClientServices,
} from "@/test/portal-fixture";
import { act, renderHook, waitFor } from "@/test/render-with-portal";
import { useLoginPersonal, useRegisterPersonal } from "./personal-auth";
import { useLoginStudent, useStudentLinkLogin } from "./student-auth";
import {
  useApplyPersonalAuthed,
  useLoginTeacher,
  useRegisterTeacher,
  useSetupTeacher,
} from "./teacher-auth";

const student: StudentMeData = {
  id: "sa",
  displayName: "甲",
  loginName: "sa",
  accountKind: "personal",
  passwordEnabled: true,
  linkEnabled: false,
};
const teacher: TeacherInfo = {
  id: "ta",
  loginName: "ta",
  accountKind: "personal",
  isAdmin: false,
  createdAt: "2026-01-01",
};
const pair: PersonalSessionData = { student, teacher };
const credentials = { loginName: "ta", password: "valid-password" };
const kinds = [
  "student",
  "link",
  "teacher",
  "setup",
  "register",
  "personal",
  "personal-register",
  "teacher-pair",
] as const;
for (const kind of kinds)
  it(`${kind}真实mutation取消传播到调用级onSuccess，不导航不写B`, async () => {
    const cache = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    cache.setQueryData(["student", "me"], student);
    cache.setQueryData(["teacher", "me"], teacher);
    const onSuccess = vi.fn();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const clients = {
      ...testClientServices,
      loginStudentApi: vi.fn(async () => {
        await gate;
        return student;
      }),
      loginStudentByLinkApi: vi.fn(async () => {
        await gate;
        return student;
      }),
      loginTeacher: vi.fn(async () => {
        await gate;
        return kind === "teacher-pair"
          ? { ...teacher, student }
          : { ...teacher, accountKind: "class" as const };
      }),
      setupTeacher: vi.fn(async () => {
        await gate;
        return teacher;
      }),
      registerTeacher: vi.fn(async () => {
        await gate;
        return teacher;
      }),
      loginPersonalApi: vi.fn(async () => {
        await gate;
        return pair;
      }),
      registerPersonalApi: vi.fn(async () => {
        await gate;
        return pair;
      }),
    };
    const view = renderHook(
      () => {
        const s = useLoginStudent(),
          l = useStudentLinkLogin(),
          t = useLoginTeacher(),
          i = useSetupTeacher(),
          r = useRegisterTeacher(),
          p = useLoginPersonal(),
          pr = useRegisterPersonal();
        return {
          student: () => s.mutateAsync(credentials, { onSuccess }),
          link: () => l.mutateAsync("token", { onSuccess }),
          teacher: () => t.mutateAsync(credentials, { onSuccess }),
          setup: () => i.mutateAsync(credentials, { onSuccess }),
          register: () => r.mutateAsync(credentials, { onSuccess }),
          personal: () => p.mutateAsync(credentials, { onSuccess }),
          "personal-register": () =>
            pr.mutateAsync(
              { ...credentials, inviteCode: "code" },
              { onSuccess },
            ),
          "teacher-pair": () => t.mutateAsync(credentials, { onSuccess }),
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
    await waitFor(() =>
      expect(
        Object.values(clients).some(
          (value) =>
            typeof value === "function" &&
            vi.isMockFunction(value) &&
            value.mock.calls.length > 0,
        ),
      ).toBe(true),
    );
    let result: unknown;
    await act(async () => {
      cache.setQueryData(["student", "me"], { ...student, id: "sb" });
      cache.setQueryData(["teacher", "me"], { ...teacher, id: "tb" });
      cache.setQueryData(["student", "private-b"], "B");
      cache.setQueryData(["teacher", "private-b"], "B");
      release();
      result = await pending;
    });
    expect(result).toMatchObject({ name: "AuthCancelledError" });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(cache.getQueryData<{ id: string }>(["student", "me"])?.id).toBe(
      "sb",
    );
    expect(cache.getQueryData<{ id: string }>(["teacher", "me"])?.id).toBe(
      "tb",
    );
    expect(cache.getQueryData(["student", "private-b"])).toBe("B");
    expect(cache.getQueryData(["teacher", "private-b"])).toBe("B");
    view.unmount();
    cache.clear();
  });
it("个人协调识别第一半边提交时外部更新，保外部B且不宣告双提交成功", async () => {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  cache.setQueryData(["student", "me"], { ...student, id: "old-s" });
  cache.setQueryData(["teacher", "me"], { ...teacher, id: "old-t" });
  let changed = false;
  const stop = cache.getQueryCache().subscribe((event) => {
    if (
      event.type === "updated" &&
      event.action.type === "success" &&
      event.query.queryKey[0] === "student" &&
      event.query.queryKey[1] === "me" &&
      !changed
    ) {
      changed = true;
      cache.setQueryData(["teacher", "me"], { ...teacher, id: "external-b" });
      cache.setQueryData(["teacher", "private-b"], "B");
    }
  });
  const view = renderHook(() => useApplyPersonalAuthed(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={cache}>{children}</QueryClientProvider>
    ),
  });
  let result: unknown;
  await act(async () => {
    result = await view.result.current(pair).catch((error) => error);
  });
  expect(result).toMatchObject({
    name: "AuthCancelledError",
    committedRoles: ["student"],
  });
  expect(cache.getQueryData<{ id: string }>(["teacher", "me"])?.id).toBe(
    "external-b",
  );
  expect(cache.getQueryData(["teacher", "private-b"])).toBe("B");
  stop();
  view.unmount();
  cache.clear();
});
it("个人两角色自己提交互不误判，凭据在任一外部同ID或ABA写后失效", async () => {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  cache.setQueryData(["student", "me"], student);
  cache.setQueryData(["teacher", "me"], teacher);
  const view = renderHook(() => useApplyPersonalAuthed(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={cache}>{children}</QueryClientProvider>
    ),
  });
  await act(async () => {
    const receipt = await view.result.current(pair);
    expect(receipt.isCurrent()).toBe(true);
    cache.setQueryData(["teacher", "me"], teacher);
    expect(receipt.isCurrent()).toBe(false);
  });
  view.unmount();
  cache.clear();
});
it("个人mutation部分提交后外部双身份B保住两侧cache，调用级成功不执行", async () => {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  cache.setQueryData(["student", "me"], { ...student, id: "old-s" });
  cache.setQueryData(["teacher", "me"], { ...teacher, id: "old-t" });
  let changed = false;
  const stop = cache.getQueryCache().subscribe((event) => {
    if (
      event.type === "updated" &&
      event.action.type === "success" &&
      event.query.queryKey[0] === "teacher" &&
      event.query.queryKey[1] === "me" &&
      (event.query.state.data as { id: string })?.id === teacher.id &&
      !changed
    ) {
      changed = true;
      cache.setQueryData(["student", "me"], { ...student, id: "sb" });
      cache.setQueryData(["teacher", "me"], { ...teacher, id: "tb" });
      cache.setQueryData(["student", "private-b"], "SB");
      cache.setQueryData(["teacher", "private-b"], "TB");
    }
  });
  const onSuccess = vi.fn();
  const clients = {
    ...testClientServices,
    loginPersonalApi: vi.fn(async () => pair),
  };
  const view = renderHook(() => useLoginPersonal(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={cache}>
        <TestPortalProvider runtime={createTestRuntime({ clients })}>
          {children}
        </TestPortalProvider>
      </QueryClientProvider>
    ),
  });
  let result: unknown;
  await act(async () => {
    result = await view.result.current
      .mutateAsync(credentials, { onSuccess })
      .catch((error) => error);
  });
  expect(result).toMatchObject({
    name: "AuthCancelledError",
    committedRoles: ["student"],
  });
  expect(onSuccess).not.toHaveBeenCalled();
  expect(cache.getQueryData<{ id: string }>(["student", "me"])?.id).toBe("sb");
  expect(cache.getQueryData<{ id: string }>(["teacher", "me"])?.id).toBe("tb");
  expect(cache.getQueryData(["student", "private-b"])).toBe("SB");
  expect(cache.getQueryData(["teacher", "private-b"])).toBe("TB");
  stop();
  view.unmount();
  cache.clear();
});

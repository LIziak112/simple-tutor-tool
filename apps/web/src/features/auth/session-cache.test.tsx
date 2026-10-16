import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { StudentMeData, TeacherInfo } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchStudentMe,
  fetchTeacherMe,
  loginStudentApi,
  loginStudentByLinkApi,
  loginTeacher,
} from "@/lib/api";
import {
  studentMeKey,
  useLoginStudent,
  useLogoutStudent,
  useStudentLinkLogin,
  useStudentMe,
} from "./student-auth";
import {
  teacherMeKey,
  useLoginTeacher,
  useLogoutTeacher,
  useTeacherMe,
} from "./teacher-auth";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchStudentMe: vi.fn(),
  fetchTeacherMe: vi.fn(),
  loginStudentApi: vi.fn(),
  loginStudentByLinkApi: vi.fn(),
  loginTeacher: vi.fn(),
  logoutStudentApi: vi.fn(async () => ({ ok: true })),
  logoutTeacher: vi.fn(async () => ({ ok: true })),
  fetchStudentAssignmentsApi: vi.fn(async () => ({ assignments: [] })),
  fetchStudentCoursesApi: vi.fn(async () => ({ courses: [] })),
  fetchStudentLecturesApi: vi.fn(async () => ({ lectures: [] })),
}));

const studentA: StudentMeData = {
  id: "a",
  displayName: "甲",
  loginName: "a",
  passwordEnabled: true,
  linkEnabled: true,
};
const studentB: StudentMeData = {
  ...studentA,
  id: "b",
  displayName: "乙",
  loginName: "b",
};
const teacherA: TeacherInfo = {
  id: "a",
  loginName: "teacher-a",
  isAdmin: true,
  createdAt: "2026-10-16",
};
const teacherB: TeacherInfo = {
  ...teacherA,
  id: "b",
  loginName: "teacher-b",
  isAdmin: false,
};

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

beforeEach(() => {
  vi.mocked(fetchStudentMe).mockRejectedValue(
    new ApiError("UNAUTHORIZED", "请登录", 401),
  );
  vi.mocked(fetchTeacherMe).mockRejectedValue(
    new ApiError("UNAUTHORIZED", "请登录", 401),
  );
  vi.mocked(loginStudentApi).mockResolvedValue(studentB);
  vi.mocked(loginStudentByLinkApi).mockResolvedValue(studentB);
  vi.mocked(loginTeacher).mockResolvedValue(teacherB);
});

describe("学生账号缓存边界", () => {
  it("退出后仍挂载的身份订阅清除旧姓名，重登接收新身份", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(studentMeKey, studentA);
    client.setQueryData(["teacher", "courses"], "教师会话保留");
    const { result } = renderHook(
      () => ({
        me: useStudentMe(),
        logout: useLogoutStudent(),
        login: useLoginStudent(),
      }),
      { wrapper },
    );
    await act(async () => {
      await result.current.logout.mutateAsync();
    });
    await waitFor(() => expect(result.current.me.data).toBeUndefined());
    await act(async () => {
      await result.current.login.mutateAsync({
        loginName: "b",
        password: "password",
      });
    });
    await waitFor(() => expect(result.current.me.data).toEqual(studentB));
    expect(client.getQueryData(["teacher", "courses"])).toBe("教师会话保留");
    client.clear();
  });

  it.each(["密码", "链接"] as const)(
    "%s 登录清除旧业务数据并阻止迟到请求覆盖身份",
    async (method) => {
      const { client, wrapper } = setup();
      client.setQueryData(studentMeKey, studentA);
      client.setQueryData(["student", "wrong"], "甲的错题");
      let release: (value: StudentMeData) => void = () => {};
      const pending = client
        .fetchQuery({
          queryKey: studentMeKey,
          staleTime: 0,
          queryFn: () =>
            new Promise<StudentMeData>((resolve) => {
              release = resolve;
            }),
        })
        .catch(() => undefined);
      const { result } = renderHook(
        () => ({ login: useLoginStudent(), link: useStudentLinkLogin() }),
        { wrapper },
      );
      await act(async () => {
        if (method === "密码")
          await result.current.login.mutateAsync({
            loginName: "b",
            password: "password",
          });
        else await result.current.link.mutateAsync("token");
      });
      expect(client.getQueryData(["student", "wrong"])).toBeUndefined();
      await act(async () => {
        release(studentA);
        await pending;
      });
      expect(client.getQueryData(studentMeKey)).toEqual(studentB);
      client.clear();
    },
  );
});

describe("教师账号缓存边界", () => {
  it("退出清除活动身份与教师/管理业务，保留学生会话", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(teacherMeKey, teacherA);
    client.setQueryData(["teacher", "courses"], "甲的课程");
    client.setQueryData(["admin", "teachers"], "管理员数据");
    client.setQueryData(studentMeKey, studentA);
    const { result } = renderHook(
      () => ({ me: useTeacherMe(), logout: useLogoutTeacher() }),
      { wrapper },
    );
    await act(async () => {
      await result.current.logout.mutateAsync();
    });
    await waitFor(() => expect(result.current.me.data).toBeUndefined());
    expect(client.getQueryData(["teacher", "courses"])).toBeUndefined();
    expect(client.getQueryData(["admin", "teachers"])).toBeUndefined();
    expect(client.getQueryData(studentMeKey)).toEqual(studentA);
    client.clear();
  });

  it("登录另一教师后清除旧课程及管理员缓存", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(teacherMeKey, teacherA);
    client.setQueryData(["teacher", "courses"], "甲的课程");
    client.setQueryData(["admin", "teachers"], "管理员数据");
    const { result } = renderHook(() => useLoginTeacher(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        loginName: "teacher-b",
        password: "password",
      });
    });
    expect(client.getQueryData(teacherMeKey)).toEqual(teacherB);
    expect(client.getQueryData(["teacher", "courses"])).toBeUndefined();
    expect(client.getQueryData(["admin", "teachers"])).toBeUndefined();
    client.clear();
  });
});

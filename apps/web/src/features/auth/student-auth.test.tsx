import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { StudentMeData } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindNoteSession,
  currentNoteSession,
  resetNoteSession,
} from "@/features/notes/note-sync";
import { useLogoutStudent, useStudentLinkLogin } from "./student-auth";

/**
 * 学生登录/登出的草稿会话接线（T6R.9 增补）：
 * - 登录身份与当前草稿绑定不同 → 立即停旧会话（复审①：堵「换账号后旧待传
 *   用新 Cookie 上传被误打 denied(access) 终态」——旧会话 epoch 失效）；
 * - 同账号重登不重置（队列照常）；登出统一 resetNoteSession。
 * note-sync 用真实模块（会话单例可观察）；API 出网 mock。
 */

vi.mock("@/lib/api", () => ({
  loginStudentByLinkApi: vi.fn(),
  logoutStudentApi: vi.fn(async () => ({ ok: true })),
  fetchStudentAssignmentsApi: vi.fn(async () => ({ assignments: [] })),
  fetchStudentCoursesApi: vi.fn(async () => ({ courses: [] })),
  fetchStudentLecturesApi: vi.fn(async () => ({ lectures: [] })),
}));

import { loginStudentByLinkApi } from "@/lib/api";

const linkMock = vi.mocked(loginStudentByLinkApi);

const ME_A: StudentMeData = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "学生甲",
  loginName: "stu-a",
  linkEnabled: true,
  passwordEnabled: false,
};
const ME_B: StudentMeData = {
  ...ME_A,
  id: "44444444-4444-4444-8444-444444444444",
  displayName: "学生乙",
  loginName: "stu-b",
};

function renderAuthHooks() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    logout: renderHook(() => useLogoutStudent(), { wrapper }).result,
    linkLogin: renderHook(() => useStudentLinkLogin(), { wrapper }).result,
  };
}

beforeEach(() => {
  resetNoteSession();
  linkMock.mockReset();
});

afterEach(() => {
  resetNoteSession();
});

describe("登录成功路径的草稿会话接线（T6R.9 复审①）", () => {
  it("登录另一学生：旧绑定立即失效（currentNoteSession → null）", async () => {
    bindNoteSession({ origin: "https://tutor.example", studentId: ME_A.id });
    linkMock.mockResolvedValue(ME_B);
    const hooks = renderAuthHooks();
    await act(async () => {
      await hooks.linkLogin.current.mutateAsync("t");
    });
    await waitFor(() => expect(hooks.linkLogin.current.isSuccess).toBe(true));
    expect(currentNoteSession()).toBeNull(); // 旧会话 epoch 已失效
  });

  it("同账号重登（专属链接重进）：不重置，队列照常", async () => {
    bindNoteSession({ origin: "https://tutor.example", studentId: ME_A.id });
    linkMock.mockResolvedValue(ME_A);
    const hooks = renderAuthHooks();
    await act(async () => {
      await hooks.linkLogin.current.mutateAsync("t");
    });
    await waitFor(() => expect(hooks.linkLogin.current.isSuccess).toBe(true));
    expect(currentNoteSession()).toEqual({
      origin: "https://tutor.example",
      studentId: ME_A.id,
    });
  });

  it("登出成功 → resetNoteSession（会话解绑）", async () => {
    bindNoteSession({ origin: "https://tutor.example", studentId: ME_A.id });
    const hooks = renderAuthHooks();
    await act(async () => {
      await hooks.logout.current.mutateAsync();
    });
    await waitFor(() => expect(hooks.logout.current.isSuccess).toBe(true));
    expect(currentNoteSession()).toBeNull();
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { resetNoteSession } from "@/features/notes/note-sync";
import { useLogoutStudent } from "./student-auth";

/**
 * 学生退出登录（T6R.9 增补）：登出成功后除清查询缓存外，还须
 * resetNoteSession——停旧草稿同步队列、中止在途上传、隔离回执
 * （本地未同步内容保留，方案 §6.1）。note-sync 模块 mock 观察调用。
 */

vi.mock("@/features/notes/note-sync", () => ({
  resetNoteSession: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  logoutStudentApi: vi.fn(async () => ({ ok: true })),
}));

it("登出成功 → 清学生查询缓存并 resetNoteSession", async () => {
  const client = new QueryClient();
  const { result } = renderHook(() => useLogoutStudent(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await act(async () => {
    await result.current.mutateAsync();
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(resetNoteSession).toHaveBeenCalledTimes(1);
});

import { expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-response";
import { resolveInkProfileAccount } from "./ink-profile-account";
import { createPortalRoutes } from "./routes";

it("个人管理手写页只读取管理主体，个人学习页只读取学习主体", async () => {
  const clients = {
    fetchTeacherMe: vi.fn(async () => ({ id: "teacher" })),
    fetchStudentMe: vi.fn(async () => ({ id: "student" })),
  };
  expect(
    await resolveInkProfileAccount(
      createPortalRoutes("personal"),
      "/p/manage/settings/ink-feel",
      clients,
    ),
  ).toEqual({ role: "teacher", id: "teacher" });
  expect(clients.fetchStudentMe).not.toHaveBeenCalled();
  expect(
    await resolveInkProfileAccount(
      createPortalRoutes("personal"),
      "/p/learn/settings/ink-feel",
      clients,
    ),
  ).toEqual({ role: "student", id: "student" });
});
it("个人学习会话失效不借管理Cookie继续配置，全局独立试写页保留旧降级", async () => {
  const clients = {
    fetchTeacherMe: vi.fn(async () => ({ id: "teacher" })),
    fetchStudentMe: vi.fn(async () => {
      throw new ApiError("UNAUTHORIZED", "请登录", 401);
    }),
  };
  await expect(
    resolveInkProfileAccount(
      createPortalRoutes("personal"),
      "/p/learn/settings/ink-feel",
      clients,
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(clients.fetchTeacherMe).not.toHaveBeenCalled();
  expect(
    await resolveInkProfileAccount(
      createPortalRoutes("student"),
      "/ink-feel",
      clients,
    ),
  ).toEqual({ role: "teacher", id: "teacher" });
});

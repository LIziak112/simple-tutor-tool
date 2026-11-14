import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { StudentMeData, TeacherInfo } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import {
  type PortalRuntime,
  usePortalRuntime,
} from "@/features/runtime/portal-runtime";
import { act, cleanup, render, waitFor } from "@/test/render-with-portal";
import { PortalHost } from "./PortalHost";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(personal: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const teacher: TeacherInfo = {
    id: "teacher",
    loginName: "t",
    isAdmin: false,
    accountKind: personal ? "personal" : "class",
    createdAt: "2026-01-01",
  };
  const student: StudentMeData = {
    id: "student-a",
    displayName: "a",
    loginName: "a",
    linkEnabled: false,
    passwordEnabled: false,
    accountKind: personal ? "personal" : "class",
  };
  client.setQueryData(["teacher", "me"], teacher);
  client.setQueryData(["student", "me"], student);
  let current: PortalRuntime | null = null;
  function Capture() {
    current = usePortalRuntime();
    return null;
  }
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[personal ? "/p/manage/library" : "/t/library"]}
      >
        <PortalHost>
          <Capture />
        </PortalHost>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return {
    client,
    student,
    runtime: () => {
      if (current === null) throw new Error("宿主未创建");
      return current;
    },
  };
}
it("个人另一侧会话变化也关闭旧主体端口，即使当前管理主体ID相同", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetcher);
  const host = setup(true);
  const old = host.runtime();
  act(() =>
    host.client.setQueryData(["student", "me"], {
      ...host.student,
      id: "student-b",
    }),
  );
  await waitFor(() => expect(old.signal.aborted).toBe(true));
  expect(host.runtime().subject?.id).toBe("teacher");
  expect(host.runtime().clients).not.toBe(old.clients);
  await expect(old.clients.fetchTeacherMe()).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it("班级门户保留独立会话，其他学生Cookie缓存变化不撤销教师端口", async () => {
  const host = setup(false);
  const old = host.runtime();
  await act(async () => {
    host.client.setQueryData(["student", "me"], {
      ...host.student,
      id: "student-b",
    });
    await Promise.resolve();
  });
  expect(old.signal.aborted).toBe(false);
  expect(host.runtime().clients).toBe(old.clients);
});

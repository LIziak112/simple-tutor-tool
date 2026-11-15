import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { PortalHost } from "@/portals/PortalHost";
import { fireEvent, render, screen, waitFor } from "@/test/render-with-portal";
import { LoginPage } from "./LoginPage";

afterEach(() => vi.unstubAllGlobals());
it("真实Host新教师登录后用新主体读取唯一学生落点，不能用已关闭未确认端口回退", async () => {
  const teacher = {
    id: "teacher-a",
    loginName: "teacher-a",
    accountKind: "class",
    isAdmin: false,
    createdAt: "2026-01-01",
  };
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const path = new URL(
        input instanceof Request ? input.url : String(input),
        "https://local.invalid",
      ).pathname;
      paths.push(path);
      if (path === "/api/teacher/me")
        return new Response(
          JSON.stringify({
            ok: false,
            error: "UNAUTHORIZED",
            message: "未登录",
          }),
          { status: 401 },
        );
      const data = path.endsWith("/status")
        ? { hasTeacher: true, registrationOpen: true }
        : path.endsWith("/login")
          ? teacher
          : path === "/api/teacher/students"
            ? { students: [{ id: "only-student", archived: false }] }
            : null;
      return new Response(JSON.stringify({ ok: true, data }));
    }),
  );
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        element: (
          <PortalHost>
            <Outlet />
          </PortalHost>
        ),
        children: [
          { path: "/t/login", element: <LoginPage /> },
          { path: "/t/students", element: <p>列表</p> },
          { path: "/t/students/:id", element: <p>唯一学生</p> },
        ],
      },
    ],
    { initialEntries: ["/t/login"] },
  );
  const view = render(
    <QueryClientProvider client={cache}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  fireEvent.change(await screen.findByLabelText("登录名"), {
    target: { value: "teacher-a" },
  });
  fireEvent.change(screen.getByLabelText("密码"), {
    target: { value: "1234abcd" },
  });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/t/students/only-student"),
  );
  expect(paths.filter((path) => path === "/api/teacher/students")).toHaveLength(
    1,
  );
  expect(cache.getQueryData(["teacher", "me"])).toEqual(teacher);
  view.unmount();
  cache.clear();
});

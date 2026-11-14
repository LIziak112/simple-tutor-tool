import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PersonalSessionData } from "@tutor/contract";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { expect, it, vi } from "vitest";
import { useStudentWorkspace } from "@/features/student/student-workspace-layout";
import { ApiError } from "@/lib/api-response";
import {
  createTestRuntime,
  TestPortalProvider,
  testClientServices,
} from "@/test/portal-fixture";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/test/render-with-portal";
import { createPortalRoutes } from "../routes";
import PersonalLayout from "./PersonalLayout";

vi.mock("@/features/student/use-learner-bindings", () => ({
  useLearnerBindings: vi.fn(),
}));
vi.mock("@/features/ink/use-ink-profiles", () => ({
  useBindInkProfiles: vi.fn(),
}));
const pair: PersonalSessionData = {
  student: {
    id: "s",
    displayName: "个人学习者",
    loginName: "personal",
    linkEnabled: false,
    passwordEnabled: false,
    accountKind: "personal",
  },
  teacher: {
    id: "t",
    loginName: "personal",
    isAdmin: false,
    accountKind: "personal",
    createdAt: "2026-01-01T00:00:00Z",
  },
};
function WorkspaceSample() {
  useStudentWorkspace();
  return <p>专用作答工作区</p>;
}
function LoginDestination() {
  const location = useLocation();
  return (
    <>
      <p>个人登录页</p>
      <output data-testid="login-path">
        {location.pathname + location.search + location.hash}
      </output>
    </>
  );
}
function setup(entry = "/p/learn/home", unauthorized = false) {
  const check = vi.fn(async () => (unauthorized ? null : pair));
  const logout = vi.fn(async () => ({ paired: true }));
  const clients = {
    ...testClientServices,
    fetchStudentMe: vi.fn(async () => pair.student),
    fetchTeacherMe: vi.fn(async () => {
      if (unauthorized) throw new ApiError("UNAUTHORIZED", "请登录", 401);
      return pair.teacher;
    }),
    checkPersonalSessionApi: check,
    logoutPersonalApi: logout,
  };
  function Host() {
    const location = useLocation();
    const management = location.pathname.startsWith("/p/manage");
    return (
      <TestPortalProvider
        runtime={createTestRuntime({
          portal: "personal",
          view: management ? "management" : "learning",
          subject: {
            type: management ? "teacher" : "student",
            id: management ? "t" : "s",
          },
          clients,
          routes: createPortalRoutes("personal"),
        })}
      >
        <Routes>
          <Route path="/p/learn" element={<PersonalLayout />}>
            <Route path="attempts/:id" element={<WorkspaceSample />} />
            <Route path="*" element={<p>个人学习内容</p>} />
          </Route>
          <Route path="/p/manage" element={<PersonalLayout />}>
            <Route path="*" element={<p>个人管理内容</p>} />
          </Route>
          <Route path="/p/login" element={<LoginDestination />} />
        </Routes>
      </TestPortalProvider>
    );
  }
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <MemoryRouter initialEntries={[entry]}>
        <Host />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { check, logout };
}
it("独立个人壳裁剪班级入口，切换前核验双会话，不显示教师导航", async () => {
  const { check } = setup();
  const learn = await screen.findByRole("navigation", { name: "个人学习导航" });
  expect(within(learn).getByRole("link", { name: "课程" })).toHaveAttribute(
    "href",
    "/p/learn/courses",
  );
  expect(
    within(learn).queryByRole("link", { name: "我的作业" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "切换到管理视角" }));
  const manage = await screen.findByRole("navigation", {
    name: "个人管理导航",
  });
  expect(within(manage).getByRole("link", { name: "资源库" })).toHaveAttribute(
    "href",
    "/p/manage/library",
  );
  for (const name of ["学生", "作业", "连接 AI"])
    expect(
      within(manage).queryByRole("link", { name }),
    ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("navigation", { name: "教师端导航" }),
  ).not.toBeInTheDocument();
  expect(check).toHaveBeenCalledWith("student");
  expect(check).toHaveBeenCalledWith("teacher");
});
it("个人退出失败保留内容并可重试，成功结束个人会话返回登录", async () => {
  const { logout } = setup();
  await screen.findByText("个人学习内容");
  logout.mockRejectedValueOnce(new Error("退出失败，请重试"));
  fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "退出失败，请重试",
  );
  expect(screen.getByText("个人学习内容")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
  await waitFor(() => expect(screen.getByText("个人登录页")).toBeVisible());
  expect(logout).toHaveBeenCalledTimes(2);
  expect(logout).toHaveBeenCalledWith("student");
});

it("个人作答复用专用工作区，卸载前隐藏普通门户导航", async () => {
  setup("/p/learn/attempts/a");
  await screen.findByText("专用作答工作区");
  await waitFor(() =>
    expect(
      screen.queryByRole("navigation", { name: "个人学习导航" }),
    ).not.toBeInTheDocument(),
  );
});

it("个人管理401复用认证守卫并保留业务查询和hash", async () => {
  setup("/p/manage/library?folder=f#q2", true);
  expect(await screen.findByTestId("login-path")).toHaveTextContent(
    "/p/login?returnTo=%2Fp%2Fmanage%2Flibrary%3Ffolder%3Df%23q2",
  );
});

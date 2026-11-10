import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StudentMeData } from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStudentWorkspace } from "@/features/student/student-workspace-layout";
import {
  ApiError,
  fetchStudentMe,
  logoutStudentApi,
  logoutTeacher,
} from "@/lib/api";
import StudentLayout from "./StudentLayout";

/**
 * 学生端布局与守卫测试（T2.3）：未登录跳 /s/login；已登录渲染顶栏
 * （姓名 / 六分区导航 / 退出）；退出调 logout 接口并回登录页。
 * 2026-10 学生端 IA 调整：错题本升为一级导航（/s/wrong）。
 * 模块 0 个人账号：导航无「我的作业」、顶栏有「管理视角」切换、退出同时结束两枚会话。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentMe: vi.fn(),
    logoutStudentApi: vi.fn(),
    logoutTeacher: vi.fn(),
  };
});

const mockedMe = vi.mocked(fetchStudentMe);
const mockedLogout = vi.mocked(logoutStudentApi);
const mockedLogoutTeacher = vi.mocked(logoutTeacher);

const STUDENT: StudentMeData = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "张三",
  loginName: "张三",
  linkEnabled: true,
  passwordEnabled: true,
  accountKind: "class",
};

function renderLayout() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/s/home"]}>
        <Routes>
          <Route path="/s" element={<StudentLayout />}>
            <Route
              path="settings"
              element={<p data-testid="route-stub">学生设置页</p>}
            />
            <Route
              path="home"
              element={<p data-testid="route-stub">学生首页</p>}
            />
          </Route>
          <Route
            path="/s/login"
            element={<p data-testid="route-stub">学生登录页</p>}
          />
          <Route
            path="/p/login"
            element={<p data-testid="route-stub">个人登录页</p>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedMe.mockReset();
  mockedLogout.mockReset();
  mockedLogoutTeacher.mockReset();
});

describe("StudentLayout · 个人账号（模块 0）", () => {
  const PERSONAL: StudentMeData = {
    ...STUDENT,
    loginName: "kaosheng",
    linkEnabled: false,
    passwordEnabled: false,
    accountKind: "personal",
  };

  it("导航五分区（无「我的作业」）+ 「管理视角」切换指向 /t", async () => {
    mockedMe.mockResolvedValue(PERSONAL);
    renderLayout();

    expect(await screen.findByRole("link", { name: "首页" })).toHaveAttribute(
      "href",
      "/s/home",
    );
    expect(
      screen.queryByRole("link", { name: "我的作业" }),
    ).not.toBeInTheDocument();
    for (const [name, href] of [
      ["课程", "/s/courses"],
      ["错题本", "/s/wrong"],
      ["我的记录", "/s/records"],
      ["随笔", "/s/memos"],
    ] as const) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
    }
    const manage = screen.getAllByRole("link", { name: "切换到管理视角" });
    expect(manage.length).toBeGreaterThan(0);
    expect(manage[0]).toHaveAttribute("href", "/t");
  });

  it("退出同时调学生与教师登出接口，并回个人登录页", async () => {
    mockedMe.mockResolvedValue(PERSONAL);
    mockedLogout.mockResolvedValue(null);
    mockedLogoutTeacher.mockResolvedValue(null);
    renderLayout();

    const [logoutButton] = await screen.findAllByRole("button", {
      name: /退出/,
    });
    if (!logoutButton) throw new Error("退出按钮缺失");
    fireEvent.click(logoutButton);

    await waitFor(() => {
      expect(mockedLogout).toHaveBeenCalledTimes(1);
      expect(mockedLogoutTeacher).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("route-stub")).toHaveTextContent("个人登录页");
    });
  });
});

describe("StudentLayout", () => {
  it("头像姓名统一进入设置，顶栏不再显示独立手写手感链接", async () => {
    mockedMe.mockResolvedValue(STUDENT);
    renderLayout();
    const entries = await screen.findAllByRole("link", {
      name: "张三，学生设置",
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveAttribute("href", "/s/settings");
    expect(
      screen.queryByRole("link", { name: "手写手感" }),
    ).not.toBeInTheDocument();
    if (!entries[0]) throw new Error("设置入口缺失");
    fireEvent.click(entries[0]);
    expect(screen.getByTestId("route-stub")).toHaveTextContent("学生设置页");
  });
  it("未登录（401）跳转 /s/login", async () => {
    mockedMe.mockRejectedValue(
      new ApiError("UNAUTHORIZED", "未登录或会话已过期，请重新登录", 401),
    );
    renderLayout();

    await waitFor(() => {
      expect(screen.getByTestId("route-stub")).toHaveTextContent("学生登录页");
    });
  });

  it("已登录渲染顶栏：姓名、六分区导航（首页/我的作业/课程/错题本/我的记录/随笔）与退出按钮", async () => {
    mockedMe.mockResolvedValue(STUDENT);
    renderLayout();

    expect(await screen.findAllByText("张三")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "首页" })).toHaveAttribute(
      "href",
      "/s/home",
    );
    expect(screen.getByRole("link", { name: "我的作业" })).toHaveAttribute(
      "href",
      "/s/assignments",
    );
    expect(screen.getByRole("link", { name: "课程" })).toHaveAttribute(
      "href",
      "/s/courses",
    );
    expect(screen.getByRole("link", { name: "错题本" })).toHaveAttribute(
      "href",
      "/s/wrong",
    );
    expect(screen.getByRole("link", { name: "我的记录" })).toHaveAttribute(
      "href",
      "/s/records",
    );
    // 模块 5 第一步：随笔入口 + 右下角浮动「随手记」
    expect(screen.getByRole("link", { name: "随笔" })).toHaveAttribute(
      "href",
      "/s/memos",
    );
    expect(screen.getByRole("button", { name: "随手记" })).toBeInTheDocument();
    // 顶栏不再有讲义入口（/s/lectures 保留为二级页面）
    expect(
      screen.queryByRole("link", { name: "讲义" }),
    ).not.toBeInTheDocument();
    // jsdom 不加载响应式 CSS；实际可见的退出入口由浏览器测试验证。
    expect(screen.getAllByRole("button", { name: /退出/ })).toHaveLength(2);
    // 子路由正常渲染
    expect(screen.getByTestId("route-stub")).toHaveTextContent("学生首页");
  });

  it("工作区页面（作答 / 结果 / 讲练）不浮「随手记」：自带吸底操作条，入口在各自工具栏", async () => {
    mockedMe.mockResolvedValue(STUDENT);
    function WorkspaceStub() {
      useStudentWorkspace();
      return <p data-testid="route-stub">作答页</p>;
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/s/attempts/a1"]}>
          <Routes>
            <Route path="/s" element={<StudentLayout />}>
              <Route path="attempts/:id" element={<WorkspaceStub />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("route-stub")).toHaveTextContent("作答页");
    expect(
      screen.queryByRole("button", { name: /^随手记/ }),
    ).not.toBeInTheDocument();
    // 工作区连顶栏导航也不渲染（页面自带头部）
    expect(
      screen.queryByRole("link", { name: "随笔" }),
    ).not.toBeInTheDocument();
  });

  it("点击退出调用接口并回登录页", async () => {
    mockedMe.mockResolvedValue(STUDENT);
    mockedLogout.mockResolvedValue(null);
    renderLayout();

    const buttons = await screen.findAllByRole("button", { name: /退出/ });
    const button = buttons[0];
    if (!button) throw new Error("缺少退出按钮");
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByTestId("route-stub")).toHaveTextContent("学生登录页");
    });
    expect(mockedLogout).toHaveBeenCalledTimes(1);
  });

  it("网络错误显示错误态与重试", async () => {
    mockedMe.mockRejectedValue(new Error("连不上服务器"));
    renderLayout();

    expect(await screen.findByText("连不上服务器")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

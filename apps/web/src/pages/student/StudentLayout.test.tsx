import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StudentMeData } from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchStudentMe, logoutStudentApi } from "@/lib/api";
import StudentLayout from "./StudentLayout";

/**
 * 学生端布局与守卫测试（T2.3）：未登录跳 /s/login；已登录渲染顶栏
 * （姓名 / 四分区导航 / 退出）；退出调 logout 接口并回登录页。
 * 2026-10 学生端 IA 调整：错题本升为一级导航（/s/wrong）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentMe: vi.fn(),
    logoutStudentApi: vi.fn(),
  };
});

const mockedMe = vi.mocked(fetchStudentMe);
const mockedLogout = vi.mocked(logoutStudentApi);

const STUDENT: StudentMeData = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "张三",
  loginName: "张三",
  linkEnabled: true,
  passwordEnabled: true,
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
              path="home"
              element={<p data-testid="route-stub">学生首页</p>}
            />
          </Route>
          <Route
            path="/s/login"
            element={<p data-testid="route-stub">学生登录页</p>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedMe.mockReset();
  mockedLogout.mockReset();
});

describe("StudentLayout", () => {
  it("未登录（401）跳转 /s/login", async () => {
    mockedMe.mockRejectedValue(
      new ApiError("UNAUTHORIZED", "未登录或会话已过期，请重新登录", 401),
    );
    renderLayout();

    await waitFor(() => {
      expect(screen.getByTestId("route-stub")).toHaveTextContent("学生登录页");
    });
  });

  it("已登录渲染顶栏：姓名、四分区导航（首页/课程/错题本/我的记录）与退出按钮", async () => {
    mockedMe.mockResolvedValue(STUDENT);
    renderLayout();

    expect(await screen.findByText("张三")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "首页" })).toHaveAttribute(
      "href",
      "/s/home",
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
    // 顶栏不再有讲义入口（/s/lectures 保留为二级页面）
    expect(
      screen.queryByRole("link", { name: "讲义" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /退出/ })).toBeInTheDocument();
    // 子路由正常渲染
    expect(screen.getByTestId("route-stub")).toHaveTextContent("学生首页");
  });

  it("点击退出调用接口并回登录页", async () => {
    mockedMe.mockResolvedValue(STUDENT);
    mockedLogout.mockResolvedValue(null);
    renderLayout();

    fireEvent.click(await screen.findByRole("button", { name: /退出/ }));

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

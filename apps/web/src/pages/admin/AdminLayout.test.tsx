import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { TeacherInfo } from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTeacherMe } from "@/lib/api";
import AdminLayout from "./AdminLayout";

/**
 * /a 管理端布局与路由守卫测试（T2B.6，D19）：
 * 非管理员（me.isAdmin=false）→ 跳 /t；401 → 跳 /t/login；管理员 → 独立布局
 * （概览/教师管理导航 + 返回教师端 + 顶栏登录名）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchTeacherMe: vi.fn(),
  };
});

const mockedMe = vi.mocked(fetchTeacherMe);

const ADMIN: TeacherInfo = {
  id: "11111111-1111-4111-8111-111111111111",
  loginName: "teacher",
  isAdmin: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function renderLayout(initialEntry: string): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/a" element={<AdminLayout />}>
            <Route
              index
              element={<p data-testid="admin-route-stub">管理端页面占位</p>}
            />
            <Route
              path="*"
              element={<p data-testid="admin-route-stub">管理端页面占位</p>}
            />
          </Route>
          <Route path="/t" element={<p data-testid="teacher-home">教师端</p>} />
          <Route
            path="/t/login"
            element={<p data-testid="login-page">登录页</p>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedMe.mockReset();
});

describe("AdminLayout 路由守卫（D19：管理入口只对 isAdmin）", () => {
  it("非管理员直接访问 /a → 跳回教师端 /t", async () => {
    mockedMe.mockResolvedValue({ ...ADMIN, isAdmin: false });
    renderLayout("/a");

    expect(await screen.findByTestId("teacher-home")).toBeInTheDocument();
  });

  it("未登录（401 UNAUTHORIZED）→ 跳 /t/login", async () => {
    const { ApiError } = await import("@/lib/api");
    mockedMe.mockRejectedValue(
      new ApiError("UNAUTHORIZED", "未登录或会话已过期，请重新登录", 401),
    );
    renderLayout("/a");

    expect(await screen.findByTestId("login-page")).toBeInTheDocument();
  });

  it("管理员：独立布局渲染（概览/教师管理导航、返回教师端、顶栏登录名）", async () => {
    mockedMe.mockResolvedValue(ADMIN);
    renderLayout("/a");

    expect(await screen.findByTestId("admin-route-stub")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "概览" })).toHaveAttribute(
      "href",
      "/a",
    );
    expect(screen.getByRole("link", { name: "教师管理" })).toHaveAttribute(
      "href",
      "/a/teachers",
    );
    expect(screen.getByRole("link", { name: "返回教师端" })).toHaveAttribute(
      "href",
      "/t",
    );
    // 教师端导航不出现在管理端布局（D19 独立布局）
    expect(
      screen.queryByRole("link", { name: "资源库" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("admin-login-name")).toHaveTextContent("teacher");
  });

  it("me 查询失败（非 401）→ 错误态与重试", async () => {
    mockedMe.mockRejectedValue(new Error("网络异常"));
    renderLayout("/a");

    expect(await screen.findByText("无法完成请求")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { TeacherInfo } from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTeacherMe } from "@/lib/api";
import TeacherLayout from "./TeacherLayout";

/**
 * 教师端布局导航测试（2026-09-29 侧边栏去重简化）：
 * 资源库 · 课程 · 学生 · 作业 · 数据 · 学情 · 设置；
 * 讲义库/题库/回收站由 /t/library 页内页签切换、导入经「导入内容」按钮，
 * 侧边栏不再单列（与页内导航去重）；资源库在 /t/library 任意页签与
 * /t/import（导入流程页）上均高亮（aria-current）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchTeacherMe: vi.fn(),
  };
});

const mockedMe = vi.mocked(fetchTeacherMe);

const TEACHER: TeacherInfo = {
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
          <Route path="/t" element={<TeacherLayout />}>
            <Route
              path="*"
              element={<p data-testid="route-stub">路由占位</p>}
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedMe.mockReset();
});

describe("TeacherLayout 导航（侧边栏去重简化）", () => {
  it("顶栏显示当前登录名（D1：身份显示一律用登录名）", async () => {
    mockedMe.mockResolvedValue(TEACHER);
    renderLayout("/t/courses");

    expect(await screen.findByTestId("teacher-login-name")).toHaveTextContent(
      "teacher",
    );
  });

  it("渲染七个分区入口，讲义库/题库/导入不再单列", async () => {
    mockedMe.mockResolvedValue(TEACHER);
    renderLayout("/t/courses");

    expect(await screen.findByRole("link", { name: "资源库" })).toHaveAttribute(
      "href",
      "/t/library",
    );
    expect(screen.getByRole("link", { name: "课程" })).toHaveAttribute(
      "href",
      "/t/courses",
    );
    expect(screen.getByRole("link", { name: "学生" })).toHaveAttribute(
      "href",
      "/t/students",
    );
    expect(screen.getByRole("link", { name: "作业" })).toHaveAttribute(
      "href",
      "/t/assignments",
    );
    expect(screen.getByRole("link", { name: "数据" })).toHaveAttribute(
      "href",
      "/t/data",
    );
    expect(screen.getByRole("link", { name: "学情" })).toHaveAttribute(
      "href",
      "/t/insights",
    );
    expect(screen.getByRole("link", { name: "设置" })).toHaveAttribute(
      "href",
      "/t/settings",
    );
    // 讲义库/题库/导入由页内页签与「导入内容」按钮承担，侧边栏不再出现
    expect(
      screen.queryByRole("link", { name: "讲义库" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "题库" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "导入" }),
    ).not.toBeInTheDocument();
  });

  it("/t/library 任意页签均高亮「资源库」", async () => {
    mockedMe.mockResolvedValue(TEACHER);
    renderLayout("/t/library?tab=lectures");

    expect(await screen.findByRole("link", { name: "资源库" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("/t/import（导入流程页）上「资源库」保持高亮", async () => {
    mockedMe.mockResolvedValue(TEACHER);
    renderLayout("/t/import");

    expect(await screen.findByRole("link", { name: "资源库" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("其他分区不与「资源库」同时高亮", async () => {
    mockedMe.mockResolvedValue(TEACHER);
    renderLayout("/t/library");

    expect(await screen.findByRole("link", { name: "资源库" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "课程" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByRole("link", { name: "设置" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("课程子路由仍高亮「课程」", async () => {
    mockedMe.mockResolvedValue(TEACHER);
    renderLayout("/t/courses/22222222-2222-4222-8222-222222222222");

    expect(await screen.findByRole("link", { name: "课程" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});

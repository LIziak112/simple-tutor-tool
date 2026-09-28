import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { TeacherInfo } from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTeacherMe } from "@/lib/api";
import TeacherLayout from "./TeacherLayout";

/**
 * 教师端布局导航测试（T2A.9 侧边栏定稿）：
 * 资源库组（讲义库 / 题库 / 导入）+ 课程 / 学生 / 作业 / 数据 / 学情 / 设置；
 * 讲义库与题库共用 /t/library，按 ?tab= 区分直达目标与高亮（aria-current 唯一）。
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

describe("TeacherLayout 导航（T2A.9 定稿）", () => {
  it("渲染资源库组（讲义库/题库/导入）与其余分区", async () => {
    mockedMe.mockResolvedValue(TEACHER);
    renderLayout("/t/courses");

    expect(await screen.findByRole("link", { name: "讲义库" })).toHaveAttribute(
      "href",
      "/t/library?tab=lectures",
    );
    expect(screen.getByRole("link", { name: "题库" })).toHaveAttribute(
      "href",
      "/t/library",
    );
    expect(screen.getByRole("link", { name: "导入" })).toHaveAttribute(
      "href",
      "/t/import",
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
    // 旧的单一「资源库」入口不再存在（拆为组内三入口）；
    // ByRole 的 name 按可达名整串匹配，不会误中「讲义库」等子项
    expect(
      screen.queryByRole("link", { name: "资源库" }),
    ).not.toBeInTheDocument();
  });

  it("讲义库入口按 ?tab=lectures 直达并唯一高亮（aria-current）", async () => {
    mockedMe.mockResolvedValue(TEACHER);
    renderLayout("/t/library?tab=lectures");

    expect(await screen.findByRole("link", { name: "讲义库" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "题库" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("/t/library 无参数视为题库页签：题库高亮、讲义库不高亮", async () => {
    mockedMe.mockResolvedValue(TEACHER);
    renderLayout("/t/library");

    expect(await screen.findByRole("link", { name: "题库" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "讲义库" })).not.toHaveAttribute(
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

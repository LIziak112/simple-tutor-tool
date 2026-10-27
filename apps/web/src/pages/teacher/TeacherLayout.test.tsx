import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { TeacherInfo } from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTeacherMe } from "@/lib/api";
import TeacherLayout from "./TeacherLayout";

/**
 * 教师端布局导航测试（2026-09-29 侧边栏去重简化；T4.7 起「学情」附近追加
 * 「导出」与「连接 AI」；T-PR1 起「学情分析」入口下沉为作答记录页「统计」切换）：
 * 资源库 · 课程 · 学生 · 作业 · 作答记录 · 导出 · 连接 AI · 设置；
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
  it("展示 OwnClass 品牌，并按用途组织导航", async () => {
    mockedMe.mockResolvedValue(TEACHER);
    renderLayout("/t/courses");
    const nav = await screen.findByRole("navigation", { name: "教师端导航" });
    expect(screen.getByText("OwnClass")).toBeVisible();
    for (const label of ["教学", "分析", "系统"]) {
      expect(
        within(nav).getByRole("region", { name: label }),
      ).toBeInTheDocument();
    }
  });

  it("窄屏导航抽屉选择入口后关闭", async () => {
    mockedMe.mockResolvedValue(TEACHER);
    renderLayout("/t/courses");
    fireEvent.click(await screen.findByRole("button", { name: "打开导航" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("link", { name: "学生" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("顶栏显示当前登录名（D1：身份显示一律用登录名）", async () => {
    mockedMe.mockResolvedValue(TEACHER);
    renderLayout("/t/courses");

    expect(await screen.findByTestId("teacher-login-name")).toHaveTextContent(
      "teacher",
    );
  });

  it("渲染八个分区入口（T-PR1 起「学情分析」下沉到作答记录页「统计」切换），讲义库/题库/导入不再单列", async () => {
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
    expect(screen.getByRole("link", { name: "作答记录" })).toHaveAttribute(
      "href",
      "/t/data",
    );
    // T-PR1：侧边栏不再有「学情分析」入口（下沉为作答记录页「统计」切换）
    expect(
      screen.queryByRole("link", { name: "学情分析" }),
    ).not.toBeInTheDocument();
    // T4.7：导出中心与连接 AI（D26）
    expect(screen.getByRole("link", { name: "导出中心" })).toHaveAttribute(
      "href",
      "/t/export",
    );
    expect(screen.getByRole("link", { name: "连接 AI" })).toHaveAttribute(
      "href",
      "/t/connect",
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

  it("/t/insights（统计次级页）上「作答记录」保持高亮", async () => {
    mockedMe.mockResolvedValue(TEACHER);
    renderLayout("/t/insights");

    expect(
      await screen.findByRole("link", { name: "作答记录" }),
    ).toHaveAttribute("aria-current", "page");
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

describe("TeacherLayout 管理入口（T2B.6：只对 isAdmin 显示）", () => {
  it("系统管理集中在账号分类，导航只保留一个账号入口", async () => {
    mockedMe.mockResolvedValue(TEACHER);
    renderLayout("/t/courses");

    await screen.findByTestId("teacher-login-name");
    expect(screen.queryByRole("link", { name: "系统管理" })).toBeNull();
    expect(screen.getAllByRole("link", { name: "查看教师账号" })).toHaveLength(
      1,
    );
    expect(
      screen.queryByText("Your data. Your way. All for learning."),
    ).toBeNull();
  });

  it("普通教师不显示「管理」入口", async () => {
    mockedMe.mockResolvedValue({ ...TEACHER, isAdmin: false });
    renderLayout("/t/courses");

    await screen.findByTestId("teacher-login-name");
    expect(
      screen.queryByRole("link", { name: "系统管理" }),
    ).not.toBeInTheDocument();
  });
});

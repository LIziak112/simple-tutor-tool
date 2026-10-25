import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTeacherMe } from "@/lib/api";
import SettingsPage from "./SettingsPage";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchTeacherMe: vi.fn(),
  // hall-9533：AI 提示词区在页面测试只要求渲染，不取真实接口
  fetchTeacherAiPromptsApi: async () => ({
    slots: [],
    updatedAt: "1970-01-01T00:00:00.000Z",
  }),
}));

// 模拟有未保存本地状态的配置，验证分类切换不会卸载配置控制器。
vi.mock("@/features/teacher-settings/CapabilityProfileSection", () => ({
  CapabilityProfileSection: () => (
    <label>
      逐步揭晓
      <input type="checkbox" defaultChecked />
    </label>
  ),
}));
vi.mock("@/features/teacher-backup/BackupSection", () => ({
  BackupSection: () => <h2>备份与恢复内容</h2>,
}));
// SAI-07：AI 伴学区挂进 teaching 分类（行为由组件测试与路由联调覆盖）
vi.mock("@/features/student-ai/TeacherAiSettingsSection", () => ({
  TeacherAiSettingsSection: () => <section aria-label="AI 伴学设置区" />,
}));

function LocationProbe() {
  return <output data-testid="location">{useLocation().search}</output>;
}

function renderPage(entry = "/t/settings") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <SettingsPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(fetchTeacherMe).mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    loginName: "teacher",
    isAdmin: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
});

describe("设置分类", () => {
  it("学生作答方式不展示教师手写手感入口", async () => {
    renderPage("/t/settings?section=teaching");
    await screen.findByRole("checkbox", { name: "逐步揭晓" });
    expect(
      screen.queryByRole("link", { name: "调整我的手写手感" }),
    ).not.toBeInTheDocument();
  });

  it("账号分类展示管理员专属系统入口与品牌广告词", async () => {
    renderPage("/t/settings?section=account");
    expect(
      await screen.findByRole("link", { name: "系统管理" }),
    ).toHaveAttribute("href", "/a");
    expect(
      screen.getByText("Your data. Your way. All for learning."),
    ).toBeVisible();
  });

  it("普通教师账号分类没有管理入口", async () => {
    vi.mocked(fetchTeacherMe).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      loginName: "teacher",
      isAdmin: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    renderPage("/t/settings?section=account");
    await screen.findByRole("button", { name: "退出登录" });
    expect(screen.queryByRole("link", { name: "系统管理" })).toBeNull();
  });
  it("非管理员普通教师同样可管理本人教学配置：AI 伴学区在 teaching 分类渲染", async () => {
    vi.mocked(fetchTeacherMe).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      loginName: "teacher",
      isAdmin: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    renderPage("/t/settings?section=teaching");
    // teaching 分类含辅助能力与 AI 伴学两区；非管理员不被挡在本人配置外
    expect(
      await screen.findByRole("checkbox", { name: "逐步揭晓" }),
    ).toBeVisible();
    expect(screen.getByRole("region", { name: "AI 伴学设置区" })).toBeVisible();
    // UI 不提供越权入口（无系统管理；账号页不展示内部 UUID）
    expect(screen.queryByRole("link", { name: "系统管理" })).toBeNull();
  });
  it("默认展示学生作答方式，账号与备份不占首屏", async () => {
    renderPage();
    expect(
      await screen.findByRole("checkbox", { name: "逐步揭晓" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
    expect(screen.getByText("备份与恢复内容")).not.toBeVisible();
    expect(screen.getByRole("link", { name: "管理 AI 连接" })).toHaveAttribute(
      "href",
      "/t/connect",
    );
  });

  it("通过 URL 直达备份分类，未知分类回落教学配置", async () => {
    const view = renderPage("/t/settings?section=backup");
    expect(await screen.findByText("备份与恢复内容")).toBeVisible();
    view.unmount();
    renderPage("/t/settings?section=unknown");
    expect(
      await screen.findByRole("checkbox", { name: "逐步揭晓" }),
    ).toBeVisible();
  });

  it("切换分类保存 URL，同时保留未保存的开关", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("checkbox", { name: "逐步揭晓" }));
    fireEvent.click(screen.getByRole("link", { name: "备份与恢复" }));
    expect(screen.getByTestId("location")).toHaveTextContent("?section=backup");
    expect(screen.getByText("备份与恢复内容")).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: "学生作答方式" }));
    expect(
      screen.getByRole("checkbox", { name: "逐步揭晓" }),
    ).not.toBeChecked();
  });
});

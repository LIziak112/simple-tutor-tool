import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TeacherInfo } from "@tutor/contract";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { teacherMeKey } from "@/features/auth/teacher-auth";
import { fetchTeacherMe, logoutTeacher } from "@/lib/api";
import { logoutPersonalApi } from "@/lib/personal-session-legacy-api";
import { fireEvent, render, screen, waitFor } from "@/test/render-with-portal";
import SettingsPage from "./SettingsPage";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchTeacherMe: vi.fn(),
  logoutTeacher: vi.fn(),
  // hall-9533：AI 提示词区在页面测试只要求渲染，不取真实接口
  fetchTeacherAiPromptsApi: async () => ({
    slots: [],
    updatedAt: "1970-01-01T00:00:00.000Z",
  }),
}));

vi.mock("@/lib/device-api", () => ({
  listDevicesApi: vi.fn(async () => ({
    devices: [],
    unassignedSessionCount: 0,
  })),
}));

vi.mock("@/lib/personal-session-legacy-api", () => ({
  logoutPersonalApi: vi.fn(),
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
vi.mock("@/features/student-ai/TeacherAiSettingsPanel", () => ({
  TeacherAiSettingsPanel: () => <section aria-label="AI 伴学设置区" />,
}));

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname === "/t/settings"
        ? location.search
        : location.pathname + location.search + location.hash}
    </output>
  );
}

function renderPage(entry = "/t/settings", cachedTeacher?: TeacherInfo) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (cachedTeacher) client.setQueryData(teacherMeKey, cachedTeacher);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <SettingsPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const teacher = {
  id: "11111111-1111-4111-8111-111111111111",
  loginName: "teacher",
  isAdmin: true,
  accountKind: "class",
  createdAt: "2026-01-01T00:00:00.000Z",
} as const;

beforeEach(() => {
  vi.mocked(fetchTeacherMe).mockResolvedValue(teacher);
});

describe("设置分类", () => {
  it.each(["class", "personal"] as const)(
    "%s账号的设备区沿用门户AI连接能力",
    async (accountKind) => {
      vi.mocked(fetchTeacherMe).mockResolvedValue({ ...teacher, accountKind });
      renderPage("/t/settings?section=account");
      expect(
        await screen.findByRole("heading", { name: "我的设备" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("link", { name: "前往AI连接设置" }) !== null,
      ).toBe(accountKind === "class");
    },
  );
  it("未获主机授权的管理员打开旧备份书签时回落教学设置", async () => {
    renderPage("/t/settings?section=backup");
    expect(
      await screen.findByRole("checkbox", { name: "逐步揭晓" }),
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: "备份与恢复" })).toBeNull();
    expect(screen.queryByText("备份与恢复内容")).toBeNull();
  });

  it("登录回执预填身份后会读取操作员权限并显示备份入口", async () => {
    vi.mocked(fetchTeacherMe).mockResolvedValue({
      ...teacher,
      canManageInstanceBackup: true,
    });
    renderPage("/t/settings?section=backup", teacher);
    expect(await screen.findByText("备份与恢复内容")).toBeVisible();
  });

  it("重新打开设置时以服务端撤销结果覆盖缓存的操作员权限", async () => {
    renderPage("/t/settings?section=backup", {
      ...teacher,
      canManageInstanceBackup: true,
    });
    await screen.findByRole("checkbox", { name: "逐步揭晓" });
    expect(screen.queryByRole("link", { name: "备份与恢复" })).toBeNull();
  });

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

  it("个人账号退出同时结束两侧会话并回 /p/login", async () => {
    vi.mocked(fetchTeacherMe).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      loginName: "小明",
      isAdmin: false,
      accountKind: "personal",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(logoutPersonalApi).mockResolvedValue({ paired: true });
    renderPage("/t/settings?section=account");
    expect(
      await screen.findByText(/退出会同时结束学习视角与管理视角的会话/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/p/login?returnTo=%2Ft%2Fsettings%3Fsection%3Daccount",
      ),
    );
    expect(logoutPersonalApi).toHaveBeenCalledWith("teacher");
    expect(logoutTeacher).not.toHaveBeenCalled();
  });

  it("普通教师账号分类没有管理入口", async () => {
    vi.mocked(fetchTeacherMe).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      loginName: "teacher",
      isAdmin: false,
      accountKind: "class",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    renderPage("/t/settings?section=account");
    await screen.findByRole("button", { name: "退出登录" });
    expect(screen.queryByRole("link", { name: "系统管理" })).toBeNull();
  });
  it("非管理员普通教师同样可管理本人教学配置：AI 伴学区在 AI 设置分类渲染", async () => {
    vi.mocked(fetchTeacherMe).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      loginName: "teacher",
      isAdmin: false,
      accountKind: "class",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    renderPage("/t/settings?section=teaching");
    // teaching 分类含辅助能力与 AI 伴学两区；非管理员不被挡在本人配置外
    expect(
      await screen.findByRole("checkbox", { name: "逐步揭晓" }),
    ).toBeVisible();
    expect(screen.getByLabelText("AI 伴学设置区")).not.toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: "AI 设置" }));
    expect(screen.getByRole("region", { name: "AI 伴学设置区" })).toBeVisible();
    expect(screen.getByTestId("location")).toHaveTextContent("?section=ai");
    // UI 不提供越权入口（无系统管理；账号页不展示内部 UUID）
    expect(screen.queryByRole("link", { name: "系统管理" })).toBeNull();
  });
  it("默认展示学生作答方式，账号与备份不占首屏", async () => {
    renderPage();
    expect(
      await screen.findByRole("checkbox", { name: "逐步揭晓" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
    expect(screen.queryByText("备份与恢复内容")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "AI 设置" }));
    expect(screen.getByRole("link", { name: "管理 AI 连接" })).toHaveAttribute(
      "href",
      "/t/connect",
    );
  });

  it("通过 URL 直达备份分类，未知分类回落教学配置", async () => {
    vi.mocked(fetchTeacherMe).mockResolvedValue({
      ...teacher,
      canManageInstanceBackup: true,
    });
    const view = renderPage("/t/settings?section=backup");
    expect(await screen.findByText("备份与恢复内容")).toBeVisible();
    view.unmount();
    renderPage("/t/settings?section=unknown");
    expect(
      await screen.findByRole("checkbox", { name: "逐步揭晓" }),
    ).toBeVisible();
  });

  it("切换分类保存 URL，同时保留未保存的开关", async () => {
    vi.mocked(fetchTeacherMe).mockResolvedValue({
      ...teacher,
      canManageInstanceBackup: true,
    });
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

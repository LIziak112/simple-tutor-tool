import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAdminOverview, updateAdminSettingsApi } from "@/lib/api";
import { AdminOverviewPage } from "./AdminOverviewPage";

/**
 * /a 概览页测试（T2B.6，D20/§4.3）：
 * 聚合计数卡片渲染；注册开关行显示当前状态并可就地切换（翻转值调 PATCH）。
 */

const apiMocks = vi.hoisted(() => ({
  fetchAdminOverview: vi.fn(),
  updateAdminSettingsApi: vi.fn(),
  fetchAdminSettings: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAdminOverview: apiMocks.fetchAdminOverview,
    updateAdminSettingsApi: apiMocks.updateAdminSettingsApi,
    fetchAdminSettings: apiMocks.fetchAdminSettings,
  };
});

vi.mocked(fetchAdminOverview);
vi.mocked(updateAdminSettingsApi);

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminOverviewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.fetchAdminOverview.mockResolvedValue({
    teacherCount: 3,
    activeTeacherCount: 2,
    studentCount: 12,
    attemptCount: 45,
    sharedFileCount: 1,
    registrationOpen: true,
  });
});

describe("AdminOverviewPage（D20 聚合计数）", () => {
  it("渲染四张计数卡片与注册开关行（开放中）", async () => {
    renderPage();

    expect(await screen.findByText("教师")).toBeInTheDocument();
    expect(screen.getByText("3 人")).toBeInTheDocument();
    expect(screen.getByText("未禁用 2 人")).toBeInTheDocument();
    expect(screen.getByText("学生总数")).toBeInTheDocument();
    expect(screen.getByText("12 人")).toBeInTheDocument();
    expect(screen.getByText("作答总数")).toBeInTheDocument();
    expect(screen.getByText("45 份")).toBeInTheDocument();
    expect(screen.getByText("共享文件")).toBeInTheDocument();
    expect(screen.getByText("1 个")).toBeInTheDocument();
    expect(screen.getByTestId("registration-state")).toHaveTextContent(
      "开放中",
    );
  });

  it("注册开关就地切换：开放中点「关闭注册」→ PATCH allowRegistration=false（§4.3）", async () => {
    apiMocks.updateAdminSettingsApi.mockResolvedValue({
      allowRegistration: false,
    });
    renderPage();

    const toggle = await screen.findByRole("button", { name: "关闭注册" });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(apiMocks.updateAdminSettingsApi.mock.calls[0]?.[0]).toEqual({
        allowRegistration: false,
      });
    });
  });

  it("开关已关时显示「已关闭」与「开放注册」按钮", async () => {
    apiMocks.fetchAdminOverview.mockResolvedValue({
      teacherCount: 1,
      activeTeacherCount: 1,
      studentCount: 0,
      attemptCount: 0,
      sharedFileCount: 0,
      registrationOpen: false,
    });
    renderPage();

    expect(await screen.findByTestId("registration-state")).toHaveTextContent(
      "已关闭",
    );
    expect(
      screen.getByRole("button", { name: "开放注册" }),
    ).toBeInTheDocument();
  });

  it("加载失败 → 错误态与重试", async () => {
    apiMocks.fetchAdminOverview.mockRejectedValue(new Error("网络异常"));
    renderPage();

    expect(await screen.findByText("概览加载失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

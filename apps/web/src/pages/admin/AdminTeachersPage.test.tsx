import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AdminTeacherSummary } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAdminTeacherApi,
  disableAdminTeacherApi,
  fetchAdminTeachers,
} from "@/lib/api";
import { AdminTeachersPage } from "./AdminTeachersPage";

/**
 * /a/teachers 教师管理页测试（T2B.6 验收项）：
 * 管理列表状态标签（正常/已禁用/管理员）、「我」行按钮置灰、创建弹层、
 * 初始密码一次性展示、禁用确认弹层（影响说明）。
 */

const apiMocks = vi.hoisted(() => ({
  fetchAdminTeachers: vi.fn(),
  createAdminTeacherApi: vi.fn(),
  updateAdminTeacherApi: vi.fn(),
  disableAdminTeacherApi: vi.fn(),
  enableAdminTeacherApi: vi.fn(),
  resetAdminTeacherPasswordApi: vi.fn(),
  fetchTeacherMe: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAdminTeachers: apiMocks.fetchAdminTeachers,
    createAdminTeacherApi: apiMocks.createAdminTeacherApi,
    updateAdminTeacherApi: apiMocks.updateAdminTeacherApi,
    disableAdminTeacherApi: apiMocks.disableAdminTeacherApi,
    enableAdminTeacherApi: apiMocks.enableAdminTeacherApi,
    resetAdminTeacherPasswordApi: apiMocks.resetAdminTeacherPasswordApi,
    fetchTeacherMe: apiMocks.fetchTeacherMe,
  };
});

vi.mocked(fetchAdminTeachers);
vi.mocked(createAdminTeacherApi);
vi.mocked(disableAdminTeacherApi);

const MY_ID = "11111111-1111-4111-8111-111111111111";

function teacher(overrides: Partial<AdminTeacherSummary>): AdminTeacherSummary {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    loginName: "李老师",
    isAdmin: false,
    disabledAt: null,
    createdAt: "2026-09-01T08:00:00.000Z",
    studentCount: 3,
    ...overrides,
  };
}

/** 取「创建教师」入口的第一个（页头 + 空态卡片两处都有） */
async function firstCreateButton(): Promise<HTMLElement> {
  const buttons = await screen.findAllByRole("button", { name: "创建教师" });
  const button = buttons[0];
  if (button === undefined) throw new Error("未找到「创建教师」按钮");
  return button;
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminTeachersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.fetchTeacherMe.mockResolvedValue({
    id: MY_ID,
    loginName: "teacher",
    isAdmin: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
});

describe("AdminTeachersPage 列表与状态标签", () => {
  it("渲染教师卡片：登录名、管理员徽章、状态标签、学生数（§4.3）", async () => {
    apiMocks.fetchAdminTeachers.mockResolvedValue({
      teachers: [
        teacher({ loginName: "teacher", isAdmin: true, id: MY_ID }),
        teacher({ loginName: "李老师" }),
        teacher({
          loginName: "王老师",
          disabledAt: "2026-09-28T00:00:00.000Z",
        }),
      ],
    });
    renderPage();

    expect(await screen.findByText("teacher")).toBeInTheDocument();
    // 状态标签：管理员 / 正常 / 已禁用
    const statuses = screen
      .getAllByTestId("teacher-status")
      .map((el) => el.textContent);
    expect(statuses).toEqual(["正常", "正常", "已禁用"]);
    expect(screen.getByText("管理员")).toBeInTheDocument();
    expect(screen.getByText("李老师")).toBeInTheDocument();
    // 学生数（文本节点被 JSX 拆分，按行内整段匹配）
    expect(
      screen.getAllByText(
        (_, element) =>
          element?.tagName === "P" && element.textContent.includes("名学生"),
      ).length,
    ).toBe(3);
  });

  it("「我」所在行标注「我」，禁用与撤销管理员按钮置灰（§4.3 验收项）", async () => {
    apiMocks.fetchAdminTeachers.mockResolvedValue({
      teachers: [
        teacher({ loginName: "teacher", isAdmin: true, id: MY_ID }),
        teacher({ loginName: "李老师" }),
      ],
    });
    renderPage();

    await screen.findByText("teacher");
    const meBadge = screen.getByTestId("me-badge");
    // 「我」徽章位于自己那一行
    expect(meBadge.closest("li")).toHaveTextContent("teacher");

    // 自己行上的「禁用」按钮 disabled；他人行可点（精确匹配行操作按钮，
    // 排除状态筛选组的「未禁用/已禁用」）
    const disableButtons = screen.getAllByRole("button", { name: "禁用" });
    expect(disableButtons).toHaveLength(2);
    const mine = disableButtons.find((b) =>
      b.closest("li")?.textContent?.includes("teacher"),
    );
    const others = disableButtons.find((b) =>
      b.closest("li")?.textContent?.includes("李老师"),
    );
    expect(mine).toBeDefined();
    expect(others).toBeDefined();
    if (mine === undefined || others === undefined)
      throw new Error("按钮行定位失败");
    expect(mine).toBeDisabled();
    expect(others).not.toBeDisabled();

    // 自己（管理员）行上的「撤销管理员」置灰；他人（非管理员）行的「授予管理员」可点
    const revokeMine = screen.getByRole("button", { name: "撤销管理员" });
    expect(revokeMine.closest("li")).toHaveTextContent("teacher");
    expect(revokeMine).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "授予管理员" }),
    ).not.toBeDisabled();
  });

  it("搜索（前端过滤）与状态筛选切换重新拉取", async () => {
    apiMocks.fetchAdminTeachers.mockResolvedValue({
      teachers: [
        teacher({ loginName: "李老师" }),
        teacher({ loginName: "王老师" }),
      ],
    });
    renderPage();
    await screen.findByText("李老师");

    fireEvent.change(screen.getByLabelText("按登录名搜索"), {
      target: { value: "李" },
    });
    expect(screen.getByText("李老师")).toBeInTheDocument();
    expect(screen.queryByText("王老师")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "已禁用" }));
    await waitFor(() => {
      expect(apiMocks.fetchAdminTeachers.mock.calls.at(-1)?.[0]).toBe(
        "disabled",
      );
    });
  });

  it("空列表显示引导空态（创建教师 或 打开注册开关，§4.6）", async () => {
    apiMocks.fetchAdminTeachers.mockResolvedValue({ teachers: [] });
    renderPage();

    expect(await screen.findByText("还没有其他老师")).toBeInTheDocument();
    // 页头 + 空态卡片各一个「创建教师」入口，取第一个
    expect(screen.getAllByRole("button", { name: "创建教师" }).length).toBe(2);
  });
});

describe("AdminTeachersPage 创建教师（§4.4 初始密码一次性展示）", () => {
  it("创建弹层：登录名 + 可选密码；成功后一次性展示初始密码", async () => {
    apiMocks.fetchAdminTeachers.mockResolvedValue({ teachers: [] });
    apiMocks.createAdminTeacherApi.mockResolvedValue({
      teacher: teacher({ loginName: "新老师", studentCount: 0 }),
      initialPassword: "Abc123Xyz789",
    });
    renderPage();

    // 页头 + 空态卡片两个入口，取第一个
    fireEvent.click(await firstCreateButton());

    fireEvent.change(await screen.findByLabelText("登录名"), {
      target: { value: "新老师" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    // 初始密码一次性展示（含「已复制」按钮）
    expect(await screen.findByTestId("one-time-password")).toHaveTextContent(
      "Abc123Xyz789",
    );
    expect(
      screen.getByRole("button", { name: "复制初始密码" }),
    ).toBeInTheDocument();
    expect(apiMocks.createAdminTeacherApi.mock.calls[0]?.[0]).toEqual({
      loginName: "新老师",
    });
  });

  it("自备密码时不弹一次性密码（initialPassword=null）", async () => {
    apiMocks.fetchAdminTeachers.mockResolvedValue({ teachers: [] });
    apiMocks.createAdminTeacherApi.mockResolvedValue({
      teacher: teacher({ loginName: "新老师", studentCount: 0 }),
      initialPassword: null,
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /创建教师/ }));
    fireEvent.change(await screen.findByLabelText("登录名"), {
      target: { value: "新老师" },
    });
    fireEvent.change(screen.getByLabelText(/初始密码/), {
      target: { value: "given-pass-888" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(apiMocks.createAdminTeacherApi.mock.calls[0]?.[0]).toEqual({
        loginName: "新老师",
        password: "given-pass-888",
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("one-time-password")).not.toBeInTheDocument();
    });
  });

  it("重名（409 TEACHER_LOGIN_EXISTS）在弹层内提示", async () => {
    const { ApiError } = await import("@/lib/api");
    apiMocks.fetchAdminTeachers.mockResolvedValue({ teachers: [] });
    apiMocks.createAdminTeacherApi.mockRejectedValue(
      new ApiError("TEACHER_LOGIN_EXISTS", "登录名已被使用，请换一个", 409),
    );
    renderPage();

    fireEvent.click(await firstCreateButton());
    fireEvent.change(await screen.findByLabelText("登录名"), {
      target: { value: "teacher" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "登录名已被使用，请换一个",
    );
  });
});

describe("AdminTeachersPage 禁用确认（§4.1 影响先说清）", () => {
  it("禁用前弹确认层：写明学生不受影响、数据保留、可恢复；确认后调接口并反馈", async () => {
    apiMocks.fetchAdminTeachers.mockResolvedValue({
      teachers: [teacher({ loginName: "李老师", studentCount: 5 })],
    });
    apiMocks.disableAdminTeacherApi.mockResolvedValue(
      teacher({
        loginName: "李老师",
        studentCount: 5,
        disabledAt: "2026-09-30T00:00:00.000Z",
      }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "禁用" }));

    // 确认弹层：影响先说清（5 名学生不受影响、数据保留、可重新启用）
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("停用「李老师」？");
    expect(dialog).toHaveTextContent("5 名学生不受影响");
    expect(dialog).toHaveTextContent("历史数据全部保留");
    expect(dialog).toHaveTextContent("可随时重新启用");

    fireEvent.click(screen.getByRole("button", { name: "确认停用" }));
    await waitFor(() => {
      expect(apiMocks.disableAdminTeacherApi.mock.calls[0]?.[0]).toBe(
        "22222222-2222-4222-8222-222222222222",
      );
    });
    // 成功操作反馈（§4.2）
    expect(await screen.findByTestId("admin-notice")).toHaveTextContent(
      "已停用「李老师」",
    );
  });
});

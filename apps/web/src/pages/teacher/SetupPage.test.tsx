import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SetupPage } from "./SetupPage";

/**
 * /t/setup 表单校验提示测试（T1.9 轻量组件测试；T2B.2 起表单为
 * 「登录名 + 密码 + 确认密码」三字段，登录名默认 teacher 可改）：
 * 登录名（D2 字符集与长度）、密码策略（≥8 字符）与两次一致性的本地提示
 * ——规则来自共享契约，校验失败时不应发起任何请求。
 */

/** api 模块的 mock 实现（hoisted：vi.mock 工厂在模块作用域执行） */
const apiMocks = vi.hoisted(() => ({
  fetchTeacherStatus: vi.fn(),
  setupTeacher: vi.fn(),
  loginTeacher: vi.fn(),
  logoutTeacher: vi.fn(),
  fetchTeacherMe: vi.fn(),
}));

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  return {
    ApiError,
    api: {},
    fetchTeacherStatus: apiMocks.fetchTeacherStatus,
    setupTeacher: apiMocks.setupTeacher,
    loginTeacher: apiMocks.loginTeacher,
    logoutTeacher: apiMocks.logoutTeacher,
    fetchTeacherMe: apiMocks.fetchTeacherMe,
  };
});

function renderSetupPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/t/setup"]}>
        <SetupPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  // 默认场景：尚未设置教师（首启）
  apiMocks.fetchTeacherStatus.mockResolvedValue({
    hasTeacher: false,
    registrationOpen: false,
  });
});

describe("SetupPage 表单校验（登录名 + 密码两字段流程）", () => {
  it("登录名默认预填 teacher（默认建议，可改）", async () => {
    renderSetupPage();
    await waitFor(() => {
      expect(screen.getByLabelText("登录名")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("登录名")).toHaveValue("teacher");
  });

  it("登录名含空格等非法字符时提交给出中文提示，且不发起请求", async () => {
    renderSetupPage();
    await waitFor(() => {
      expect(screen.getByLabelText("登录名")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("登录名"), {
      target: { value: "张 三" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "1234abcd" },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: { value: "1234abcd" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建账号并进入" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "登录名只能包含中文、字母、数字、下划线或连字符",
    );
    expect(apiMocks.setupTeacher).not.toHaveBeenCalled();
  });

  it("登录名过短（1 个字符）时提示长度要求，且不发起请求", async () => {
    renderSetupPage();
    await waitFor(() => {
      expect(screen.getByLabelText("登录名")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("登录名"), {
      target: { value: "a" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "1234abcd" },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: { value: "1234abcd" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建账号并进入" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "登录名至少需要 2 个字符",
    );
    expect(apiMocks.setupTeacher).not.toHaveBeenCalled();
  });

  it("密码少于 8 个字符时提交给出中文提示，且不发起请求", async () => {
    renderSetupPage();
    await waitFor(() => {
      expect(screen.getByLabelText("密码")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "short" },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建账号并进入" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "密码至少需要 8 个字符",
    );
    expect(apiMocks.setupTeacher).not.toHaveBeenCalled();
  });

  it("两次输入不一致时提示「两次输入的密码不一致」", async () => {
    renderSetupPage();
    await waitFor(() => {
      expect(screen.getByLabelText("密码")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "1234abcd" },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: { value: "1234abcX" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建账号并进入" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "两次输入的密码不一致",
    );
    expect(apiMocks.setupTeacher).not.toHaveBeenCalled();
  });

  it("两字段全部合法时按 { loginName, password } 提交（登录名可改）", async () => {
    apiMocks.setupTeacher.mockResolvedValue({
      id: "t1",
      loginName: "王老师",
      isAdmin: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    renderSetupPage();
    await waitFor(() => {
      expect(screen.getByLabelText("登录名")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("登录名"), {
      target: { value: "王老师" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "1234abcd" },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: { value: "1234abcd" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建账号并进入" }));

    // TanStack Query v5 的 mutationFn 会附带第二个 context 参数，只断言首个参数
    await waitFor(() => {
      expect(apiMocks.setupTeacher.mock.calls[0]?.[0]).toEqual({
        loginName: "王老师",
        password: "1234abcd",
      });
    });
  });

  it("已设置教师时不渲染表单（守卫分流到登录页的路由行为由浏览器自验覆盖）", async () => {
    apiMocks.fetchTeacherStatus.mockResolvedValue({
      hasTeacher: true,
      registrationOpen: false,
    });
    renderSetupPage();
    await waitFor(() => {
      expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    });
  });
});

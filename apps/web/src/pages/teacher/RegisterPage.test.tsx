import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RegisterPage } from "./RegisterPage";

/**
 * /t/register 注册页测试（T2B.6 验收：两字段与开关关闭文案）：
 * - 开关开：登录名 + 密码两字段、本地校验、成功注册自动进入 /t；
 * - 开关关：显示「注册已关闭，请联系管理员」，不出表单；
 * - 未设置教师：跳 /t/setup；
 * - 服务端错误：重名（TEACHER_LOGIN_EXISTS）/ 锁定（LOCKED）文案。
 */

const apiMocks = vi.hoisted(() => {
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
    fetchTeacherStatus: vi.fn(),
    setupTeacher: vi.fn(),
    loginTeacher: vi.fn(),
    registerTeacher: vi.fn(),
    logoutTeacher: vi.fn(),
    fetchTeacherMe: vi.fn(),
  };
});

vi.mock("@/lib/api", () => ({
  ApiError: apiMocks.ApiError,
  api: {},
  fetchTeacherStatus: apiMocks.fetchTeacherStatus,
  setupTeacher: apiMocks.setupTeacher,
  loginTeacher: apiMocks.loginTeacher,
  registerTeacher: apiMocks.registerTeacher,
  logoutTeacher: apiMocks.logoutTeacher,
  fetchTeacherMe: apiMocks.fetchTeacherMe,
}));

function renderRegisterPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/t/register"]}>
        <Routes>
          <Route path="/t/register" element={<RegisterPage />} />
          <Route path="/t" element={<p data-testid="teacher-home">教师端</p>} />
          <Route path="/t/setup" element={<p data-testid="setup">初始化</p>} />
          <Route path="/t/login" element={<p data-testid="login">登录</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // 默认场景：已有教师且注册开放
  apiMocks.fetchTeacherStatus.mockResolvedValue({
    hasTeacher: true,
    registrationOpen: true,
  });
});

describe("RegisterPage 表单（开关开）", () => {
  it("渲染登录名 + 密码两字段与注册按钮", async () => {
    renderRegisterPage();
    await waitFor(() => {
      expect(screen.getByLabelText("登录名")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("密码")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "注册并进入" }),
    ).toBeInTheDocument();
  });

  it("本地校验：登录名过短 / 密码过短不发起请求并提示", async () => {
    renderRegisterPage();
    await waitFor(() => {
      expect(screen.getByLabelText("登录名")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("登录名"), {
      target: { value: "a" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "12345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册并进入" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "登录名至少需要 2 个字符",
    );

    fireEvent.change(screen.getByLabelText("登录名"), {
      target: { value: "王老师" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册并进入" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "密码至少需要 8 个字符",
    );
    expect(apiMocks.registerTeacher).not.toHaveBeenCalled();
  });

  it("成功注册自动进入教师端（/t）", async () => {
    apiMocks.registerTeacher.mockResolvedValue({
      id: "t-new",
      loginName: "王老师",
      isAdmin: false,
      createdAt: "2026-09-30T00:00:00.000Z",
    });
    renderRegisterPage();
    await waitFor(() => {
      expect(screen.getByLabelText("登录名")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("登录名"), {
      target: { value: "王老师" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "self-pass-88" },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册并进入" }));

    await waitFor(() => {
      expect(screen.getByTestId("teacher-home")).toBeInTheDocument();
    });
    // TanStack Query v5 的 mutationFn 会附带第二个 context 参数，只断言首个参数
    expect(apiMocks.registerTeacher.mock.calls[0]?.[0]).toEqual({
      loginName: "王老师",
      password: "self-pass-88",
    });
  });

  it("服务端错误：重名（TEACHER_LOGIN_EXISTS）与锁定（LOCKED）展示服务端文案", async () => {
    const { ApiError } = apiMocks;
    apiMocks.registerTeacher.mockRejectedValue(
      new ApiError("TEACHER_LOGIN_EXISTS", "登录名已被使用，请换一个", 409),
    );
    renderRegisterPage();
    await waitFor(() => {
      expect(screen.getByLabelText("登录名")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("登录名"), {
      target: { value: "王老师" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "self-pass-88" },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册并进入" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "登录名已被使用，请换一个",
    );
  });
});

describe("RegisterPage 分流（开关与首启状态）", () => {
  it("开关关闭：显示「注册已关闭，请联系管理员」，不出表单；提供返回登录", async () => {
    apiMocks.fetchTeacherStatus.mockResolvedValue({
      hasTeacher: true,
      registrationOpen: false,
    });
    renderRegisterPage();
    expect(
      await screen.findByText("注册已关闭，请联系管理员"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("登录名")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "返回登录" }),
    ).toHaveAttribute("href", "/t/login");
    expect(apiMocks.registerTeacher).not.toHaveBeenCalled();
  });

  it("未设置教师：跳转初始化页", async () => {
    apiMocks.fetchTeacherStatus.mockResolvedValue({
      hasTeacher: false,
      registrationOpen: false,
    });
    renderRegisterPage();
    await waitFor(() => {
      expect(screen.getByTestId("setup")).toBeInTheDocument();
    });
  });
});

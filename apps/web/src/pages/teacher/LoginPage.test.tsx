import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";

/**
 * /t/login 登录表单测试（T2B.2：「登录名 + 密码」双字段）：
 * 登录名（D2 字符集）与密码的本地校验提示、账号停用（ACCOUNT_DISABLED）等
 * 服务端错误文案展示、成功登录后 localStorage 记住登录名供下次预填。
 */

/** api 模块的 mock 实现（hoisted：vi.mock 工厂在模块作用域执行） */
const apiMocks = vi.hoisted(() => {
  /** 与真实 ApiError 同构的测试替身（code/status 可供断言分支） */
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
  logoutTeacher: apiMocks.logoutTeacher,
  fetchTeacherMe: apiMocks.fetchTeacherMe,
}));

function renderLoginPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/t/login"]}>
        <Routes>
          <Route path="/t/login" element={<LoginPage />} />
          <Route path="/t" element={<p data-testid="teacher-home">教师端</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  // 默认场景：教师已设置（登录页正常展示）
  apiMocks.fetchTeacherStatus.mockResolvedValue({
    hasTeacher: true,
    registrationOpen: false,
  });
});

describe("LoginPage 表单校验", () => {
  it("登录名为空提交时提示「登录名至少需要 2 个字符」，且不发起请求", async () => {
    renderLoginPage();
    await waitFor(() => {
      expect(screen.getByLabelText("登录名")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "1234abcd" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "登录名至少需要 2 个字符",
    );
    expect(apiMocks.loginTeacher).not.toHaveBeenCalled();
  });

  it("登录名含非法字符（空格/斜杠）时提示字符集规则，且不发起请求", async () => {
    renderLoginPage();
    await waitFor(() => {
      expect(screen.getByLabelText("登录名")).toBeInTheDocument();
    });

    for (const bad of ["张 三", "a/b"]) {
      fireEvent.change(screen.getByLabelText("登录名"), {
        target: { value: bad },
      });
      fireEvent.click(screen.getByRole("button", { name: "登录" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "登录名只能包含中文、字母、数字、下划线或连字符",
      );
    }
    expect(apiMocks.loginTeacher).not.toHaveBeenCalled();
  });

  it("密码为空提交时提示「请输入密码」，且不发起请求", async () => {
    renderLoginPage();
    await waitFor(() => {
      expect(screen.getByLabelText("密码")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("登录名"), {
      target: { value: "teacher" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("请输入密码");
    expect(apiMocks.loginTeacher).not.toHaveBeenCalled();
  });
});

describe("LoginPage 服务端错误文案", () => {
  it("账号停用（403 ACCOUNT_DISABLED）时展示服务端文案", async () => {
    const { ApiError } = apiMocks;
    apiMocks.loginTeacher.mockRejectedValue(
      new ApiError("ACCOUNT_DISABLED", "账号已被停用，请联系管理员", 403),
    );
    renderLoginPage();
    await waitFor(() => {
      expect(screen.getByLabelText("登录名")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("登录名"), {
      target: { value: "teacher" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "1234abcd" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "账号已被停用，请联系管理员",
    );
  });

  it("凭证错误（401 INVALID_CREDENTIALS）时展示统一口径文案", async () => {
    const { ApiError } = apiMocks;
    apiMocks.loginTeacher.mockRejectedValue(
      new ApiError("INVALID_CREDENTIALS", "登录名或密码不正确", 401),
    );
    renderLoginPage();
    await waitFor(() => {
      expect(screen.getByLabelText("登录名")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("登录名"), {
      target: { value: "teacher" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "wrong-pass" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "登录名或密码不正确",
    );
  });
});

describe("LoginPage 记住登录名（localStorage 预填）", () => {
  it("成功登录后写入 localStorage 并进入教师端", async () => {
    apiMocks.loginTeacher.mockResolvedValue({
      id: "t1",
      loginName: "王老师",
      isAdmin: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    renderLoginPage();
    await waitFor(() => {
      expect(screen.getByLabelText("登录名")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("登录名"), {
      target: { value: "王老师" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "1234abcd" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => {
      expect(screen.getByTestId("teacher-home")).toBeInTheDocument();
    });
    // TanStack Query v5 的 mutationFn 会附带第二个 context 参数，只断言首个参数
    expect(apiMocks.loginTeacher.mock.calls[0]?.[0]).toEqual({
      loginName: "王老师",
      password: "1234abcd",
    });
    expect(window.localStorage.getItem("tutor:teacher-login-name")).toBe(
      "王老师",
    );
  });

  it("登录失败不写入 localStorage（避免记住敲错的登录名）", async () => {
    const { ApiError } = apiMocks;
    apiMocks.loginTeacher.mockRejectedValue(
      new ApiError("INVALID_CREDENTIALS", "登录名或密码不正确", 401),
    );
    renderLoginPage();
    await waitFor(() => {
      expect(screen.getByLabelText("登录名")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("登录名"), {
      target: { value: "teacher" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "wrong-pass" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByRole("alert");

    expect(window.localStorage.getItem("tutor:teacher-login-name")).toBeNull();
  });

  it("再次进入登录页时用 localStorage 预填登录名", async () => {
    window.localStorage.setItem("tutor:teacher-login-name", "王老师");
    renderLoginPage();
    await waitFor(() => {
      expect(screen.getByLabelText("登录名")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("登录名")).toHaveValue("王老师");
  });
});

describe("LoginPage 注册入口（T2B.6：按 status.registrationOpen 显示）", () => {
  it("开关开：显示「没有账号？注册」链接指向 /t/register", async () => {
    apiMocks.fetchTeacherStatus.mockResolvedValue({
      hasTeacher: true,
      registrationOpen: true,
    });
    renderLoginPage();
    const link = await screen.findByRole("link", { name: "注册" });
    expect(link).toHaveAttribute("href", "/t/register");
  });

  it("开关关：不显示注册入口", async () => {
    apiMocks.fetchTeacherStatus.mockResolvedValue({
      hasTeacher: true,
      registrationOpen: false,
    });
    renderLoginPage();
    await waitFor(() => {
      expect(screen.getByLabelText("登录名")).toBeInTheDocument();
    });
    expect(screen.queryByRole("link", { name: "注册" })).not.toBeInTheDocument();
  });
});

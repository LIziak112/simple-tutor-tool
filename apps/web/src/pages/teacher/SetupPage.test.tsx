import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SetupPage } from "./SetupPage";

/**
 * /t/setup 表单校验提示测试（T1.9 轻量组件测试）：
 * 密码策略（≥8 字符）与两次一致性的本地提示——规则来自共享契约，
 * 校验失败时不应发起任何请求。
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
  // 默认场景：尚未设置教师（首启）
  apiMocks.fetchTeacherStatus.mockResolvedValue({ hasTeacher: false });
});

describe("SetupPage 表单校验", () => {
  it("密码少于 8 个字符时提交给出中文提示，且不发起请求", async () => {
    renderSetupPage();
    // status 查询完成后表单出现
    await waitFor(() => {
      expect(screen.getByLabelText("密码")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "short" },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByRole("button", { name: "设置密码并进入" }));

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
    fireEvent.click(screen.getByRole("button", { name: "设置密码并进入" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "两次输入的密码不一致",
    );
    expect(apiMocks.setupTeacher).not.toHaveBeenCalled();
  });

  it("已设置教师时不渲染表单（守卫分流到登录页的路由行为由浏览器自验覆盖）", async () => {
    apiMocks.fetchTeacherStatus.mockResolvedValue({ hasTeacher: true });
    renderSetupPage();
    await waitFor(() => {
      expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    });
  });
});

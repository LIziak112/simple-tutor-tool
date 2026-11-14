import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PersonalSessionData } from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchTeacherStatus } from "@/lib/api";
import { registerPersonalApi } from "@/lib/personal-session-legacy-api";
import { fireEvent, render, screen, waitFor } from "@/test/render-with-portal";
import PersonalRegisterPage from "./PersonalRegisterPage";

/**
 * /p/register 个人学习注册页（模块 0）：
 * - status.personalRegistrationOpen=false → 关闭态提示 + 返回登录；
 * - 开放 → 四字段表单；前端先按契约校验（缺邀请码不发请求）；
 * - 成功 → 调 registerPersonalApi（trim 后的邀请码、可选昵称）并跳 /p/learn/home；
 * - 服务端 403 INVITE_CODE_INVALID → 原文提示。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, fetchTeacherStatus: vi.fn() };
});
vi.mock("@/lib/personal-session-legacy-api", () => ({
  registerPersonalApi: vi.fn(),
  loginPersonalApi: vi.fn(),
}));

const mockedStatus = vi.mocked(fetchTeacherStatus);
const mockedRegister = vi.mocked(registerPersonalApi);

const SESSION: PersonalSessionData = {
  teacher: {
    id: "22222222-2222-4222-8222-222222222222",
    loginName: "kaosheng",
    isAdmin: false,
    accountKind: "personal",
    createdAt: "2026-11-09T00:00:00.000Z",
  },
  student: {
    id: "11111111-1111-4111-8111-111111111111",
    displayName: "小考",
    loginName: "kaosheng",
    linkEnabled: false,
    passwordEnabled: false,
    accountKind: "personal",
  },
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/p/register"]}>
        <Routes>
          <Route path="/p/register" element={<PersonalRegisterPage />} />
          <Route
            path="/p/learn/home"
            element={<p data-testid="route-stub">学习视角首页</p>}
          />
          <Route
            path="/p/login"
            element={<p data-testid="route-stub">个人登录页</p>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedStatus.mockResolvedValue({
    hasTeacher: true,
    registrationOpen: true,
    personalRegistrationOpen: true,
  });
});

describe("PersonalRegisterPage（模块 0）", () => {
  it("未开放（无邀请码）→ 关闭态提示与返回登录", async () => {
    mockedStatus.mockResolvedValue({
      hasTeacher: true,
      registrationOpen: true,
      personalRegistrationOpen: false,
    });
    renderPage();

    expect(await screen.findByText("个人学习注册未开放")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回登录" })).toHaveAttribute(
      "href",
      "/p/login",
    );
    expect(mockedRegister).not.toHaveBeenCalled();
  });

  it("缺邀请码时前端拦截，不发请求", async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText("登录名"), {
      target: { value: "kaosheng" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "personal-pass-8" },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册并开始学习" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("请输入邀请码");
    expect(mockedRegister).not.toHaveBeenCalled();
  });

  it("成功：按契约 trim 邀请码、昵称可选 → 调接口并跳 /p/learn/home", async () => {
    mockedRegister.mockResolvedValue(SESSION);
    renderPage();
    fireEvent.change(await screen.findByLabelText("登录名"), {
      target: { value: "kaosheng" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "personal-pass-8" },
    });
    fireEvent.change(screen.getByLabelText("邀请码"), {
      target: { value: "  GONGKAO-2026 " },
    });
    fireEvent.change(screen.getByLabelText(/昵称/), {
      target: { value: " 小考 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册并开始学习" }));

    await waitFor(() => {
      // mutationFn 的第二个实参是 TanStack 的 mutation 上下文，只断言请求体
      expect(mockedRegister.mock.calls[0]?.[0]).toEqual({
        loginName: "kaosheng",
        password: "personal-pass-8",
        inviteCode: "GONGKAO-2026",
        displayName: "小考",
      });
      expect(screen.getByTestId("route-stub")).toHaveTextContent(
        "学习视角首页",
      );
    });
  });

  it("服务端 403 INVITE_CODE_INVALID → 原文提示，停留本页", async () => {
    mockedRegister.mockRejectedValue(
      new ApiError("INVITE_CODE_INVALID", "邀请码不正确", 403),
    );
    renderPage();
    fireEvent.change(await screen.findByLabelText("登录名"), {
      target: { value: "kaosheng" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "personal-pass-8" },
    });
    fireEvent.change(screen.getByLabelText("邀请码"), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册并开始学习" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("邀请码不正确");
    expect(screen.queryByTestId("route-stub")).not.toBeInTheDocument();
  });
});

import { screen, waitFor } from "@testing-library/react";
import type { StudentMeData } from "@tutor/contract";
import { describe, expect, it, vi } from "vitest";
import { ApiError, loginStudentByLinkApi } from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentLinkLoginPage from "./StudentLinkLoginPage";

/**
 * 学生专属链接登录页组件测试（T2.3）：挂载即用 URL token 调链接登录、
 * 成功跳 /s/home；失效（401 LINK_INVALID）显示中文指引 + 「去密码登录」入口。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    loginStudentByLinkApi: vi.fn(),
    fetchStudentAssignmentsApi: vi.fn(),
    fetchStudentCoursesApi: vi.fn(),
    fetchStudentLecturesApi: vi.fn(),
  };
});

const mockedLinkLogin = vi.mocked(loginStudentByLinkApi);

const STUDENT: StudentMeData = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "张三",
  loginName: "张三",
  linkEnabled: true,
  passwordEnabled: true,
};

function renderPage(token = "abc-link-token") {
  return renderWithStudentRoutes({
    initialPath: `/s/${token}`,
    routePath: "/s/:token",
    element: <StudentLinkLoginPage />,
  });
}

describe("StudentLinkLoginPage", () => {
  it("挂载即以 URL 中的 token 调链接登录，成功跳 /s/home", async () => {
    mockedLinkLogin.mockResolvedValue(STUDENT);
    renderPage("valid-token-123");

    await waitFor(() => {
      expect(screen.getByTestId("route-stub")).toHaveTextContent("学生首页");
    });
    // TanStack v5 的 mutationFn 第二参为回调上下文，只断言首参（token）
    expect(mockedLinkLogin.mock.calls[0]?.[0]).toBe("valid-token-123");
  });

  it("链接失效显示中文指引与「去密码登录」入口（点击可达登录页）", async () => {
    mockedLinkLogin.mockRejectedValue(
      new ApiError("LINK_INVALID", "专属链接不存在或已失效", 401),
    );
    renderPage("stale-token");

    expect(
      await screen.findByRole("heading", { name: "链接已失效" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/请联系老师重新发送链接/)).toBeInTheDocument();

    const loginLink = screen.getByRole("link", { name: "去密码登录" });
    expect(loginLink).toHaveAttribute("href", "/s/login");
  });

  it("网络错误显示错误态与重试按钮（点击重新发起登录）", async () => {
    mockedLinkLogin
      .mockRejectedValueOnce(new Error("连不上服务器"))
      .mockResolvedValueOnce(STUDENT);
    renderPage("flaky-token");

    const retry = await screen.findByRole("button", { name: "重试" });
    expect(screen.getByText("连不上服务器")).toBeInTheDocument();
    retry.click();

    await waitFor(() => {
      expect(screen.getByTestId("route-stub")).toHaveTextContent("学生首页");
    });
  });
});

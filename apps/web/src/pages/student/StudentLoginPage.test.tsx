import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { StudentMeData } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchStudentMe, loginStudentApi } from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentLoginPage from "./StudentLoginPage";

/**
 * 学生密码登录页组件测试（T2.3）：成功跳 /s/home、失败按错误码提示、
 * 已登录访问直接跳走。API 层 mock（真实接口行为由后端 students.test.ts 覆盖）；
 * 业务错误用真实 ApiError 实例抛出（组件按 instanceof ApiError 分支展示）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    loginStudentApi: vi.fn(),
    fetchStudentMe: vi.fn(),
    fetchStudentAssignmentsApi: vi.fn(),
    fetchStudentCoursesApi: vi.fn(),
    fetchStudentLecturesApi: vi.fn(),
  };
});

const mockedLogin = vi.mocked(loginStudentApi);
const mockedMe = vi.mocked(fetchStudentMe);

const STUDENT: StudentMeData = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "张三",
  loginName: "张三",
  linkEnabled: true,
  passwordEnabled: true,
};

function renderPage() {
  return renderWithStudentRoutes({
    initialPath: "/s/login",
    routePath: "/s/login",
    element: <StudentLoginPage />,
  });
}

beforeEach(() => {
  // 缺省未登录（me 401 → 显示登录表单）
  mockedMe.mockRejectedValue(
    new ApiError("UNAUTHORIZED", "未登录或会话已过期，请重新登录", 401),
  );
});

describe("StudentLoginPage", () => {
  it("未登录时显示登录表单（登录名 + 密码）", async () => {
    renderPage();
    expect(await screen.findByLabelText("登录名")).toBeInTheDocument();
    expect(screen.getByLabelText("密码")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
  });

  it("登录成功跳转 /s/home", async () => {
    mockedLogin.mockResolvedValue(STUDENT);
    renderPage();

    fireEvent.change(await screen.findByLabelText("登录名"), {
      target: { value: "张三" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "stu-pass-6" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => {
      expect(screen.getByTestId("route-stub")).toHaveTextContent("学生首页");
    });
    expect(mockedLogin).toHaveBeenCalledWith({
      loginName: "张三",
      password: "stu-pass-6",
    });
  });

  it("凭证错误显示统一口径中文提示（防枚举）", async () => {
    mockedLogin.mockRejectedValue(
      new ApiError("INVALID_CREDENTIALS", "登录名或密码不正确", 401),
    );
    renderPage();

    fireEvent.change(await screen.findByLabelText("登录名"), {
      target: { value: "张三" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "wrong-pass" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "登录名或密码不正确，请检查后再试",
    );
    // 登录失败停留在登录页
    expect(screen.getByLabelText("登录名")).toBeInTheDocument();
  });

  it("限流锁定提示稍后再试", async () => {
    mockedLogin.mockRejectedValue(new ApiError("LOCKED", "尝试次数过多", 429));
    renderPage();

    fireEvent.change(await screen.findByLabelText("登录名"), {
      target: { value: "张三" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "whatever" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "尝试次数过多，已暂时锁定",
    );
  });

  it("已登录访问直接跳 /s/home（不显示表单）", async () => {
    mockedMe.mockResolvedValue(STUDENT);
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("route-stub")).toHaveTextContent("学生首页");
    });
  });
});

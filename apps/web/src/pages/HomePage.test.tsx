import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StudentMeData, TeacherInfo } from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchHealth,
  fetchStudentMe,
  fetchTeacherMe,
} from "@/lib/api";
import { HomePage } from "./HomePage";

/**
 * 首页登录面板测试：未登录时展示学生/教师两个入口（链接指向各自登录页）、
 * 已登录时对应卡换文案并直达端内页、底部系统状态卡三态（成功时间/错误重试）。
 * API 层 mock（真实接口行为由后端测试覆盖）；未登录用真实 ApiError 401。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchHealth: vi.fn(),
    fetchStudentMe: vi.fn(),
    fetchTeacherMe: vi.fn(),
  };
});

const mockedHealth = vi.mocked(fetchHealth);
const mockedStudentMe = vi.mocked(fetchStudentMe);
const mockedTeacherMe = vi.mocked(fetchTeacherMe);

const STUDENT: StudentMeData = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "张三",
  loginName: "张三",
  linkEnabled: true,
  passwordEnabled: true,
};

const TEACHER: TeacherInfo = {
  id: "22222222-2222-4222-8222-222222222222",
  loginName: "demo",
  isAdmin: false,
  createdAt: "2026-09-01T00:00:00.000Z",
};

function renderHomePage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // 缺省：两端均未登录（me 401），系统状态正常
  mockedStudentMe.mockRejectedValue(
    new ApiError("UNAUTHORIZED", "未登录或会话已过期，请重新登录", 401),
  );
  mockedTeacherMe.mockRejectedValue(
    new ApiError("UNAUTHORIZED", "未登录或会话已过期，请重新登录", 401),
  );
  mockedHealth.mockResolvedValue({ time: "2026-10-05T08:30:00.000Z" });
});

describe("HomePage 登录入口面板", () => {
  it("未登录时展示学生/教师两个登录入口，链接指向各自登录页", async () => {
    renderHomePage();

    const studentLink = await screen.findByRole("link", { name: /学生登录/ });
    expect(studentLink).toHaveAttribute("href", "/s/login");
    expect(screen.getByRole("link", { name: /教师登录/ })).toHaveAttribute(
      "href",
      "/t/login",
    );
  });

  it("学生已登录时学生卡直达 /s/home 并显示姓名，教师卡仍是登录入口", async () => {
    mockedStudentMe.mockResolvedValue(STUDENT);
    renderHomePage();

    const studentLink = await screen.findByRole("link", { name: /继续学习/ });
    expect(studentLink).toHaveAttribute("href", "/s/home");
    expect(studentLink).toHaveTextContent("已登录：张三");
    expect(screen.getByRole("link", { name: /教师登录/ })).toHaveAttribute(
      "href",
      "/t/login",
    );
  });

  it("教师已登录时教师卡直达 /t 并显示登录名，学生卡仍是登录入口", async () => {
    mockedTeacherMe.mockResolvedValue(TEACHER);
    renderHomePage();

    const teacherLink = await screen.findByRole("link", { name: /进入工作台/ });
    expect(teacherLink).toHaveAttribute("href", "/t");
    expect(teacherLink).toHaveTextContent("已登录：demo");
    expect(screen.getByRole("link", { name: /学生登录/ })).toHaveAttribute(
      "href",
      "/s/login",
    );
  });
});

describe("HomePage 系统状态卡", () => {
  it("成功态显示 Asia/Shanghai 服务器时间", async () => {
    renderHomePage();

    expect(
      await screen.findByText("2026年10月5日 16:30:00"),
    ).toBeInTheDocument();
  });

  it("错误态显示原因与重试按钮，点击重试重新请求", async () => {
    mockedHealth.mockRejectedValue(new Error("网络断开"));
    renderHomePage();

    expect(await screen.findByText(/无法获取服务器时间/)).toHaveTextContent(
      "网络断开",
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => {
      expect(mockedHealth).toHaveBeenCalledTimes(2);
    });
  });
});

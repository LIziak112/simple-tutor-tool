import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  CourseListData,
  StudentCreateData,
  StudentListData,
  StudentSummary,
} from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStudentApi,
  fetchStudentsApi,
  fetchTeacherCourses,
  resetStudentLinkApi,
  resetStudentPasswordApi,
  updateStudentApi,
} from "@/lib/api";
import { copyText } from "@/lib/copy";
import StudentsPage from "./StudentsPage";

/**
 * 学生页组件测试（T2.1 三态 + 列表操作 + 新增流程）。
 * API 层 mock（真实接口行为由后端 students.test.ts 集成覆盖）；
 * 复制降级链路在 lib/copy.test.ts 单测。
 * T2A.4：mock 课程列表（所在课程列 / 新增可选课程 / 管理课程的数据源）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentsApi: vi.fn(),
    createStudentApi: vi.fn(),
    updateStudentApi: vi.fn(),
    resetStudentPasswordApi: vi.fn(),
    resetStudentLinkApi: vi.fn(),
    fetchTeacherCourses: vi.fn(),
  };
});

vi.mock("@/lib/copy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copy")>();
  return {
    ...actual,
    copyText: vi.fn().mockResolvedValue(true),
  };
});

const mockedFetch = vi.mocked(fetchStudentsApi);
const mockedCreate = vi.mocked(createStudentApi);
const mockedUpdate = vi.mocked(updateStudentApi);
const mockedResetPassword = vi.mocked(resetStudentPasswordApi);
const mockedResetLink = vi.mocked(resetStudentLinkApi);
const mockedCopy = vi.mocked(copyText);
const mockedCourses = vi.mocked(fetchTeacherCourses);

/** T2A.4：课程列表默认返回空（所在课程列显示「未加入任何课程」） */
const emptyCourseList = (archived: boolean): CourseListData => ({
  courses: [],
  ...(archived ? {} : {}),
});

/** 取非空值（替代非空断言，biome noNonNullAssertion） */
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`测试前置条件不满足：${what}`);
  }
  return value;
}

/** 包 QueryClient 渲染页面 */
function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <StudentsPage />
    </QueryClientProvider>,
  );
}

const TOKEN_A = "aaaa-token-a";
const TOKEN_B = "bbbb-token-b";

const STUDENT_A: StudentSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "张三",
  loginName: "张三",
  linkEnabled: true,
  passwordEnabled: true,
  hasPassword: true,
  linkToken: TOKEN_A,
  note: "初二，周三晚课",
  archived: false,
  createdAt: "2026-09-20T10:00:00.000Z",
};

const STUDENT_B: StudentSummary = {
  id: "22222222-2222-4222-8222-222222222222",
  displayName: "李四",
  loginName: "李四2",
  linkEnabled: false,
  passwordEnabled: false,
  hasPassword: true,
  linkToken: TOKEN_B,
  note: null,
  archived: true,
  createdAt: "2026-09-25T10:00:00.000Z",
};

const LIST: StudentListData = { students: [STUDENT_A, STUDENT_B] };

describe("StudentsPage 三态", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCourses.mockImplementation((archived: boolean) =>
      Promise.resolve(emptyCourseList(archived)),
    );
  });

  it("加载中显示骨架与提示，不白屏", () => {
    mockedFetch.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText("正在加载学生…")).toBeInTheDocument();
  });

  it("加载失败显示错误原因与重试按钮，重试后恢复", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("连不上服务器"));
    renderPage();
    expect(await screen.findByText("学生加载失败")).toBeInTheDocument();
    expect(screen.getByText("连不上服务器")).toBeInTheDocument();

    mockedFetch.mockResolvedValue({ students: [] });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("还没有学生")).toBeInTheDocument();
  });

  it("空态：解释性文案 + 新增学生入口", async () => {
    mockedFetch.mockResolvedValue({ students: [] });
    renderPage();
    expect(await screen.findByText("还没有学生")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /新增学生/ }).length,
    ).toBeGreaterThan(0);
  });
});

describe("StudentsPage 列表与操作", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetch.mockResolvedValue(LIST);
    mockedCourses.mockImplementation((archived: boolean) =>
      Promise.resolve(emptyCourseList(archived)),
    );
  });

  it("渲染姓名、登录名、备注、归档标记与两种登录方式状态", async () => {
    renderPage();
    expect(await screen.findByText("张三")).toBeInTheDocument();
    expect(screen.getByText("李四")).toBeInTheDocument();
    expect(screen.getByText("登录名：张三")).toBeInTheDocument();
    expect(screen.getByText("登录名：李四2")).toBeInTheDocument();
    expect(screen.getByText("已归档")).toBeInTheDocument();
    expect(screen.getByText("备注：初二，周三晚课")).toBeInTheDocument();
    // 张三链接开启、李四链接关闭
    expect(screen.getAllByText("专属链接：已开启").length).toBe(1);
    expect(screen.getAllByText("专属链接：已关闭").length).toBe(1);
    expect(screen.getByText("共 2 名学生")).toBeInTheDocument();
  });

  it("T2A.4：所在课程列显示课程徽标，未加入显示提示", async () => {
    mockedCourses.mockImplementation((archived: boolean) =>
      Promise.resolve(
        archived
          ? { courses: [] }
          : {
              courses: [
                {
                  id: "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
                  name: "初一上",
                  description: null,
                  archived: false,
                  archivedAt: null,
                  order: 0,
                  memberCount: 1,
                  itemCount: 3,
                  visibleItemCount: 2,
                  memberIds: [STUDENT_A.id],
                  hasAttempts: false,
                  createdAt: "2026-09-01T00:00:00.000Z",
                },
              ],
            },
      ),
    );
    renderPage();
    // 张三在「初一上」，李四未加入任何课程
    expect(await screen.findByText("初一上")).toBeInTheDocument();
    expect(screen.getByText("未加入任何课程")).toBeInTheDocument();
    // 行操作「管理课程」按钮存在
    expect(screen.getAllByRole("button", { name: "管理课程" }).length).toBe(2);
  });

  it("点按开关调用 PATCH（linkEnabled 取反）", async () => {
    renderPage();
    const toggle = await screen.findByRole("button", {
      name: "专属链接：已开启",
    });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mockedUpdate.mock.calls[0]?.[0]).toBe(STUDENT_A.id),
    );
    expect(mockedUpdate.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ linkEnabled: false }),
    );
  });

  it("归档按钮调用 PATCH（archived 取反）", async () => {
    renderPage();
    const buttons = await screen.findAllByRole("button", { name: "归档" });
    fireEvent.click(must(buttons[0], "归档按钮"));
    await waitFor(() =>
      expect(mockedUpdate.mock.calls[0]?.[0]).toBe(STUDENT_A.id),
    );
    expect(mockedUpdate.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ archived: true }),
    );
    // 已归档的学生显示「取消归档」
    expect(
      screen.getByRole("button", { name: "取消归档" }),
    ).toBeInTheDocument();
  });

  it("复制专属链接：拼完整地址 origin/s/token 并给出成功反馈", async () => {
    renderPage();
    const copyButtons = await screen.findAllByRole("button", {
      name: "复制专属链接",
    });
    fireEvent.click(must(copyButtons[0], "复制按钮"));
    await waitFor(() =>
      expect(mockedCopy).toHaveBeenCalledWith(
        `${window.location.origin}/s/${TOKEN_A}`,
      ),
    );
    expect(await screen.findByText("已复制专属链接")).toBeInTheDocument();
  });

  it("重置密码：弹窗展示一次性明文", async () => {
    mockedResetPassword.mockResolvedValue({ password: "NewPass99" });
    renderPage();
    const buttons = await screen.findAllByRole("button", { name: "重置密码" });
    fireEvent.click(must(buttons[0], "重置密码按钮"));
    expect(await screen.findByText("张三 的新密码")).toBeInTheDocument();
    expect(screen.getByText("NewPass99")).toBeInTheDocument();
    // TanStack Query 会给 mutationFn 传第二个 context 参数，只断言首参（学生 id）
    expect(mockedResetPassword.mock.calls[0]?.[0]).toBe(STUDENT_A.id);
  });

  it("重置链接：弹窗展示新链接（旧链接立即失效的提示）", async () => {
    mockedResetLink.mockResolvedValue({ linkToken: "new-token-x" });
    renderPage();
    const buttons = await screen.findAllByRole("button", { name: "重置链接" });
    fireEvent.click(must(buttons[0], "重置链接按钮"));
    expect(await screen.findByText("张三 的新专属链接")).toBeInTheDocument();
    expect(
      screen.getByText(`${window.location.origin}/s/new-token-x`),
    ).toBeInTheDocument();
  });
});

describe("StudentsPage 新增学生", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetch.mockResolvedValue({ students: [] });
    mockedCourses.mockImplementation((archived: boolean) =>
      Promise.resolve(emptyCourseList(archived)),
    );
  });

  it("登录名默认跟随姓名；提交正确 payload；生成密码时弹一次性明文", async () => {
    const created: StudentCreateData = {
      student: {
        id: "33333333-3333-4333-8333-333333333333",
        displayName: "王五",
        loginName: "王五",
        linkEnabled: true,
        passwordEnabled: true,
        hasPassword: true,
        linkToken: "wuwu-token",
        note: null,
        archived: false,
        createdAt: "2026-09-27T00:00:00.000Z",
      },
      initialPassword: "InitPass9",
    };
    mockedCreate.mockResolvedValue(created);

    renderPage();
    // 空态下「新增学生」有两个入口（页头 + 空态卡片），取第一个
    const createButtons = await screen.findAllByRole("button", {
      name: /新增学生/,
    });
    fireEvent.click(must(createButtons[0], "新增学生入口"));

    // 精确匹配「姓名」标签（「登录名（默认同姓名…）」也含"姓名"二字）
    const nameInput = await screen.findByLabelText("姓名");
    fireEvent.change(nameInput, { target: { value: "王五" } });
    // 登录名未手动改过 → 提交值等于姓名
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    // TanStack Query 给 mutationFn 传第二个 context 参数，只断言首参
    await waitFor(() =>
      expect(mockedCreate.mock.calls[0]?.[0]).toEqual({
        displayName: "王五",
        loginName: "王五",
      }),
    );
    // 一次性初始密码弹窗（关闭创建弹窗后展示）
    expect(await screen.findByText("王五 的初始密码")).toBeInTheDocument();
    expect(screen.getByText("InitPass9")).toBeInTheDocument();
  });

  it("登录名重复（409 LOGIN_NAME_TAKEN）显示可指导的中文提示", async () => {
    const { ApiError } = await import("@/lib/api");
    mockedCreate.mockRejectedValue(
      new ApiError("LOGIN_NAME_TAKEN", "登录名已被使用，请换一个", 409),
    );

    renderPage();
    const createButtons = await screen.findAllByRole("button", {
      name: /新增学生/,
    });
    fireEvent.click(must(createButtons[0], "新增学生入口"));
    fireEvent.change(await screen.findByLabelText("姓名"), {
      target: { value: "张三" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    expect(
      await screen.findByText(/登录名已被使用，请换一个/),
    ).toBeInTheDocument();
  });
});

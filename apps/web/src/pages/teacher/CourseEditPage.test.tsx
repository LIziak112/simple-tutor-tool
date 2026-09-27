import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  CourseDetailData,
  CourseListData,
  CourseStudentViewData,
} from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCourseDetail,
  fetchCourseStudentView,
  fetchTeacherCourses,
} from "@/lib/api";
import CourseEditPage from "./CourseEditPage";
import CoursesPage from "./CoursesPage";

/**
 * 课程页面组件测试（T2A.4 验收项）：
 * - 定时发布显示「定时」标签与北京时间（Asia/Shanghai，M月D日 HH:mm）；
 * - 隐藏条目在学生可见预览中消失（预览只渲染 student-view 返回的 D5 过滤目录）；
 * - 列表页卡片展示成员数 / 条目数 / 可见条目数（三态齐全由 isPending 分支保证）。
 * API 层 mock（真实 D5 过滤行为由服务端 routes/courses.test.ts 覆盖）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchCourseDetail: vi.fn(),
    fetchCourseStudentView: vi.fn(),
    fetchTeacherCourses: vi.fn(),
  };
});

const mockedDetail = vi.mocked(fetchCourseDetail);
const mockedStudentView = vi.mocked(fetchCourseStudentView);
const mockedCourses = vi.mocked(fetchTeacherCourses);

const COURSE_ID = "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b";
const STUDENT_ID = "1b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b";

const DETAIL: CourseDetailData = {
  id: COURSE_ID,
  name: "初一上",
  description: null,
  archived: false,
  archivedAt: null,
  order: 0,
  hasAttempts: false,
  createdAt: "2026-09-01T00:00:00.000Z",
  members: [
    {
      studentId: STUDENT_ID,
      displayName: "张三",
      joinedAt: "2026-09-01T00:00:00.000Z",
      archived: false,
    },
  ],
  items: [
    {
      // 定时发布：2099-09-30T00:00:00Z = 北京时间 09月30日 08:00
      id: "3b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
      kind: "lecture",
      refId: "4b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
      title: "第1讲 有理数",
      order: 0,
      visible: true,
      publishAt: "2099-09-30T00:00:00.000Z",
      status: "scheduled",
      questionCount: null,
      resourceUpdatedAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    {
      // 隐藏单元：学生不可见
      id: "5b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
      kind: "unit",
      refId: "练习四",
      title: "练习四",
      order: 1,
      visible: false,
      publishAt: null,
      status: "hidden",
      questionCount: 8,
      resourceUpdatedAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ],
};

const STUDENT_VIEW: CourseStudentViewData = {
  studentId: STUDENT_ID,
  studentName: "张三",
  courseArchived: false,
  studentArchived: false,
  isMember: true,
  // D5 过滤后：隐藏单元消失（服务端计算，此处为 mock 响应）
  items: [
    {
      id: DETAIL.items[0]?.id as string,
      kind: "lecture",
      refId: DETAIL.items[0]?.refId as string,
      title: "第1讲 有理数",
      order: 0,
    },
  ],
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/t/courses/${COURSE_ID}`]}>
        <Routes>
          <Route path="/t/courses/:id" element={<CourseEditPage />} />
          <Route path="/t/courses" element={<CoursesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedDetail.mockResolvedValue(DETAIL);
  mockedStudentView.mockResolvedValue(STUDENT_VIEW);
});

describe("CourseEditPage（T2A.4）", () => {
  it("定时发布条目显示「定时」标签与北京时间（9月30日 08:00 发布）", async () => {
    renderPage();
    expect(await screen.findByText("定时（9月30日 08:00 发布）")).toBeVisible();
    // 目录标签同时给出讲义类型说明
    expect(await screen.findByText("第1讲 有理数")).toBeVisible();
  });

  it("隐藏条目在学生可见预览中消失（预览只含 student-view 返回条目）", async () => {
    renderPage();
    await screen.findByText("练习四");

    // 打开学生可见预览
    fireEvent.click(screen.getByRole("button", { name: /学生可见预览/ }));
    const panel = await screen.findByLabelText("学生可见预览");
    // 可见的讲义出现在预览中；隐藏的「练习四」不出现（D5 服务端过滤 + 前端只读渲染）
    expect(await within(panel).findByText("第1讲 有理数")).toBeVisible();
    expect(within(panel).queryByText("练习四")).toBeNull();
    expect(within(panel).getByText("张三 · 共 1 条可见")).toBeVisible();

    expect(mockedStudentView).toHaveBeenCalledWith(COURSE_ID, STUDENT_ID);
  });

  it("详情加载失败显示错误态与重试", async () => {
    mockedDetail.mockRejectedValue(new Error("课程不存在"));
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("课程加载失败");
    expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
  });
});

describe("CoursesPage（T2A.4）", () => {
  it("卡片展示名称、成员数、条目数、可见条目数", async () => {
    const data: CourseListData = {
      courses: [
        {
          id: COURSE_ID,
          name: "初一上",
          description: null,
          archived: false,
          archivedAt: null,
          order: 0,
          memberCount: 2,
          itemCount: 5,
          visibleItemCount: 3,
          memberIds: [STUDENT_ID],
          hasAttempts: false,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    };
    mockedCourses.mockResolvedValue(data);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/t/courses"]}>
          <Routes>
            <Route path="/t/courses" element={<CoursesPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("初一上")).toBeVisible();
    expect(screen.getByText("成员 2")).toBeVisible();
    expect(screen.getByText("条目 5（可见 3）")).toBeVisible();
    await waitFor(() => expect(mockedCourses).toHaveBeenCalledWith(false));
  });
});

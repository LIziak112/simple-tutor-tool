import { screen } from "@testing-library/react";
import type {
  StudentAssignmentListData,
  StudentLectureListData,
} from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStudentAssignmentsApi, fetchStudentLecturesApi } from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentHomePage from "./StudentHomePage";

/**
 * 学生首页组件测试（T2.3）：作业卡片（标题/单元/题数/截止/状态徽章）、
 * 讲义摘要入口、我的记录入口、作业与讲义空态。API 层 mock。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentAssignmentsApi: vi.fn(),
    fetchStudentLecturesApi: vi.fn(),
  };
});

const mockedAssignments = vi.mocked(fetchStudentAssignmentsApi);
const mockedLectures = vi.mocked(fetchStudentLecturesApi);

const ASSIGNMENTS: StudentAssignmentListData = {
  assignments: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      title: "周末加练",
      unitId: "unit-一元一次方程",
      unitTitle: "一元一次方程",
      topic: "方程",
      questionCount: 5,
      dueAt: "2026-10-01T12:00:00.000Z",
      createdAt: "2026-09-26T08:00:00.000Z",
      status: "not_started",
    },
    {
      id: "55555555-5555-4555-8555-555555555555",
      title: "课前预习",
      unitId: "unit-有理数",
      unitTitle: "有理数",
      topic: null,
      questionCount: 3,
      dueAt: null,
      createdAt: "2026-09-25T08:00:00.000Z",
      status: "not_started",
    },
  ],
};

const LECTURES: StudentLectureListData = {
  lectures: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      title: "第1讲 有理数",
      topic: "有理数",
      updatedAt: "2026-09-20T10:00:00.000Z",
    },
    {
      id: "66666666-6666-4666-8666-666666666666",
      title: "第2讲 数轴",
      topic: null,
      updatedAt: "2026-09-21T10:00:00.000Z",
    },
  ],
};

function renderPage() {
  return renderWithStudentRoutes({
    initialPath: "/s/home",
    routePath: "/s/home",
    element: <StudentHomePage />,
  });
}

beforeEach(() => {
  mockedAssignments.mockReset();
  mockedLectures.mockReset();
});

describe("StudentHomePage", () => {
  it("渲染作业卡片：标题、单元、题数、截止北京时间、不限截止、状态徽章", async () => {
    mockedAssignments.mockResolvedValue(ASSIGNMENTS);
    mockedLectures.mockResolvedValue(LECTURES);
    renderPage();

    // 第一份作业：有截止（UTC 12:00 = 北京时间 20:00）
    expect(await screen.findByText("周末加练")).toBeInTheDocument();
    expect(screen.getByText("单元：一元一次方程")).toBeInTheDocument();
    expect(screen.getByText("共 5 题")).toBeInTheDocument();
    expect(screen.getByText("10月1日 20:00 截止")).toBeInTheDocument();
    // 两份作业当前都未开始（状态徽章；四态配色见 student-ui）
    expect(screen.getAllByText("未开始").length).toBe(2);
    // 第二份作业：不限截止
    expect(screen.getByText("课前预习")).toBeInTheDocument();
    expect(screen.getByText("不限截止")).toBeInTheDocument();
    // 答题入口 T2.6 开放：按钮置灰提示
    expect(
      screen.getAllByRole("button", { name: /开始练习（即将开放）/ }).length,
    ).toBe(2);
  });

  it("渲染讲义摘要与「我的记录」入口", async () => {
    mockedAssignments.mockResolvedValue({ assignments: [] });
    mockedLectures.mockResolvedValue(LECTURES);
    renderPage();

    const lectureLink = await screen.findByRole("link", {
      name: /第1讲 有理数/,
    });
    expect(lectureLink).toHaveAttribute(
      "href",
      `/s/lectures/${LECTURES.lectures[0]?.id}`,
    );
    expect(
      screen.getByRole("link", { name: /第2讲 数轴/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /做题记录与错题本/ }),
    ).toHaveAttribute("href", "/s/records");
  });

  it("作业空态：解释性文案（下一步去看讲义）", async () => {
    mockedAssignments.mockResolvedValue({ assignments: [] });
    mockedLectures.mockResolvedValue(LECTURES);
    renderPage();

    expect(await screen.findByText("现在没有待完成的作业")).toBeInTheDocument();
  });

  it("讲义空态：老师还没有上传讲义", async () => {
    mockedAssignments.mockResolvedValue({ assignments: [] });
    mockedLectures.mockResolvedValue({ lectures: [] });
    renderPage();

    expect(await screen.findByText("老师还没有上传讲义")).toBeInTheDocument();
  });

  it("作业加载失败显示错误态与重试按钮", async () => {
    mockedAssignments.mockRejectedValue(new Error("服务器响应异常"));
    mockedLectures.mockResolvedValue(LECTURES);
    renderPage();

    expect(await screen.findByText("作业加载失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

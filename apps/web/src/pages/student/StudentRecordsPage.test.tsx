import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  StudentAssignmentListData,
  StudentCourseListData,
  StudentRecordRow,
  StudentRecordsData,
} from "@tutor/contract";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchStudentAssignmentsApi,
  fetchStudentCoursesApi,
  fetchStudentRecordsApi,
} from "@/lib/api";
import StudentRecordsPage from "./StudentRecordsPage";

/**
 * /s/records 我的记录页组件测试（T3.5，D10）：三态、卡片字段口径
 * （来源/状态/待批徽章、得分与「待公布」、点击路由）、筛选与分页的 URL 同步。
 * API 层 mock（真实接口行为由后端集成与 E2E 覆盖）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentRecordsApi: vi.fn(),
    fetchStudentCoursesApi: vi.fn(),
    fetchStudentAssignmentsApi: vi.fn(),
  };
});

const mockedRecords = vi.mocked(fetchStudentRecordsApi);
const mockedCourses = vi.mocked(fetchStudentCoursesApi);
const mockedAssignments = vi.mocked(fetchStudentAssignmentsApi);

const COURSE_ID = "12121212-1212-4121-8121-121212121212";
const ASSIGNMENT_ID = "44444444-4444-4444-8444-444444444444";
const ATTEMPT_IDS = Array.from(
  { length: 60 },
  (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
);

const COURSES: StudentCourseListData = {
  courses: [
    {
      id: COURSE_ID,
      name: "初一上",
      description: null,
      visibleLectureCount: 2,
      visibleUnitCount: 3,
      completedUnitCount: 1,
    },
  ],
};

const ASSIGNMENTS: StudentAssignmentListData = {
  assignments: [
    {
      id: ASSIGNMENT_ID,
      title: "周末加练",
      units: [{ id: "unit-有理数", title: "有理数" }],
      unitCount: 1,
      questionCount: 4,
      dueAt: null,
      createdAt: "2026-09-26T08:00:00.000Z",
      status: "graded",
    },
  ],
};

/** 记录行工厂（assignment 来源默认；overrides 换来源/状态/得分/公布） */
function makeRow(overrides: Partial<StudentRecordRow> = {}): StudentRecordRow {
  return {
    sourceType: "assignment",
    courseId: COURSE_ID,
    courseName: "初一上",
    assignmentId: ASSIGNMENT_ID,
    assignmentTitle: "周末加练",
    unitId: null,
    unitTitle: null,
    attemptNo: 1,
    attemptId: ATTEMPT_IDS[0] as string,
    status: "graded",
    score: 90,
    pendingCount: 0,
    answersReleased: true,
    startedAt: "2026-09-28T10:00:00.000Z",
    submittedAt: "2026-09-28T10:05:00.000Z",
    ...overrides,
  };
}

/** 路由地址探针（断言筛选/分页写进 URL） */
function LocationProbe() {
  const location = useLocation();
  return (
    <p data-testid="location-probe">
      {location.pathname}
      {location.search}
    </p>
  );
}

function renderPage(initialEntry = "/s/records") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/s/records"
            element={
              <>
                <StudentRecordsPage />
                <LocationProbe />
              </>
            }
          />
          {/* 点击落点桩：/s/attempts/:attemptId */}
          <Route
            path="/s/attempts/:attemptId"
            element={<p data-testid="route-stub">答题/结果页</p>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedCourses.mockResolvedValue(COURSES);
  mockedAssignments.mockResolvedValue(ASSIGNMENTS);
});

describe("StudentRecordsPage 三态", () => {
  it("加载中显示骨架提示，不白屏", () => {
    mockedRecords.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText("正在加载我的记录…")).toBeInTheDocument();
  });

  it("加载失败显示错误与重试，重试后恢复；无记录给出指引", async () => {
    mockedRecords.mockRejectedValueOnce(new Error("连不上服务器"));
    renderPage();
    expect(await screen.findByText("记录加载失败")).toBeInTheDocument();
    expect(screen.getByText("连不上服务器")).toBeInTheDocument();

    mockedRecords.mockResolvedValue({ records: [], total: 0 });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("还没有作答记录")).toBeInTheDocument();
  });

  it("筛选下无结果显示「当前筛选下没有记录」与「清除筛选」", async () => {
    mockedRecords.mockResolvedValue({ records: [], total: 0 });
    renderPage("/s/records?status=draft");
    expect(await screen.findByText("当前筛选下没有记录")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /清除筛选/ }),
    ).toBeInTheDocument();
  });
});

describe("StudentRecordsPage 卡片字段口径（D10）", () => {
  it("来源/状态徽章混排；得分、待批徽章、待公布、点击进 /s/attempts/:id", async () => {
    mockedRecords.mockResolvedValue({
      records: [
        // graded 作业：已批改徽章 + 得分
        makeRow(),
        // submitted 课程练习：已交卷 + 待批 2 + 「单元标题 · 第 n 次」与课程名
        makeRow({
          sourceType: "course",
          assignmentId: null,
          assignmentTitle: null,
          courseId: COURSE_ID,
          unitId: "unit-有理数",
          unitTitle: "有理数",
          attemptNo: 3,
          status: "submitted",
          score: 60,
          pendingCount: 2,
          attemptId: ATTEMPT_IDS[1] as string,
        }),
        // draft 作业：进行中徽章 + 「继续作答」、不显示得分
        makeRow({
          status: "draft",
          score: null,
          pendingCount: 0,
          submittedAt: null,
          attemptId: ATTEMPT_IDS[2] as string,
        }),
        // after_due 未公布：得分/待批已置 null → 「待公布」
        makeRow({
          status: "submitted",
          score: null,
          pendingCount: null,
          answersReleased: false,
          attemptId: ATTEMPT_IDS[3] as string,
        }),
      ],
      total: 4,
    } as StudentRecordsData);
    renderPage();
    await screen.findAllByRole("link", { name: /查看结果|继续作答/ });

    // graded 作业卡：来源徽章 + 已批改 + 得分 90，点击进 /s/attempts/:id
    const gradedCard = screen.getByRole("link", {
      name: "查看结果：周末加练（已批改）",
    });
    expect(gradedCard).toHaveAttribute("href", `/s/attempts/${ATTEMPT_IDS[0]}`);
    expect(within(gradedCard).getByText("作业")).toBeInTheDocument();
    expect(within(gradedCard).getByText("90")).toBeInTheDocument();

    // submitted 课程练习卡：课程练习徽章 + 已交卷 + 待批 2 + 课程名
    const submittedCard = screen.getByRole("link", {
      name: "查看结果：有理数 · 第 3 次（已交卷）",
    });
    expect(within(submittedCard).getByText("课程练习")).toBeInTheDocument();
    expect(within(submittedCard).getByText("待批 2")).toBeInTheDocument();
    expect(within(submittedCard).getByText("课程：初一上")).toBeInTheDocument();

    // draft 卡：进行中 + 继续作答、无得分数字
    const draftCard = screen.getByRole("link", {
      name: "继续作答：周末加练（进行中）",
    });
    expect(draftCard).toHaveAttribute("href", `/s/attempts/${ATTEMPT_IDS[2]}`);
    expect(within(draftCard).queryByText("得分")).not.toBeInTheDocument();

    // 未公布卡：待公布徽章、无得分数字与待批徽章
    const unreleasedCard = screen.getByRole("link", {
      name: "查看结果：周末加练（已交卷）",
    });
    expect(within(unreleasedCard).getByText("待公布")).toBeInTheDocument();
    expect(within(unreleasedCard).queryByText("得分")).not.toBeInTheDocument();
    expect(within(unreleasedCard).queryByText(/待批/)).not.toBeInTheDocument();
  });

  it("点击已交条目跳转 /s/attempts/:attemptId（路由桩命中）", async () => {
    mockedRecords.mockResolvedValue({
      records: [makeRow()],
      total: 1,
    });
    renderPage();
    const card = await screen.findByRole("link", {
      name: "查看结果：周末加练（已批改）",
    });
    fireEvent.click(card);
    expect(await screen.findByTestId("route-stub")).toHaveTextContent(
      "答题/结果页",
    );
  });
});

describe("StudentRecordsPage 筛选与分页的 URL 同步", () => {
  it("课程/作业下拉选项来自学生接口；改状态筛选写 URL 并重置 offset", async () => {
    mockedRecords.mockResolvedValue({ records: [], total: 0 });
    // 只有 offset=50 不算筛选生效 → 空态是「还没有作答记录」（非筛选空态）
    renderPage("/s/records?offset=50");
    await screen.findByText("还没有作答记录");

    // 下拉选项：课程名与作业标题（来自 mock 接口）
    expect(
      screen.getByRole("combobox", { name: /课程/ }).querySelectorAll("option"),
    ).toHaveLength(2);
    expect(
      screen.getByRole("combobox", { name: /作业/ }).querySelectorAll("option"),
    ).toHaveLength(2);

    fireEvent.change(screen.getByLabelText(/^状态/), {
      target: { value: "draft" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        "status=draft",
      ),
    );
    // 筛选变化重置 offset（URL 不再带 offset）
    expect(screen.getByTestId("location-probe")).not.toHaveTextContent(
      "offset",
    );
  });

  it("超过一页显示分页条；下一页把 offset 写进 URL", async () => {
    mockedRecords.mockResolvedValue({
      records: Array.from({ length: 50 }, (_, i) =>
        makeRow({ attemptId: ATTEMPT_IDS[i] as string }),
      ),
      total: 51,
    } as StudentRecordsData);
    renderPage();
    await screen.findByText(/共 51 条 · 第 1 \/ 2 页/);

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        "offset=50",
      ),
    );
  });

  it("页头不再有「错题本」入口（2026-10 IA 调整：错题本升为一级导航 /s/wrong）", async () => {
    mockedRecords.mockResolvedValue({ records: [makeRow()], total: 1 });
    renderPage();

    await screen.findByText("我的记录");
    expect(
      screen.queryByRole("link", { name: /打开错题本|错题本/ }),
    ).not.toBeInTheDocument();
  });
});

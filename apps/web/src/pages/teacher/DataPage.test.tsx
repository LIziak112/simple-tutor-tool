import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  StudentListData,
  TeacherAttemptCard,
  TeacherAttemptListData,
} from "@tutor/contract";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStudentsApi, fetchTeacherAttemptsApi } from "@/lib/api";
import DataPage from "./DataPage";

/**
 * /t/data 作答数据页组件测试（T3.1）：三态、三视图分组、卡片字段口径
 * （进行中徽章、得分回退 scoreFinal??scoreAuto、待批徽章）、筛选/分页与
 * URL 同步。API 层 mock（真实接口行为由后端集成与 E2E 覆盖）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchTeacherAttemptsApi: vi.fn(),
    fetchStudentsApi: vi.fn(),
  };
});

const mockedAttempts = vi.mocked(fetchTeacherAttemptsApi);
const mockedStudents = vi.mocked(fetchStudentsApi);

const STUDENT_ID = "11111111-1111-4111-8111-111111111111";
const STUDENT_B_ID = "22222222-2222-4222-8222-222222222222";
const COURSE_ID = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_IDS = Array.from(
  { length: 60 },
  (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
);

const STUDENTS: StudentListData = { students: [] };

/** 卡片工厂（course 来源默认；overrides 换单元/作业/状态/得分） */
function makeCard(
  overrides: Partial<TeacherAttemptCard> = {},
): TeacherAttemptCard {
  return {
    sourceType: "course",
    courseId: COURSE_ID,
    courseName: "初一上",
    assignmentId: null,
    assignmentTitle: null,
    unitId: "unit-有理数",
    unitTitle: "有理数",
    attemptNo: 1,
    attemptId: "99999999-9999-4999-8999-999999999991",
    studentId: STUDENT_ID,
    studentName: "张三",
    unitCount: 1,
    questionCount: 3,
    status: "submitted",
    scoreAuto: 80,
    scoreFinal: null,
    pendingCount: 0,
    startedAt: "2026-09-28T10:00:00.000Z",
    submittedAt: "2026-09-28T10:05:00.000Z",
    activeSec: 300,
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

function renderPage(initialEntry = "/t/data") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/t/data"
            element={
              <>
                <DataPage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedStudents.mockResolvedValue(STUDENTS);
});

describe("DataPage 三态", () => {
  it("加载中显示骨架提示，不白屏", () => {
    mockedAttempts.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText("正在加载作答数据…")).toBeInTheDocument();
  });

  it("加载失败显示错误与重试，重试后恢复；空列表给出指引", async () => {
    mockedAttempts.mockRejectedValueOnce(new Error("连不上服务器"));
    renderPage();
    expect(await screen.findByText("作答数据加载失败")).toBeInTheDocument();
    expect(screen.getByText("连不上服务器")).toBeInTheDocument();

    mockedAttempts.mockResolvedValue({ attempts: [], total: 0 });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("还没有作答记录")).toBeInTheDocument();
  });

  it("筛选下无结果显示「当前筛选下没有作答」与「清除筛选」", async () => {
    mockedAttempts.mockResolvedValue({ attempts: [], total: 0 });
    renderPage("/t/data?status=draft");
    expect(await screen.findByText("当前筛选下没有作答")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /清除筛选/ }),
    ).toBeInTheDocument();
  });
});

describe("DataPage 三视图分组（D6）", () => {
  it("默认按课程：课程组内课程练习与关联作业混排，未挂课程作业单独成组", async () => {
    mockedAttempts.mockResolvedValue({
      attempts: [
        makeCard({ attemptId: ATTEMPT_IDS[1] as string }),
        makeCard({
          sourceType: "assignment",
          assignmentId: "44444444-4444-4444-8444-444444444444",
          assignmentTitle: "周末加练",
          unitId: null,
          unitTitle: null,
          attemptId: ATTEMPT_IDS[2] as string,
        }),
        makeCard({
          sourceType: "assignment",
          courseId: null,
          courseName: null,
          assignmentId: "55555555-5555-4555-8555-555555555555",
          assignmentTitle: "课后小卷",
          unitId: null,
          unitTitle: null,
          attemptId: ATTEMPT_IDS[3] as string,
        }),
      ],
      total: 3,
    });
    renderPage();
    await screen.findAllByText("张三");

    // 课程组：标题 + 2 条（课程练习 + 作业）；未挂课程组 1 条
    const courseGroup = screen
      .getAllByRole("heading", { name: /初一上/ })
      .at(-1)
      ?.closest("section");
    expect(courseGroup).not.toBeNull();
    expect(
      within(courseGroup as HTMLElement).getByText("课程练习"),
    ).toBeInTheDocument();
    expect(
      within(courseGroup as HTMLElement).getByText("作业"),
    ).toBeInTheDocument();
    expect(within(courseGroup as HTMLElement).getAllByRole("link").length).toBe(
      2,
    );
    const noCourseGroup = screen
      .getAllByRole("heading", { name: /未挂课程的作业/ })
      .at(-1)
      ?.closest("section");
    expect(noCourseGroup).not.toBeNull();
    // 未挂课程组只有「课后小卷」；课程组内的作业卡片带课程名
    expect(
      within(noCourseGroup as HTMLElement).getByText("课后小卷"),
    ).toBeInTheDocument();
    expect(
      within(courseGroup as HTMLElement).getByText("周末加练（初一上）"),
    ).toBeInTheDocument();
  });

  it("切「按学生」：URL 带 view=student 且按学生名分组", async () => {
    mockedAttempts.mockResolvedValue({
      attempts: [
        makeCard({ studentId: STUDENT_ID, studentName: "张三" }),
        makeCard({
          studentId: STUDENT_B_ID,
          studentName: "李四",
          attemptId: ATTEMPT_IDS[4] as string,
        }),
      ],
      total: 2,
    });
    renderPage();
    await screen.findByText("张三");
    fireEvent.click(screen.getByRole("button", { name: "按学生" }));
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        "?view=student",
      ),
    );
    // 组标题带条数徽章（如「张三 1 条」），用正则匹配
    expect(screen.getByRole("heading", { name: /张三/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /李四/ })).toBeInTheDocument();
  });
});

describe("DataPage 卡片字段口径（D5/D2）", () => {
  it("进行中显著徽章；得分 scoreFinal??scoreAuto（无分「—」）；待批徽章", async () => {
    mockedAttempts.mockResolvedValue({
      attempts: [
        // draft：无任何得分 → 「—」+ 进行中徽章
        makeCard({
          status: "draft",
          scoreAuto: null,
          scoreFinal: null,
          submittedAt: null,
          attemptId: ATTEMPT_IDS[10] as string,
        }),
        // submitted：scoreFinal null → 回退显示 scoreAuto 80，待批 2
        makeCard({
          scoreAuto: 80,
          scoreFinal: null,
          pendingCount: 2,
          attemptId: ATTEMPT_IDS[11] as string,
        }),
        // graded：scoreFinal 90 优先于 scoreAuto 100
        makeCard({
          status: "graded",
          scoreAuto: 100,
          scoreFinal: 90,
          attemptId: ATTEMPT_IDS[12] as string,
        }),
      ],
      total: 3,
    });
    renderPage();
    await screen.findAllByText("张三");

    const draftCard = screen.getByRole("link", {
      name: "查看 张三 的作答详情（进行中）",
    });
    expect(
      within(draftCard).getByText("进行中", { exact: true }),
    ).toBeInTheDocument();
    expect(within(draftCard).getByText("—")).toBeInTheDocument();

    const submittedCard = screen.getByRole("link", {
      name: "查看 张三 的作答详情（已交卷）",
    });
    expect(within(submittedCard).getByText("80")).toBeInTheDocument();
    expect(within(submittedCard).getByText("待批 2")).toBeInTheDocument();

    const gradedCard = screen.getByRole("link", {
      name: "查看 张三 的作答详情（已批改）",
    });
    expect(within(gradedCard).getByText("90")).toBeInTheDocument();
    expect(within(gradedCard).queryByText("100")).not.toBeInTheDocument();
  });
});

describe("DataPage 分页与筛选的 URL 同步", () => {
  it("超过一页显示分页条；下一页把 offset 写进 URL；筛选变化重置 offset", async () => {
    mockedAttempts.mockResolvedValue({
      attempts: Array.from({ length: 50 }, (_, i) =>
        makeCard({
          attemptId: ATTEMPT_IDS[i] as string,
          studentId: STUDENT_ID,
          studentName: "张三",
        }),
      ),
      total: 51,
    } as TeacherAttemptListData);
    renderPage();
    await screen.findByText(/共 51 条 · 第 1 \/ 2 页/);

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        "offset=50",
      ),
    );

    // 改筛选（状态=进行中）→ offset 归零并写 status
    fireEvent.change(screen.getByLabelText(/^状态/), {
      target: { value: "draft" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        "status=draft",
      ),
    );
    expect(screen.getByTestId("location-probe")).not.toHaveTextContent(
      "offset",
    );
  });
});

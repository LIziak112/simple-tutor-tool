import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  CourseDetailData,
  CourseListData,
  LibraryUnitList,
  StudentListData,
  TeacherAssignment,
  TeacherAssignmentListData,
} from "@tutor/contract";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteAssignmentApi,
  fetchAssignmentsApi,
  fetchCourseDetail,
  fetchLibraryFolders,
  fetchLibraryUnits,
  fetchStudentsApi,
  fetchTeacherCourses,
} from "@/lib/api";
import AssignmentsPage from "./AssignmentsPage";

/**
 * 作业页组件测试（T2.2 三态 + 卡片；T2A.7 课程筛选 + 课程页入口路由参数）。
 * 三步向导与编辑弹层的交互测试分别在 AssignmentComposeWizard.test.tsx 与
 * AssignmentEditDialog.test.tsx；API 层 mock（真实接口行为由后端集成覆盖）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAssignmentsApi: vi.fn(),
    fetchAssignmentDetailApi: vi.fn(),
    fetchTeacherCourses: vi.fn(),
    fetchCourseDetail: vi.fn(),
    fetchStudentsApi: vi.fn(),
    fetchLibraryFolders: vi.fn(),
    fetchLibraryUnits: vi.fn(),
    deleteAssignmentApi: vi.fn(),
  };
});

const mockedFetchAssignments = vi.mocked(fetchAssignmentsApi);
const mockedFetchCourses = vi.mocked(fetchTeacherCourses);
const mockedFetchDetail = vi.mocked(fetchCourseDetail);
const mockedFetchStudents = vi.mocked(fetchStudentsApi);
const mockedFetchFolders = vi.mocked(fetchLibraryFolders);
const mockedFetchLibraryUnits = vi.mocked(fetchLibraryUnits);
const mockedDelete = vi.mocked(deleteAssignmentApi);

const STUDENT_A_ID = "11111111-1111-4111-8111-111111111111";
const COURSE_ID = "33333333-3333-4333-8333-333333333333";
const UNIT_ID = "unit-一元一次方程";
const UNIT_ID_2 = "unit-有理数乘除";
const ASSIGNMENT_ID = "44444444-4444-4444-8444-444444444444";

const COURSES: CourseListData = {
  courses: [
    {
      id: COURSE_ID,
      name: "初一上",
      description: null,
      archived: false,
      archivedAt: null,
      order: 0,
      memberCount: 1,
      itemCount: 2,
      visibleItemCount: 2,
      memberIds: [STUDENT_A_ID],
      hasAttempts: false,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ],
};

/** 课程页入口打开向导时向导需要的最小数据（内容与向导测试文件无关） */
const COURSE_DETAIL: CourseDetailData = {
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
      studentId: STUDENT_A_ID,
      displayName: "张三",
      joinedAt: "2026-09-01T00:00:00.000Z",
      archived: false,
    },
  ],
  items: [
    {
      id: "77777777-7777-4777-8777-777777777771",
      kind: "unit",
      refId: UNIT_ID,
      title: "一元一次方程",
      order: 0,
      visible: true,
      publishAt: null,
      status: "visible",
      questionCount: 2,
      resourceUpdatedAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ],
};

const STUDENTS: StudentListData = {
  students: [
    {
      id: STUDENT_A_ID,
      displayName: "张三",
      loginName: "张三",
      linkEnabled: true,
      passwordEnabled: true,
      hasPassword: true,
      linkToken: "token-a",
      note: null,
      archived: false,
      createdAt: "2026-09-20T10:00:00.000Z",
    },
  ],
};

function makeAssignment(
  overrides: Partial<TeacherAssignment> = {},
): TeacherAssignment {
  return {
    id: ASSIGNMENT_ID,
    courseId: null,
    courseName: null,
    title: "周末加练",
    dueAt: "2026-10-01T12:00:00.000Z",
    units: [
      {
        unitId: UNIT_ID,
        title: "一元一次方程",
        questionCount: 2,
        deleted: false,
      },
      {
        unitId: UNIT_ID_2,
        title: "有理数乘除",
        questionCount: 1,
        deleted: false,
      },
    ],
    totalQuestionCount: 3,
    containsDeletedUnit: false,
    locked: false,
    studentCount: 1,
    rosterStats: { notStarted: 1, inProgress: 0, submitted: 0, graded: 0 },
    deleted: false,
    deletedAt: null,
    createdAt: "2026-09-26T08:00:00.000Z",
    ...overrides,
  };
}

/** 路由地址探针（断言课程入口参数被消费清空） */
function LocationProbe() {
  const location = useLocation();
  return (
    <p data-testid="location-probe">
      {location.pathname}
      {location.search}
    </p>
  );
}

/** 包 QueryClient + MemoryRouter 渲染页面 */
function renderPage(initialEntry = "/t/assignments") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/t/assignments"
            element={
              <>
                <AssignmentsPage />
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
  mockedFetchCourses.mockResolvedValue(COURSES);
  mockedFetchDetail.mockResolvedValue(COURSE_DETAIL);
  mockedFetchStudents.mockResolvedValue(STUDENTS);
  mockedFetchFolders.mockResolvedValue({ folders: [] });
  mockedFetchLibraryUnits.mockResolvedValue({ units: [] } as LibraryUnitList);
});

describe("AssignmentsPage 三态", () => {
  beforeEach(() => {
    mockedFetchAssignments.mockReturnValue(new Promise(() => undefined));
  });

  it("加载中显示骨架与提示，不白屏", () => {
    renderPage();
    expect(screen.getByText("正在加载作业…")).toBeInTheDocument();
  });

  it("加载失败显示错误原因与重试按钮，重试后恢复", async () => {
    mockedFetchAssignments.mockReset();
    mockedFetchAssignments.mockRejectedValueOnce(new Error("连不上服务器"));
    renderPage();
    expect(await screen.findByText("作业加载失败")).toBeInTheDocument();
    expect(screen.getByText("连不上服务器")).toBeInTheDocument();

    mockedFetchAssignments.mockResolvedValue({ assignments: [] });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("还没有作业")).toBeInTheDocument();
  });

  it("空态解释原因并给出下一步动作（资源库 + 多单元语境）", async () => {
    mockedFetchAssignments.mockReset();
    mockedFetchAssignments.mockResolvedValue({ assignments: [] });
    renderPage();
    expect(await screen.findByText("还没有作业")).toBeInTheDocument();
    expect(
      screen.getByText(/已在「资源库」导入带题目的练习/),
    ).toBeInTheDocument();
    expect(screen.getByText(/作业可包含多个练习单元/)).toBeInTheDocument();
  });
});

describe("AssignmentsPage 列表卡片（T2A.7 新字段）", () => {
  beforeEach(() => {
    mockedFetchAssignments.mockResolvedValue({
      assignments: [makeAssignment()],
    });
  });

  it("显示标题、单元列表与各单元题数、总题数、四态统计、截止时间（Asia/Shanghai）", async () => {
    renderPage();
    expect(await screen.findByText("周末加练")).toBeInTheDocument();
    expect(screen.getByText("一元一次方程（2 题）")).toBeInTheDocument();
    expect(screen.getByText("有理数乘除（1 题）")).toBeInTheDocument();
    expect(screen.getByText("共 3 题")).toBeInTheDocument();
    expect(
      screen.getByText(/名单 1 人：未开始 1 · 进行中 0 · 已交 0 · 已批 0/),
    ).toBeInTheDocument();
    // 2026-10-01T12:00:00Z = 北京时间 10月1日 20:00
    expect(screen.getByText("截止：10月1日 20:00")).toBeInTheDocument();
    // 用精确名匹配卡片删除按钮（避开「显示已删除」开关）
    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument();
  });

  it("课程名、内容锁定与含已删单元标记；已删单元标题划线展示", async () => {
    mockedFetchAssignments.mockResolvedValue({
      assignments: [
        makeAssignment({
          courseId: COURSE_ID,
          courseName: "初一上",
          locked: true,
          containsDeletedUnit: true,
          units: [
            {
              unitId: UNIT_ID,
              title: "一元一次方程",
              questionCount: 2,
              deleted: true,
            },
          ],
        }),
      ],
    });
    renderPage();
    expect(await screen.findByText("课程：初一上")).toBeInTheDocument();
    expect(screen.getByText("内容已锁定")).toBeInTheDocument();
    expect(screen.getByText("含已删除单元")).toBeInTheDocument();
    expect(screen.getByText("一元一次方程（2 题）").className).toContain(
      "line-through",
    );
  });

  it("已删除作业带标记且不出现编辑/删除按钮", async () => {
    mockedFetchAssignments.mockResolvedValue({
      assignments: [
        makeAssignment({
          deleted: true,
          deletedAt: "2026-09-27T00:00:00.000Z",
        }),
      ],
    });
    renderPage();
    expect(await screen.findByText("已删除")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "删除" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "编辑" }),
    ).not.toBeInTheDocument();
  });
});

describe("AssignmentsPage 课程筛选（T2A.7）", () => {
  it("默认全部；切「无课程」与具体课程分别以对应 courseId 重新拉取，筛选空态文案区分", async () => {
    mockedFetchAssignments.mockResolvedValue({
      assignments: [makeAssignment()],
    });
    renderPage();
    await screen.findByText("周末加练");
    // 初始：全部课程（courseId=undefined）
    expect(mockedFetchAssignments).toHaveBeenCalledWith(undefined, false);
    await screen.findByRole("option", { name: "初一上" });

    // 切「无课程」→ courseId="none"，返回空 → 筛选空态
    mockedFetchAssignments.mockResolvedValue({ assignments: [] });
    fireEvent.change(screen.getByLabelText(/课程筛选/), {
      target: { value: "none" },
    });
    await waitFor(() =>
      expect(mockedFetchAssignments).toHaveBeenCalledWith("none", false),
    );
    expect(await screen.findByText("当前筛选下没有作业")).toBeInTheDocument();

    // 切具体课程 → courseId=UUID
    fireEvent.change(screen.getByLabelText(/课程筛选/), {
      target: { value: COURSE_ID },
    });
    await waitFor(() =>
      expect(mockedFetchAssignments).toHaveBeenCalledWith(COURSE_ID, false),
    );
  });
});

describe("AssignmentsPage 课程页入口（?courseId&compose=1）", () => {
  it("挂载时预选课程并直接打开向导（第①步已选课程），随后 replace 清空参数", async () => {
    const list: TeacherAssignmentListData = { assignments: [] };
    mockedFetchAssignments.mockResolvedValue(list);
    renderPage(`/t/assignments?courseId=${COURSE_ID}&compose=1`);

    // 向导直接打开且课程已预选（下拉值为课程 id）
    const courseSelect = (await screen.findByLabelText(
      /所属课程/,
    )) as HTMLSelectElement;
    expect(courseSelect.value).toBe(COURSE_ID);
    // 成员已带出且默认勾选（张三是「初一上」成员）
    const zhang = await screen.findByLabelText(/张三/);
    await waitFor(() => expect((zhang as HTMLInputElement).checked).toBe(true));

    // 参数被消费清空（避免刷新重复弹层）
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        /^\/t\/assignments$/,
      ),
    );
    expect(screen.getByTestId("location-probe")).not.toHaveTextContent(
      "compose",
    );
  });
});

describe("删除作业流程", () => {
  beforeEach(() => {
    mockedDelete.mockResolvedValue(null);
    mockedFetchAssignments.mockResolvedValue({
      assignments: [makeAssignment()],
    });
  });

  it("二次确认文案说明软删后果，确认后调用删除接口；取消则不调用", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    expect(
      await screen.findByText(/删除后学生端立即不可见，作答记录会保留/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(mockedDelete).toHaveBeenCalledTimes(1));
    expect(mockedDelete.mock.calls[0]?.[0]).toBe(ASSIGNMENT_ID);
    // 取消则不调用
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    expect(mockedDelete).toHaveBeenCalledTimes(1);
  });
});

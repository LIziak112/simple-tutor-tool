import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ContentTree,
  CourseListData,
  StudentListData,
  TeacherAssignment,
  TeacherAssignmentListData,
} from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createAssignmentApi,
  deleteAssignmentApi,
  fetchAssignmentDetailApi,
  fetchAssignmentsApi,
  fetchContentTree,
  fetchStudentsApi,
  fetchTeacherCourses,
  updateAssignmentApi,
} from "@/lib/api";
import { localInputToUtcIso } from "@/lib/time";
import AssignmentsPage from "./AssignmentsPage";

/**
 * 作业页组件测试（T2.2 三态 + 卡片；T2A.7 多单元卡片 + 布置/编辑弹层）。
 * API 层 mock（真实接口行为由后端 assignments.test.ts 集成覆盖）；
 * 截止时间换算用真实 localInputToUtcIso 计算期望值（与时区无关）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAssignmentsApi: vi.fn(),
    fetchAssignmentDetailApi: vi.fn(),
    fetchTeacherCourses: vi.fn(),
    createAssignmentApi: vi.fn(),
    updateAssignmentApi: vi.fn(),
    deleteAssignmentApi: vi.fn(),
    fetchStudentsApi: vi.fn(),
    fetchContentTree: vi.fn(),
  };
});

const mockedFetchAssignments = vi.mocked(fetchAssignmentsApi);
const mockedFetchDetail = vi.mocked(fetchAssignmentDetailApi);
const mockedFetchCourses = vi.mocked(fetchTeacherCourses);
const mockedCreate = vi.mocked(createAssignmentApi);
const mockedUpdate = vi.mocked(updateAssignmentApi);
const mockedDelete = vi.mocked(deleteAssignmentApi);
const mockedFetchStudents = vi.mocked(fetchStudentsApi);
const mockedFetchTree = vi.mocked(fetchContentTree);

const STUDENT_A_ID = "11111111-1111-4111-8111-111111111111";
const STUDENT_B_ID = "22222222-2222-4222-8222-222222222222";
const COURSE_ID = "33333333-3333-4333-8333-333333333333";
const UNIT_ID = "unit-一元一次方程";
const UNIT_ID_2 = "unit-有理数乘除";
const ASSIGNMENT_ID = "44444444-4444-4444-8444-444444444444";

const TREE: ContentTree = {
  courses: [
    {
      id: COURSE_ID,
      title: "初一上",
      lectures: [],
      units: [
        {
          id: UNIT_ID,
          title: "一元一次方程",
          topic: "方程",
          updatedAt: "2026-09-01T00:00:00.000Z",
          questions: [
            {
              id: "q1",
              type: "fill",
              difficulty: 2,
              knowledge: [],
              version: 1,
            },
            {
              id: "q2",
              type: "choice",
              difficulty: 1,
              knowledge: [],
              version: 1,
            },
          ],
        },
        {
          id: UNIT_ID_2,
          title: "有理数乘除",
          topic: null,
          updatedAt: "2026-09-01T00:00:00.000Z",
          questions: [
            {
              id: "q3",
              type: "fill",
              difficulty: 1,
              knowledge: [],
              version: 1,
            },
          ],
        },
        {
          // 无题目的单元不应出现在布置选项里
          id: "unit-empty",
          title: "空单元",
          topic: null,
          updatedAt: "2026-09-01T00:00:00.000Z",
          questions: [],
        },
      ],
    },
  ],
};

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
    {
      id: STUDENT_B_ID,
      displayName: "李四",
      loginName: "李四",
      linkEnabled: true,
      passwordEnabled: false,
      hasPassword: false,
      linkToken: "token-b",
      note: null,
      archived: false,
      createdAt: "2026-09-21T10:00:00.000Z",
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

/** 包 QueryClient 渲染页面 */
function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AssignmentsPage />
    </QueryClientProvider>,
  );
}

/** 打开布置弹层并等待表单字段就绪（课程/单元/学生数据加载完成后） */
async function openCreateDialog(list: TeacherAssignmentListData) {
  mockedFetchAssignments.mockResolvedValue(list);
  mockedFetchTree.mockResolvedValue(TREE);
  mockedFetchStudents.mockResolvedValue(STUDENTS);
  mockedFetchCourses.mockResolvedValue(COURSES);
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "布置作业" }));
  await screen.findByLabelText(/所属课程/);
}

describe("AssignmentsPage 三态", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("加载中显示骨架与提示，不白屏", () => {
    mockedFetchAssignments.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText("正在加载作业…")).toBeInTheDocument();
  });

  it("加载失败显示错误原因与重试按钮，重试后恢复", async () => {
    mockedFetchAssignments.mockRejectedValueOnce(new Error("连不上服务器"));
    renderPage();
    expect(await screen.findByText("作业加载失败")).toBeInTheDocument();
    expect(screen.getByText("连不上服务器")).toBeInTheDocument();

    mockedFetchAssignments.mockResolvedValue({ assignments: [] });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("还没有作业")).toBeInTheDocument();
  });

  it("空态解释原因并给出下一步动作", async () => {
    mockedFetchAssignments.mockResolvedValue({ assignments: [] });
    renderPage();
    expect(await screen.findByText("还没有作业")).toBeInTheDocument();
    expect(
      screen.getByText(/请确认已在「内容」页导入练习/),
    ).toBeInTheDocument();
  });
});

describe("AssignmentsPage 列表卡片（T2A.7 新字段）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("显示标题、单元列表与各单元题数、总题数、四态统计、截止时间（Asia/Shanghai）", async () => {
    mockedFetchAssignments.mockResolvedValue({
      assignments: [makeAssignment()],
    });
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

describe("布置作业流程（多单元勾选 + 课程）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCreate.mockResolvedValue(makeAssignment());
  });

  it("弹层只列有题目的单元；勾选两个单元 + 学生 + 截止后按勾选顺序提交 unitIds", async () => {
    await openCreateDialog({ assignments: [] });

    // 空单元不出现；单元选项带课程与题数信息
    expect(screen.queryByText("空单元")).not.toBeInTheDocument();
    expect(screen.getByText("有理数乘除")).toBeInTheDocument();

    // 先在未选单元时提交 → 行内错误
    fireEvent.click(screen.getByRole("button", { name: /确认布置/ }));
    expect(
      await screen.findByText("请至少选择一个练习单元"),
    ).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();

    // 勾选顺序即提交顺序：先勾「有理数乘除」再勾「一元一次方程」
    fireEvent.click(screen.getByLabelText(/有理数乘除/));
    fireEvent.click(screen.getByLabelText(/一元一次方程/));

    // 未选学生时提交 → 行内错误
    fireEvent.click(screen.getByRole("button", { name: /确认布置/ }));
    expect(await screen.findByText("请至少选择一名学生")).toBeInTheDocument();

    // 勾选两名学生（label 文本 = 姓名 + 登录名，用非锚定正则）
    fireEvent.click(screen.getByLabelText(/张三/));
    fireEvent.click(screen.getByLabelText(/李四/));

    // 填截止时间（本地输入值；期望值用同一换算函数计算，测试不依赖时区）
    fireEvent.change(screen.getByLabelText(/截止时间/), {
      target: { value: "2026-10-01T20:00" },
    });

    fireEvent.click(screen.getByRole("button", { name: /确认布置/ }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    expect(mockedCreate.mock.calls[0]?.[0]).toEqual({
      unitIds: [UNIT_ID_2, UNIT_ID],
      studentIds: [STUDENT_A_ID, STUDENT_B_ID],
      dueAt: localInputToUtcIso("2026-10-01T20:00"),
    });
    // 标题留空 → 不提交该字段（服务端按单元标题组合缺省）
    expect(mockedCreate.mock.calls[0]?.[0]?.title).toBeUndefined();
  });

  it("选择课程后名单默认带出课程成员；标题可自定义；标题占位符随所选单元组合", async () => {
    await openCreateDialog({ assignments: [] });

    // 选择课程 → 名单带出成员（张三是「初一上」成员）
    fireEvent.change(screen.getByLabelText(/所属课程/), {
      target: { value: COURSE_ID },
    });
    const zhang = screen.getByLabelText(/张三/) as HTMLInputElement;
    expect(zhang.checked).toBe(true);
    const li = screen.getByLabelText(/李四/) as HTMLInputElement;
    expect(li.checked).toBe(false);

    // 勾选两个单元 → 标题占位符为「首个单元标题 等 n 个单元」组合
    fireEvent.click(screen.getByLabelText(/一元一次方程/));
    fireEvent.click(screen.getByLabelText(/有理数乘除/));
    expect(screen.getByLabelText(/作业标题/)).toHaveAttribute(
      "placeholder",
      "默认：一元一次方程 等 2 个单元",
    );

    fireEvent.change(screen.getByLabelText(/作业标题/), {
      target: { value: "国庆专项" },
    });
    fireEvent.click(screen.getByRole("button", { name: /确认布置/ }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    expect(mockedCreate.mock.calls[0]?.[0]).toEqual({
      unitIds: [UNIT_ID, UNIT_ID_2],
      studentIds: [STUDENT_A_ID],
      courseId: COURSE_ID,
      title: "国庆专项",
    });
  });
});

describe("编辑作业流程（名单增删 + 确认移出）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUpdate.mockResolvedValue(makeAssignment());
    mockedFetchStudents.mockResolvedValue(STUDENTS);
    mockedFetchDetail.mockResolvedValue({
      ...makeAssignment(),
      roster: [
        {
          studentId: STUDENT_A_ID,
          displayName: "张三",
          status: "not_started",
          addedAt: "2026-09-26T08:00:00.000Z",
        },
      ],
      startedCount: 0,
      courseNewMembers: [],
    });
  });

  it("打开编辑弹层带入原值；增删名单差集提交 addStudentIds/removeStudentIds；清空截止 → dueAt:null", async () => {
    mockedFetchAssignments.mockResolvedValue({
      assignments: [makeAssignment()],
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    // 弹层打开后等待表单就绪（名单加载完成后标题输入框出现）
    const titleInput = (await screen.findByLabelText(
      /作业标题/,
    )) as HTMLInputElement;
    expect(titleInput.value).toBe("周末加练");

    // 名单差集：取消张三（移出）、勾选李四（新增）
    fireEvent.click(screen.getByLabelText(/张三/));
    fireEvent.click(screen.getByLabelText(/李四/));

    // 清空截止（原有截止 → 提交 dueAt:null 表示取消）
    fireEvent.change(screen.getByLabelText(/截止时间/), {
      target: { value: "" },
    });

    fireEvent.click(screen.getByRole("button", { name: /保存修改/ }));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    expect(mockedUpdate.mock.calls[0]?.[0]).toBe(ASSIGNMENT_ID);
    expect(mockedUpdate.mock.calls[0]?.[1]).toEqual({
      // 标题未改动 → 不提交（增量语义）
      dueAt: null,
      addStudentIds: [STUDENT_B_ID],
      removeStudentIds: [STUDENT_A_ID],
    });
  });

  it("移出已开始学生：409 CONFIRM_REQUIRED → 确认弹层列姓名 → 带 confirmStarted 重发", async () => {
    mockedFetchAssignments.mockResolvedValue({
      assignments: [makeAssignment()],
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    await screen.findByLabelText(/作业标题/);

    // 模拟后端首次拒绝（extra._students 附名单）
    mockedUpdate.mockRejectedValueOnce(
      new ApiError("CONFIRM_REQUIRED", "以下学生已开始作答，请确认", 409, {
        _students: [{ studentId: STUDENT_A_ID, displayName: "张三" }],
      }),
    );
    // 取消勾选张三并保存
    fireEvent.click(screen.getByLabelText(/张三/));
    fireEvent.click(screen.getByRole("button", { name: /保存修改/ }));

    // 确认弹层出现并列出姓名
    expect(
      await screen.findByText(/确认移出已开始作答的学生/),
    ).toBeInTheDocument();
    // 姓名出现在确认弹层描述中（与名单里的张三并存 → getAllByText）
    expect(screen.getAllByText(/张三/).length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole("button", { name: "确认移出" }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(2));
    expect(mockedUpdate.mock.calls[1]?.[1]).toMatchObject({
      removeStudentIds: [STUDENT_A_ID],
      confirmStarted: true,
    });
  });
});

describe("删除作业流程", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

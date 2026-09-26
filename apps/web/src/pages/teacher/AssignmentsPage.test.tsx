import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ContentTree,
  StudentListData,
  TeacherAssignment,
  TeacherAssignmentListData,
} from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAssignmentApi,
  deleteAssignmentApi,
  fetchAssignmentsApi,
  fetchContentTree,
  fetchStudentsApi,
  updateAssignmentApi,
} from "@/lib/api";
import { localInputToUtcIso } from "@/lib/time";
import AssignmentsPage from "./AssignmentsPage";

/**
 * 作业页组件测试（T2.2 三态 + 卡片 + 布置流程 + 删除确认）。
 * API 层 mock（真实接口行为由后端 assignments.test.ts 集成覆盖）；
 * 截止时间换算用真实 localInputToUtcIso 计算期望值（与时区无关）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAssignmentsApi: vi.fn(),
    createAssignmentApi: vi.fn(),
    updateAssignmentApi: vi.fn(),
    deleteAssignmentApi: vi.fn(),
    fetchStudentsApi: vi.fn(),
    fetchContentTree: vi.fn(),
  };
});

const mockedFetchAssignments = vi.mocked(fetchAssignmentsApi);
const mockedCreate = vi.mocked(createAssignmentApi);
const mockedUpdate = vi.mocked(updateAssignmentApi);
const mockedDelete = vi.mocked(deleteAssignmentApi);
const mockedFetchStudents = vi.mocked(fetchStudentsApi);
const mockedFetchTree = vi.mocked(fetchContentTree);

const STUDENT_A_ID = "11111111-1111-4111-8111-111111111111";
const STUDENT_B_ID = "22222222-2222-4222-8222-222222222222";
const UNIT_ID = "unit-一元一次方程";

const TREE: ContentTree = {
  courses: [
    {
      id: "33333333-3333-4333-8333-333333333333",
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
    id: "44444444-4444-4444-8444-444444444444",
    unitId: UNIT_ID,
    unitTitle: "一元一次方程",
    title: "周末加练",
    dueAt: "2026-10-01T12:00:00.000Z",
    questionCount: 2,
    students: [{ id: STUDENT_A_ID, displayName: "张三" }],
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

/** 打开布置弹层并等待表单字段就绪（单元/学生数据加载完成后） */
async function openCreateDialog(list: TeacherAssignmentListData) {
  mockedFetchAssignments.mockResolvedValue(list);
  mockedFetchTree.mockResolvedValue(TREE);
  mockedFetchStudents.mockResolvedValue(STUDENTS);
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "布置作业" }));
  await screen.findByLabelText(/练习单元/);
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

describe("AssignmentsPage 列表卡片", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("显示标题、单元与题数、学生名单、截止时间（Asia/Shanghai）", async () => {
    mockedFetchAssignments.mockResolvedValue({
      assignments: [makeAssignment()],
    });
    renderPage();
    expect(await screen.findByText("周末加练")).toBeInTheDocument();
    expect(screen.getByText("单元：一元一次方程（2 题）")).toBeInTheDocument();
    expect(screen.getByText("张三")).toBeInTheDocument();
    // 2026-10-01T12:00:00Z = 北京时间 10月1日 20:00
    expect(screen.getByText("截止：10月1日 20:00")).toBeInTheDocument();
    // 用精确名匹配卡片删除按钮（避开「显示已删除」开关）
    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument();
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

describe("布置作业流程", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCreate.mockResolvedValue(makeAssignment());
  });

  it("弹层只列有题目的单元；选单元 + 勾选学生 + 截止时间后按 UTC 提交", async () => {
    await openCreateDialog({ assignments: [] });

    // 空单元不出现；选项含课程前缀与题数
    const unitSelect = screen.getByLabelText(/练习单元/) as HTMLSelectElement;
    expect(
      screen.queryByRole("option", { name: /空单元/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "初一上 / 一元一次方程（2 题）" }),
    ).toBeInTheDocument();
    fireEvent.change(unitSelect, { target: { value: UNIT_ID } });

    // 先在未选学生时提交 → 行内错误
    fireEvent.click(screen.getByRole("button", { name: /确认布置/ }));
    expect(await screen.findByText("请至少选择一名学生")).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();

    // 勾选两名学生（label 文本 = 姓名 + 登录名，用非锚定正则）
    fireEvent.click(screen.getByLabelText(/张三/));
    fireEvent.click(screen.getByLabelText(/李四/));

    // 填截止时间（本地输入值；期望值用同一换算函数计算，测试不依赖时区）
    fireEvent.change(screen.getByLabelText(/截止时间/), {
      target: { value: "2026-10-01T20:00" },
    });

    fireEvent.click(screen.getByRole("button", { name: /确认布置/ }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    // mutate 会附带 TanStack 上下文作为第二参，断言只看请求体（首参）
    expect(mockedCreate.mock.calls[0]?.[0]).toEqual({
      unitId: UNIT_ID,
      studentIds: [STUDENT_A_ID, STUDENT_B_ID],
      dueAt: localInputToUtcIso("2026-10-01T20:00"),
    });
    // 标题留空 → 不提交该字段（服务端缺省用单元标题）
    expect(mockedCreate.mock.calls[0]?.[0]?.title).toBeUndefined();
  });

  it("标题可自定义；不填截止时间则不提交 dueAt", async () => {
    await openCreateDialog({ assignments: [] });
    fireEvent.change(screen.getByLabelText(/作业标题/), {
      target: { value: "国庆专项" },
    });
    fireEvent.click(screen.getByLabelText(/李四/));
    fireEvent.click(screen.getByRole("button", { name: /确认布置/ }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    expect(mockedCreate.mock.calls[0]?.[0]).toEqual({
      unitId: UNIT_ID,
      studentIds: [STUDENT_B_ID],
      title: "国庆专项",
    });
    expect(mockedCreate.mock.calls[0]?.[0]?.dueAt).toBeUndefined();
  });
});

describe("编辑作业流程", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUpdate.mockResolvedValue(makeAssignment());
  });

  it("打开编辑弹层带入原值；改名单 + 清空截止 → 全量名单与 dueAt:null 提交", async () => {
    mockedFetchAssignments.mockResolvedValue({
      assignments: [makeAssignment()],
    });
    mockedFetchTree.mockResolvedValue(TREE);
    mockedFetchStudents.mockResolvedValue(STUDENTS);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    // 弹层打开后等待表单就绪（标题带入原值；单元选择被禁用）
    const titleInput = (await screen.findByLabelText(
      /作业标题/,
    )) as HTMLInputElement;
    expect(titleInput.value).toBe("周末加练");

    // 换名单：取消张三、勾选李四（全量替换语义）
    fireEvent.click(screen.getByLabelText(/张三/));
    fireEvent.click(screen.getByLabelText(/李四/));

    // 清空截止（原有截止 → 提交 dueAt:null 表示取消）
    fireEvent.change(screen.getByLabelText(/截止时间/), {
      target: { value: "" },
    });

    fireEvent.click(screen.getByRole("button", { name: /保存修改/ }));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    expect(mockedUpdate.mock.calls[0]?.[0]).toBe(
      "44444444-4444-4444-8444-444444444444",
    );
    expect(mockedUpdate.mock.calls[0]?.[1]).toEqual({
      // 标题输入框带入原值且未被改动 → 原样提交（幂等）
      title: "周末加练",
      studentIds: [STUDENT_B_ID],
      dueAt: null,
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
    expect(mockedDelete.mock.calls[0]?.[0]).toBe(
      "44444444-4444-4444-8444-444444444444",
    );
    // 取消则不调用
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    expect(mockedDelete).toHaveBeenCalledTimes(1);
  });
});

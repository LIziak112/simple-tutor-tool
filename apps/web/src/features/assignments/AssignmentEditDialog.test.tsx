import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  AssignmentDetailData,
  StudentListData,
  TeacherAssignment,
} from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchAssignmentDetailApi,
  fetchStudentsApi,
  updateAssignmentApi,
} from "@/lib/api";
import { localInputToUtcIso } from "@/lib/time";
import { AssignmentEditDialog } from "./AssignmentEditDialog";

/**
 * 作业编辑弹层组件测试（T2A.7 完整版）：
 * - 名单状态徽章（D13）与锁定原因展示（D14）；
 * - 移出未开始学生直接 PATCH；移出已开始学生 409 CONFIRM_REQUIRED →
 *   二次确认列姓名与影响 → 带 confirmStarted 重发（D13/§4-1）；
 * - 补充课程新成员 / 添加学生（addStudentIds）；
 * - 标题/截止增量保存；未保存改动关闭需确认（§4-5）。
 * API 层 mock（真实接口行为由后端 assignments.test.ts 集成覆盖）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAssignmentDetailApi: vi.fn(),
    fetchStudentsApi: vi.fn(),
    updateAssignmentApi: vi.fn(),
  };
});

const mockedDetail = vi.mocked(fetchAssignmentDetailApi);
const mockedStudents = vi.mocked(fetchStudentsApi);
const mockedUpdate = vi.mocked(updateAssignmentApi);

const ASSIGNMENT_ID = "44444444-4444-4444-8444-444444444444";
const COURSE_ID = "33333333-3333-4333-8333-333333333333";
const STUDENT_A_ID = "11111111-1111-4111-8111-111111111111"; // 张三 已交卷
const STUDENT_B_ID = "22222222-2222-4222-8222-222222222222"; // 李四 未开始
const STUDENT_C_ID = "66666666-6666-4666-8666-666666666666"; // 王五 进行中
const STUDENT_D_ID = "77777777-7777-4777-8777-777777777777"; // 赵六 课程新成员
const STUDENT_E_ID = "88888888-8888-4888-8888-888888888888"; // 孙七 不在名单
const ATTEMPT_A_ID = "99999999-9999-4999-8999-999999999991"; // 张三的 attempt（已交卷）
const ATTEMPT_C_ID = "99999999-9999-4999-8999-999999999993"; // 王五的 attempt（进行中）

function makeAssignment(
  overrides: Partial<TeacherAssignment> = {},
): TeacherAssignment {
  return {
    id: ASSIGNMENT_ID,
    courseId: COURSE_ID,
    courseName: "初一上",
    title: "周末加练",
    dueAt: "2026-10-01T12:00:00.000Z",
    answerRelease: "on_submit",
    units: [
      {
        unitId: "unit-一元一次方程",
        title: "一元一次方程",
        questionCount: 2,
        deleted: false,
      },
      {
        unitId: "unit-有理数乘除",
        title: "有理数乘除",
        questionCount: 1,
        deleted: true,
      },
    ],
    totalQuestionCount: 3,
    containsDeletedUnit: true,
    locked: true,
    studentCount: 3,
    rosterStats: { notStarted: 1, inProgress: 1, submitted: 1, graded: 0 },
    deleted: false,
    deletedAt: null,
    createdAt: "2026-09-26T08:00:00.000Z",
    ...overrides,
  };
}

/** 详情（带课程）：roster 三人三种状态 + startedCount=2 + 课程新成员赵六 */
function makeDetail(
  overrides: Partial<AssignmentDetailData> = {},
): AssignmentDetailData {
  return {
    ...makeAssignment(),
    roster: [
      {
        studentId: STUDENT_A_ID,
        displayName: "张三",
        status: "submitted",
        attemptId: ATTEMPT_A_ID,
        addedAt: "2026-09-26T08:00:00.000Z",
      },
      {
        studentId: STUDENT_B_ID,
        displayName: "李四",
        status: "not_started",
        attemptId: null,
        addedAt: "2026-09-26T08:00:00.000Z",
      },
      {
        studentId: STUDENT_C_ID,
        displayName: "王五",
        status: "in_progress",
        attemptId: ATTEMPT_C_ID,
        addedAt: "2026-09-26T08:00:00.000Z",
      },
    ],
    startedCount: 2,
    courseNewMembers: [{ studentId: STUDENT_D_ID, displayName: "赵六" }],
    ...overrides,
  };
}

const STUDENT_ROWS: [string, string][] = [
  [STUDENT_A_ID, "张三"],
  [STUDENT_B_ID, "李四"],
  [STUDENT_C_ID, "王五"],
  [STUDENT_D_ID, "赵六"],
  [STUDENT_E_ID, "孙七"],
];

const STUDENTS: StudentListData = {
  students: STUDENT_ROWS.map(([id, name], index) => ({
    id,
    displayName: name,
    loginName: name,
    linkEnabled: true,
    passwordEnabled: true,
    hasPassword: true,
    linkToken: `token-${index}`,
    note: null,
    archived: false,
    createdAt: "2026-09-20T10:00:00.000Z",
  })),
};

function renderDialog(assignment: TeacherAssignment = makeAssignment()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onClose = vi.fn();
  const utils = render(
    <QueryClientProvider client={client}>
      <AssignmentEditDialog assignment={assignment} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { ...utils, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedDetail.mockResolvedValue(makeDetail());
  mockedStudents.mockResolvedValue(STUDENTS);
  mockedUpdate.mockResolvedValue(makeAssignment());
});

describe("AssignmentEditDialog 展示", () => {
  it("名单每人显示状态徽章；锁定时展示锁定原因（已开始人数）且单元只读列出", async () => {
    renderDialog();
    // 三人三种状态徽章
    await screen.findByText("张三");
    expect(screen.getByText("已交卷")).toBeInTheDocument();
    expect(screen.getAllByText("未开始").length).toBeGreaterThan(0);
    expect(screen.getByText("进行中")).toBeInTheDocument();

    // D14 锁定原因 + 只读单元列表（含已删标记）
    expect(
      screen.getByText(/已有 2 名学生开始作答，内容已锁定/),
    ).toBeInTheDocument();
    expect(screen.getByText(/1. 一元一次方程（2 题）/)).toBeInTheDocument();
    expect(screen.getByText(/2. 有理数乘除（1 题）/)).toBeInTheDocument();
    expect(
      screen.getByText(/有理数乘除（1 题）（已删除）/),
    ).toBeInTheDocument();
  });

  it("无课程或无课程新成员时隐藏「补充课程新成员」", async () => {
    mockedDetail.mockResolvedValue(
      makeDetail({
        courseId: null,
        courseName: null,
        courseNewMembers: [],
      }),
    );
    renderDialog();
    await screen.findByText("张三");
    expect(screen.queryByText(/补充课程新成员/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /添加学生/ }),
    ).toBeInTheDocument();
  });
});

describe("AssignmentEditDialog 名单移出", () => {
  it("移出未开始学生：直接调用 PATCH removeStudentIds，无二次确认", async () => {
    renderDialog();
    await screen.findByText("李四");
    fireEvent.click(screen.getByRole("button", { name: "移出 李四" }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    expect(mockedUpdate.mock.calls[0]?.[0]).toBe(ASSIGNMENT_ID);
    expect(mockedUpdate.mock.calls[0]?.[1]).toEqual({
      removeStudentIds: [STUDENT_B_ID],
    });
    expect(
      screen.queryByText(/确认移出已开始作答的学生/),
    ).not.toBeInTheDocument();
  });

  it("移出已开始学生：409 CONFIRM_REQUIRED → 确认弹层列姓名与影响 → 带 confirmStarted 重发", async () => {
    renderDialog();
    await screen.findByText("王五");

    // 首次移出被后端拒绝（extra._students 附名单）
    mockedUpdate.mockRejectedValueOnce(
      new ApiError("CONFIRM_REQUIRED", "以下学生已开始作答，请确认", 409, {
        _students: [{ studentId: STUDENT_C_ID, displayName: "王五" }],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "移出 王五" }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    // 确认弹层列出姓名与影响（§4-1）
    expect(
      await screen.findByText(/确认移出已开始作答的学生/),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/王五/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/该作业从其待办中消失/)).toBeInTheDocument();
    expect(screen.getByText(/已交卷的结果保留在其记录中/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认移出" }));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(2));
    expect(mockedUpdate.mock.calls[1]?.[1]).toEqual({
      removeStudentIds: [STUDENT_C_ID],
      confirmStarted: true,
    });
  });

  it("多选批量移出所选学生", async () => {
    renderDialog();
    await screen.findByText("李四");
    fireEvent.click(screen.getByLabelText("选择 李四"));
    fireEvent.click(screen.getByRole("button", { name: /移出所选（1 人）/ }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    expect(mockedUpdate.mock.calls[0]?.[1]).toEqual({
      removeStudentIds: [STUDENT_B_ID],
    });
  });
});

describe("AssignmentEditDialog 名单新增", () => {
  it("补充课程新成员：列出可勾选加入，提交 addStudentIds", async () => {
    renderDialog();
    await screen.findByText("张三");
    fireEvent.click(
      screen.getByRole("button", { name: /补充课程新成员（1 人）/ }),
    );

    // 嵌套弹层列出课程新成员（赵六）
    const zhao = await screen.findByLabelText(/赵六/);
    fireEvent.click(zhao);
    fireEvent.click(screen.getByRole("button", { name: /加入名单（1 人）/ }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    expect(mockedUpdate.mock.calls[0]?.[1]).toEqual({
      addStudentIds: [STUDENT_D_ID],
    });
  });

  it("添加学生：列出不在名单的未归档学生多选加入", async () => {
    renderDialog();
    await screen.findByText("张三");
    fireEvent.click(screen.getByRole("button", { name: "添加学生" }));

    // 嵌套弹层内：名单内的张三不出现；孙七（不在名单）出现
    const addDialog = await screen.findByRole("dialog", { name: "添加学生" });
    const sun = await within(addDialog).findByLabelText(/孙七/);
    expect(within(addDialog).queryByLabelText(/张三/)).not.toBeInTheDocument();
    fireEvent.click(sun);
    fireEvent.click(screen.getByRole("button", { name: /加入名单（1 人）/ }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    expect(mockedUpdate.mock.calls[0]?.[1]).toEqual({
      addStudentIds: [STUDENT_E_ID],
    });
  });
});

describe("AssignmentEditDialog 标题/截止与关闭守卫", () => {
  it("标题/截止增量保存：只提交发生变化的部分；无改动时保存按钮禁用", async () => {
    renderDialog();
    const titleInput = (await screen.findByLabelText(
      /作业标题/,
    )) as HTMLInputElement;
    expect(titleInput.value).toBe("周末加练");
    expect(
      screen.getByRole("button", { name: /保存标题与截止/ }),
    ).toBeDisabled();

    fireEvent.change(titleInput, { target: { value: "国庆专项" } });
    fireEvent.change(screen.getByLabelText(/截止时间/), {
      target: { value: "2026-10-02T20:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保存标题与截止/ }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    expect(mockedUpdate.mock.calls[0]?.[1]).toEqual({
      title: "国庆专项",
      dueAt: localInputToUtcIso("2026-10-02T20:00"),
    });
  });

  it("清空截止并保存 → dueAt:null（取消截止）", async () => {
    renderDialog();
    await screen.findByLabelText(/作业标题/);
    fireEvent.change(screen.getByLabelText(/截止时间/), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保存标题与截止/ }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    expect(mockedUpdate.mock.calls[0]?.[1]).toEqual({ dueAt: null });
  });

  it("有未保存的标题/截止改动时关闭需确认；放弃并关闭后调用 onClose", async () => {
    const { onClose } = renderDialog();
    const titleInput = await screen.findByLabelText(/作业标题/);
    fireEvent.change(titleInput, { target: { value: "新标题" } });

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(await screen.findByText("放弃未保存的内容？")).toBeInTheDocument();

    // 继续编辑留在弹层；放弃并关闭真正关闭
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(await screen.findByRole("button", { name: "放弃并关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("AssignmentEditDialog 答案公布时机（T2A.8）", () => {
  it("改为「截止后公布」保存 → PATCH 只带 answerRelease；改回 on_submit 同理", async () => {
    renderDialog();
    const select = (await screen.findByLabelText(
      /答案公布时机/,
    )) as HTMLSelectElement;
    expect(select.value).toBe("on_submit");

    fireEvent.change(select, { target: { value: "after_due" } });
    expect(
      screen.getByRole("button", { name: /保存标题与截止/ }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /保存标题与截止/ }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    expect(mockedUpdate.mock.calls[0]?.[1]).toEqual({
      answerRelease: "after_due",
    });
  });

  it("无截止的作业选「截止后公布」→ 即时提示且保存禁用；填上截止或改回交卷即公布后恢复", async () => {
    renderDialog(makeAssignment({ dueAt: null }));
    const select = (await screen.findByLabelText(
      /答案公布时机/,
    )) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "after_due" } });
    expect(screen.getByText(/需要截止时间/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /保存标题与截止/ }),
    ).toBeDisabled();

    // 填上截止 → 提示消失、保存恢复，请求同时带 dueAt 与 answerRelease
    fireEvent.change(screen.getByLabelText(/截止时间/), {
      target: { value: "2026-10-02T20:00" },
    });
    expect(screen.queryByText(/需要截止时间/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /保存标题与截止/ }));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    expect(mockedUpdate.mock.calls[0]?.[1]).toEqual({
      dueAt: localInputToUtcIso("2026-10-02T20:00"),
      answerRelease: "after_due",
    });
  });
});

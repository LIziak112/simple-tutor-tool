import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  AssignmentCheckData,
  CourseDetailData,
  CourseListData,
  LibraryUnitList,
  LibraryUnitSummary,
  StudentListData,
  TeacherAssignment,
} from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkAssignmentApi,
  createAssignmentApi,
  fetchCourseDetail,
  fetchLibraryFolders,
  fetchLibraryUnits,
  fetchStudentsApi,
  fetchTeacherCourses,
} from "@/lib/api";
import { localInputToUtcIso } from "@/lib/time";
import { AssignmentComposeWizard } from "./AssignmentComposeWizard";

/**
 * 布置作业三步向导组件测试（T2A.7 前端完整版）：
 * - 三步流转与课程成员带出（D13）、双页签选择与去重（D12）、已选排序（§4-9）、
 *   默认标题占位（defaultAssignmentTitle）、D15 已做过提示、提交请求体
 *   （unitIds 顺序 = 已选顺序）、关闭守卫（§4-5）。
 * API 层 mock（真实接口行为由后端 assignments.test.ts 集成覆盖）；
 * 截止时间换算用真实 localInputToUtcIso 计算期望值（与时区无关）。
 * 注意：已选列表的拖拽把手/上下移/移除按钮的 aria-label 都含单元标题，
 * 与选择器行标签会同时命中模糊匹配——凡涉及单元行一律 within(列表) 精确取。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchTeacherCourses: vi.fn(),
    fetchCourseDetail: vi.fn(),
    fetchStudentsApi: vi.fn(),
    fetchLibraryFolders: vi.fn(),
    fetchLibraryUnits: vi.fn(),
    checkAssignmentApi: vi.fn(),
    createAssignmentApi: vi.fn(),
  };
});

const mockedCourses = vi.mocked(fetchTeacherCourses);
const mockedDetail = vi.mocked(fetchCourseDetail);
const mockedStudents = vi.mocked(fetchStudentsApi);
const mockedFolders = vi.mocked(fetchLibraryFolders);
const mockedLibraryUnits = vi.mocked(fetchLibraryUnits);
const mockedCheck = vi.mocked(checkAssignmentApi);
const mockedCreate = vi.mocked(createAssignmentApi);

const COURSE_ID = "33333333-3333-4333-8333-333333333333";
const FOLDER_ID = "55555555-5555-4555-8555-555555555555";
const STUDENT_A_ID = "11111111-1111-4111-8111-111111111111"; // 张三（课程成员）
const STUDENT_B_ID = "22222222-2222-4222-8222-222222222222"; // 李四（非成员）
const STUDENT_C_ID = "66666666-6666-4666-8666-666666666666"; // 王五（课程成员）
const UNIT_A_ID = "unit-一元一次方程";
const UNIT_B_ID = "unit-有理数乘除";
const UNIT_C_ID = "unit-几何入门";
/** 单元标题常量（中文，供顺序断言复用） */
const UNIT_TITLES = {
  A: "一元一次方程",
  B: "有理数乘除",
  C: "几何入门",
} as const;

const COURSES: CourseListData = {
  courses: [
    {
      id: COURSE_ID,
      name: "初一上",
      description: null,
      archived: false,
      archivedAt: null,
      order: 0,
      memberCount: 2,
      itemCount: 6,
      visibleItemCount: 4,
      memberIds: [STUDENT_A_ID, STUDENT_C_ID],
      hasAttempts: false,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ],
};

/** 课程详情：目录顺序 = 讲义、单元A（可见）、单元B（隐藏）、单元C（定时）、
 *  已删除单元、无题目单元；成员 张三 + 王五 */
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
    {
      studentId: STUDENT_C_ID,
      displayName: "王五",
      joinedAt: "2026-09-02T00:00:00.000Z",
      archived: false,
    },
  ],
  items: [
    {
      id: "77777777-7777-4777-8777-777777777770",
      kind: "lecture",
      refId: "88888888-8888-4888-8888-888888888880",
      title: "第1讲 有理数",
      order: 0,
      visible: true,
      publishAt: null,
      status: "visible",
      questionCount: null,
      resourceUpdatedAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    {
      id: "77777777-7777-4777-8777-777777777771",
      kind: "unit",
      refId: UNIT_A_ID,
      title: UNIT_TITLES.A,
      order: 1,
      visible: true,
      publishAt: null,
      status: "visible",
      questionCount: 2,
      resourceUpdatedAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    {
      id: "77777777-7777-4777-8777-777777777772",
      kind: "unit",
      refId: UNIT_B_ID,
      title: UNIT_TITLES.B,
      order: 2,
      visible: false,
      publishAt: null,
      status: "hidden",
      questionCount: 1,
      resourceUpdatedAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    {
      id: "77777777-7777-4777-8777-777777777773",
      kind: "unit",
      refId: UNIT_C_ID,
      title: UNIT_TITLES.C,
      order: 3,
      visible: true,
      // 2099-09-30 = 北京时间 9月30日 08:00（定时标签文案）
      publishAt: "2099-09-30T00:00:00.000Z",
      status: "scheduled",
      questionCount: 3,
      resourceUpdatedAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    {
      id: "77777777-7777-4777-8777-777777777774",
      kind: "unit",
      refId: "unit-旧单元",
      title: "旧单元",
      order: 4,
      visible: true,
      publishAt: null,
      status: "deleted",
      questionCount: 5,
      resourceUpdatedAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    {
      id: "77777777-7777-4777-8777-777777777775",
      kind: "unit",
      refId: "unit-empty",
      title: "空单元",
      order: 5,
      visible: true,
      publishAt: null,
      status: "no-questions",
      questionCount: 0,
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

function makeLibraryUnit(
  overrides: Partial<LibraryUnitSummary> & {
    id: string;
    title: string;
  },
): LibraryUnitSummary {
  return {
    topic: null,
    folderId: null,
    lectureId: null,
    lectureTitle: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: null,
    questionCount: 1,
    typeDistribution: {},
    knowledge: [],
    courseCount: 0,
    assignmentCount: 0,
    questions: [],
    ...overrides,
  };
}

const LIBRARY_UNITS: LibraryUnitList = {
  units: [
    makeLibraryUnit({
      id: UNIT_A_ID,
      title: UNIT_TITLES.A,
      questionCount: 2,
      typeDistribution: { fill: 2 },
      knowledge: ["方程"],
    }),
    makeLibraryUnit({
      id: UNIT_B_ID,
      title: UNIT_TITLES.B,
      folderId: FOLDER_ID,
      questionCount: 1,
      typeDistribution: { judge: 1 },
    }),
    makeLibraryUnit({
      id: UNIT_C_ID,
      title: UNIT_TITLES.C,
      questionCount: 3,
      typeDistribution: { choice: 2, solve: 1 },
    }),
    // 无题目单元：资源库页签置灰不可勾选
    makeLibraryUnit({
      id: "unit-empty",
      title: "空单元",
      questionCount: 0,
    }),
  ],
};

const FOLDERS = {
  folders: [
    {
      id: FOLDER_ID,
      name: "代数",
      order: 0,
      lectureCount: 0,
      unitCount: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ],
};

const CHECK_EMPTY: AssignmentCheckData = { hints: [] };

function makeAssignment(): TeacherAssignment {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    courseId: null,
    courseName: null,
    title: "周末加练",
    dueAt: null,
    answerRelease: "on_submit",
    units: [],
    totalQuestionCount: 3,
    containsDeletedUnit: false,
    locked: false,
    studentCount: 1,
    rosterStats: { notStarted: 1, inProgress: 0, submitted: 0, graded: 0 },
    deleted: false,
    deletedAt: null,
    createdAt: "2026-09-26T08:00:00.000Z",
  };
}

function renderWizard(initialCourseId: string | null = null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onClose = vi.fn();
  const utils = render(
    <QueryClientProvider client={client}>
      <AssignmentComposeWizard
        initialCourseId={initialCourseId}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onClose };
}

/** 「本课程练习」页签的单元列表（命名列表，避免与已选列表的 aria-label 混淆） */
function courseList(): HTMLElement {
  return screen.getByRole("list", { name: "本课程练习单元列表" });
}

/** 「资源库」页签的单元列表 */
function libraryList(): HTMLElement {
  return screen.getByRole("list", { name: "资源库单元列表" });
}

/** 在本课程练习页签勾选/取消一个单元 */
function clickCourseUnit(title: string): void {
  fireEvent.click(within(courseList()).getByLabelText(new RegExp(title)));
}

/** 在资源库页签勾选/取消一个单元 */
function clickLibraryUnit(title: string): void {
  fireEvent.click(within(libraryList()).getByLabelText(new RegExp(title)));
}

/** 选定课程进入第①步（等待成员默认全选生效），返回渲染工具 */
async function openWizardWithCourse() {
  const utils = renderWizard();
  await screen.findByLabelText(/所属课程/);
  fireEvent.change(screen.getByLabelText(/所属课程/), {
    target: { value: COURSE_ID },
  });
  const zhang = await screen.findByLabelText(/张三/);
  await waitFor(() => expect((zhang as HTMLInputElement).checked).toBe(true));
  return utils;
}

/** 从第①步（已选课程、成员默认全选）进入第②步 */
async function openStep2() {
  await openWizardWithCourse();
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  await screen.findByRole("tablist", { name: "内容来源" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedCourses.mockResolvedValue(COURSES);
  mockedDetail.mockResolvedValue(COURSE_DETAIL);
  mockedStudents.mockResolvedValue(STUDENTS);
  mockedFolders.mockResolvedValue(FOLDERS);
  mockedLibraryUnits.mockResolvedValue(LIBRARY_UNITS);
  mockedCheck.mockResolvedValue(CHECK_EMPTY);
  mockedCreate.mockResolvedValue(makeAssignment());
});

describe("AssignmentComposeWizard 第①步 对象", () => {
  it("选课程带出全部成员且默认全勾选，可逐个取消；未选成员时下一步禁用", async () => {
    await openWizardWithCourse();
    expect(screen.getByText("① 对象")).toHaveAttribute("aria-current", "step");
    const zhang = screen.getByLabelText(/张三/) as HTMLInputElement;
    const wang = screen.getByLabelText(/王五/) as HTMLInputElement;
    expect(zhang.checked).toBe(true);
    expect(wang.checked).toBe(true);
    expect(screen.getByText("已选 2 人")).toBeInTheDocument();

    // 取消王五 → 已选 1 人
    fireEvent.click(wang);
    expect(screen.getByText("已选 1 人")).toBeInTheDocument();

    // 全部取消 → 下一步禁用；重新勾选可进入第②步
    fireEvent.click(zhang);
    expect(screen.getByRole("button", { name: "下一步" })).toBeDisabled();
    fireEvent.click(zhang);
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(await screen.findByText("② 内容")).toHaveAttribute(
      "aria-current",
      "step",
    );
  });

  it("不按课程：从学生列表直接多选", async () => {
    renderWizard();
    const li = await screen.findByLabelText(/李四/);
    expect((li as HTMLInputElement).checked).toBe(false);
    fireEvent.click(li);
    expect(screen.getByText("已选 1 人")).toBeInTheDocument();
    expect(mockedDetail).not.toHaveBeenCalled();
  });
});

describe("AssignmentComposeWizard 第②步 内容", () => {
  it("本课程练习按目录顺序列出单元并标注隐藏/定时状态；跳过已删除、无题目与讲义条目", async () => {
    await openStep2();
    const list = courseList();

    // 讲义、已删除、无题目条目不出现
    expect(within(list).queryByLabelText(/第1讲/)).not.toBeInTheDocument();
    expect(within(list).queryByLabelText(/旧单元/)).not.toBeInTheDocument();
    expect(within(list).queryByLabelText(/空单元/)).not.toBeInTheDocument();

    // 目录顺序：一元一次方程 → 有理数乘除（隐藏）→ 几何入门（定时）
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain(UNIT_TITLES.A);
    expect(rows[1]?.textContent).toContain(UNIT_TITLES.B);
    expect(rows[2]?.textContent).toContain(UNIT_TITLES.C);
    expect(within(list).getByText("隐藏")).toBeInTheDocument();
    expect(
      within(list).getByText(/定时（9月30日 08:00 发布）/),
    ).toBeInTheDocument();
  });

  it("资源库页签：文件夹筛选与搜索即时过滤，显示题数与题型分布", async () => {
    await openStep2();
    fireEvent.click(screen.getByRole("tab", { name: "资源库" }));
    const list = libraryList();

    // 题数与题型分布
    expect(within(list).getByText(/2 题 · 填空×2/)).toBeInTheDocument();
    expect(within(list).getByText(/3 题 · 单选×2 计算×1/)).toBeInTheDocument();

    // 搜索即时过滤（标题）
    fireEvent.change(screen.getByLabelText(/搜索单元/), {
      target: { value: "几何" },
    });
    expect(within(list).getByLabelText(/几何入门/)).toBeInTheDocument();
    expect(
      within(list).queryByLabelText(/一元一次方程/),
    ).not.toBeInTheDocument();

    // 清空搜索后按文件夹筛选（有理数乘除在「代数」文件夹）
    fireEvent.change(screen.getByLabelText(/搜索单元/), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText(/文件夹筛选/), {
      target: { value: FOLDER_ID },
    });
    expect(within(list).getByLabelText(/有理数乘除/)).toBeInTheDocument();
    expect(
      within(list).queryByLabelText(/一元一次方程/),
    ).not.toBeInTheDocument();
  });

  it("同一单元不可重复选：跨页签标记「已选」且勾选态联动；已选汇总含题型分布", async () => {
    await openStep2();
    // 在本课程练习页签勾选一元一次方程
    clickCourseUnit(UNIT_TITLES.A);
    expect(screen.getByText("已选 1 个单元 · 共 2 题")).toBeInTheDocument();

    // 切到资源库：同单元显示已选徽章且勾选态保持
    fireEvent.click(screen.getByRole("tab", { name: "资源库" }));
    const list = libraryList();
    const inLibrary = within(list).getByLabelText(
      new RegExp(UNIT_TITLES.A),
    ) as HTMLInputElement;
    expect(inLibrary.checked).toBe(true);
    expect(within(list).getByText("已选")).toBeInTheDocument();

    // 从资源库再选一个 → 顺序追加、汇总更新（题型分布合并）
    clickLibraryUnit(UNIT_TITLES.B);
    expect(screen.getByText("已选 2 个单元 · 共 3 题")).toBeInTheDocument();
    expect(screen.getByText("填空×2 判断×1")).toBeInTheDocument();
  });

  it("已选列表上移/下移调整顺序；无题目单元在资源库页签置灰不可选", async () => {
    await openStep2();
    clickCourseUnit(UNIT_TITLES.A);
    clickCourseUnit(UNIT_TITLES.B);

    // 下移「一元一次方程」→ 顺序变为 [有理数乘除, 一元一次方程]
    fireEvent.click(
      screen.getByRole("button", { name: `下移 ${UNIT_TITLES.A}` }),
    );
    // aside 与内部拖拽区都有「已选单元」字样的可访问名称，用精确匹配取外层
    const aside = screen.getByLabelText("已选单元");
    const first = within(aside).getByText(UNIT_TITLES.B);
    const second = within(aside).getByText(UNIT_TITLES.A);
    expect(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    // 资源库页签：无题目单元禁用不可勾选
    fireEvent.click(screen.getByRole("tab", { name: "资源库" }));
    expect(within(libraryList()).getByLabelText(/空单元/)).toBeDisabled();
    expect(within(libraryList()).getByText("无题目")).toBeInTheDocument();
  });
});

describe("AssignmentComposeWizard 第③步 确认", () => {
  it("标题占位符为缺省组合；提交请求体 unitIds 顺序 = 已选顺序（含 courseId/title/dueAt）", async () => {
    await openStep2();
    clickCourseUnit(UNIT_TITLES.A);
    clickCourseUnit(UNIT_TITLES.B);
    fireEvent.click(
      screen.getByRole("button", { name: `下移 ${UNIT_TITLES.A}` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    await screen.findByText("③ 确认");
    // 重排后 [有理数乘除, 一元一次方程] → 缺省标题 = 首个 等 2 个单元
    expect(screen.getByLabelText(/作业标题/)).toHaveAttribute(
      "placeholder",
      "默认：有理数乘除 等 2 个单元",
    );

    fireEvent.change(screen.getByLabelText(/作业标题/), {
      target: { value: "国庆专项" },
    });
    fireEvent.change(screen.getByLabelText(/截止时间（可选，北京时间）/), {
      target: { value: "2026-10-01T20:00" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /布置作业（2 个单元 · 3 题）/ }),
    );

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    expect(mockedCreate.mock.calls[0]?.[0]).toEqual({
      unitIds: [UNIT_B_ID, UNIT_A_ID],
      studentIds: [STUDENT_A_ID, STUDENT_C_ID],
      courseId: COURSE_ID,
      title: "国庆专项",
      dueAt: localInputToUtcIso("2026-10-01T20:00"),
      answerRelease: "on_submit",
    });
  });

  it("T2A.8 公布时机：默认交卷即公布；选「截止后公布」未填截止 → 即时提示且提交禁用；填截止后请求体带 answerRelease", async () => {
    await openStep2();
    clickCourseUnit(UNIT_TITLES.A);
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    await screen.findByText("③ 确认");

    // 默认选中「交卷即公布」，无阻断提示
    expect(
      screen.getByRole("radio", { name: /交卷即公布（默认）/ }),
    ).toBeChecked();
    expect(
      screen.getByRole("button", { name: /布置作业（1 个单元/ }),
    ).toBeEnabled();

    // 切「截止后公布」而未填截止 → 即时提示 + 提交禁用
    fireEvent.click(screen.getByRole("radio", { name: /截止后公布/ }));
    expect(screen.getByText(/必须先填写截止时间/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /布置作业（1 个单元/ }),
    ).toBeDisabled();

    // 填上截止 → 提示消失、提交恢复，请求体带 answerRelease=after_due 与 dueAt
    fireEvent.change(screen.getByLabelText(/截止时间（可选，北京时间）/), {
      target: { value: "2026-10-01T20:00" },
    });
    expect(screen.queryByText(/必须先填写截止时间/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /布置作业（1 个单元/ }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    expect(mockedCreate.mock.calls[0]?.[0]).toMatchObject({
      dueAt: localInputToUtcIso("2026-10-01T20:00"),
      answerRelease: "after_due",
    });
  });

  it("D15 已做过提示逐条渲染，仅提示不阻止提交", async () => {
    mockedCheck.mockResolvedValue({
      hints: [
        {
          studentId: STUDENT_A_ID,
          studentName: "张三",
          courseId: COURSE_ID,
          courseName: "初一上",
          unitId: UNIT_A_ID,
          unitTitle: UNIT_TITLES.A,
          submittedCount: 2,
        },
      ],
    });
    await openStep2();
    clickCourseUnit(UNIT_TITLES.A);
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    expect(
      await screen.findByText(
        "张三：已在〈初一上〉中做过〈一元一次方程〉2 次（已看过答案）",
      ),
    ).toBeInTheDocument();
    // 仅提示不阻止：提交按钮可用；check 请求携带全部已选对象与单元
    expect(
      screen.getByRole("button", { name: /布置作业（1 个单元/ }),
    ).toBeEnabled();
    expect(mockedCheck.mock.calls[0]?.[0]).toEqual({
      unitIds: [UNIT_A_ID],
      studentIds: [STUDENT_A_ID, STUDENT_C_ID],
    });
  });

  it("未选课程：本课程练习页签置灰并提示先选课程；提交不带 courseId；单单元缺省标题为该单元标题", async () => {
    renderWizard();
    const li = await screen.findByLabelText(/李四/);
    fireEvent.click(li);
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    expect(screen.getByRole("tab", { name: "本课程练习" })).toBeDisabled();
    expect(screen.getByText(/先在第①步选择课程后可用/)).toBeInTheDocument();
    // 未选课程时实际展示资源库页签
    expect(
      screen.getByRole("tab", { name: "资源库" }).getAttribute("aria-selected"),
    ).toBe("true");

    clickLibraryUnit(UNIT_TITLES.A);
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    await screen.findByText("③ 确认");
    expect(screen.getByLabelText(/作业标题/)).toHaveAttribute(
      "placeholder",
      "默认：一元一次方程",
    );

    fireEvent.click(
      screen.getByRole("button", { name: /布置作业（1 个单元 · 2 题）/ }),
    );
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    expect(mockedCreate.mock.calls[0]?.[0]).toEqual({
      unitIds: [UNIT_A_ID],
      studentIds: [STUDENT_B_ID],
      answerRelease: "on_submit",
    });
  });
});

describe("AssignmentComposeWizard 关闭守卫（§4-5）", () => {
  it("空向导直接关闭，无确认弹层", async () => {
    const empty = renderWizard();
    await screen.findByLabelText(/李四/);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(empty.onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("放弃未保存的内容？")).not.toBeInTheDocument();
  });

  it("有已选内容时取消 → 确认弹层；继续编辑留在向导，放弃并关闭调用 onClose", async () => {
    const utils = renderWizard();
    const li = await screen.findByLabelText(/李四/);
    fireEvent.click(li);
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    clickLibraryUnit(UNIT_TITLES.A);

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(await screen.findByText("放弃未保存的内容？")).toBeInTheDocument();
    expect(utils.onClose).not.toHaveBeenCalled();

    // 继续编辑：确认弹层关闭，向导仍在
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.queryByText("放弃未保存的内容？")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();

    // 再次取消 → 放弃并关闭
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(await screen.findByRole("button", { name: "放弃并关闭" }));
    expect(utils.onClose).toHaveBeenCalledTimes(1);
  });
});

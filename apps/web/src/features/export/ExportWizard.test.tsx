import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  CourseListData,
  LearningPackPreviewData,
  LectureDetail,
  LibraryLectureList,
  StudentListData,
  TeacherAssignmentListData,
} from "@tutor/contract";
import {
  learningPackExportRequestSchema,
  NOTE_PHASE_LABELS,
} from "@tutor/contract";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadLearningPackApi,
  fetchAssignmentsApi,
  fetchLectureDetail,
  fetchLibraryLectures,
  fetchStudentsApi,
  fetchTeacherCourses,
  previewLearningPackApi,
} from "@/lib/api";
import ExportPage from "@/pages/teacher/ExportPage";
import { ExportWizard } from "./ExportWizard";

/**
 * 「导出给 AI」五步向导组件测试（T4.4）：步骤流转与下一步禁用条件、回退
 * 保留状态、画像入口预填、模块联动（题目三层 / 讲义小节树 → payload
 * sectionIndexes / 手写 PNG 提示）、隐私二次确认、预览三态与超限禁下载、
 * 下载触发与防重复、未完成离开确认（页内二次确认 + beforeunload）。
 * API 层 mock（真实打包与下载流由 T4.3 服务测试 + T4.7 E2E 覆盖）；
 * downloadLearningPackApi 自身的文件名解析另见 download-learning-pack.test.ts。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentsApi: vi.fn(),
    fetchTeacherCourses: vi.fn(),
    fetchAssignmentsApi: vi.fn(),
    fetchLibraryLectures: vi.fn(),
    fetchLectureDetail: vi.fn(),
    previewLearningPackApi: vi.fn(),
    downloadLearningPackApi: vi.fn(),
  };
});

// 闸门 F1③ 测试注入点：只把 learningPackExportRequestSchema.parse 包成
// vi.fn（委托原实现）——Object.create(原实例) 原型委派（zod4 的 _zod 内部态
// 是不可枚举自有属性，Object.assign 拷贝会丢，safeParse 会崩），parse 以自有
// 属性遮蔽，其余导出原样透传
vi.mock("@tutor/contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tutor/contract")>();
  const original = actual.learningPackExportRequestSchema;
  const wrapped = Object.create(original) as typeof original;
  wrapped.parse = vi.fn((...args: Parameters<typeof original.parse>) =>
    original.parse(...args),
  ) as typeof original.parse;
  return { ...actual, learningPackExportRequestSchema: wrapped };
});

const mockedStudents = vi.mocked(fetchStudentsApi);
const mockedCourses = vi.mocked(fetchTeacherCourses);
const mockedAssignments = vi.mocked(fetchAssignmentsApi);
const mockedLectures = vi.mocked(fetchLibraryLectures);
const mockedLectureDetail = vi.mocked(fetchLectureDetail);
const mockedPreview = vi.mocked(previewLearningPackApi);
const mockedDownload = vi.mocked(downloadLearningPackApi);

// ---------- fixtures ----------

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const COURSE_A = "44444444-4444-4444-8444-444444444444";
const ASSIGNMENT_1 = "55555555-5555-4555-8555-555555555555";
const ASSIGNMENT_2 = "66666666-6666-4666-8666-666666666666";
const LECTURE_1 = "77777777-7777-4777-8777-777777777771";
const LECTURE_2 = "77777777-7777-4777-8777-777777777772";

const NOW = "2026-10-01T04:00:00.000Z";

const STUDENTS: StudentListData = {
  students: [
    {
      id: S1,
      displayName: "陈小明",
      loginName: "chenxm",
      linkEnabled: true,
      passwordEnabled: true,
      hasPassword: true,
      linkToken: "tok-1",
      note: null,
      archived: false,
      createdAt: NOW,
    },
    {
      id: S2,
      displayName: "李小红",
      loginName: "lixh",
      linkEnabled: true,
      passwordEnabled: false,
      hasPassword: false,
      linkToken: "tok-2",
      note: null,
      archived: false,
      createdAt: NOW,
    },
    {
      id: S3,
      displayName: "王小刚",
      loginName: "wangxg",
      linkEnabled: false,
      passwordEnabled: true,
      hasPassword: true,
      linkToken: "tok-3",
      note: null,
      archived: true,
      createdAt: NOW,
    },
  ],
};

const COURSES: CourseListData = {
  courses: [
    {
      id: COURSE_A,
      name: "初一数学·上学期",
      description: null,
      archived: false,
      archivedAt: null,
      order: 0,
      memberCount: 2,
      itemCount: 2,
      visibleItemCount: 2,
      memberIds: [S1, S2],
      hasAttempts: true,
      createdAt: NOW,
    },
  ],
};

const ASSIGNMENTS: TeacherAssignmentListData = {
  assignments: [
    {
      id: ASSIGNMENT_1,
      courseId: COURSE_A,
      courseName: "初一数学·上学期",
      title: "开学摸底练习",
      dueAt: null,
      answerRelease: "on_submit",
      units: [],
      totalQuestionCount: 5,
      containsDeletedUnit: false,
      locked: true,
      studentCount: 2,
      rosterStats: { notStarted: 0, inProgress: 0, submitted: 1, graded: 1 },
      deleted: false,
      deletedAt: null,
      createdAt: NOW,
    },
    {
      id: ASSIGNMENT_2,
      courseId: null,
      courseName: null,
      title: "周末加练",
      dueAt: null,
      answerRelease: "on_submit",
      units: [],
      totalQuestionCount: 3,
      containsDeletedUnit: false,
      locked: false,
      studentCount: 2,
      rosterStats: { notStarted: 2, inProgress: 0, submitted: 0, graded: 0 },
      deleted: true,
      deletedAt: NOW,
      createdAt: NOW,
    },
  ],
};

/** 讲义一：H2/H2/H3 交错目录（headingIndex 0/1/2，与 extractOutline 同口径） */
const LECTURE_1_DETAIL: LectureDetail = {
  id: LECTURE_1,
  title: "有理数讲义",
  markdown: [
    "# 有理数讲义",
    "",
    "## 第一节 概念",
    "",
    "正文。",
    "",
    "### 概念小结",
    "",
    "正文。",
    "",
    "## 第二节 运算",
    "",
    "正文。",
    "",
  ].join("\n"),
  updatedAt: NOW,
};

const LECTURES: LibraryLectureList = {
  lectures: [
    {
      id: LECTURE_1,
      title: "有理数讲义",
      folderId: null,
      updatedAt: NOW,
      deletedAt: null,
      courseCount: 1,
    },
    {
      id: LECTURE_2,
      title: "方程讲义",
      folderId: null,
      updatedAt: NOW,
      deletedAt: null,
      courseCount: 0,
    },
  ],
};

/** 预览响应（未超限基线） */
const PREVIEW_OK: LearningPackPreviewData = {
  files: [
    { path: "pack.json", estimatedBytes: 40_960 },
    { path: "summary.md", estimatedBytes: 2_048 },
    { path: "prompt.md", estimatedBytes: 1_024 },
    { path: "schema.json", estimatedBytes: 8_192 },
    { path: "映射.txt", estimatedBytes: 64 },
  ],
  totalEstimatedBytes: 52_288,
  limitBytes: 52_428_800,
  overLimit: false,
  hint: null,
  // 装配时刻与证据图清单（基线夹具：证据清单为空）
  asOf: "2026-10-07T01:02:03.456Z",
  evidenceImages: [],
};

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** 渲染向导并等第①步学生名单就绪 */
async function renderWizard(initialStudentId: string | null = null) {
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>
        <ExportWizard initialStudentId={initialStudentId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByText("陈小明");
}

function nextButton(): HTMLElement {
  return screen.getByRole("button", { name: "下一步" });
}

/** 渲染向导 → 勾一名学生并进入第②步 */
async function pickStudentAndGoStep2(): Promise<void> {
  await renderWizard();
  fireEvent.click(screen.getByRole("checkbox", { name: /陈小明/ }));
  fireEvent.click(nextButton());
  await screen.findByText(/讲义（候选集为资源库全部讲义/);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedStudents.mockResolvedValue(STUDENTS);
  mockedCourses.mockResolvedValue(COURSES);
  mockedAssignments.mockResolvedValue(ASSIGNMENTS);
  mockedLectures.mockResolvedValue(LECTURES);
  mockedLectureDetail.mockResolvedValue(LECTURE_1_DETAIL);
  mockedPreview.mockResolvedValue(PREVIEW_OK);
  mockedDownload.mockResolvedValue("learning-pack-20260101-120000.zip");
});

// ---------- 五步流转 ----------

describe("ExportWizard 五步流转", () => {
  it("①未选学生时下一步禁用；勾选后进入②；②无内容模块时下一步禁用", async () => {
    await renderWizard();
    expect(nextButton()).toBeDisabled();
    expect(screen.getByText(/下一步需要至少一名学生/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /陈小明/ }));
    expect(nextButton()).toBeEnabled();
    fireEvent.click(nextButton());
    await screen.findByText(/讲义（候选集为资源库全部讲义/);

    // ②：一个内容模块都没勾 → 下一步禁用（手写 PNG 只是附件开关不算）
    fireEvent.click(screen.getByRole("checkbox", { name: /手写过程 PNG/ }));
    expect(nextButton()).toBeDisabled();
    // 勾一个有效模块后恢复
    fireEvent.click(screen.getByRole("checkbox", { name: /作答汇总/ }));
    expect(nextButton()).toBeEnabled();
  });

  it("走完五步进入预览：④→⑤ 时以当前勾选调用 preview 接口", async () => {
    await renderWizard();
    fireEvent.click(screen.getByRole("checkbox", { name: /陈小明/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /李小红/ }));
    fireEvent.click(nextButton());
    await screen.findByText(/讲义（候选集为资源库全部讲义/);

    fireEvent.click(screen.getByRole("checkbox", { name: /作答汇总/ }));
    fireEvent.click(nextButton());
    await screen.findByText(/任务目标（决定数据包内/);
    fireEvent.click(nextButton());
    await screen.findByText(/化名导出（默认开启）/);
    fireEvent.click(nextButton());

    await screen.findByText("包内文件清单");
    await waitFor(() => {
      expect(mockedPreview).toHaveBeenCalledTimes(1);
    });
    // useMutation 会额外传 context 作第二参，取第一参（请求体）断言
    const payload = mockedPreview.mock.calls[0]?.[0];
    expect(payload?.scope).toEqual({ studentIds: [S1, S2], days: 30 });
    expect(payload?.goal).toBe("diagnose-weakness");
    expect(payload?.privacy).toEqual({ anonymize: true });
    // v1 默认请求语义零变化：不开证据组时不请求 packVersion=2、evidence 关、
    // 阶段缺省 scratch（buildRequest 经契约 schema.parse 填默认——显式携带
    // 与缺省对服务端同 schema 等价，无 v2 泄漏）
    expect(payload).not.toHaveProperty("packVersion");
    expect(payload?.modules?.evidence).toBe(false);
    expect(payload?.modules?.evidencePhases).toEqual(["scratch"]);
    // 文件清单渲染（路径 + 合计，使用 sizeTextOf）
    expect(screen.getByText("pack.json")).toBeInTheDocument();
    expect(screen.getByText("映射.txt")).toBeInTheDocument();
    expect(screen.getByText(/51 KB/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /生成并下载/ })).toBeEnabled();
  });

  it("回退保留状态：⑤→① 学生勾选仍在，改勾后再进⑤重新预览", async () => {
    await renderWizard();
    fireEvent.click(screen.getByRole("checkbox", { name: /陈小明/ }));
    fireEvent.click(nextButton());
    await screen.findByText(/讲义（候选集为资源库全部讲义/);
    fireEvent.click(screen.getByRole("checkbox", { name: /作答汇总/ }));
    fireEvent.click(nextButton());
    await screen.findByText(/任务目标/);
    fireEvent.click(nextButton());
    await screen.findByText(/化名导出/);
    fireEvent.click(nextButton());
    await screen.findByText("包内文件清单");
    await waitFor(() => expect(mockedPreview).toHaveBeenCalledTimes(1));

    // ⑤ → ④ → ③ → ②：模块勾选仍保留（作答汇总在②可见）
    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    expect(screen.getByRole("checkbox", { name: /作答汇总/ })).toBeChecked();

    // ② → ①：学生勾选仍保留
    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    expect(screen.getByRole("checkbox", { name: /陈小明/ })).toBeChecked();

    // 改动后再走回⑤：preview 重新发起（共 2 次）
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    await screen.findByText("包内文件清单");
    await waitFor(() => expect(mockedPreview).toHaveBeenCalledTimes(2));
  });

  it("画像入口预填：ExportPage 读 ?studentId= 自动勾选该生", async () => {
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <MemoryRouter initialEntries={[`/t/export?studentId=${S2}`]}>
          <Routes>
            <Route path="/t/export" element={<ExportPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText("李小红");
    expect(screen.getByRole("checkbox", { name: /李小红/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /陈小明/ })).not.toBeChecked();
    expect(screen.getByText(/已选 1 人/)).toBeInTheDocument();
  });
});

// ---------- 模块联动 ----------

describe("ExportWizard 模块联动", () => {
  it("讲义小节树勾选进 payload：勾讲义=仅大纲，勾小节自动纳入并带 sectionIndexes", async () => {
    await pickStudentAndGoStep2();

    // 展开讲义一目录（H2/H3 与 extractOutline 同口径：0 概念 1 小结 2 运算）
    fireEvent.click(
      screen.getByRole("button", { name: "展开 有理数讲义 的小节目录" }),
    );
    await screen.findByText("第一节 概念");
    expect(
      screen.getByRole("checkbox", { name: /第一节 概念/ }),
    ).toBeInTheDocument();

    // 勾第 0、2 节（第 0 节勾选自动纳入讲义）
    fireEvent.click(screen.getByRole("checkbox", { name: /第一节 概念/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /第二节 运算/ }));
    // 再单独勾另一篇讲义 = 仅大纲
    fireEvent.click(screen.getByRole("checkbox", { name: /方程讲义/ }));

    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    await screen.findByText("包内文件清单");
    await waitFor(() => expect(mockedPreview).toHaveBeenCalledTimes(1));
    const payload = mockedPreview.mock.calls[0]?.[0];
    expect(payload?.modules.lectures).toEqual([
      { lectureId: LECTURE_1, sectionIndexes: [0, 2] },
      { lectureId: LECTURE_2, sectionIndexes: [] },
    ]);
  });

  it("题目三层单选升级：默认不含，选「题干 + 参考答案」后 payload questions=answer", async () => {
    await pickStudentAndGoStep2();

    // 默认不含题目
    expect(screen.getByRole("radio", { name: "不包含题目" })).toBeChecked();
    fireEvent.click(
      screen.getByRole("radio", { name: "仅题干（题干中的答案标记会隐去）" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "题干 + 参考答案" }));
    // 升级式单选：后者覆盖前者
    expect(
      screen.getByRole("radio", { name: "题干 + 参考答案" }),
    ).toBeChecked();
    expect(
      screen.getByRole("radio", { name: "仅题干（题干中的答案标记会隐去）" }),
    ).not.toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: /逐题答案/ }));
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    await screen.findByText("包内文件清单");
    const payload = mockedPreview.mock.calls.at(-1)?.[0];
    expect(payload?.modules.questions).toBe("answer");
    expect(payload?.modules.responses).toBe(true);
  });

  it("勾选手写 PNG 出现体积提示；范围步骤的课程/作业/时间进 payload", async () => {
    await renderWizard();
    fireEvent.click(screen.getByRole("checkbox", { name: /陈小明/ }));
    // 课程与作业叠加筛选（交叉）
    fireEvent.change(screen.getByLabelText(/按课程筛选/), {
      target: { value: COURSE_A },
    });
    fireEvent.change(screen.getByLabelText(/按作业筛选/), {
      target: { value: ASSIGNMENT_1 },
    });
    fireEvent.click(screen.getByRole("radio", { name: "最近 90 天" }));
    fireEvent.click(nextButton());
    await screen.findByText(/讲义（候选集为资源库全部讲义/);

    expect(screen.queryByText(/手写图片体积大/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /手写过程 PNG/ }));
    expect(screen.getByText(/手写图片体积大/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /每题派生指标/ }));
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    await screen.findByText("包内文件清单");
    const payload = mockedPreview.mock.calls.at(-1)?.[0];
    expect(payload?.scope).toEqual({
      studentIds: [S1],
      courseId: COURSE_A,
      assignmentId: ASSIGNMENT_1,
      days: 90,
    });
    expect(payload?.modules.ink).toBe(true);
    expect(payload?.modules.traces).toBe(true);
    // 任务目标与附加段进 payload
  });

  it("任务目标四模板单选 + 自定义附加段随 payload 提交", async () => {
    await pickStudentAndGoStep2();
    fireEvent.click(screen.getByRole("checkbox", { name: /作答汇总/ }));
    fireEvent.click(nextButton());
    await screen.findByText(/任务目标/);
    fireEvent.click(screen.getByRole("radio", { name: /生成变式练习/ }));
    fireEvent.change(screen.getByLabelText(/教师附加要求/), {
      target: { value: "侧重有理数运算" },
    });
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    await screen.findByText("包内文件清单");
    const payload = mockedPreview.mock.calls.at(-1)?.[0];
    expect(payload?.goal).toBe("variant-practice");
    expect(payload?.customPrompt).toBe("侧重有理数运算");
  });
});

// ---------- 隐私 ----------

describe("ExportWizard 隐私（D16）", () => {
  async function goToPrivacy(): Promise<void> {
    await pickStudentAndGoStep2();
    fireEvent.click(screen.getByRole("checkbox", { name: /作答汇总/ }));
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    await screen.findByText(/化名导出（默认开启）/);
  }

  it("默认化名开启（包含真实姓名开关未勾，payload anonymize=true）", async () => {
    await goToPrivacy();
    expect(
      screen.getByRole("checkbox", { name: /包含真实姓名/ }),
    ).not.toBeChecked();
    fireEvent.click(nextButton());
    await screen.findByText("包内文件清单");
    expect(mockedPreview.mock.calls.at(-1)?.[0].privacy).toEqual({
      anonymize: true,
    });
  });

  it("开真实姓名弹二次确认：取消保持化名；确认后 anonymize=false", async () => {
    await goToPrivacy();
    const realNameToggle = screen.getByRole("checkbox", {
      name: /包含真实姓名/,
    });
    fireEvent.click(realNameToggle);
    // 确认弹层出现
    expect(screen.getByText(/确认在数据包中包含真实姓名/)).toBeInTheDocument();
    // 取消：开关不变化
    fireEvent.click(screen.getByRole("button", { name: "仍使用化名" }));
    expect(
      screen.queryByText(/确认在数据包中包含真实姓名/),
    ).not.toBeInTheDocument();
    expect(realNameToggle).not.toBeChecked();

    // 再次打开并确认：关闭化名
    fireEvent.click(realNameToggle);
    fireEvent.click(screen.getByRole("button", { name: "确认包含真实姓名" }));
    expect(realNameToggle).toBeChecked();
    fireEvent.click(nextButton());
    await screen.findByText("包内文件清单");
    expect(mockedPreview.mock.calls.at(-1)?.[0].privacy).toEqual({
      anonymize: false,
    });
  });
});

// ---------- 预览与下载 ----------

describe("ExportWizard 预览与下载", () => {
  /** 走到第⑤步（1 名学生 + 作答汇总），等 preview 首次调用完成 */
  async function goToPreview(): Promise<void> {
    await pickStudentAndGoStep2();
    fireEvent.click(screen.getByRole("checkbox", { name: /作答汇总/ }));
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    await waitFor(() => {
      expect(mockedPreview).toHaveBeenCalledTimes(1);
    });
  }

  it("preview 失败呈现错误态并可重试成功", async () => {
    mockedPreview.mockRejectedValueOnce(new Error("连不上服务器"));
    await goToPreview();
    expect(await screen.findByText("预览加载失败")).toBeInTheDocument();
    expect(screen.getByText("连不上服务器")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新预览" }));
    await screen.findByText("包内文件清单");
  });

  it("超限（overLimit）→ 精简提示出现且下载禁用", async () => {
    mockedPreview.mockResolvedValue({
      ...PREVIEW_OK,
      totalEstimatedBytes: 60_000_000,
      overLimit: true,
      hint: "建议减少学生人数或取消手写图片",
    });
    await goToPreview();
    expect(screen.getByText(/超过 50 MB 上限，无法下载/)).toBeInTheDocument();
    expect(screen.getByText(/服务端提示：/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /生成并下载/ })).toBeDisabled();
  });

  it("正常预览 → 点下载调用下载接口；下载中禁用防重复；成功显示文件名", async () => {
    let resolveDownload!: (filename: string) => void;
    mockedDownload.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve;
        }),
    );
    await goToPreview();
    const downloadButton = screen.getByRole("button", { name: /生成并下载/ });
    fireEvent.click(downloadButton);
    // 下载中：按钮转「正在生成数据包…」并禁用（防重复点击）
    const pendingButton = await screen.findByRole("button", {
      name: /正在生成数据包/,
    });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    await waitFor(() => {
      expect(mockedDownload).toHaveBeenCalledTimes(1);
    });
    const downloadPayload = mockedDownload.mock.calls[0]?.[0];
    expect(downloadPayload?.asOf).toBe(PREVIEW_OK.asOf);

    resolveDownload("learning-pack-20260101-120000.zip");
    expect(await screen.findByText(/已生成并开始下载/)).toBeInTheDocument();
    expect(
      screen.getByText(/learning-pack-20260101-120000\.zip/),
    ).toBeInTheDocument();
  });

  it("下载失败呈现中文错误且按钮恢复", async () => {
    mockedDownload.mockRejectedValueOnce(
      new Error("内容合计超过 50 MB 上限，请精简后重试"),
    );
    await goToPreview();
    fireEvent.click(screen.getByRole("button", { name: /生成并下载/ }));
    expect(
      await screen.findByText(/内容合计超过 50 MB 上限/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /生成并下载/ })).toBeEnabled();
  });
});

// ---------- 未完成离开确认 ----------

describe("ExportWizard 未完成离开确认", () => {
  it("未改动时直接退出（无确认弹层）", async () => {
    let locationPath = "";
    function LocationProbe(): string | null {
      locationPath = useLocation().pathname;
      return null;
    }
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <MemoryRouter initialEntries={["/t/export"]}>
          <Routes>
            <Route
              path="/t/export"
              element={<ExportWizard initialStudentId={null} />}
            />
            <Route path="/t/insights" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText("陈小明");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(locationPath).toBe("/t/insights"));
    expect(screen.queryByText("放弃未保存的内容？")).not.toBeInTheDocument();
  });

  it("有勾选改动后退出需确认：继续编辑留在向导，放弃并关闭才离开", async () => {
    let locationPath = "";
    function LocationProbe(): string | null {
      locationPath = useLocation().pathname;
      return null;
    }
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <MemoryRouter initialEntries={["/t/export"]}>
          <Routes>
            <Route
              path="/t/export"
              element={<ExportWizard initialStudentId={null} />}
            />
            <Route path="/t/insights" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText("陈小明");
    fireEvent.click(screen.getByRole("checkbox", { name: /陈小明/ }));

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("放弃未保存的内容？")).toBeInTheDocument();

    // 继续编辑：弹层关闭、留在向导（步骤条仍在）
    fireEvent.click(within(dialog).getByRole("button", { name: "继续编辑" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("① 范围")).toBeInTheDocument();

    // 放弃并关闭：离开向导
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    const dialog2 = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog2).getByRole("button", { name: "放弃并关闭" }),
    );
    await waitFor(() => expect(locationPath).toBe("/t/insights"));
  });

  it("有改动时刷新/关闭触发 beforeunload 拦截；无改动不拦截", async () => {
    await renderWizard();
    // 无改动：不拦截
    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    fireEvent.click(screen.getByRole("checkbox", { name: /陈小明/ }));
    const dirtyEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
  });

  it("下载成功后退出不再确认（向导已完成）", async () => {
    let locationPath = "";
    function LocationProbe(): string | null {
      locationPath = useLocation().pathname;
      return null;
    }
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <MemoryRouter initialEntries={["/t/export"]}>
          <Routes>
            <Route
              path="/t/export"
              element={<ExportWizard initialStudentId={null} />}
            />
            <Route path="/t/insights" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText("陈小明");
    fireEvent.click(screen.getByRole("checkbox", { name: /陈小明/ }));
    fireEvent.click(nextButton());
    await screen.findByText(/讲义（候选集为资源库全部讲义/);
    fireEvent.click(screen.getByRole("checkbox", { name: /作答汇总/ }));
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    fireEvent.click(await screen.findByRole("button", { name: /生成并下载/ }));
    await screen.findByText(/已生成并开始下载/);

    // 完成后退出：直接离开，无确认弹层
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(locationPath).toBe("/t/insights"));
    expect(screen.queryByText("放弃未保存的内容？")).not.toBeInTheDocument();
  });
});

// ---------- T6R.16 新增特性测试 ----------

describe("ExportWizard 手写证据分组（T6R.16 A）", () => {
  it("默认主开关关闭且不显示阶段选择；开启后显示三个阶段且默认勾选原稿", async () => {
    await pickStudentAndGoStep2();

    const evidenceToggle = screen.getByRole("checkbox", {
      name: /手写原稿与订正图片（v2 数据包）/,
    });
    expect(evidenceToggle).not.toBeChecked();
    expect(screen.queryByText("选择收录阶段")).not.toBeInTheDocument();

    // 开启主开关
    fireEvent.click(evidenceToggle);
    expect(evidenceToggle).toBeChecked();
    expect(screen.getByText(/选择收录阶段/)).toBeInTheDocument();

    // 默认原稿勾选
    const scratchCheckbox = screen.getByRole("checkbox", { name: /^原稿/ });
    const correctionCheckbox = screen.getByRole("checkbox", { name: /^订正/ });
    const supplementCheckbox = screen.getByRole("checkbox", {
      name: /^补充稿/,
    });
    expect(scratchCheckbox).toBeChecked();
    expect(correctionCheckbox).not.toBeChecked();
    expect(supplementCheckbox).not.toBeChecked();

    // 体积与手写真实姓名提示
    expect(
      screen.getByText(/证据图片体积较大（上限 50MB）/),
    ).toBeInTheDocument();
    expect(screen.getByText(/手写图片可能包含真实姓名/)).toBeInTheDocument();
  });

  it("开启证据并勾选三阶段后，payload 携带 packVersion: 2 / evidence: true / 规范序 evidencePhases", async () => {
    await pickStudentAndGoStep2();
    // 勾选逐题作答以满足契约要求
    fireEvent.click(screen.getByRole("checkbox", { name: /逐题答案/ }));

    // 开启证据
    fireEvent.click(
      screen.getByRole("checkbox", { name: /手写原稿与订正图片/ }),
    );
    // 勾选补充稿再勾选订正（乱序操作）
    fireEvent.click(screen.getByRole("checkbox", { name: /^补充稿/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^订正/ }));

    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    await screen.findByText("包内文件清单");
    await waitFor(() => expect(mockedPreview).toHaveBeenCalledTimes(1));

    const payload = mockedPreview.mock.calls[0]?.[0];
    expect(payload?.packVersion).toBe(2);
    expect(payload?.modules.evidence).toBe(true);
    // 规范序：scratch → correction → supplement
    expect(payload?.modules.evidencePhases).toEqual([
      "scratch",
      "correction",
      "supplement",
    ]);
  });

  it("保证至少一门阶段勾选：尝试取消唯一的勾选阶段被阻止", async () => {
    await pickStudentAndGoStep2();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /手写原稿与订正图片/ }),
    );

    const scratchCheckbox = screen.getByRole("checkbox", { name: /^原稿/ });
    expect(scratchCheckbox).toBeChecked();
    // 尝试取消原稿（当前唯一已选项）
    fireEvent.click(scratchCheckbox);
    // 仍保持勾选
    expect(scratchCheckbox).toBeChecked();
  });

  it("勾选证据但未勾逐题作答时行内提示；证据只是附件开关不单独构成有效模块", async () => {
    await renderWizard();
    fireEvent.click(screen.getByRole("checkbox", { name: /陈小明/ }));
    fireEvent.click(nextButton());
    await screen.findByText(/讲义（候选集为资源库全部讲义/);

    // 未勾选任何内容模块，仅勾选证据
    fireEvent.click(
      screen.getByRole("checkbox", { name: /手写原稿与订正图片/ }),
    );
    // 提示需要同时勾选逐题作答
    expect(
      screen.getByText(/证据附件挂在逐题作答行上，需同时勾选/),
    ).toBeInTheDocument();
    // 证据不算内容模块，下一步保持禁用
    expect(nextButton()).toBeDisabled();
  });
});

describe("ExportWizard 逐题评析联动（T6R.16 B）", () => {
  it("选中逐题评析时自动开启证据主开关（原稿默认勾），并显示 aria-live 提示", async () => {
    await pickStudentAndGoStep2();
    fireEvent.click(screen.getByRole("checkbox", { name: /逐题答案/ }));
    // 确认此时证据主开关未开
    const evidenceToggle = screen.getByRole("checkbox", {
      name: /手写原稿与订正图片/,
    });
    expect(evidenceToggle).not.toBeChecked();

    fireEvent.click(nextButton());
    await screen.findByText(/任务目标/);

    // 选中第五张卡「逐题评析」
    const reviewRadio = screen.getByRole("radio", { name: /逐题评析/ });
    fireEvent.click(reviewRadio);
    expect(reviewRadio).toBeChecked();

    // aria-live 提示出现（闸门 F1② 文案：同时提及证据与逐题作答两动作）
    expect(
      screen.getByText(/逐题评析需要 v2 证据附件与逐题作答，已自动开启并勾选/),
    ).toBeInTheDocument();

    // 回到第二步查看证据主开关已被自动开启
    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    expect(
      screen.getByRole("checkbox", { name: /手写原稿与订正图片/ }),
    ).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /^原稿/ })).toBeChecked();
  });

  it("目标为逐题评析时试图关闭证据主开关 → 阻止并提示", async () => {
    await pickStudentAndGoStep2();
    fireEvent.click(screen.getByRole("checkbox", { name: /逐题答案/ }));
    fireEvent.click(nextButton());
    await screen.findByText(/任务目标/);
    fireEvent.click(screen.getByRole("radio", { name: /逐题评析/ }));

    // 回到第二步试图关闭证据主开关
    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    const evidenceToggle = screen.getByRole("checkbox", {
      name: /手写原稿与订正图片/,
    });
    expect(evidenceToggle).toBeChecked();

    fireEvent.click(evidenceToggle);
    // 阻止关闭：仍为勾选状态
    expect(evidenceToggle).toBeChecked();
    expect(
      screen.getByText(/逐题评析依赖证据附件，请先改选其他任务目标/),
    ).toBeInTheDocument();
  });
});

// ---------- 闸门修复（F1/F9/F10：证据联动崩溃三连与缩略图健壮性） ----------

describe("ExportWizard 证据联动防御（闸门 F1/F9/F10）", () => {
  /** 走到第⑤步（1 名学生 + 作答汇总），等 preview 首次调用完成 */
  async function goToPreview(): Promise<void> {
    await pickStudentAndGoStep2();
    fireEvent.click(screen.getByRole("checkbox", { name: /作答汇总/ }));
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    await waitFor(() => {
      expect(mockedPreview).toHaveBeenCalledTimes(1);
    });
  }

  it("F1①：勾证据且有其他内容模块但未勾逐题作答 → 下一步仍禁用；补勾后恢复", async () => {
    await pickStudentAndGoStep2();
    fireEvent.click(screen.getByRole("checkbox", { name: /作答汇总/ }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: /手写原稿与订正图片/ }),
    );
    expect(nextButton()).toBeDisabled();
    // 补勾逐题作答（证据附件的挂载模块）后恢复
    fireEvent.click(screen.getByRole("checkbox", { name: /逐题答案/ }));
    expect(nextButton()).toBeEnabled();
  });

  it("F1②：选逐题评析时未勾逐题作答 → 自动开证据并勾选逐题作答，回②步核对", async () => {
    await pickStudentAndGoStep2();
    // 不勾逐题作答、不开证据，靠作答汇总进③
    fireEvent.click(screen.getByRole("checkbox", { name: /作答汇总/ }));
    fireEvent.click(nextButton());
    await screen.findByText(/任务目标/);
    fireEvent.click(screen.getByRole("radio", { name: /逐题评析/ }));
    expect(
      screen.getByText(/逐题评析需要 v2 证据附件与逐题作答，已自动开启并勾选/),
    ).toBeInTheDocument();
    // 回②步：逐题作答与证据主开关都已自动勾上
    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    expect(screen.getByRole("checkbox", { name: /逐题答案/ })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /手写原稿与订正图片/ }),
    ).toBeChecked();
  });

  it("F1③：buildRequest 契约 parse 抛错 → 预览错误态中文提示，重试恢复", async () => {
    // 用真实解析失败构造 ZodError（mock 只在本次注入 throw）
    const broken = learningPackExportRequestSchema.safeParse({
      goal: "diagnose-weakness",
    });
    if (broken.success) {
      throw new Error("夹具应当构造出解析失败");
    }
    vi.mocked(learningPackExportRequestSchema.parse).mockImplementationOnce(
      () => {
        throw broken.error;
      },
    );

    await pickStudentAndGoStep2();
    fireEvent.click(screen.getByRole("checkbox", { name: /作答汇总/ }));
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());

    // 组装失败不冒泡成渲染崩溃：错误态中文提示（含 ZodError 首条 issue）
    expect(await screen.findByText("预览加载失败")).toBeInTheDocument();
    expect(screen.getByText(/请求组装失败：/)).toBeInTheDocument();
    // 重试（默认实现 = 原始 parse）恢复成功
    fireEvent.click(screen.getByRole("button", { name: "重新预览" }));
    await screen.findByText("包内文件清单");
  });

  it("F9：ready 行 downloadUrl 非同源白名单 → 按缺失分支渲染（不外链外域）", async () => {
    mockedPreview.mockResolvedValueOnce({
      ...PREVIEW_OK,
      evidenceImages: [
        {
          file: "evidence/e001-original-01.png",
          ref: "e001",
          phase: "scratch",
          pageIndex: 0,
          state: "ready",
          bytes: 102_400,
          downloadUrl: "https://evil.example.com/e001.png",
        },
      ],
    });
    await goToPreview();
    await screen.findByText(/手写证据图片/);
    // 外域 URL 不进 <img>/<a>，走缺失分支（reason 缺省文案）
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(/缺失：图片未生成或丢失/)).toBeInTheDocument();
  });

  it("F10：缩略图上限 60——61 条只渲染 60 个，其余提示下载数据包查看", async () => {
    mockedPreview.mockResolvedValueOnce({
      ...PREVIEW_OK,
      evidenceImages: Array.from({ length: 61 }, (_, i) => ({
        file: `evidence/e${String(i + 1).padStart(3, "0")}-original-01.png`,
        ref: `e${String(i + 1).padStart(3, "0")}`,
        phase: "scratch" as const,
        pageIndex: 0,
        state: "ready" as const,
        bytes: 100,
        downloadUrl: `/api/teacher/note-versions/v-${i + 1}/images/img-${i + 1}.png`,
      })),
    });
    await goToPreview();
    // 标题计数仍用全长
    expect(await screen.findByText(/手写证据图片（共 61 项）/)).toBeVisible();
    expect(screen.getAllByRole("img")).toHaveLength(60);
    expect(
      screen.getByText(/其余 1 项请在下载数据包后查看/),
    ).toBeInTheDocument();
  });
});

describe("ExportWizard 隐私与预览增强（T6R.16 C/D）", () => {
  it("第④步包含手写笔迹脱敏文案提示", async () => {
    await pickStudentAndGoStep2();
    fireEvent.click(screen.getByRole("checkbox", { name: /作答汇总/ }));
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    await screen.findByText(/化名导出（默认开启）/);

    expect(
      screen.getByText(
        /化名不等于图像脱敏——手写笔迹中可能出现真实姓名，请导出前在第⑤步预览图片确认。/,
      ),
    ).toBeInTheDocument();
  });

  it("第⑤步包含不自动发送给 AI 服务的明示文案", async () => {
    await pickStudentAndGoStep2();
    fireEvent.click(screen.getByRole("checkbox", { name: /作答汇总/ }));
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    await screen.findByText("包内文件清单");

    expect(
      screen.getByText(
        "本系统不会自动把数据包发送给任何 AI 服务，需你自行交给对话客户端。",
      ),
    ).toBeInTheDocument();
  });

  it("第⑤步渲染 ready 与 missing 证据缩略图", async () => {
    mockedPreview.mockResolvedValueOnce({
      ...PREVIEW_OK,
      evidenceImages: [
        {
          file: "evidence/e001-original-01.png",
          ref: "e001",
          phase: "scratch",
          pageIndex: 0,
          state: "ready",
          bytes: 102_400,
          downloadUrl: "/api/teacher/note-versions/v1/images/img1.png",
        },
        {
          file: "evidence/e002-correction-01.png",
          ref: "e002",
          phase: "correction",
          pageIndex: 0,
          state: "missing",
          bytes: 0,
          reason: "草稿未生成分析图",
        },
      ],
    });

    await pickStudentAndGoStep2();
    fireEvent.click(screen.getByRole("checkbox", { name: /作答汇总/ }));
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());

    await screen.findByText(/手写证据图片/);
    // ready 项显示图片、懒加载、链接、尺寸
    const img = screen.getByRole("img", {
      name: "evidence/e001-original-01.png",
    });
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute(
      "src",
      "/api/teacher/note-versions/v1/images/img1.png",
    );
    expect(screen.getByText("100 KB")).toBeInTheDocument();

    // missing 项显示缺失原因且无 img
    expect(screen.getByText(/缺失：草稿未生成分析图/)).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: "evidence/e002-correction-01.png" }),
    ).not.toBeInTheDocument();

    // 阶段徽标文案引契约单源（闸门 F8：NOTE_PHASE_LABELS，勿再手写副本）
    expect(screen.getByText(NOTE_PHASE_LABELS.scratch)).toBeInTheDocument();
    expect(screen.getByText(NOTE_PHASE_LABELS.correction)).toBeInTheDocument();
  });
});

describe("ExportWizard ErrorRetry 错误重试（T6R.16 E）", () => {
  it("学生名单失败时通过 ErrorRetry 重试", async () => {
    mockedStudents.mockRejectedValueOnce(new Error("学生列表网络错误"));
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <MemoryRouter>
          <ExportWizard initialStudentId={null} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("学生列表网络错误")).toBeInTheDocument();
    mockedStudents.mockResolvedValueOnce(STUDENTS);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("陈小明");
  });

  it("讲义列表失败时通过 ErrorRetry 重试", async () => {
    mockedLectures.mockRejectedValueOnce(new Error("讲义列表网络错误"));
    await renderWizard();
    fireEvent.click(screen.getByRole("checkbox", { name: /陈小明/ }));
    fireEvent.click(nextButton());

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("讲义列表网络错误")).toBeInTheDocument();
    mockedLectures.mockResolvedValueOnce(LECTURES);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("有理数讲义");
  });

  it("讲义大纲加载失败时通过 ErrorRetry 重试", async () => {
    mockedLectureDetail.mockRejectedValueOnce(new Error("大纲解析失败"));
    await pickStudentAndGoStep2();
    fireEvent.click(
      screen.getByRole("button", { name: "展开 有理数讲义 的小节目录" }),
    );

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("大纲解析失败")).toBeInTheDocument();
    mockedLectureDetail.mockResolvedValueOnce(LECTURE_1_DETAIL);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("第一节 概念");
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AiTaskPublic, AttemptDraftData } from "@tutor/contract";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigationType,
} from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  installAnnotationBackend,
  memoryAnnotationBackend,
} from "@/features/annotation/annotation-store";
import {
  bindAnnotationSession,
  resetAnnotationSession,
} from "@/features/annotation/annotation-sync";
import {
  installNoteBackend,
  memoryNoteBackend,
} from "@/features/notes/note-store";
import { bindNoteSession, resetNoteSession } from "@/features/notes/note-sync";
import { bindAiDisplayAccount } from "@/features/student-ai/ai-display-preference-store";
import { connectedAiStatus } from "@/features/student-ai/student-ai-test-utils";
import {
  fetchAttemptApi,
  fetchPracticeQuestionFeedbackApi,
  fetchStudentAiStatusApi,
  fetchStudentAiTaskApi,
  fetchStudentNoteHeadsApi,
  fetchStudentQuickButtonsApi,
  listStudentAiTasksApi,
  openStudentAiReplyApi,
  saveAttemptAnswerApi,
  submitPracticeQuestionApi,
} from "@/lib/api";
import { installEventStore, memoryEventStore } from "@/lib/event-queue";
import StudentAttemptPage from "@/pages/student/StudentAttemptPage";
import { getAttemptRecoveryState } from "./attempt-material-recovery";
import {
  installDraftBackend,
  type KVBackend,
  memoryBackend,
} from "./draft-store";
import {
  bindPracticePreferenceAccount,
  savePracticePreference,
} from "./practice-preference-store";
import { workflowOf } from "./practice-test-fixtures";

/**
 * PracticeWorkspace 集成（M3-D1，§11 纪律 1/7）：v1 新协议卷在作答页引入
 * 列表/单题两种呈现——同一 keyed 题卡序列仅改变容器呈现，互切不重建题面
 * （DOM 节点同一性）；单题切题用 replace 更新 URL q（验证属本卷，非法忽略
 * 回退首道未提交题）；legacy 卷（无 practiceWorkflow）零变化（无摘要行、无
 * 菜单切换项）。lesson 卷不经过本页作答视图（服务端恒不下发 workflow）。
 * M4-D2（§12.1）：单题切题先收起 AI 阅读（复用收起链，返回原题见折叠入口）；
 * 旧任务定位先走统一切题入口再展开；键盘不劫持 AI 输入；AI 节点不入题面域
 * 与反馈区（底图/导出零 AI 输入）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAnnotationViewApi: vi.fn(async () => ({
      base: null,
      maxWidthPx: 1440,
      doc: null,
      annotation: null,
    })),
    fetchAttemptApi: vi.fn(),
    fetchAttemptMaterialRevisionsApi: vi.fn(async () => ({
      notes: {},
      annotations: {},
      ink: {},
    })),
    postAttemptEventsApi: vi.fn(async () => ({ accepted: 1 })),
    sealAttemptAnnotationsApi: vi.fn(async () => ({
      phase: "scratch" as const,
      sealedCount: 0,
    })),
    fetchAttemptInkApi: vi.fn(async () => null),
    putAttemptInkApi: vi.fn(async () => ({
      questionId: "",
      inkId: "",
      strokeCount: 0,
      width: 0,
      height: 0,
      updatedAt: "",
    })),
    uploadStudentAiTaskMaterialsApi: vi.fn(async () => undefined),
    createCorrectionApi: vi.fn(),
    sealCorrectionApi: vi.fn(),
    fetchStudentNotebookApi: vi.fn(),
    fetchStudentNoteHeadsApi: vi.fn(),
    submitPracticeQuestionApi: vi.fn(),
    fetchPracticeQuestionFeedbackApi: vi.fn(),
    saveAttemptAnswerApi: vi.fn(),
    fetchStudentAiStatusApi: vi.fn(async () => connectedAiStatus()),
    listStudentAiTasksApi: vi.fn(async () => ({
      tasks: [aiTask],
      nextCursor: null,
    })),
    fetchStudentQuickButtonsApi: vi.fn(async () => ({
      updatedAt: "2026-10-23T00:00:00Z",
      buttons: [],
    })),
    fetchStudentAiTaskApi: vi.fn(async () => ({
      task: aiTask,
      messages: [
        {
          id: "reply",
          taskId: aiTask.id,
          role: "assistant",
          contentMd: "先列出条件，再代入特殊值。",
          createdAt: aiTask.updatedAt,
        },
      ],
      facts: [],
    })),
    createStudentAiTaskApi: vi.fn(),
    followupStudentAiTaskApi: vi.fn(),
    openStudentAiReplyApi: vi.fn(async () => undefined),
  };
});
const mockedFetch = vi.mocked(fetchAttemptApi);

const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";
const COURSE_ID = "12121212-1212-4121-8121-121212121212";

/** AI 伴学任务夹具：q1 的已回复任务（attemptId 与本卷一致，供旧任务定位） */
const aiTask: AiTaskPublic = {
  id: "task-q1",
  attemptId: ATTEMPT_ID,
  questionId: "q1",
  questionRevisionId: "rev-q1",
  channel: "inapp",
  status: "replied",
  modeAtSend: "open_study",
  question: "为什么？",
  beforeSubmit: true,
  contextVersion: "ctx",
  snapshotAt: "2026-10-23T02:00:00Z",
  hasReply: true,
  replyDeliveredAt: "2026-10-23T02:01:00Z",
  errorText: null,
  retryCount: 0,
  allowedActions: ["followup"],
  materials: [],
  createdAt: "2026-10-23T02:00:00Z",
  updatedAt: "2026-10-23T02:01:00Z",
  archivedAt: null,
};

/** 三题课程草稿：q1 已提交（反馈可读），q2/q3 未提交；首道未提交 = q2 */
const baseDraft = (): AttemptDraftData => ({
  attempt: {
    id: ATTEMPT_ID,
    sourceType: "course",
    assignmentId: null,
    lectureId: null,
    courseId: COURSE_ID,
    unitId: "有理数小练",
    attemptNo: 1,
    status: "draft",
    startedAt: "2026-10-23T02:00:00.000Z",
    submittedAt: null,
    scoreAuto: null,
  },
  title: "有理数小练",
  courseName: "初一上",
  dueAt: null,
  units: [
    {
      id: "有理数小练",
      title: "有理数小练",
      questions: [
        {
          id: "q1",
          type: "judge",
          difficulty: 1,
          knowledge: ["有理数的概念"],
          stemMd: "$0$ 既不是正数，也不是负数。[[]]",
          hintCount: 0,
          questionRevisionId: "rev-q1",
        },
        {
          id: "q2",
          type: "fill",
          difficulty: 2,
          knowledge: ["有理数加法"],
          stemMd: "计算：$(-3)+7=$ [[]]。",
          hintCount: 0,
          questionRevisionId: "rev-q2",
        },
        {
          id: "q3",
          type: "judge",
          difficulty: 2,
          knowledge: ["有理数减法"],
          stemMd: "$5-8$ 是负数。[[]]",
          hintCount: 0,
          questionRevisionId: "rev-q3",
        },
      ],
    },
  ],
  drafts: {},
  hintsOpened: {},
  legacyUnverified: false,
  answerRelease: "on_submit",
  enabledCapabilities: ["steps", "ink"],
});

const v1Draft = (): AttemptDraftData => ({
  ...baseDraft(),
  practiceWorkflow: workflowOf(),
  questionProgress: [
    {
      questionId: "q1",
      submittedAt: "2026-10-23T02:10:00.000Z",
      feedbackReadable: true,
    },
    { questionId: "q2", submittedAt: null, feedbackReadable: false },
    { questionId: "q3", submittedAt: null, feedbackReadable: false },
  ],
});

/** 路由探针：暴露 MemoryRouter 的位置与导航动作（断言 replace 语义） */
const locationRef = {
  search: "",
  action: "POP" as "POP" | "PUSH" | "REPLACE",
};
function LocationProbe() {
  const location = useLocation();
  locationRef.search = location.search;
  locationRef.action = useNavigationType();
  return null;
}

function renderPage(search = "") {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[`/s/attempts/${ATTEMPT_ID}${search}`]}>
        <Routes>
          <Route
            path="/s/attempts/:attemptId"
            element={
              <>
                <LocationProbe />
                <StudentAttemptPage />
              </>
            }
          />
          <Route path="*" element={<p data-testid="route-stub">未匹配</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openPracticeMenu() {
  // Radix 菜单触发响应 pointerdown（jsdom 需显式指针序列，见 AttemptHeader.test）
  fireEvent.pointerDown(screen.getByRole("button", { name: "练习更多" }), {
    button: 0,
    ctrlKey: false,
  });
  await waitFor(() =>
    expect(
      screen.getByRole("menuitem", { name: "练习信息" }),
    ).toBeInTheDocument(),
  );
}

beforeEach(() => {
  localStorage.clear();
  bindPracticePreferenceAccount(null);
  bindPracticePreferenceAccount("m3d1-test");
  bindAiDisplayAccount(null);
  bindAiDisplayAccount("m4d2-ai");
  mockedFetch.mockReset();
  vi.mocked(fetchPracticeQuestionFeedbackApi).mockReset();
  vi.mocked(fetchPracticeQuestionFeedbackApi).mockResolvedValue({
    feedback: { status: "pending_attempt" },
  });
  vi.mocked(saveAttemptAnswerApi).mockReset();
  vi.mocked(saveAttemptAnswerApi).mockImplementation(
    async (_attemptId, questionId) => ({ questionId, changeCount: 1 }),
  );
  vi.mocked(fetchStudentNoteHeadsApi).mockReset();
  vi.mocked(fetchStudentNoteHeadsApi).mockImplementation(
    async (_attemptId, ids) =>
      ids.map(() => ({
        note: null,
        images: [],
        evidence: null,
        corrections: [],
        supplements: [],
      })),
  );
  vi.mocked(fetchStudentAiStatusApi).mockReset();
  vi.mocked(fetchStudentAiStatusApi).mockResolvedValue(connectedAiStatus());
  vi.mocked(listStudentAiTasksApi).mockReset();
  vi.mocked(listStudentAiTasksApi).mockImplementation(async (query) => ({
    tasks: query.questionId === aiTask.questionId ? [aiTask] : [],
    nextCursor: null,
  }));
  vi.mocked(fetchStudentAiTaskApi).mockReset();
  vi.mocked(fetchStudentAiTaskApi).mockResolvedValue({
    task: aiTask,
    messages: [
      {
        id: "reply",
        taskId: aiTask.id,
        role: "assistant",
        contentMd: "先列出条件，再代入特殊值。",
        createdAt: aiTask.updatedAt,
      },
    ],
    facts: [],
  });
  vi.mocked(fetchStudentQuickButtonsApi).mockReset();
  vi.mocked(fetchStudentQuickButtonsApi).mockResolvedValue({
    updatedAt: "2026-10-23T00:00:00Z",
    buttons: [],
  });
  vi.mocked(openStudentAiReplyApi).mockReset();
  vi.mocked(openStudentAiReplyApi).mockResolvedValue(aiTask);
});

it("v1 卷默认列表呈现：摘要行可见，三题同列渲染", async () => {
  mockedFetch.mockResolvedValue(v1Draft());
  const { container } = renderPage();
  expect(
    await screen.findByText(/做题方式：列表 · 每题提交后查看/),
  ).toBeInTheDocument();
  // 三张题卡都在 DOM（列表呈现）
  expect(container.querySelectorAll("article")).toHaveLength(3);
  expect(locationRef.search).toBe("");
});

it("legacy 卷零变化：无摘要行、更多菜单无做题方式项", async () => {
  mockedFetch.mockResolvedValue(baseDraft());
  renderPage();
  await screen.findByRole("button", { name: "交卷" });
  expect(screen.queryByText(/做题方式：/)).toBeNull();
  expect(screen.queryByRole("button", { name: /调整做题方式/ })).toBeNull();
  fireEvent.pointerDown(screen.getByRole("button", { name: "练习更多" }), {
    button: 0,
    ctrlKey: false,
  });
  await waitFor(() =>
    expect(
      screen.getByRole("menuitem", { name: "练习信息" }),
    ).toBeInTheDocument(),
  );
  expect(
    screen.queryByRole("menuitemradio", { name: /做题方式：/ }),
  ).toBeNull();
});

it("菜单切单题：仅当前题可见、其余隐藏但不卸载；进度行计数正确", async () => {
  mockedFetch.mockResolvedValue(v1Draft());
  const { container } = renderPage();
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  // 切换前抓 q2 输入节点（DOM 同一性断言用）
  const q2InputBefore = screen.getByRole("textbox", { name: "第1空" });
  await openPracticeMenu();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: /做题方式：单题/ }),
  );
  // 摘要切换为单题；进入定位首道未提交 q2（q1 已提交）
  expect(
    await screen.findByText(/做题方式：单题 · 每题提交后查看/),
  ).toBeInTheDocument();
  expect(screen.getByText("第 2 / 3 题 · 已提交 1 题")).toBeInTheDocument();
  // 非当前题隐藏且不可聚焦（display:none 离开可访问树），但 DOM 节点保留
  expect(screen.queryByRole("radio", { name: /正确|对|错|√|×/ })).toBeNull();
  expect(container.querySelectorAll("article")).toHaveLength(3);
  // q2 输入仍是同一 DOM 节点（题卡未重建，§11 纪律 1）
  expect(screen.getByRole("textbox", { name: "第1空" })).toBe(q2InputBefore);
  // URL 以 replace 写入 q（不加历史条目）
  await waitFor(() => expect(locationRef.search).toContain("q=q2"));
  expect(locationRef.action).toBe("REPLACE");
});

it("列表↔单题互切题卡不重建，切回列表恢复全部题可见", async () => {
  mockedFetch.mockResolvedValue(v1Draft());
  renderPage();
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  const q2Input = screen.getByRole("textbox", { name: "第1空" });
  await openPracticeMenu();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: /做题方式：单题/ }),
  );
  await screen.findByText(/做题方式：单题 · 每题提交后查看/);
  expect(screen.getByRole("textbox", { name: "第1空" })).toBe(q2Input);
  await openPracticeMenu();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: /做题方式：列表/ }),
  );
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  expect(screen.getByRole("textbox", { name: "第1空" })).toBe(q2Input);
  // 回列表后各题恢复可见（q3 判断题选项可再访问）
  expect(screen.getAllByRole("radio").length).toBeGreaterThanOrEqual(2);
  // 回列表清除 q
  await waitFor(() => expect(locationRef.search).toBe(""));
});

it("单题模式上一题/下一题切换题目并 replace 更新 q", async () => {
  mockedFetch.mockResolvedValue(v1Draft());
  const { container } = renderPage();
  // D2 起当前题为已提交时主操作位追加「下一题」（同在操作条容器内）；
  // 本用例只考操作条的切题钮（outline 变体）
  const bar = () => {
    const element = container.querySelector<HTMLElement>(
      '[data-slot="practice-action-bar"]',
    );
    if (element === null) throw new Error("操作条未渲染");
    return element;
  };
  const barNext = () => {
    const button = within(bar())
      .getAllByRole("button", { name: "下一题" })
      .find((item) => item.dataset.variant === "outline");
    if (button === undefined) throw new Error("操作条下一题未渲染");
    return button;
  };
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  await openPracticeMenu();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: /做题方式：单题/ }),
  );
  await screen.findByText("第 2 / 3 题 · 已提交 1 题");
  // 首题边界：q2 不是第一题，上一题到 q1
  fireEvent.click(screen.getByRole("button", { name: "上一题" }));
  await waitFor(() =>
    expect(screen.getByText("第 1 / 3 题 · 已提交 1 题")).toBeInTheDocument(),
  );
  await waitFor(() => expect(locationRef.search).toContain("q=q1"));
  expect(screen.getByRole("button", { name: "上一题" })).toBeDisabled();
  fireEvent.click(barNext());
  await waitFor(() =>
    expect(screen.getByText("第 2 / 3 题 · 已提交 1 题")).toBeInTheDocument(),
  );
  fireEvent.click(barNext());
  await waitFor(() =>
    expect(screen.getByText("第 3 / 3 题 · 已提交 1 题")).toBeInTheDocument(),
  );
  expect(barNext()).toBeDisabled();
  await waitFor(() => expect(locationRef.search).toContain("q=q3"));
});

it("偏好默认单题：进入即单题呈现，非法 q 忽略并定位首道未提交题", async () => {
  savePracticePreference({ layout: "single", keyboardShortcuts: true, feedback: null });
  mockedFetch.mockResolvedValue(v1Draft());
  renderPage("?q=not-exist");
  expect(
    await screen.findByText(/做题方式：单题 · 每题提交后查看/),
  ).toBeInTheDocument();
  expect(screen.getByText("第 2 / 3 题 · 已提交 1 题")).toBeInTheDocument();
});

it("偏好默认单题：合法 q 直达该题", async () => {
  savePracticePreference({ layout: "single", keyboardShortcuts: true, feedback: null });
  mockedFetch.mockResolvedValue(v1Draft());
  renderPage("?q=q3");
  expect(
    await screen.findByText("第 3 / 3 题 · 已提交 1 题"),
  ).toBeInTheDocument();
});

it("受限卷（老师要求交卷后公布）在摘要行显示受限文案", async () => {
  mockedFetch.mockResolvedValue({
    ...v1Draft(),
    practiceWorkflow: workflowOf({
      feedbackMode: "after_attempt",
      canChangeFeedback: false,
      allowedFeedbackModes: ["after_attempt"],
      canSubmitQuestion: false,
      restrictionReason: "teacher_after_attempt",
    }),
  });
  renderPage();
  expect(
    await screen.findByText(/做题方式：列表 · 交卷后查看/),
  ).toBeInTheDocument();
  expect(screen.getByText(/老师要求交卷后公布/)).toBeInTheDocument();
});

it("v1 卷导航区四态可见且已提交待公布行无对错泄露", async () => {
  mockedFetch.mockResolvedValue({
    ...v1Draft(),
    questionProgress: [
      {
        questionId: "q1",
        submittedAt: "2026-10-23T02:10:00.000Z",
        feedbackReadable: false,
      },
      { questionId: "q2", submittedAt: null, feedbackReadable: false },
      { questionId: "q3", submittedAt: null, feedbackReadable: false },
    ],
  });
  renderPage();
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  // 统一公布模式：q1 已提交但反馈不可读——导航只报提交事实
  const submitted = screen.getByRole("button", {
    name: "第 1 题，已提交，反馈待公布",
  });
  expect(submitted.textContent).not.toMatch(/对|错|正确|得分/);
  expect(
    screen.getByRole("button", { name: /第 2 题，未填写/ }),
  ).toBeInTheDocument();
});

// ---------- M3-D1.5：硬刷新直达作答页时绑定晚于首渲染的默认布局对齐 ----------

/** 预置账号 x 的持久化默认「单题」，随后回到未绑定（模拟硬刷新时序） */
function presetSingleAccountThenUnbind() {
  bindPracticePreferenceAccount(null);
  bindPracticePreferenceAccount("x");
  savePracticePreference({ layout: "single", keyboardShortcuts: true, feedback: null });
  bindPracticePreferenceAccount(null);
}

it("未绑定先渲染回落列表：账号绑定时按已保存单题对齐一次", async () => {
  presetSingleAccountThenUnbind();
  mockedFetch.mockResolvedValue(v1Draft());
  renderPage();
  // 布局层账号绑定 effect 晚于本组件首渲染：初始只回落列表
  expect(
    await screen.findByText(/做题方式：列表 · 每题提交后查看/),
  ).toBeInTheDocument();
  // 布局层绑定该账号：呈现按已保存默认布局切为单题（一次性对齐）
  act(() => {
    bindPracticePreferenceAccount("x");
  });
  expect(
    await screen.findByText(/做题方式：单题 · 每题提交后查看/),
  ).toBeInTheDocument();
  expect(screen.getByText("第 2 / 3 题 · 已提交 1 题")).toBeInTheDocument();
});

it("显式切换过布局后，账号绑定与跨标签变更不拉扯当前选择", async () => {
  presetSingleAccountThenUnbind();
  mockedFetch.mockResolvedValue(v1Draft());
  renderPage();
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  // 用户显式切到单题再切回列表：本次作答内自决
  await openPracticeMenu();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: /做题方式：单题/ }),
  );
  await screen.findByText(/做题方式：单题 · 每题提交后查看/);
  await openPracticeMenu();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: /做题方式：列表/ }),
  );
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  // 此刻才绑定「默认单题」账号：不得覆盖用户显式选择
  act(() => {
    bindPracticePreferenceAccount("x");
  });
  // 跨标签再改默认偏好同样不拉扯（store 订阅只对齐绑定时刻，不跟随变更）
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: `ownclass:practice-pref:${JSON.stringify([location.origin, "student", "x"])}`,
        newValue:
          '{"version":1,"layout":"single","feedback":"per_question","keyboardShortcuts":true}',
        storageArea: localStorage,
      }),
    );
  });
  expect(
    screen.getByText(/做题方式：列表 · 每题提交后查看/),
  ).toBeInTheDocument();
});

// ---------- M3-D3：单题切题本机落盘保护（§11-5） ----------

/** 可注入本机写失败的后端（只关心 set；读走内存缓存不触发 get） */
function installSwitchGuardBackend(failRef: { current: boolean }): void {
  const backend: KVBackend = {
    get: async () => undefined,
    set: async () => {
      if (failRef.current) throw new Error("配额不足");
    },
    del: async () => {},
  };
  installDraftBackend(backend);
}

it("单题切题保护：本机写失败不切题并提示，重试成功后再切题", async () => {
  const failRef = { current: false };
  installSwitchGuardBackend(failRef);
  // q1 有本机草稿：attempt 记录存在，切题前的本机落盘会真实写后端
  mockedFetch.mockResolvedValue({
    ...v1Draft(),
    drafts: { q1: { kind: "judge", value: true } },
    draftRevisions: { q1: 2 },
  });
  renderPage();
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  await openPracticeMenu();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: /做题方式：单题/ }),
  );
  await screen.findByText("第 2 / 3 题 · 已提交 1 题");
  failRef.current = true;
  fireEvent.click(screen.getByRole("button", { name: "上一题" }));
  // 不切题：仍停留 q2，就地提示与重试入口
  expect(
    await screen.findByText("本机稿未保存，仍停留本题"),
  ).toBeInTheDocument();
  expect(screen.getByText("第 2 / 3 题 · 已提交 1 题")).toBeInTheDocument();
  expect(locationRef.search).toContain("q=q2");
  // 重试成功：继续切到 q1，提示收起
  failRef.current = false;
  fireEvent.click(screen.getByRole("button", { name: "重试保存并切换" }));
  await waitFor(() =>
    expect(screen.getByText("第 1 / 3 题 · 已提交 1 题")).toBeInTheDocument(),
  );
  await waitFor(() => expect(locationRef.search).toContain("q=q1"));
  expect(screen.queryByText("本机稿未保存，仍停留本题")).toBeNull();
});

it("单题切题成功后焦点落单题工作区容器（←→ 键盘域），URL q 同步 replace", async () => {
  mockedFetch.mockResolvedValue(v1Draft());
  renderPage();
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  await openPracticeMenu();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: /做题方式：单题/ }),
  );
  await screen.findByText("第 2 / 3 题 · 已提交 1 题");
  fireEvent.click(screen.getByRole("button", { name: "下一题" }));
  await waitFor(() =>
    expect(screen.getByText("第 3 / 3 题 · 已提交 1 题")).toBeInTheDocument(),
  );
  await waitFor(() => {
    const container = document.querySelector<HTMLElement>(
      '[data-slot="practice-single-workspace"]',
    );
    expect(document.activeElement).toBe(container);
  });
  await waitFor(() => expect(locationRef.search).toContain("q=q3"));
});

it("保存详情定位在单题模式走统一切题入口：更新单题态与 URL（闸门修复）", async () => {
  mockedFetch.mockResolvedValue(v1Draft());
  renderPage();
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  await openPracticeMenu();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: /做题方式：单题/ }),
  );
  await screen.findByText("第 2 / 3 题 · 已提交 1 题");
  // q2 作答产生本机保存行；切到 q3 再作答，制造可回跳的保存详情行
  fireEvent.change(screen.getByRole("textbox", { name: "第1空" }), {
    target: { value: "4" },
  });
  fireEvent.click(screen.getByRole("button", { name: "下一题" }));
  await screen.findByText("第 3 / 3 题 · 已提交 1 题");
  fireEvent.click(screen.getByRole("radio", { name: "对" }));
  await openPracticeMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "练习信息" }));
  fireEvent.click(await screen.findByRole("button", { name: "保存详情" }));
  // 从保存详情回跳 q2：单题态与 URL 必须随切（直连 jumpToQuestion 时对隐藏卡无效）
  fireEvent.click(await screen.findByRole("button", { name: "定位第 2 题" }));
  await screen.findByText("第 2 / 3 题 · 已提交 1 题");
  await waitFor(() => expect(locationRef.search).toContain("q=q2"));
  expect(locationRef.action).toBe("REPLACE");
});

// ---------- M4-D2：单题专注 × AI 伴学整合（§12.1） ----------

/** rail 实效状态（data-ai-state）：closed/inline/side/dock/dialog——隐藏面板
 * 不进可访问树，role 查询区分不了「开着但随卡隐藏」的幽灵面板，用属性判 */
const railState = () =>
  document
    .querySelector('[data-slot="ai-companion-rail"]')
    ?.getAttribute("data-ai-state") ?? "missing";

/** 单题操作条按钮（上一题/下一题 outline 切题钮所在容器） */
function barButton(name: string): HTMLElement {
  const bar = document.querySelector<HTMLElement>(
    '[data-slot="practice-action-bar"]',
  );
  if (bar === null) throw new Error("单题操作条未渲染");
  return within(bar).getByRole("button", { name });
}

/** 就绪材料会话：AI 打开的 ready 闸门要求材料恢复成功（空盘点=即刻就绪） */
function installMaterialSessions() {
  resetNoteSession();
  resetAnnotationSession();
  installNoteBackend(memoryNoteBackend());
  installAnnotationBackend(memoryAnnotationBackend());
  const session = { origin: "https://page.test", studentId: "m4d2-ai" };
  bindNoteSession(session);
  bindAnnotationSession(session);
  installEventStore(memoryEventStore());
}

/** 进入单题模式并打开当前题的 AI 助教（label=当前题显示名） */
async function openSingleWithAi(entry = "", label = "第 2 题") {
  savePracticePreference({ layout: "single", keyboardShortcuts: true, feedback: null });
  installDraftBackend(memoryBackend());
  installMaterialSessions();
  mockedFetch.mockResolvedValue(v1Draft());
  renderPage(entry);
  await screen.findByText(/做题方式：单题 · 每题提交后查看/);
  // ready 闸门：等材料恢复状态真实就绪后再单次点击（重复点击会切绑/收起）
  await waitFor(() =>
    expect(getAttemptRecoveryState(ATTEMPT_ID).state).toBe("ready"),
  );
  fireEvent.click(screen.getByRole("button", { name: "AI 助教" }));
  await screen.findByRole("region", { name: `${label}的 AI 助教` });
}

afterEach(() => {
  resetNoteSession();
  resetAnnotationSession();
});

it("单题切题先收起 AI 阅读：切换后 rail 关闭，返回原题见折叠入口", async () => {
  await openSingleWithAi();
  expect(railState()).toBe("inline");
  // 操作条「下一题」切题（统一切题入口）：AI 阅读先收起，再切换
  fireEvent.click(barButton("下一题"));
  await screen.findByText("第 3 / 3 题 · 已提交 1 题");
  await waitFor(() => expect(railState()).toBe("closed"));
  await waitFor(() => expect(locationRef.search).toContain("q=q3"));
  // 返回 q2：面板不自动重开，折叠入口保留（阅读锚点语义）
  fireEvent.click(screen.getByRole("button", { name: "上一题" }));
  await screen.findByText("第 2 / 3 题 · 已提交 1 题");
  expect(screen.getByRole("button", { name: "再看回复" })).toBeInTheDocument();
  expect(railState()).toBe("closed");
  // 「再看回复」原位重开同一题的阅读
  fireEvent.click(screen.getByRole("button", { name: "再看回复" }));
  await screen.findByRole("region", { name: "第 2 题的 AI 助教" });
  expect(railState()).toBe("inline");
});

it("单题模式旧任务定位先统一切题再展开回复，URL 消费 ai 参数", async () => {
  // 深链停在 q2，任务属于 q1：必须先经统一切题入口（收笔/落盘/AI 收起
  // 保护同链）切到 q1，再展开 q1 的回复；失败保留现场不切题
  savePracticePreference({ layout: "single", keyboardShortcuts: true, feedback: null });
  installDraftBackend(memoryBackend());
  installMaterialSessions();
  mockedFetch.mockResolvedValue(v1Draft());
  renderPage("?q=q2&aiTask=task-q1&aiQuestion=q1");
  await screen.findByText("第 1 / 3 题 · 已提交 1 题");
  expect(
    await screen.findByRole("region", { name: "第 1 题的 AI 助教" }),
  ).toBeInTheDocument();
  await screen.findByText("先列出条件，再代入特殊值。");
  await waitFor(() => expect(locationRef.search).toContain("q=q1"));
  await waitFor(() => expect(locationRef.search).not.toContain("aiTask"));
});

it("AI 输入聚焦时键盘不劫持：Enter/←→/数字保持输入语义", async () => {
  // q1 换成未提交的单选题，便于断言数字键不误触选项
  savePracticePreference({ layout: "single", keyboardShortcuts: true, feedback: null });
  installDraftBackend(memoryBackend());
  installMaterialSessions();
  mockedFetch.mockResolvedValue({
    ...v1Draft(),
    units: [
      {
        id: "有理数小练",
        title: "有理数小练",
        questions: [
          {
            id: "q1",
            type: "choice",
            difficulty: 2,
            knowledge: ["有理数乘法"],
            stemMd: "下列说法正确的是：",
            options: ["甲", "乙", "丙"],
            hintCount: 0,
            questionRevisionId: "rev-q1",
          },
          {
            id: "q2",
            type: "fill",
            difficulty: 2,
            knowledge: ["有理数加法"],
            stemMd: "计算：$(-3)+7=$ [[]]。",
            hintCount: 0,
            questionRevisionId: "rev-q2",
          },
          {
            id: "q3",
            type: "judge",
            difficulty: 2,
            knowledge: ["有理数减法"],
            stemMd: "$5-8$ 是负数。[[]]",
            hintCount: 0,
            questionRevisionId: "rev-q3",
          },
        ],
      },
    ],
    questionProgress: [
      { questionId: "q1", submittedAt: null, feedbackReadable: false },
      { questionId: "q2", submittedAt: null, feedbackReadable: false },
      { questionId: "q3", submittedAt: null, feedbackReadable: false },
    ],
  });
  renderPage("?q=q1");
  await screen.findByText("第 1 / 3 题 · 已提交 0 题");
  // ready 闸门：等材料恢复真实就绪后再单次点击（重复点击会切绑/收起）
  await waitFor(() =>
    expect(getAttemptRecoveryState(ATTEMPT_ID).state).toBe("ready"),
  );
  fireEvent.click(screen.getByRole("button", { name: "AI 助教" }));
  // 有历史回复时输入位是追问框：点「这一步没懂」展开追问输入。role 轮询
  // 查询用 queryAllByRole 手动等待：getBy/findBy 未命中时的错误转储会枚举
  // 全文档角色，踩中 jsdom 对 KaTeX MathML 节点的 computed-style 缺口
  const followupButton = await waitFor(() => {
    const entry = screen.queryAllByRole("button", { name: "这一步没懂" }).at(0);
    expect(entry).toBeDefined();
    return entry as HTMLElement;
  });
  fireEvent.click(followupButton);
  const input = await waitFor(() => {
    const box = screen
      .queryAllByRole("textbox", { name: "继续追问本题" })
      .at(0);
    expect(box).toBeDefined();
    return box as HTMLElement;
  });
  input.focus();
  fireEvent.change(input, { target: { value: "我还在写问题" } });
  input.focus();
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(input, { key: "ArrowRight" });
  fireEvent.keyDown(input, { key: "1" });
  // Enter 不提交本题、方向键不切题、数字不误触选项、输入原样保留
  expect(vi.mocked(submitPracticeQuestionApi)).not.toHaveBeenCalled();
  expect(screen.getByText("第 1 / 3 题 · 已提交 0 题")).toBeInTheDocument();
  // 选项可访问名非裸文本（含序号前缀），用正则匹配；精确名未命中同样会
  // 触发 prettyRoles 转储崩溃
  expect(screen.getByRole("radio", { name: /甲/ })).not.toBeChecked();
  expect(input).toHaveValue("我还在写问题");
});

it("AI 节点不进题面域与反馈区（底图与导出零 AI 输入）", async () => {
  // q1 已提交且反馈可读：反馈区与题面域同时在场，AI 面板开启状态下断言零交叉
  await openSingleWithAi("?q=q1", "第 1 题");
  const regionLabel = "第 1 题的 AI 助教";
  expect(
    await screen.findByRole("region", { name: regionLabel }),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(
      document.querySelector('[data-slot="practice-question-feedback"]'),
    ).not.toBeNull(),
  );
  expect(
    document.querySelectorAll('[data-slot="question-surface"]').length,
  ).toBeGreaterThan(0);
  const aiSelectors =
    '[data-ai-question], [data-slot="ai-companion-panel"], [data-slot="ai-companion-rail"]';
  for (const surface of Array.from(
    document.querySelectorAll('[data-slot="question-surface"]'),
  )) {
    expect(surface.querySelector(aiSelectors)).toBeNull();
  }
  for (const section of Array.from(
    document.querySelectorAll('[data-slot="practice-question-feedback"]'),
  )) {
    expect(section.querySelector(aiSelectors)).toBeNull();
  }
  for (const article of Array.from(document.querySelectorAll("article"))) {
    expect(article.querySelector(aiSelectors)).toBeNull();
  }
  // 全文档只有一份 AI 面板，且位于所有题卡之外（inline 随 li 兄弟位）
  expect(
    document.querySelectorAll('[data-slot="ai-companion-panel"]'),
  ).toHaveLength(1);
});

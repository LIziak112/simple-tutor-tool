import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  AttemptQuestionPublic,
  AttemptResultQuestion,
  AttemptScoreSummary,
  LessonStartData,
} from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { draftStore } from "@/features/attempt/draft-store";
import { connectedAiStatus } from "@/features/student-ai/student-ai-test-utils";
import {
  createStudentAiTaskApi,
  fetchStudentAiStatusApi,
  fetchStudentNoteHeadsApi,
  fetchStudentQuickButtonsApi,
  listStudentAiTasksApi,
  restartLessonAttemptApi,
  startLessonAttemptApi,
  submitLessonQuestionApi,
} from "@/lib/api";
import StudentLessonPage from "./StudentLessonPage";

/**
 * 讲练页 AI 伴学接入（SAI-22 四来源矩阵的讲练列）：作答页头部「AI 助教」
 * 入口、打开绑定当前作答题（初始为首个未提交题、作答交互跟随最近题）、
 * 材料面收窄（讲练题卡无圈画层——只呈纸面勾选）、当题提交后绑定当题复盘
 * 发送（题级完成裁决在服务端，本层只验证请求按 attempt+question 定位）、
 * 未完成邻题遇「完成后可用」模式的拦截呈现、再做一次（restart）后新卷
 * 伴学查询不串旧卷 attemptId。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    startLessonAttemptApi: vi.fn(),
    restartLessonAttemptApi: vi.fn(),
    submitLessonQuestionApi: vi.fn(),
    fetchStudentNoteHeadsApi: vi.fn(),
    fetchStudentAiStatusApi: vi.fn(),
    createStudentAiTaskApi: vi.fn(),
    listStudentAiTasksApi: vi.fn(),
    uploadStudentAiTaskMaterialsApi: vi.fn(),
    fetchStudentQuickButtonsApi: vi.fn(),
  };
});

const mockedStart = vi.mocked(startLessonAttemptApi);
const mockedRestart = vi.mocked(restartLessonAttemptApi);
const mockedSubmitQuestion = vi.mocked(submitLessonQuestionApi);
const mockedNoteHeads = vi.mocked(fetchStudentNoteHeadsApi);
const mockedStatus = vi.mocked(fetchStudentAiStatusApi);
const mockedCreate = vi.mocked(createStudentAiTaskApi);
const mockedList = vi.mocked(listStudentAiTasksApi);
const mockedQuickButtons = vi.mocked(fetchStudentQuickButtonsApi);

const LECTURE_ID = "44444444-4444-4444-8444-444444444444";
const COURSE_ID = "12121212-1212-4121-8121-121212121212";
const ATTEMPT_ID = "66666666-6666-4666-8666-666666666666";
const ATTEMPT_ID_2 = "77777777-7777-4777-8777-777777777777";

const Q1: AttemptQuestionPublic = {
  id: "lesson-q1",
  type: "choice",
  difficulty: 2,
  knowledge: ["有理数"],
  stemMd: "下列各数中，正数是（）",
  options: ["$+7$", "$-3.5$", "$0$"],
  hintCount: 0,
  questionRevisionId: "rev-q1",
};
const Q2: AttemptQuestionPublic = {
  id: "lesson-q2",
  type: "judge",
  difficulty: 1,
  knowledge: ["有理数"],
  stemMd: "$0$ 既不是正数，也不是负数。[[]]",
  hintCount: 0,
  questionRevisionId: "rev-q2",
};

const DRAFT_SUMMARY: AttemptScoreSummary = {
  total: 2,
  answered: 0,
  correct: 0,
  wrong: 0,
  pending: 0,
  unanswered: 2,
  autoGradable: 0,
  scoreFinal: null,
  pendingCount: 0,
};

function attemptOf(
  attemptId: string,
  status: "draft" | "submitted" | "graded",
  attemptNo = 1,
): LessonStartData["attempt"] {
  return {
    id: attemptId,
    sourceType: "lesson",
    assignmentId: null,
    lectureId: LECTURE_ID,
    courseId: COURSE_ID,
    unitId: "有理数讲练单元",
    attemptNo,
    status,
    startedAt: "2026-10-16T02:00:00.000Z",
    submittedAt: status === "draft" ? null : "2026-10-16T03:00:00.000Z",
    scoreAuto: status === "draft" ? null : 50,
  };
}

function lessonStart(overrides?: {
  attemptId?: string;
  released?: Record<string, AttemptResultQuestion>;
  status?: "draft" | "submitted" | "graded";
  attemptNo?: number;
}): LessonStartData {
  return {
    lecture: {
      id: LECTURE_ID,
      title: "第1讲 有理数·讲练",
      topic: "有理数",
      courseId: COURSE_ID,
      courseName: "初一上",
    },
    blocks: [
      { type: "md", md: "# 第1讲 有理数·讲练\n\n## 一、正数与负数" },
      { type: "question", questionId: Q1.id },
      { type: "md", md: "## 二、练一练" },
      { type: "question", questionId: Q2.id },
    ],
    attempt: attemptOf(
      overrides?.attemptId ?? ATTEMPT_ID,
      overrides?.status ?? "draft",
      overrides?.attemptNo ?? 1,
    ),
    questions: [Q1, Q2],
    drafts: {},
    hintsOpened: {},
    released: overrides?.released ?? {},
    summary:
      overrides?.status === "draft"
        ? DRAFT_SUMMARY
        : { ...DRAFT_SUMMARY, answered: 2 },
    enabledCapabilities: ["steps", "ink"],
  };
}

function releasedOf(question: AttemptQuestionPublic): AttemptResultQuestion {
  return {
    questionId: question.id,
    snapshot: {
      id: question.id,
      type: question.type,
      difficulty: question.difficulty,
      knowledge: question.knowledge,
      stemMd: question.stemMd,
      ...(question.options !== undefined ? { options: question.options } : {}),
      hintCount: question.hintCount,
    },
    answers: question.type === "choice" ? { kind: "choice", index: 0 } : null,
    solutionMd: "解析内容。",
    answer: null,
    autoCorrect: true,
    teacherMark: null,
    teacherComment: null,
    finalCorrect: true,
    hintsOpened: [],
  };
}

const NONE_HEAD = {
  note: null,
  images: [],
  evidence: null,
  corrections: [],
  supplements: [],
};

function renderPage(
  path = `/s/lectures/${LECTURE_ID}/lesson/run?courseId=${COURSE_ID}`,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/s/lectures/:id/lesson/run"
            element={<StudentLessonPage />}
          />
          <Route
            path="/s/lectures/:id/lesson"
            element={<p data-testid="landing-stub">落地页</p>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 打开 AI 助教并等待面板出现 */
async function openCompanion() {
  fireEvent.click(screen.getByRole("button", { name: "AI 助教" }));
  await screen.findByRole("dialog");
}

beforeEach(async () => {
  vi.clearAllMocks();
  // 本文件有点作答交互：清跨测试残留的本机稿（draftStore 模块级单例），
  // 避免上一例的稿让下一例的单题提交走「草稿未保存完整」弹层
  await draftStore.clearDraft(ATTEMPT_ID);
  await draftStore.clearDraft(ATTEMPT_ID_2);
  mockedStart.mockReset();
  mockedRestart.mockReset();
  mockedSubmitQuestion.mockReset();
  mockedNoteHeads
    .mockReset()
    .mockImplementation(
      async (_attemptId: string, questionIds: readonly string[]) =>
        questionIds.map(() => NONE_HEAD),
    );
  mockedStatus.mockReset().mockResolvedValue(connectedAiStatus());
  mockedList.mockReset().mockResolvedValue({ tasks: [], nextCursor: null });
  mockedQuickButtons.mockReset().mockResolvedValue({
    buttons: [],
    updatedAt: "2026-10-16T00:00:00.000Z",
  });
  mockedCreate.mockReset().mockResolvedValue({
    id: "task-1",
    attemptId: ATTEMPT_ID,
    questionId: Q1.id,
    questionRevisionId: "rev-q1",
    channel: "inapp",
    status: "created",
    modeAtSend: "open_study",
    question: "这道题为什么是这样？",
    beforeSubmit: false,
    contextVersion: "ctx",
    snapshotAt: "2026-10-16T00:00:00.000Z",
    hasReply: false,
    replyDeliveredAt: null,
    errorText: null,
    retryCount: 0,
    allowedActions: [],
    materials: [],
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
    archivedAt: null,
  });
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("1024"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
  Element.prototype.scrollIntoView = vi.fn();
});

describe("讲练页 AI 伴学（SAI-22 四来源接入）", () => {
  it("作答页头部「AI 助教」入口：打开绑定首个未提交题，材料只呈纸面（无圈画勾选）", async () => {
    mockedStart.mockResolvedValue(lessonStart());
    renderPage();
    await screen.findByText("第 1 题");
    await openCompanion();
    // 绑定当前作答题（首个未提交 = 第 1 题）——状态查询按 attempt+question 定位
    await waitFor(() =>
      expect(mockedStatus).toHaveBeenCalledWith(ATTEMPT_ID, "lesson-q1"),
    );
    expect(
      await screen.findByText("第 1 题", { selector: "p" }),
    ).toBeInTheDocument();
    // 讲练题卡无圈画层：随信材料组只呈纸面勾选，无「圈画」选项
    const materialGroup = screen.getByRole("group", { name: "随信材料" });
    expect(
      materialGroup.querySelector('input[type="checkbox"]'),
    ).not.toBeNull();
    expect(within(materialGroup).queryByText("圈画")).toBeNull();
  });

  it("作答交互跟随最近作答题：在第 2 题作答后打开绑定第 2 题", async () => {
    mockedStart.mockResolvedValue(lessonStart());
    const { container } = renderPage();
    await screen.findByText("第 1 题");
    // 在第 2 题（judge）作答：直接按 DOM 点它的单选控件（绕开 jsdom 的
    // accessible-name 样式计算崩溃；本页只有第 2 题渲染单选）
    const radios = container.querySelectorAll('input[type="radio"]');
    expect(radios.length).toBeGreaterThan(0);
    const target = radios[radios.length - 1];
    if (target === undefined) throw new Error("测试前置失败：无单选控件");
    fireEvent.click(target);
    await openCompanion();
    await waitFor(() =>
      expect(mockedStatus).toHaveBeenCalledWith(ATTEMPT_ID, "lesson-q2"),
    );
  });

  it("当题提交即当题复盘：单题提交成功后绑定当题发送创建任务（题级完成裁决在服务端）", async () => {
    mockedStart.mockResolvedValue(lessonStart());
    mockedSubmitQuestion.mockResolvedValue({
      question: releasedOf(Q1),
      summary: { ...DRAFT_SUMMARY, answered: 1 },
      attempt: attemptOf(ATTEMPT_ID, "draft"),
    });
    renderPage();
    await screen.findByText("第 1 题");
    // 第 1 题显示答案（单题提交，当题释放；同页多张题卡取第一张的按钮）
    const [submitButton] = screen.getAllByRole("button", { name: "显示答案" });
    if (submitButton === undefined)
      throw new Error("测试前置失败：无显示答案按钮");
    fireEvent.click(submitButton);
    expect(await screen.findByText("答对")).toBeInTheDocument();
    // 打开伴学：绑定保持当题（第 1 题——提交动作不移动当前作答题）
    await openCompanion();
    await waitFor(() =>
      expect(mockedStatus).toHaveBeenCalledWith(ATTEMPT_ID, "lesson-q1"),
    );
    // 发送：任务按 attempt+question 创建（题级 completed 由服务端裁决）
    const textarea = await screen.findByPlaceholderText("写下你想问的问题");
    fireEvent.change(textarea, { target: { value: "这题的解析没看懂" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    expect(mockedCreate.mock.calls[0]?.[0]).toMatchObject({
      attemptId: ATTEMPT_ID,
      questionId: "lesson-q1",
      question: "这题的解析没看懂",
    });
  });

  it("未完成题遇「完成后可用」模式：发送被拦截并呈现原因（不创建任务）", async () => {
    mockedStart.mockResolvedValue(lessonStart());
    mockedStatus.mockResolvedValue(
      connectedAiStatus({
        resolution: {
          usable: false,
          reason: "student_closed",
        },
      }),
    );
    renderPage();
    await screen.findByText("第 1 题");
    await openCompanion();
    await waitFor(() =>
      expect(mockedStatus).toHaveBeenCalledWith(ATTEMPT_ID, "lesson-q1"),
    );
    const textarea = await screen.findByPlaceholderText("写下你想问的问题");
    fireEvent.change(textarea, { target: { value: "帮我看看这题" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    // 状态区与发送失败提示共用单源文案（studentModeReasonText）——至少呈现
    await waitFor(() =>
      expect(
        screen.getAllByText(/当前模式为完成后可用/).length,
      ).toBeGreaterThan(0),
    );
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("再做一次（restart）：新卷伴学查询按新 attemptId 定位，不串旧卷", async () => {
    // 旧卷已完成；restart 返回新卷（attemptNo 2、新 attemptId）；start 在
    // restart 失效缓存后的重取返回同一份新卷投影
    mockedStart
      .mockResolvedValueOnce(lessonStart({ status: "submitted", attemptNo: 1 }))
      .mockResolvedValue(
        lessonStart({ attemptId: ATTEMPT_ID_2, attemptNo: 2 }),
      );
    mockedRestart.mockResolvedValue(
      lessonStart({ attemptId: ATTEMPT_ID_2, attemptNo: 2 }),
    );
    renderPage();
    expect(
      await screen.findByRole("button", { name: "再做一次" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "再做一次" }));
    fireEvent.click(screen.getByRole("button", { name: "开始新一轮" }));
    // 新卷作答页就绪后打开伴学：入口只在作答视图（等它出现即新卷已渲染）
    const trigger = await screen.findByRole(
      "button",
      { name: "AI 助教" },
      { timeout: 3000 },
    );
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    await waitFor(() =>
      expect(mockedStatus).toHaveBeenCalledWith(ATTEMPT_ID_2, "lesson-q1"),
    );
    expect(
      mockedStatus.mock.calls.some(([attemptId]) => attemptId === ATTEMPT_ID),
    ).toBe(false);
  });
});

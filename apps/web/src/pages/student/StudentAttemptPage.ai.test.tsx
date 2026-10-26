import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AttemptDraftData } from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installAnnotationBackend,
  memoryAnnotationBackend,
} from "@/features/annotation/annotation-store";
import {
  bindAnnotationSession,
  resetAnnotationSession,
} from "@/features/annotation/annotation-sync";
import {
  installDraftBackend,
  memoryBackend,
} from "@/features/attempt/draft-store";
import {
  installNoteBackend,
  memoryNoteBackend,
} from "@/features/notes/note-store";
import { bindNoteSession, resetNoteSession } from "@/features/notes/note-sync";
import { connectedAiStatus } from "@/features/student-ai/student-ai-test-utils";
import {
  createStudentAiTaskApi,
  fetchAttemptApi,
  fetchStudentAiStatusApi,
  fetchStudentQuickButtonsApi,
  listStudentAiTasksApi,
} from "@/lib/api";
import { installEventStore, memoryEventStore } from "@/lib/event-queue";
import StudentAttemptPage from "./StudentAttemptPage";

// 重 UI 流程文件（平均用例 >3.5s）：本机常驻负载会让墙钟在安静窗口间漂移 ±40%，
// 5s 默认超时随机击中本文件任意用例——统一 15s（仍保留挂死检测，真卡死 3 倍即报）。
vi.setConfig({ testTimeout: 15_000 });

/**
 * 四来源 AI 伴学参数化矩阵（SAI-22 完成条件①——集成用例，不只组件 mock）：
 * /s/attempts/:attemptId 通用作答页按 sourceType 参数化（assignment/course/
 * wrong；lesson 作答页与结果页另有专测），断言真实路由装配下「AI 助教」
 * 入口、打开绑定当前题、状态查询按当前卷定位；三教学模式（open_study/
 * guided_only 可用呈现与发送、post_submit_only 未完成拦截）；错题重练
 * 新卷不继承历史完成或回信权限（status/tasks 只查新卷 attemptId）。
 * 服务端的模式裁决与题级完成口径见 teaching-policy-service 测试，本文件
 * 只锁页面集成面。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAttemptApi: vi.fn(),
    fetchAnnotationViewApi: vi.fn(async () => ({
      base: null,
      maxWidthPx: 1440,
      doc: null,
      annotation: null,
    })),
    fetchAttemptMaterialRevisionsApi: vi.fn(async () => ({
      notes: {},
      annotations: {},
      ink: {},
    })),
    fetchStudentNoteHeadsApi: vi.fn(
      async (_attemptId: string, questionIds: readonly string[]) =>
        questionIds.map(() => ({
          note: null,
          images: [],
          evidence: null,
          corrections: [],
          supplements: [],
        })),
    ),
    sealAttemptAnnotationsApi: vi.fn(async () => ({
      phase: "scratch" as const,
      sealedCount: 0,
    })),
    fetchAttemptInkApi: vi.fn(async () => null),
    putAttemptInkApi: vi.fn(),
    postAttemptEventsApi: vi.fn(async () => ({ accepted: 1 })),
    fetchStudentAiStatusApi: vi.fn(),
    createStudentAiTaskApi: vi.fn(),
    listStudentAiTasksApi: vi.fn(),
    uploadStudentAiTaskMaterialsApi: vi.fn(),
    fetchStudentQuickButtonsApi: vi.fn(),
  };
});

const mockedFetch = vi.mocked(fetchAttemptApi);
const mockedStatus = vi.mocked(fetchStudentAiStatusApi);
const mockedCreate = vi.mocked(createStudentAiTaskApi);
const mockedList = vi.mocked(listStudentAiTasksApi);
const mockedQuickButtons = vi.mocked(fetchStudentQuickButtonsApi);

const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";
const OLD_ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";
const COURSE_ID = "12121212-1212-4121-8121-121212121212";

/** 三来源参数（lesson 在讲练作答页/结果页专测，不在此列） */
const SOURCES = [
  {
    key: "assignment",
    attempt: {
      sourceType: "assignment" as const,
      assignmentId: "33333333-3333-4333-8333-333333333333",
      lectureId: null,
      courseId: null,
      unitId: null,
    },
    title: "周末加练",
  },
  {
    key: "course",
    attempt: {
      sourceType: "course" as const,
      assignmentId: null,
      lectureId: null,
      courseId: COURSE_ID,
      unitId: "有理数小练",
    },
    title: "有理数小练",
  },
  {
    key: "wrong",
    attempt: {
      sourceType: "wrong" as const,
      assignmentId: null,
      lectureId: null,
      courseId: null,
      unitId: null,
    },
    title: "错题重练",
  },
] as const;

function draftOf(source: (typeof SOURCES)[number]): AttemptDraftData {
  return {
    attempt: {
      id: ATTEMPT_ID,
      ...source.attempt,
      attemptNo: 1,
      status: "draft",
      startedAt: "2026-10-16T02:00:00.000Z",
      submittedAt: null,
      scoreAuto: null,
    },
    title: source.title,
    courseName: null,
    dueAt: null,
    units: [
      {
        id: "练习四",
        title: "练习四",
        questions: [
          {
            id: "练习四-1",
            type: "judge",
            difficulty: 1,
            knowledge: ["有理数的概念"],
            stemMd: "$0$ 既不是正数，也不是负数。[[]]",
            hintCount: 0,
            questionRevisionId: "rev-练习四-1",
          },
        ],
      },
    ],
    drafts: {},
    hintsOpened: {},
    legacyUnverified: false,
    answerRelease: "on_submit",
    enabledCapabilities: ["steps", "ink"],
  };
}

function renderPage(attemptId = ATTEMPT_ID) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/s/attempts/${attemptId}`]}>
        <Routes>
          <Route
            path="/s/attempts/:attemptId"
            element={<StudentAttemptPage />}
          />
          <Route path="/s/home" element={<p data-testid="home-stub">首页</p>} />
          <Route
            path="/s/wrong"
            element={<p data-testid="wrong-stub">错题本</p>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** jsdom 无布局：矩形桩 + 滚动触发阅读定位（rAF 异步，显式等一拍） */
let rectSpy: ReturnType<typeof vi.spyOn> | null = null;
async function readyAndScroll() {
  await screen.findByRole("button", { name: "交卷" });
  rectSpy = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({
      top: 100,
      bottom: 300,
      left: 0,
      right: 400,
      width: 400,
      height: 200,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect);
  fireEvent.scroll(window);
  await new Promise((resolve) => setTimeout(resolve, 60));
}

beforeEach(() => {
  resetNoteSession();
  resetAnnotationSession();
  installNoteBackend(memoryNoteBackend());
  installAnnotationBackend(memoryAnnotationBackend());
  const session = { origin: "https://page.test", studentId: "student-ai" };
  bindNoteSession(session);
  bindAnnotationSession(session);
  installDraftBackend(memoryBackend());
  installEventStore(memoryEventStore());
  vi.clearAllMocks();
  mockedFetch.mockReset();
  mockedStatus.mockReset().mockResolvedValue(connectedAiStatus());
  mockedList.mockReset().mockResolvedValue({ tasks: [], nextCursor: null });
  mockedQuickButtons.mockReset().mockResolvedValue({
    buttons: [],
    updatedAt: "2026-10-16T00:00:00.000Z",
  });
  mockedCreate.mockReset().mockResolvedValue({
    id: "task-1",
    attemptId: ATTEMPT_ID,
    questionId: "练习四-1",
    questionRevisionId: "rev-练习四-1",
    channel: "inapp",
    status: "created",
    modeAtSend: "open_study",
    question: "这道题怎么想？",
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
});
afterEach(() => {
  rectSpy?.mockRestore();
  rectSpy = null;
  resetNoteSession();
  resetAnnotationSession();
});

/** 通道/模式收在「AI 设置」抽屉后，状态文案断言前先展开 */
const openAiSettings = () => {
  fireEvent.click(screen.getByRole("button", { name: "AI 设置" }));
};

describe("四来源 AI 伴学参数化矩阵（SAI-22 完成条件①）", () => {
  it.each(SOURCES.map((s) => [s.key, s] as const))(
    "来源 %s：作答页「AI 助教」入口打开绑定当前题，状态查询按当前卷定位",
    async (_key, source) => {
      mockedFetch.mockResolvedValue(draftOf(source));
      renderPage();
      await readyAndScroll();
      fireEvent.click(screen.getByRole("button", { name: "AI 助教" }));
      const panel = await screen.findByRole("region", { name: /的 AI 助教/ });
      // 绑定当前题（滚动定位首题）——status 按 attempt+question 定位
      await waitFor(() =>
        expect(mockedStatus).toHaveBeenCalledWith(ATTEMPT_ID, "练习四-1"),
      );
      // 题号在面板头；模式在「AI 设置」抽屉里
      expect(await within(panel).findByText("第 1 题")).toBeInTheDocument();
      openAiSettings();
      expect(await screen.findByText("当前：开放伴学")).toBeInTheDocument();
    },
  );

  it("两题共存时关闭第一题助教仍返回第一题入口", async () => {
    const draft = draftOf(SOURCES[0]);
    const first = draft.units[0]?.questions[0];
    if (!first || !draft.units[0]) throw new Error("缺少测试题目");
    draft.units[0].questions.push({ ...first, id: "练习四-2" });
    mockedFetch.mockResolvedValue(draft);
    renderPage();
    await readyAndScroll();
    const firstTrigger = within(
      screen.getByRole("article", { name: "第 1 题" }),
    ).getByRole("button", { name: "AI 助教" });
    fireEvent.click(firstTrigger);
    const close = await screen.findByRole("button", { name: "收起 AI 助教" });
    fireEvent.click(close);
    await waitFor(() => expect(firstTrigger).toHaveFocus());
  });

  it("尚未滚动定位时，题卡 AI 入口直接绑定本题并查询状态", async () => {
    mockedFetch.mockResolvedValue(draftOf(SOURCES[0]));
    renderPage();
    await screen.findByRole("button", { name: "交卷" });
    // 未打开时不查状态；题卡入口已经知道题目，无需等待滚动定位。
    expect(mockedStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "AI 助教" }));
    await screen.findByRole("region", { name: /的 AI 助教/ });
    await waitFor(() =>
      expect(mockedStatus).toHaveBeenCalledWith(ATTEMPT_ID, "练习四-1"),
    );
    // 后续滚动继续保持点击时绑定的题目。
    rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        top: 100,
        bottom: 300,
        left: 0,
        right: 400,
        width: 400,
        height: 200,
        x: 0,
        y: 100,
        toJSON: () => ({}),
      } as DOMRect);
    fireEvent.scroll(window);
    await waitFor(() =>
      expect(mockedStatus).toHaveBeenCalledWith(ATTEMPT_ID, "练习四-1"),
    );
    expect(
      await within(
        await screen.findByRole("region", { name: /的 AI 助教/ }),
      ).findByText("第 1 题"),
    ).toBeInTheDocument();
  });

  it.each([
    ["open_study", "开放伴学"],
    ["guided_only", "仅启发"],
  ] as const)(
    "模式 %s（未完成可用）：状态区呈现模式名，发送创建任务",
    async (mode, label) => {
      mockedFetch.mockResolvedValue(draftOf(SOURCES[0]));
      mockedStatus.mockResolvedValue(
        connectedAiStatus({
          resolution: { usable: true, mode, reason: "teacher_default" },
        }),
      );
      renderPage();
      await readyAndScroll();
      fireEvent.click(screen.getByRole("button", { name: "AI 助教" }));
      await screen.findByRole("region", { name: /的 AI 助教/ });
      await waitFor(() =>
        expect(mockedStatus).toHaveBeenCalledWith(ATTEMPT_ID, "练习四-1"),
      );
      openAiSettings();
      expect(await screen.findByText(`当前：${label}`)).toBeInTheDocument();
      // 发送（无材料勾选）→ 任务按 attempt+question 创建
      const textarea = await screen.findByPlaceholderText(
        "补充卡住的地方（可不填）",
      );
      fireEvent.change(textarea, { target: { value: "这道题的思路是什么" } });
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
      await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
      expect(mockedCreate.mock.calls[0]?.[0]).toMatchObject({
        attemptId: ATTEMPT_ID,
        questionId: "练习四-1",
        question: "这道题的思路是什么",
      });
    },
  );

  it("模式 post_submit_only（未完成）：发送被拦截并呈现原因，不创建任务", async () => {
    mockedFetch.mockResolvedValue(draftOf(SOURCES[0]));
    mockedStatus.mockResolvedValue(
      connectedAiStatus({
        resolution: { usable: false, reason: "teacher_default_closed" },
      }),
    );
    renderPage();
    await readyAndScroll();
    fireEvent.click(screen.getByRole("button", { name: "AI 助教" }));
    await screen.findByRole("region", { name: /的 AI 助教/ });
    await waitFor(() =>
      expect(mockedStatus).toHaveBeenCalledWith(ATTEMPT_ID, "练习四-1"),
    );
    const textarea = await screen.findByPlaceholderText(
      "补充卡住的地方（可不填）",
    );
    fireEvent.change(textarea, { target: { value: "帮我看看" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(
        screen.getAllByText(/当前模式为完成后可用/).length,
      ).toBeGreaterThan(0),
    );
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("错题重练新卷：不继承旧卷完成态或回信——status/tasks 只查新卷 attemptId", async () => {
    const draft = draftOf(SOURCES[2]);
    mockedFetch.mockResolvedValue({
      ...draft,
      attempt: { ...draft.attempt, attemptNo: 2 },
    });
    renderPage();
    await readyAndScroll();
    fireEvent.click(screen.getByRole("button", { name: "AI 助教" }));
    await screen.findByRole("region", { name: /的 AI 助教/ });
    await waitFor(() =>
      expect(mockedStatus).toHaveBeenCalledWith(ATTEMPT_ID, "练习四-1"),
    );
    await waitFor(() =>
      expect(mockedList).toHaveBeenCalledWith({
        attemptId: ATTEMPT_ID,
        questionId: "练习四-1",
      }),
    );
    // 未完成作答态呈现（新卷从 blank 开始——服务端按新 attempt 裁决）
    openAiSettings();
    expect(await screen.findByText("当前：开放伴学")).toBeInTheDocument();
    // 任何查询都不携带旧卷 attemptId（回信与完成态不跨卷）
    expect(mockedStatus.mock.calls.some(([id]) => id === OLD_ATTEMPT_ID)).toBe(
      false,
    );
    expect(
      mockedList.mock.calls.some(
        (call) => call[0].attemptId === OLD_ATTEMPT_ID,
      ),
    ).toBe(false);
  });

  it("题下助教随页面滚动，不因题面离屏卸载阅读与输入区", async () => {
    mockedFetch.mockResolvedValue(draftOf(SOURCES[0]));
    renderPage();
    await readyAndScroll();
    fireEvent.click(screen.getByRole("button", { name: "AI 助教" }));
    await screen.findByRole("region", { name: /的 AI 助教/ });
    // 面板开合/滚动锚定会让题卡离开视口并触发 scroll；没有滚轮或触摸
    // 意图时不得据此隐藏面板（否则面板与布局互相触发，无限闪动）。
    rectSpy?.mockReturnValue({
      top: 5000,
      bottom: 5200,
      left: 0,
      right: 400,
      width: 400,
      height: 200,
      x: 0,
      y: 5000,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.scroll(window);
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(
      screen.getByRole("region", { name: /的 AI 助教/ }),
    ).toBeInTheDocument();
    // 题下正文可能比题面更长，题面离屏也不能把正在读的正文卸载。
    fireEvent.wheel(window, { deltaY: 600 });
    fireEvent.scroll(window);
    expect(
      screen.getByRole("region", { name: /的 AI 助教/ }),
    ).toBeInTheDocument();
    // 滚回题卡（重新可见）→ 面板恢复（等过裁决后的抑制窗口）
    await new Promise((resolve) => setTimeout(resolve, 450));
    rectSpy?.mockReturnValue({
      top: 100,
      bottom: 300,
      left: 0,
      right: 400,
      width: 400,
      height: 200,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.wheel(window, { deltaY: -600 });
    fireEvent.scroll(window);
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: /的 AI 助教/ }),
      ).toBeInTheDocument(),
    );
  });
});

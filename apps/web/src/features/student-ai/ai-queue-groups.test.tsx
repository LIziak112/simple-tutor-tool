import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  AiAttemptOriginSummary,
  AiAttemptReviewTaskPublic,
  AiTaskBatchOrigin,
  AiTaskOriginSummary,
  AiTaskPublic,
} from "@tutor/contract";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchStudentAiAttemptReviewDetailApi,
  fetchStudentAiQueueSummaryApi,
  listStudentAiQueueApi,
  postStudentAiAttemptReviewActionApi,
} from "@/lib/api";
import { attemptOriginLineOf } from "./AiQueueItem";
import { AiQueuePanel } from "./AiQueuePanel";
import { aiQueueEntriesOf, batchProgressTextOf } from "./ai-queue-groups";
import { listStudentAiAttemptReviewQueueApi } from "./attempt-review-queue-api";

/**
 * 「求助记录」的任务呈现：整卷复盘 / 批量复盘错题 / 单题求助三类一眼分清；
 * 同一次批量复盘的逐题任务合成一张批次卡（来源 + 逐题进度）；整卷任务进
 * 列表并能打开报告。浏览与展开只读——不取报告正文、不记已读。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentAiQueueSummaryApi: vi.fn(),
    listStudentAiQueueApi: vi.fn(),
    fetchStudentAiAttemptReviewDetailApi: vi.fn(),
    postStudentAiAttemptReviewActionApi: vi.fn(),
  };
});
vi.mock("./attempt-review-queue-api", () => ({
  listStudentAiAttemptReviewQueueApi: vi.fn(),
}));

const mockedSummary = vi.mocked(fetchStudentAiQueueSummaryApi);
const mockedList = vi.mocked(listStudentAiQueueApi);
const mockedReviewQueue = vi.mocked(listStudentAiAttemptReviewQueueApi);
const mockedReviewDetail = vi.mocked(fetchStudentAiAttemptReviewDetailApi);
const mockedReviewAction = vi.mocked(postStudentAiAttemptReviewActionApi);

const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";
const REVIEW_TASK_ID = "22222222-2222-4222-8222-222222222222";

const ATTEMPT_ORIGIN: AiAttemptOriginSummary = {
  sourceType: "lesson",
  attemptNo: 2,
  title: "二次函数讲练",
  unitTitle: null,
  assignmentId: null,
  courseId: "12121212-1212-4121-8121-121212121212",
  unitId: null,
  lectureId: "13131313-1313-4131-8131-131313131313",
  attemptStatus: "submitted",
};

const BATCH: AiTaskBatchOrigin = {
  id: "batch-0001",
  taskCount: 6,
  createdAt: "2026-11-12T17:09:19.000Z",
};

function queueTask(over: Partial<AiTaskPublic> = {}): AiTaskPublic {
  return {
    id: "task-single",
    attemptId: ATTEMPT_ID,
    questionId: "q-single",
    questionRevisionId: "rev-1",
    channel: "mcp",
    status: "created",
    modeAtSend: "open_study",
    question: "请帮我复盘这些错题",
    beforeSubmit: false,
    contextVersion: "ctx-1",
    snapshotAt: "2026-11-12T17:09:19.000Z",
    hasReply: false,
    replyDeliveredAt: null,
    errorText: null,
    retryCount: 0,
    archivedAt: null,
    allowedActions: ["cancel"],
    materials: [],
    createdAt: "2026-11-12T17:09:19.000Z",
    updatedAt: "2026-11-12T17:09:19.000Z",
    ...over,
  };
}

const originOf = (
  questionNo: number,
  batch: AiTaskBatchOrigin | null,
): AiTaskOriginSummary => ({ ...ATTEMPT_ORIGIN, questionNo, batch });

/** 线上案例：同一次批量复盘为第 1、8、11、14、19、23 题各建一条任务 */
const BATCH_QUESTION_NOS = [1, 8, 11, 14, 19, 23];
const batchTasks = BATCH_QUESTION_NOS.map((no) =>
  queueTask({ id: `task-b${no}`, questionId: `q-${no}` }),
);
const batchOrigins = Object.fromEntries(
  BATCH_QUESTION_NOS.map((no) => [`task-b${no}`, originOf(no, BATCH)] as const),
);

const reviewTask = (
  over: Partial<AiAttemptReviewTaskPublic> = {},
): AiAttemptReviewTaskPublic => ({
  id: REVIEW_TASK_ID,
  attemptId: ATTEMPT_ID,
  status: "replied",
  purpose: "复盘",
  questionCount: 27,
  counts: {
    total: 27,
    correctCount: 20,
    incorrectCount: 6,
    unansweredCount: 1,
    pendingCount: 0,
    unknownAnswerCount: 0,
    hasAnswerCount: 26,
    missingAnswerCount: 1,
    gradedCount: 26,
    accuracyAmongGraded: 20 / 26,
  },
  snapshotVersion: "v",
  generation: 1,
  retryCount: 0,
  errorText: null,
  hasResult: true,
  openedAt: null,
  archivedAt: null,
  allowedActions: ["open", "archive"],
  createdAt: "2026-11-12T17:11:55.000Z",
  updatedAt: "2026-11-12T17:20:00.000Z",
  ...over,
});

function LocationProbe() {
  const location = useLocation();
  return (
    <p data-testid="location">
      {location.pathname}
      {location.search}
    </p>
  );
}

function renderPanel(
  initialEntry = "/s/records",
  props: import("./AiQueuePanel").AiQueueNavigationProps = {},
) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/s/records" element={<AiQueuePanel {...props} />} />
          <Route
            path="/s/attempts/:id"
            element={
              <>
                <LocationProbe />
                <AiQueuePanel {...props} />
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
  mockedSummary.mockResolvedValue({
    pendingCount: 6,
    processingCount: 0,
    unreadReplyCount: 1,
  });
  mockedList.mockResolvedValue({ tasks: [], nextCursor: null });
  mockedReviewQueue.mockResolvedValue({ tasks: [], nextCursor: null });
});

describe("求助记录分组模型", () => {
  it("同批次任务合成一组并保留列表次序；单题求助各自成条", () => {
    const single = queueTask({ id: "task-single", questionId: "q-single" });
    const entries = aiQueueEntriesOf(
      [batchTasks[0], single, ...batchTasks.slice(1)].filter(
        (task): task is AiTaskPublic => task !== undefined,
      ),
      (taskId) =>
        taskId === "task-single" ? originOf(5, null) : batchOrigins[taskId],
    );
    expect(entries.map((entry) => entry.kind)).toEqual(["batch", "single"]);
    const [batch] = entries;
    if (batch?.kind !== "batch") throw new Error("首项应为批次");
    expect(batch.batch).toEqual(BATCH);
    // 组内按题号排
    expect(batch.items.map((item) => item.origin.questionNo)).toEqual(
      BATCH_QUESTION_NOS,
    );
  });

  it("缺来源摘要的任务按单题呈现，不猜批次", () => {
    const entries = aiQueueEntriesOf([queueTask()], () => undefined);
    expect(entries).toEqual([
      { kind: "single", task: queueTask(), origin: undefined },
    ]);
  });

  it("批次进度按状态汇总，只列出现过的状态", () => {
    expect(batchProgressTextOf(batchTasks)).toBe("待领取 6");
    expect(
      batchProgressTextOf([
        queueTask({ status: "replied" }),
        queueTask({ status: "replied" }),
        queueTask({ status: "claimed" }),
        queueTask({ status: "created" }),
      ]),
    ).toBe("已回复 2 · 处理中 1 · 待领取 1");
  });
});

describe("来源一行", () => {
  it("讲练 / 作业：卷名 · 来源 · 第几次", () => {
    expect(attemptOriginLineOf(ATTEMPT_ORIGIN)).toBe(
      "二次函数讲练 · 讲练 · 第 2 次",
    );
  });

  it("课程练习：先写单元名（结果页的卷名）再写课程名，分得清同一门课的多份练习", () => {
    expect(
      attemptOriginLineOf({
        ...ATTEMPT_ORIGIN,
        sourceType: "course",
        title: "初二数学",
        unitTitle: "有理数小练",
        lectureId: null,
        attemptNo: 3,
      }),
    ).toBe("有理数小练 · 初二数学 · 课程练习 · 第 3 次");
  });

  it("错题重练没有卷名：只写来源与第几次", () => {
    expect(
      attemptOriginLineOf({
        ...ATTEMPT_ORIGIN,
        sourceType: "wrong",
        title: null,
        lectureId: null,
      }),
    ).toBe("错题重练 · 第 2 次");
  });
});

describe("求助记录：批次卡", () => {
  it("六条逐题任务呈现为一张批次卡：来源、不是整卷复盘的说明、进度与逐题状态", async () => {
    mockedList.mockResolvedValue({
      tasks: batchTasks,
      nextCursor: null,
      origins: batchOrigins,
    });
    renderPanel();
    const list = await screen.findByRole("list", { name: "助教任务列表" });
    // 一张卡，不是六行
    expect(within(list).getAllByTestId("ai-queue-batch")).toHaveLength(1);
    const card = within(list).getByTestId("ai-queue-batch");
    expect(within(card).getByText("批量复盘错题")).toBeInTheDocument();
    expect(within(card).getByText(/6 题/)).toBeInTheDocument();
    expect(
      within(card).getByText(/二次函数讲练 · 讲练 · 第 2 次/),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(
        "同一次批量复盘创建，每题一条独立任务，不是整卷复盘。",
      ),
    ).toBeInTheDocument();
    expect(within(card).getByText("待领取 6")).toBeInTheDocument();
    for (const no of BATCH_QUESTION_NOS) {
      expect(
        within(card).getByRole("button", {
          name: `第 ${no} 题：待领取，回到本题`,
        }),
      ).toBeInTheDocument();
    }
    // 逐题操作默认收起，展开后才出现每题的取消等动作
    expect(within(card).queryByRole("button", { name: "取消" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "展开逐题操作" }));
    expect(within(card).getAllByRole("button", { name: "取消" })).toHaveLength(
      6,
    );
  });

  it("点批次里的题号：回到那次作答的那道题，携带来源位置", async () => {
    mockedList.mockResolvedValue({
      tasks: batchTasks,
      nextCursor: null,
      origins: batchOrigins,
    });
    renderPanel("/s/records?tab=ai");
    fireEvent.click(
      await screen.findByRole("button", {
        name: "第 8 题：待领取，回到本题",
      }),
    );
    expect((await screen.findByTestId("location")).textContent).toBe(
      `/s/attempts/${ATTEMPT_ID}?aiFrom=${encodeURIComponent("/s/records?tab=ai")}&aiQuestion=q-8`,
    );
  });

  it("本页只载入了批次的一部分：如实写明本批总数与当前显示数", async () => {
    mockedList.mockResolvedValue({
      tasks: batchTasks.slice(0, 4),
      nextCursor: null,
      origins: batchOrigins,
    });
    renderPanel();
    const card = await screen.findByTestId("ai-queue-batch");
    expect(
      within(card).getByText(/本批共 6 题，当前显示 4 题/),
    ).toBeInTheDocument();
  });

  it("单题求助仍是单行卡并带类型标签", async () => {
    mockedList.mockResolvedValue({
      tasks: [queueTask({ question: "这一步为什么？" })],
      nextCursor: null,
      origins: { "task-single": originOf(5, null) },
    });
    renderPanel();
    const list = await screen.findByRole("list", { name: "助教任务列表" });
    expect(within(list).queryByTestId("ai-queue-batch")).toBeNull();
    expect(within(list).getByText("单题求助")).toBeInTheDocument();
    expect(within(list).getByText(/第 5 题/)).toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: "回到本题" }),
    ).toBeInTheDocument();
  });
});

describe("求助记录：整卷复盘", () => {
  it("整卷任务出现在列表里：类型、状态、卷名与轮次、覆盖题数；浏览不取正文不记已读", async () => {
    mockedList.mockResolvedValue({
      tasks: batchTasks,
      nextCursor: null,
      origins: batchOrigins,
    });
    mockedReviewQueue.mockResolvedValue({
      tasks: [reviewTask()],
      nextCursor: null,
      origins: { [REVIEW_TASK_ID]: ATTEMPT_ORIGIN },
    });
    renderPanel();
    const section = await screen.findByRole("list", {
      name: "整卷复盘任务列表",
    });
    expect(within(section).getAllByRole("listitem")).toHaveLength(1);
    expect(within(section).getByText("整卷复盘")).toBeInTheDocument();
    expect(within(section).getByText("报告已出 · 未读")).toBeInTheDocument();
    expect(
      within(section).getByText(/二次函数讲练 · 讲练 · 第 2 次 · 覆盖 27 题/),
    ).toBeInTheDocument();
    // 两类任务分段呈现，互不混在一个列表里
    expect(
      within(screen.getByRole("list", { name: "助教任务列表" })).getAllByTestId(
        "ai-queue-batch",
      ),
    ).toHaveLength(1);
    expect(mockedReviewDetail).not.toHaveBeenCalled();
    expect(mockedReviewAction).not.toHaveBeenCalled();
    expect(mockedReviewQueue).toHaveBeenCalledWith("exclude");
  });

  it("从别的页面点「查看整卷复盘报告」：去那次作答的结果页打开这份报告，并带回程", async () => {
    mockedReviewQueue.mockResolvedValue({
      tasks: [reviewTask({ attemptId: OTHER_ATTEMPT_ID })],
      nextCursor: null,
      origins: { [REVIEW_TASK_ID]: ATTEMPT_ORIGIN },
    });
    renderPanel("/s/records?tab=ai");
    fireEvent.click(
      await screen.findByRole("button", { name: "查看整卷复盘报告" }),
    );
    expect((await screen.findByTestId("location")).textContent).toBe(
      `/s/attempts/${OTHER_ATTEMPT_ID}?aiReview=${REVIEW_TASK_ID}&aiFrom=${encodeURIComponent("/s/records?tab=ai")}`,
    );
    expect(mockedReviewAction).not.toHaveBeenCalled();
  });

  it("已在这次作答的结果页：原地打开，保留当前位置参数，不改写回程；后退先关报告、仍在结果页", async () => {
    mockedReviewQueue.mockResolvedValue({
      tasks: [reviewTask()],
      nextCursor: null,
      origins: { [REVIEW_TASK_ID]: ATTEMPT_ORIGIN },
    });
    const onNavigated = vi.fn();
    const resultLocation = `/s/attempts/${ATTEMPT_ID}?reviewQuestion=q-8&returnTo=%2Fs%2Frecords`;
    function BrowserBack() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => void navigate(-1)}>
          浏览器后退
        </button>
      );
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter
          initialEntries={["/s/records", resultLocation]}
          initialIndex={1}
        >
          <Routes>
            <Route path="/s/records" element={<LocationProbe />} />
            <Route
              path="/s/attempts/:id"
              element={
                <>
                  <LocationProbe />
                  <BrowserBack />
                  <AiQueuePanel
                    currentAttemptId={ATTEMPT_ID}
                    onNavigated={onNavigated}
                  />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "查看整卷复盘报告" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        `${resultLocation}&aiReview=${REVIEW_TASK_ID}`,
      ),
    );
    expect(onNavigated).toHaveBeenCalledTimes(1);
    // 和顶栏入口一样是「页内打开」：新增一条历史，后退一步回到没有报告的结果页
    fireEvent.click(screen.getByRole("button", { name: "浏览器后退" }));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(resultLocation),
    );
  });

  it("等待领取的整卷任务：按钮是「查看进度」，打开的是面板而不是报告", async () => {
    mockedReviewQueue.mockResolvedValue({
      tasks: [
        reviewTask({
          status: "created",
          hasResult: false,
          allowedActions: ["cancel"],
        }),
      ],
      nextCursor: null,
      origins: { [REVIEW_TASK_ID]: ATTEMPT_ORIGIN },
    });
    renderPanel();
    expect(await screen.findByText("等待领取")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看进度" }));
    expect((await screen.findByTestId("location")).textContent).toBe(
      `/s/attempts/${ATTEMPT_ID}?aiReview=panel&aiFrom=${encodeURIComponent("/s/records")}`,
    );
  });

  it("「本次练习」范围只留本次作答的整卷任务；已归档分组按 only 取数", async () => {
    mockedReviewQueue.mockResolvedValue({
      tasks: [
        reviewTask(),
        reviewTask({ id: "other-review", attemptId: OTHER_ATTEMPT_ID }),
      ],
      nextCursor: null,
      origins: {
        [REVIEW_TASK_ID]: ATTEMPT_ORIGIN,
        "other-review": { ...ATTEMPT_ORIGIN, title: "另一份卷" },
      },
    });
    renderPanel("/s/records", { currentAttemptId: ATTEMPT_ID });
    const section = await screen.findByRole("list", {
      name: "整卷复盘任务列表",
    });
    expect(within(section).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByText(/另一份卷/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "全部来源" }));
    expect(
      within(
        screen.getByRole("list", { name: "整卷复盘任务列表" }),
      ).getAllByRole("listitem"),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole("tab", { name: "已归档" }));
    await waitFor(() => expect(mockedReviewQueue).toHaveBeenCalledWith("only"));
  });
});

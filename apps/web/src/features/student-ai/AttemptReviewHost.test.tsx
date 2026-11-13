import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  AiAttemptReviewDetailData,
  AiAttemptReviewPreviewData,
  AiAttemptReviewTaskPublic,
} from "@tutor/contract";
import {
  type InitialEntry,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStudentAiAttemptReviewApi,
  createStudentAiBatchReviewApi,
  fetchStudentAiAttemptReviewPreviewApi,
  listStudentAiAttemptReviewsApi,
  postStudentAiAttemptReviewActionApi,
} from "@/lib/api";
import { AttemptReviewHost } from "./AttemptReviewHost";
import { AttemptReviewTopBarEntry } from "./AttemptReviewTopBarEntry";
import { fetchStudentAiAttemptReviewDetailApi } from "./attempt-review-api";
import { attemptReviewListKey } from "./attempt-review-entry";
import {
  ATTEMPT_REVIEW_LAYER_STATE,
  useAttemptReviewOverlay,
} from "./attempt-review-overlay";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    listStudentAiAttemptReviewsApi: vi.fn(),
    fetchStudentAiAttemptReviewPreviewApi: vi.fn(),
    postStudentAiAttemptReviewActionApi: vi.fn(),
    createStudentAiAttemptReviewApi: vi.fn(),
    createStudentAiBatchReviewApi: vi.fn(),
  };
});
vi.mock("./attempt-review-api", () => ({
  fetchStudentAiAttemptReviewDetailApi: vi.fn(),
}));

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const RESULT_PATH = `/s/attempts/${ATTEMPT_ID}`;
const mockedList = vi.mocked(listStudentAiAttemptReviewsApi);
const mockedPreview = vi.mocked(fetchStudentAiAttemptReviewPreviewApi);
const mockedDetail = vi.mocked(fetchStudentAiAttemptReviewDetailApi);
const mockedAction = vi.mocked(postStudentAiAttemptReviewActionApi);
const mockedCreate = vi.mocked(createStudentAiAttemptReviewApi);
const mockedBatchCreate = vi.mocked(createStudentAiBatchReviewApi);

const taskOf = (
  overrides: Partial<AiAttemptReviewTaskPublic> = {},
): AiAttemptReviewTaskPublic => ({
  id: TASK_ID,
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
  ...overrides,
});

const PREVIEW: AiAttemptReviewPreviewData = {
  attemptId: ATTEMPT_ID,
  questionCount: 27,
  counts: taskOf().counts,
  fieldNotes: [],
  notes: [],
  opaquePreviewVersion: "pv-1",
  readyAt: "2026-11-12T17:00:00.000Z",
};

const DETAIL: AiAttemptReviewDetailData = {
  task: taskOf(),
  questionIds: Array.from({ length: 27 }, (_, index) => `q-${index + 1}`),
  result: {
    schemaVersion: 1,
    overview: "整体基础扎实。",
    knowledgeFindings: [
      {
        statement: "函数图像平移不稳",
        evidenceQuestionNos: [8],
        basis: "platform_fact",
        confidence: "high",
      },
    ],
    errorPatterns: [],
    performanceNotes: [],
    trainingPlan: [],
    limitations: [],
  },
};

const onJumpToQuestion = vi.fn();

function Harness() {
  const overlay = useAttemptReviewOverlay();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{location.search}</output>
      {/* 代替浏览器的后退 / 前进（手机系统返回手势就是后退） */}
      <button type="button" onClick={() => void navigate(-1)}>
        浏览器后退
      </button>
      <button type="button" onClick={() => void navigate(1)}>
        浏览器前进
      </button>
      <button
        type="button"
        onClick={() => {
          overlay.open(TASK_ID);
          overlay.open(TASK_ID);
        }}
      >
        连续打开两次
      </button>
      <button
        type="button"
        onClick={() => {
          overlay.close();
          overlay.close();
        }}
      >
        连续关闭两次
      </button>
      <AttemptReviewTopBarEntry
        attemptId={ATTEMPT_ID}
        released
        onOpen={overlay.open}
      />
      <AttemptReviewHost
        attemptId={ATTEMPT_ID}
        released
        attemptLabel="期中模拟卷 · 第 2 次"
        overlay={overlay}
        onJumpToQuestion={onJumpToQuestion}
      />
    </>
  );
}

/** 历史记录从来源页起：来源页在下，结果页（当前）在上 */
function renderWith(
  entries: InitialEntry[],
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Routes>
          <Route path="/s/home" element={<p>来源页</p>} />
          <Route path="/s/attempts/:id" element={<Harness />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const renderAt = (search: string, client?: QueryClient) =>
  renderWith(["/s/home", `${RESULT_PATH}${search}`], client);

const searchNow = () => screen.getByTestId("location").textContent;
// 弹层打开时页面其余部分对读屏隐藏，按隐藏元素查
const browserBack = () =>
  fireEvent.click(
    screen.getByRole("button", { name: "浏览器后退", hidden: true }),
  );
const browserForward = () =>
  fireEvent.click(
    screen.getByRole("button", { name: "浏览器前进", hidden: true }),
  );
const openFromTopBar = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "整卷复盘" }));
  expect(await screen.findByText("整体基础扎实。")).toBeInTheDocument();
};

beforeEach(() => {
  for (const mock of [
    mockedList,
    mockedPreview,
    mockedDetail,
    mockedAction,
    mockedCreate,
    mockedBatchCreate,
    onJumpToQuestion,
  ])
    mock.mockReset();
  mockedAction.mockResolvedValue(taskOf({ openedAt: "2026-11-12T18:00:00Z" }));
});

describe("整卷复盘承载：地址驱动", () => {
  it("带 aiReview=<任务 id> 进入：直接打开这份报告；关闭后去掉参数、保留其余位置", async () => {
    mockedList.mockResolvedValue({ tasks: [taskOf()], nextCursor: null });
    mockedDetail.mockResolvedValue(DETAIL);
    renderAt(`?reviewQuestion=q-3&aiReview=${TASK_ID}&aiFrom=%2Fs%2Fhome`);
    expect(await screen.findByText("整体基础扎实。")).toBeInTheDocument();
    expect(mockedDetail).toHaveBeenCalledWith(TASK_ID, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "关闭，回到作答结果" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(searchNow()).toBe("?reviewQuestion=q-3&aiFrom=%2Fs%2Fhome");
  });

  it("地址参数不是任务 id（如带路径片段的伪造链接）：不打开任何东西、不发请求", async () => {
    mockedList.mockResolvedValue({ tasks: [taskOf()], nextCursor: null });
    renderAt(`?aiReview=${encodeURIComponent("../../settings?x=")}`);
    // 顶栏入口照常（列表已返回），但没有弹层，也没有按伪造 id 取详情 / 记已读
    expect(
      await screen.findByRole("button", { name: "整卷复盘" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockedDetail).not.toHaveBeenCalled();
    expect(mockedAction).not.toHaveBeenCalled();
  });

  it("顶栏「整卷复盘」与地址进入打开的是同一份报告", async () => {
    mockedList.mockResolvedValue({ tasks: [taskOf()], nextCursor: null });
    mockedDetail.mockResolvedValue(DETAIL);
    renderAt("");
    fireEvent.click(await screen.findByRole("button", { name: "整卷复盘" }));
    expect(searchNow()).toBe(`?aiReview=${TASK_ID}`);
    expect(await screen.findByText("整体基础扎实。")).toBeInTheDocument();
  });

  it("看进度只读：打开面板不取报告正文、不记已读；从面板可转去看报告", async () => {
    mockedList.mockResolvedValue({ tasks: [taskOf()], nextCursor: null });
    mockedPreview.mockResolvedValue(PREVIEW);
    mockedDetail.mockResolvedValue(DETAIL);
    renderAt("?aiReview=panel");
    const panel = await screen.findByRole("dialog", { name: "整卷复盘" });
    expect(panel).toBeInTheDocument();
    const openReport = await screen.findAllByRole("button", {
      name: /查看整卷复盘报告/,
    });
    expect(mockedDetail).not.toHaveBeenCalled();
    expect(mockedAction).not.toHaveBeenCalled();
    // 只会查到面板内的按钮：顶栏入口此刻被弹层遮住，不在可访问树里
    expect(openReport).toHaveLength(1);
    const inPanel = openReport[0];
    if (inPanel === undefined) throw new Error("面板内缺少查看报告按钮");
    fireEvent.click(inPanel);
    expect(searchNow()).toBe(`?aiReview=${TASK_ID}`);
    expect(await screen.findByText("整体基础扎实。")).toBeInTheDocument();
    await waitFor(() =>
      expect(mockedAction).toHaveBeenCalledWith(TASK_ID, "open"),
    );
  });

  it("进度面板保持打开时，共用列表刷新后显示已出报告", async () => {
    mockedList.mockResolvedValue({
      tasks: [taskOf({ status: "created", hasResult: false })],
      nextCursor: null,
    });
    mockedPreview.mockResolvedValue(PREVIEW);
    const client = new QueryClient();
    renderAt("?aiReview=panel", client);
    const panel = await screen.findByRole("dialog", { name: "整卷复盘" });
    expect(await within(panel).findByText("等待领取")).toBeInTheDocument();

    mockedList.mockResolvedValue({ tasks: [taskOf()], nextCursor: null });
    await act(async () => {
      await client.refetchQueries({
        queryKey: attemptReviewListKey(ATTEMPT_ID),
      });
    });
    expect(
      await within(panel).findByRole("button", { name: "查看整卷复盘报告" }),
    ).toBeInTheDocument();
    expect(mockedDetail).not.toHaveBeenCalled();
    expect(mockedAction).not.toHaveBeenCalled();
  });

  it("首次发起：确认后只发 1 次整卷任务创建请求，不创建任何逐题任务", async () => {
    mockedList.mockResolvedValue({ tasks: [], nextCursor: null });
    mockedPreview.mockResolvedValue(PREVIEW);
    mockedCreate.mockResolvedValue({
      task: taskOf({ status: "created", hasResult: false }),
      created: true,
    });
    renderAt("");
    fireEvent.click(await screen.findByRole("button", { name: "整卷复盘" }));
    expect(searchNow()).toBe("?aiReview=panel");
    expect(
      await screen.findByText(/确认后只创建 1 条整卷任务/),
    ).toBeInTheDocument();
    mockedList.mockResolvedValue({
      tasks: [taskOf({ status: "created", hasResult: false })],
      nextCursor: null,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "确认发起整卷复盘（27 题）" }),
    );
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: ATTEMPT_ID,
        channel: "mcp",
        expectedPreviewVersion: "pv-1",
      }),
    );
    expect(mockedBatchCreate).not.toHaveBeenCalled();
    // 顶栏入口保持原位，面板内显示最新进度。
    expect(
      await screen.findByRole("list", { name: "整卷复盘任务" }),
    ).toHaveTextContent("等待领取");
  });

  it("点证据题号：先关报告再定位到那道题", async () => {
    mockedList.mockResolvedValue({ tasks: [taskOf()], nextCursor: null });
    mockedDetail.mockResolvedValue(DETAIL);
    renderAt(`?aiReview=${TASK_ID}`);
    fireEvent.click(await screen.findByRole("button", { name: "第 8 题" }));
    await waitFor(() => expect(onJumpToQuestion).toHaveBeenCalledWith("q-8"));
    expect(searchNow()).toBe("");
    expect(screen.queryByText("整体基础扎实。")).toBeNull();
    expect(onJumpToQuestion).toHaveBeenCalledTimes(1);
  });
});

describe("整卷复盘承载：浏览器后退 / 手机返回手势先关浮层", () => {
  beforeEach(() => {
    mockedList.mockResolvedValue({ tasks: [taskOf()], nextCursor: null });
    mockedPreview.mockResolvedValue(PREVIEW);
    mockedDetail.mockResolvedValue(DETAIL);
  });

  it("在结果页内打开：后退关闭报告、留在结果页原位置；再后退才离开", async () => {
    renderAt("?reviewQuestion=q-3");
    await openFromTopBar();
    expect(searchNow()).toBe(`?reviewQuestion=q-3&aiReview=${TASK_ID}`);
    browserBack();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(searchNow()).toBe("?reviewQuestion=q-3");
    browserBack();
    expect(await screen.findByText("来源页")).toBeInTheDocument();
  });

  it("在结果页内打开后用关闭按钮或 Esc 关：和后退是同一步，不留脏历史", async () => {
    renderAt("?reviewQuestion=q-3");
    await openFromTopBar();
    fireEvent.click(screen.getByRole("button", { name: "关闭，回到作答结果" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(searchNow()).toBe("?reviewQuestion=q-3");
    // 再开一次，这回按 Esc
    await openFromTopBar();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(searchNow()).toBe("?reviewQuestion=q-3");
    // 历史里没有多出来的记录：后退一步就离开结果页，不会又弹出报告，
    // 也不用多按一次
    browserBack();
    expect(await screen.findByText("来源页")).toBeInTheDocument();
  });

  it("带参数直接落地：后退按浏览器原样回来源页，不拦截", async () => {
    renderAt(`?aiReview=${TASK_ID}&aiFrom=%2Fs%2Fhome`);
    expect(await screen.findByText("整体基础扎实。")).toBeInTheDocument();
    browserBack();
    expect(await screen.findByText("来源页")).toBeInTheDocument();
  });

  it("带参数直接落地：关闭只去掉参数、留在结果页；之后后退仍回来源页", async () => {
    renderAt(`?aiReview=${TASK_ID}&aiFrom=%2Fs%2Fhome`);
    expect(await screen.findByText("整体基础扎实。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭，回到作答结果" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(searchNow()).toBe("?aiFrom=%2Fs%2Fhome");
    // 落地后再从顶栏打开，就是页内打开：后退先关报告
    await openFromTopBar();
    browserBack();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(searchNow()).toBe("?aiFrom=%2Fs%2Fhome");
    browserBack();
    expect(await screen.findByText("来源页")).toBeInTheDocument();
  });

  it("面板与报告是同一层：互相切换不新增历史，后退直接回结果页而不是回面板", async () => {
    renderAt("");
    await openFromTopBar();
    // 报告 → 面板
    fireEvent.click(screen.getByRole("button", { name: "重新发起或归档" }));
    expect(
      await screen.findByRole("dialog", { name: "整卷复盘" }),
    ).toBeInTheDocument();
    expect(searchNow()).toBe("?aiReview=panel");
    // 面板 → 报告
    fireEvent.click(
      await screen.findByRole("button", { name: /查看整卷复盘报告/ }),
    );
    expect(await screen.findByText("整体基础扎实。")).toBeInTheDocument();
    expect(searchNow()).toBe(`?aiReview=${TASK_ID}`);
    browserBack();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(searchNow()).toBe("");
    browserBack();
    expect(await screen.findByText("来源页")).toBeInTheDocument();
  });

  it("面板与报告是同一层：切到面板后用面板的关闭，同样一步回结果页", async () => {
    renderAt("");
    await openFromTopBar();
    fireEvent.click(screen.getByRole("button", { name: "重新发起或归档" }));
    const panel = await screen.findByRole("dialog", { name: "整卷复盘" });
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(searchNow()).toBe("");
    browserBack();
    expect(await screen.findByText("来源页")).toBeInTheDocument();
  });

  it("在结果页内打开后点证据题号：退回一步关报告再定位，历史里不留报告", async () => {
    renderAt("");
    await openFromTopBar();
    fireEvent.click(screen.getByRole("button", { name: "第 8 题" }));
    await waitFor(() => expect(onJumpToQuestion).toHaveBeenCalledWith("q-8"));
    expect(onJumpToQuestion).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(searchNow()).toBe("");
    browserBack();
    expect(await screen.findByText("来源页")).toBeInTheDocument();
  });

  it("已读只写一次：后退再前进重新打开同一份报告，不重复记已读", async () => {
    renderAt("");
    await openFromTopBar();
    await waitFor(() => expect(mockedAction).toHaveBeenCalledTimes(1));
    // 服务端已记下 openedAt，之后的列表与详情都带着它
    const opened = taskOf({ openedAt: "2026-11-12T18:00:00Z" });
    mockedList.mockResolvedValue({ tasks: [opened], nextCursor: null });
    mockedDetail.mockResolvedValue({ ...DETAIL, task: opened });
    browserBack();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    browserForward();
    expect(await screen.findByText("整体基础扎实。")).toBeInTheDocument();
    expect(mockedDetail).toHaveBeenCalledTimes(2);
    browserBack();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockedAction).toHaveBeenCalledTimes(1);
  });

  it("连续触发两次打开（双击入口）只新增一条历史：后退一步就关掉", async () => {
    renderAt("");
    fireEvent.click(
      await screen.findByRole("button", { name: "连续打开两次" }),
    );
    expect(await screen.findByText("整体基础扎实。")).toBeInTheDocument();
    browserBack();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(searchNow()).toBe("");
    browserBack();
    expect(await screen.findByText("来源页")).toBeInTheDocument();
  });

  it("连续触发两次关闭只退一步，不会退出结果页", async () => {
    renderAt("");
    await openFromTopBar();
    fireEvent.click(
      screen.getByRole("button", { name: "连续关闭两次", hidden: true }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("来源页")).toBeNull();
    expect(searchNow()).toBe("");
  });

  it("历史标记还在、下面却没有可退的记录：关闭兜底为去掉参数，不会关不掉", async () => {
    renderWith([
      {
        pathname: RESULT_PATH,
        search: `?reviewQuestion=q-3&aiReview=${TASK_ID}`,
        state: ATTEMPT_REVIEW_LAYER_STATE,
      },
    ]);
    expect(await screen.findByText("整体基础扎实。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭，回到作答结果" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), {
      timeout: 3000,
    });
    expect(searchNow()).toBe("?reviewQuestion=q-3");
  });
});

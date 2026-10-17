import {
  focusManager,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  AiTaskDetailData,
  AiTaskPublic,
  AttemptQuestionPublic,
  StudentQuickButtonsData,
} from "@tutor/contract";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStudentAiTaskApi,
  fetchStudentAiStatusApi,
  fetchStudentAiTaskApi,
  fetchStudentQuickButtonsApi,
  followupStudentAiTaskApi,
  listStudentAiTasksApi,
  openStudentAiReplyApi,
} from "@/lib/api";
import { AiConversationPanel } from "./AiConversationPanel";
import { connectedAiStatus } from "./student-ai-test-utils";
import {
  type AiSendController,
  useAiSendController,
} from "./use-ai-send-controller";

/**
 * SAI-21 会话面板组件测试（B11）：回信可见性、追问上下文、查询策略与
 * 完成条件①的 fake-provider 页内闭环（发送→回复→追问→刷新保留）。
 * 先测对照：①刷新可见+未读/已读区分；②追问不覆盖快照、跨题不入列；
 * ④新回复不抢焦点/光标/主区 identity；⑤隐藏页无持续轮询；⑥外部链接
 * 无平台回信显示外部未知。受限渲染（先测③）见 AiReplyMarkdown.test。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentAiStatusApi: vi.fn(),
    createStudentAiTaskApi: vi.fn(),
    listStudentAiTasksApi: vi.fn(),
    uploadStudentAiTaskMaterialsApi: vi.fn(),
    fetchStudentQuickButtonsApi: vi.fn(),
    fetchStudentAiTaskApi: vi.fn(),
    openStudentAiReplyApi: vi.fn(),
    followupStudentAiTaskApi: vi.fn(),
  };
});
vi.mock("@/features/export/ai-material-capture", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/export/ai-material-capture")
    >();
  return { ...actual, captureAiQuestionMaterials: vi.fn() };
});

// TanStack 的通知冲刷默认走 setTimeout(0)：fake timers 下轮询成功后的
// 重渲染要等虚拟时钟再前进一步才可见。按官方测试配置改为微任务冲刷，
// advanceTimersByTimeAsync 的微任务收敛即可完整呈现轮询结果。
notifyManager.setScheduler((callback) => {
  queueMicrotask(callback);
});

const mockedStatus = vi.mocked(fetchStudentAiStatusApi);
const mockedCreate = vi.mocked(createStudentAiTaskApi);
const mockedList = vi.mocked(listStudentAiTasksApi);
const mockedDetail = vi.mocked(fetchStudentAiTaskApi);
const mockedOpened = vi.mocked(openStudentAiReplyApi);
const mockedFollowup = vi.mocked(followupStudentAiTaskApi);
const mockedQuickButtons = vi.mocked(fetchStudentQuickButtonsApi);

const QUESTION: AttemptQuestionPublic = {
  id: "q-a",
  questionRevisionId: "11111111-1111-4111-8111-111111111111",
  type: "judge",
  stemMd: "题面",
  knowledge: [],
  difficulty: 1,
  hintCount: 0,
};

let taskSeq = 0;
function makeTask(over: Partial<AiTaskPublic> = {}): AiTaskPublic {
  taskSeq += 1;
  return {
    id: `task-${taskSeq}`,
    attemptId: "attempt-1",
    questionId: "q-a",
    questionRevisionId: QUESTION.questionRevisionId,
    channel: "inapp",
    status: "created",
    modeAtSend: "open_study",
    question: "这道题怎么入手？",
    beforeSubmit: true,
    contextVersion: `ctx-${taskSeq}`,
    snapshotAt: "2026-10-16T02:00:00.000Z",
    hasReply: false,
    replyDeliveredAt: null,
    errorText: null,
    retryCount: 0,
    allowedActions: [],
    materials: [],
    createdAt: "2026-10-16T02:00:00.000Z",
    updatedAt: "2026-10-16T02:00:00.000Z",
    archivedAt: null,
    ...over,
  };
}

function detailOf(
  task: AiTaskPublic,
  messages: AiTaskDetailData["messages"],
): AiTaskDetailData {
  return { task, messages, facts: [] };
}

const QUICK_BUTTONS: StudentQuickButtonsData = {
  updatedAt: "2026-10-16T00:00:00.000Z",
  buttons: [],
};

/** 组件外拿控制器（bind 是显式动作） */
const captured: { send: AiSendController | null } = { send: null };

function BoundHarness() {
  const send = useAiSendController({
    attemptId: "attempt-1",
    questions: [QUESTION],
    isHandwritten: () => false,
    surfaceOf: () => null,
    flush: async () => {},
    titleOf: () => "第 1 题 · 练习",
    active: true,
  });
  captured.send = send;
  return (
    <div>
      {/* 主区 marker：新回复到达不得重挂题面（identity 保持） */}
      <div data-testid="question-surface">题面本体</div>
      <label>
        补充问题输入
        {/* 输入经真实控制器草稿（闭环测试从输入到创建任务走真路径） */}
        <textarea
          data-testid="composer-input"
          value={send.draftOf(send.boundQuestionId ?? "").text}
          onChange={(event) => send.setText(event.target.value)}
        />
      </label>
      <AiConversationPanel send={send} />
    </div>
  );
}

function PanelHarness() {
  // 惰性初始化：状态变化重渲染不重建 client
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <BoundHarness />
    </QueryClientProvider>
  );
}

/** 绑定 A 题并让首轮查询落地 */
async function openBound() {
  render(<PanelHarness />);
  await act(async () => {
    captured.send?.bind(QUESTION.id);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  captured.send = null;
  taskSeq = 0;
  focusManager.setFocused(true);
  vi.mocked(mockedStatus).mockResolvedValue(connectedAiStatus());
  vi.mocked(mockedList).mockResolvedValue({ tasks: [], nextCursor: null });
  vi.mocked(mockedCreate).mockResolvedValue(makeTask());
  vi.mocked(mockedQuickButtons).mockResolvedValue(QUICK_BUTTONS);
  // 默认详情含一条 assistant 回信（个别用例按需覆盖；先测①b 覆盖为仅学生
  // 消息——服务端门禁不下发禁用期正文）
  vi.mocked(mockedDetail).mockResolvedValue(
    detailOf(makeTask(), [
      {
        id: "m-default-assistant",
        taskId: "00000000-0000-4000-8000-000000000000",
        role: "assistant",
        contentMd: "（默认回信占位）",
        createdAt: "2026-10-16T02:01:00.000Z",
      },
    ]),
  );
  vi.mocked(mockedOpened).mockResolvedValue(makeTask());
  vi.mocked(mockedFollowup).mockResolvedValue({
    task: makeTask({ status: "created" }),
    messages: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AiConversationPanel 回信可见性与追问（SAI-21）", () => {
  it("先测①：回信入库后轮询刷新可见；未读与已读可区分，查看才记 opened", async () => {
    vi.mocked(mockedList)
      .mockResolvedValueOnce({
        tasks: [makeTask({ id: "task-1" })],
        nextCursor: null,
      })
      .mockResolvedValue({
        tasks: [
          makeTask({
            id: "task-1",
            hasReply: true,
            replyDeliveredAt: null,
            allowedActions: ["followup", "share"],
          }),
        ],
        nextCursor: null,
      });
    vi.mocked(mockedDetail).mockResolvedValue(
      detailOf(
        makeTask({
          id: "task-1",
          hasReply: true,
          replyDeliveredAt: null,
          allowedActions: ["followup", "share"],
        }),
        [
          {
            id: "m-1",
            taskId: "task-1",
            role: "student",
            contentMd: "这道题怎么入手？",
            createdAt: "2026-10-16T02:00:00.000Z",
          },
          {
            id: "m-2",
            taskId: "task-1",
            role: "assistant",
            contentMd: "**第一步**：先把已知条件列出来。",
            createdAt: "2026-10-16T02:01:00.000Z",
          },
        ],
      ),
    );
    await openBound();

    // 初始（created）：等待处理，没有查看入口（未收到反馈不显示回复）
    expect(screen.getByText("已发送，等待处理")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /查看/ })).toBeNull();

    // 10s 轮询后发现回信：未读标记 + 轻提示；不自动展开（无 detail 调用）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText("收到新回复（未读）")).toBeInTheDocument();
    expect(screen.getByRole("status").textContent).toContain("新回复");
    expect(mockedDetail).not.toHaveBeenCalled();

    // 点击查看：detail + opened 各一次，回复经受限渲染呈现。markdown 粗体
    // 会把句子拆进 strong 与文本节点（getNodeText 只取直接文本子节点），
    // 用函数匹配器按段落 textContent 断言受限渲染结果
    fireEvent.click(screen.getByRole("button", { name: "查看回信" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockedDetail).toHaveBeenCalledWith("task-1");
    expect(mockedOpened).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "P" &&
          (element.textContent ?? "").includes("第一步：先把已知条件列出来"),
      ),
    ).toBeInTheDocument();
    // 打开即视为已读（本地即时，不等下一轮轮询）
    expect(screen.getByText("已查看回复")).toBeInTheDocument();

    // 收起再展开不重复记 opened（SAI-14 幂等口径的客户端侧）
    fireEvent.click(screen.getByRole("button", { name: "收起对话" }));
    fireEvent.click(screen.getByRole("button", { name: "查看对话" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockedOpened).toHaveBeenCalledTimes(1);
  });

  it("先测①b：禁用期回信只保留事实——历史/轮询拿不到未获准交付的正文", async () => {
    const task = makeTask({ id: "task-1", status: "replied", hasReply: true });
    vi.mocked(mockedList).mockResolvedValue({
      tasks: [task],
      nextCursor: null,
    });
    // 服务端门禁：assistant 正文不下发（学生消息恒可见）
    vi.mocked(mockedDetail).mockResolvedValue(
      detailOf(task, [
        {
          id: "m-1",
          taskId: "task-1",
          role: "student",
          contentMd: "这道题怎么入手？",
          createdAt: "2026-10-16T02:00:00.000Z",
        },
      ]),
    );
    await openBound();
    fireEvent.click(screen.getByRole("button", { name: "查看回信" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      screen.getByText("已收到回信，当前教学模式下暂不能查看"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/第一步/)).toBeNull();
  });

  it("先测②：追问只带问题与幂等键（不附材料），两任务快照各自保留；跨题不入列", async () => {
    const older = makeTask({
      id: "task-old",
      status: "replied",
      hasReply: true,
      replyDeliveredAt: "2026-10-16T03:00:00.000Z",
      modeAtSend: "guided_only",
      snapshotAt: "2026-10-16T02:00:00.000Z",
      allowedActions: ["followup", "share"],
    });
    const newer = makeTask({
      id: "task-new",
      status: "replied",
      hasReply: true,
      replyDeliveredAt: "2026-10-16T05:00:00.000Z",
      snapshotAt: "2026-10-16T04:30:00.000Z",
      question: "换了新稿再问",
      allowedActions: ["followup", "share"],
    });
    vi.mocked(mockedList).mockResolvedValue({
      tasks: [newer, older],
      nextCursor: null,
    });
    await openBound();

    // 查询按账号/attempt/绑定题隔离：列表只查本题
    expect(mockedList).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      questionId: "q-a",
    });

    // 展开旧任务追问：明确基于原发送材料（不悄悄附新笔迹）
    const olderCard = screen.getByTestId("ai-task-card-task-old");
    fireEvent.click(
      within(olderCard).getByRole("button", { name: "查看对话" }),
    );
    expect(
      within(olderCard).getByText(/追问基于原发送材料/),
    ).toBeInTheDocument();

    vi.mocked(mockedFollowup).mockResolvedValue({
      task: makeTask({ id: "task-old", status: "created", hasReply: true }),
      messages: [],
    });
    const input = within(olderCard).getByTestId("followup-input");
    fireEvent.change(input, { target: { value: "第二步为什么消项？" } });
    fireEvent.click(within(olderCard).getByRole("button", { name: "追问" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // 追问载荷只有 question + mutationId：不带任何材料字段
    expect(mockedFollowup).toHaveBeenCalledTimes(1);
    const [taskIdArg, requestArg] = mockedFollowup.mock.calls[0] ?? [];
    expect(taskIdArg).toBe("task-old");
    expect(Object.keys(requestArg ?? {}).sort()).toEqual([
      "mutationId",
      "question",
    ]);
    expect(requestArg?.question).toBe("第二步为什么消项？");

    // 两个任务的材料时间各自保留（追问/新任务不覆盖对方快照），当时模式如实
    const oldCard2 = screen.getByTestId("ai-task-card-task-old");
    const newCard = screen.getByTestId("ai-task-card-task-new");
    const timeOf = (card: HTMLElement): string =>
      (card.textContent ?? "").match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/)?.[1] ??
      "";
    expect(timeOf(oldCard2)).not.toBe("");
    expect(timeOf(newCard)).not.toBe("");
    expect(timeOf(oldCard2)).not.toBe(timeOf(newCard));
    expect(oldCard2.textContent ?? "").toContain("仅启发");
  });

  it("先测④：新回复到达不打断输入——焦点、光标与主区 identity 保持", async () => {
    vi.mocked(mockedList)
      .mockResolvedValueOnce({
        tasks: [makeTask({ id: "task-1" })],
        nextCursor: null,
      })
      .mockResolvedValue({
        tasks: [makeTask({ id: "task-1", hasReply: true })],
        nextCursor: null,
      });
    const { container } = render(<PanelHarness />);
    await act(async () => {
      captured.send?.bind(QUESTION.id);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const surface = container.querySelector('[data-testid="question-surface"]');
    // getByTestId 返回 HTMLElement：按输入框断言收窄到 HTMLTextAreaElement
    const textarea = screen.getByTestId(
      "composer-input",
    ) as HTMLTextAreaElement;
    // jsdom 的 fireEvent.focus 只派发事件、不走聚焦算法——真聚焦用 focus()
    textarea.focus();
    fireEvent.change(textarea, { target: { value: "我正在打字的一半问题" } });
    textarea.setSelectionRange(5, 5);
    expect(document.activeElement).toBe(textarea);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    // 新回复已到达（未读提示出现）
    expect(screen.getByText("收到新回复（未读）")).toBeInTheDocument();
    // 焦点/光标保持
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(5);
    // 主区（题面）不重挂
    expect(container.querySelector('[data-testid="question-surface"]')).toBe(
      surface,
    );
  });

  it("先测⑤：隐藏页无持续轮询；恢复可见只核对状态不重发", async () => {
    vi.mocked(mockedList).mockResolvedValue({
      tasks: [makeTask({ id: "task-1" })],
      nextCursor: null,
    });
    await openBound();
    const initialCalls = mockedList.mock.calls.length;
    expect(initialCalls).toBeGreaterThanOrEqual(1);

    // 页面隐藏：30s 内零新增轮询
    focusManager.setFocused(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockedList.mock.calls.length).toBe(initialCalls);

    // 恢复可见：增量查询恢复（只核对状态）
    focusManager.setFocused(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockedList.mock.calls.length).toBe(initialCalls + 1);

    // 全程无任何发送/追问（GET 之外零出站）
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedFollowup).not.toHaveBeenCalled();
  });

  it("先测⑥：外部链接无平台回信显示外部未知，不伪造已完成", async () => {
    vi.mocked(mockedList).mockResolvedValue({
      tasks: [makeTask({ id: "task-link", channel: "link", hasReply: false })],
      nextCursor: null,
    });
    await openBound();
    const card = screen.getByTestId("ai-task-card-task-link");
    expect(
      within(card).getByText(/回复在外部，平台未收到回信/),
    ).toBeInTheDocument();
    expect(within(card).getByText(/查看情况未知/)).toBeInTheDocument();
    // 不出现「已回复/已完成/已收到回信」这类伪造完成的表述
    expect(within(card).queryByText(/已回复|已完成|已收到回信/)).toBeNull();
    // 无回信则无查看入口、不取 detail
    expect(within(card).queryByRole("button", { name: /查看/ })).toBeNull();
    expect(mockedDetail).not.toHaveBeenCalled();
  });

  it("步骤6：暂停/失败/取消/待确认各有真实文案（含错误摘要）", async () => {
    vi.mocked(mockedList).mockResolvedValue({
      tasks: [
        makeTask({ id: "task-paused", status: "paused" }),
        makeTask({
          id: "task-failed",
          status: "failed",
          errorText: "供应商 429 限流",
        }),
        makeTask({ id: "task-cancelled", status: "cancelled" }),
        makeTask({ id: "task-uncertain", status: "uncertain" }),
      ],
      nextCursor: null,
    });
    await openBound();
    expect(
      within(screen.getByTestId("ai-task-card-task-paused")).getByText(
        /已暂停/,
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("ai-task-card-task-failed")).getByText(
        /发送失败：供应商 429 限流/,
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("ai-task-card-task-cancelled")).getByText(
        /已取消，已外发的信息无法撤回/,
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("ai-task-card-task-uncertain")).getByText(
        /发送结果待确认/,
      ),
    ).toBeInTheDocument();
  });

  it("完成条件①：fake-provider 页内闭环——发送→回复→追问→刷新保留", async () => {
    // 初始无任务
    vi.mocked(mockedList).mockResolvedValue({ tasks: [], nextCursor: null });
    const created = makeTask({ id: "task-loop" });
    vi.mocked(mockedCreate).mockResolvedValue(created);
    vi.mocked(mockedOpened).mockResolvedValue(
      makeTask({
        id: "task-loop",
        status: "replied",
        hasReply: true,
        replyDeliveredAt: "2026-10-16T06:00:00.000Z",
      }),
    );
    const replied = makeTask({
      id: "task-loop",
      status: "replied",
      hasReply: true,
      replyDeliveredAt: null,
      allowedActions: ["followup", "share"],
    });
    vi.mocked(mockedDetail).mockResolvedValue(
      detailOf(replied, [
        {
          id: "m-1",
          taskId: "task-loop",
          role: "student",
          contentMd: "这道题怎么入手？",
          createdAt: "2026-10-16T02:00:00.000Z",
        },
        {
          id: "m-2",
          taskId: "task-loop",
          role: "assistant",
          contentMd: "先从定义出发。",
          createdAt: "2026-10-16T02:01:00.000Z",
        },
      ]),
    );
    vi.mocked(mockedFollowup).mockResolvedValue({
      task: makeTask({ id: "task-loop", status: "created", hasReply: true }),
      messages: [],
    });
    const first = render(<PanelHarness />);
    await act(async () => {
      captured.send?.bind(QUESTION.id);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // 发送（真实控制器：状态就绪 → 创建任务）
    const textarea = screen.getByTestId("composer-input");
    fireEvent.change(textarea, { target: { value: "这道题怎么入手？" } });
    await act(async () => {
      await captured.send?.send();
    });
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedCreate.mock.calls[0]?.[0]?.question).toBe("这道题怎么入手？");

    // provider 回信入库 → 轮询刷新可见
    vi.mocked(mockedList).mockResolvedValue({
      tasks: [replied],
      nextCursor: null,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText("收到新回复（未读）")).toBeInTheDocument();

    // 查看：opened 记查看事实，回复呈现
    fireEvent.click(screen.getByRole("button", { name: "查看回信" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockedOpened).toHaveBeenCalledWith("task-loop");
    expect(screen.getByText("先从定义出发。")).toBeInTheDocument();

    // 追问（同题对话；携带 mutationId）
    const input = screen.getByTestId("followup-input");
    fireEvent.change(input, { target: { value: "那第二问呢？" } });
    fireEvent.click(screen.getByRole("button", { name: "追问" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockedFollowup).toHaveBeenCalledTimes(1);
    const [, followupRequest] = mockedFollowup.mock.calls[0] ?? [];
    expect(followupRequest?.question).toBe("那第二问呢？");
    expect(typeof followupRequest?.mutationId).toBe("string");

    // 刷新（卸载重挂、全新缓存）：对话从服务端恢复（任务与追问状态仍在）
    first.unmount();
    const afterFollowup = makeTask({
      id: "task-loop",
      status: "created",
      hasReply: true,
      replyDeliveredAt: "2026-10-16T06:00:00.000Z",
      question: "这道题怎么入手？",
    });
    vi.mocked(mockedList).mockResolvedValue({
      tasks: [afterFollowup],
      nextCursor: null,
    });
    render(<PanelHarness />);
    await act(async () => {
      captured.send?.bind(QUESTION.id);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("ai-task-card-task-loop")).toBeInTheDocument();
    expect(screen.getByText(/这道题怎么入手？/)).toBeInTheDocument();
  });

  it("opened 失败回滚本地标记：不虚报已读，收起再展开重试", async () => {
    const task = makeTask({
      id: "task-1",
      status: "replied",
      hasReply: true,
      allowedActions: ["followup"],
    });
    vi.mocked(mockedList).mockResolvedValue({
      tasks: [task],
      nextCursor: null,
    });
    vi.mocked(mockedDetail).mockResolvedValue(
      detailOf(task, [
        {
          id: "m-1",
          taskId: "task-1",
          role: "student",
          contentMd: "这道题怎么入手？",
          createdAt: "2026-10-16T02:00:00.000Z",
        },
        {
          id: "m-2",
          taskId: "task-1",
          role: "assistant",
          contentMd: "先从定义出发。",
          createdAt: "2026-10-16T02:01:00.000Z",
        },
      ]),
    );
    vi.mocked(mockedOpened).mockRejectedValueOnce(new Error("网络中断"));
    await openBound();
    fireEvent.click(screen.getByRole("button", { name: "查看回信" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // 打开失败不虚报已读：本地已读标记回滚，仍按未读呈现
    expect(screen.getByText("收到新回复（未读）")).toBeInTheDocument();

    // 收起再展开：重试 opened（这次成功 → 已读）
    fireEvent.click(screen.getByRole("button", { name: "收起对话" }));
    vi.mocked(mockedOpened).mockResolvedValue(
      makeTask({ ...task, replyDeliveredAt: "2026-10-16T06:00:00.000Z" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "查看回信" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockedOpened).toHaveBeenCalledTimes(2);
    expect(screen.getByText("已查看回复")).toBeInTheDocument();
  });

  it("轮询错误退避：失败后按 30s（3 倍）间隔重试，退避窗口内不风暴", async () => {
    vi.mocked(mockedList).mockResolvedValue({ tasks: [], nextCursor: null });
    await openBound();
    // t=10s：首次增量查询失败（此后进入 30s 退避）
    vi.mocked(mockedList).mockRejectedValueOnce(new Error("网络错误"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    const afterFail = mockedList.mock.calls.length;
    // t=20s / t=30s：退避窗口内零新增（若仍按 10s 间隔此处会多发两次）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockedList.mock.calls.length).toBe(afterFail);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockedList.mock.calls.length).toBe(afterFail);
    // t=40s：退避期满按 30s 间隔重试（Once 用尽回落成功，不再连续退避）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockedList.mock.calls.length).toBe(afterFail + 1);
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AiTaskPublic, AttemptQuestionPublic } from "@tutor/contract";
import { useState } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStudentAiTaskApi,
  fetchStudentAiStatusApi,
  fetchStudentAiTaskApi,
  followupStudentAiTaskApi,
  listStudentAiTasksApi,
  openStudentAiReplyApi,
} from "@/lib/api";
import { stubElementWidth } from "@/test/stub-element-width";
import { useAiCompanionDock } from "./AiCompanionDock";
import {
  bindAiDisplayAccount,
  saveAiDisplayPreference,
} from "./ai-display-preference-store";
import { connectedAiStatus } from "./student-ai-test-utils";

const flush = vi.fn(async (_questionId: string) => {});

const questions: AttemptQuestionPublic[] = ["q1", "q2"].map((id) => ({
  id,
  questionRevisionId: `rev-${id}`,
  type: "judge",
  stemMd: "公开题面",
  knowledge: [],
  difficulty: 1,
  hintCount: 0,
}));
const task: AiTaskPublic = {
  id: "task-q1",
  attemptId: "attempt",
  questionId: "q1",
  questionRevisionId: "rev-q1",
  channel: "inapp",
  status: "replied",
  modeAtSend: "open_study",
  question: "为什么？",
  beforeSubmit: true,
  contextVersion: "ctx",
  snapshotAt: "2026-10-18T02:00:00Z",
  hasReply: true,
  replyDeliveredAt: "2026-10-18T02:01:00Z",
  errorText: null,
  retryCount: 0,
  allowedActions: ["followup"],
  materials: [],
  createdAt: "2026-10-18T02:00:00Z",
  updatedAt: "2026-10-18T02:01:00Z",
  archivedAt: null,
};
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  fetchStudentAiStatusApi: vi.fn(async () => connectedAiStatus()),
  listStudentAiTasksApi: vi.fn(
    async ({ questionId }: { questionId: string }) => ({
      tasks: questionId === "q1" ? [task] : [],
      nextCursor: null,
    }),
  ),
  fetchStudentQuickButtonsApi: vi.fn(async () => ({
    updatedAt: "2026-10-18T00:00:00Z",
    buttons: [],
  })),
  fetchStudentAiTaskApi: vi.fn(async () => ({
    task,
    messages: [
      {
        id: "reply",
        taskId: task.id,
        role: "assistant",
        contentMd: "先列出条件，再代入特殊值。",
        createdAt: task.updatedAt,
      },
    ],
    facts: [],
  })),
  createStudentAiTaskApi: vi.fn(),
  followupStudentAiTaskApi: vi.fn(),
  openStudentAiReplyApi: vi.fn(async () => undefined),
}));

function Body({ ready = true }: { ready?: boolean }) {
  const dock = useAiCompanionDock({
    attemptId: "attempt",
    questions,
    isHandwritten: () => false,
    surfaceOf: () => null,
    flush,
    titleOf: (id) => id,
    labelOf: (id) => (id === "q1" ? "第 1 题" : "第 2 题"),
    currentQuestionId: "q1",
    editor: null,
    ready,
  });
  capturedDock.current = dock;
  return dock.rail(
    questions.map((q) => (
      <article key={q.id} aria-label={q.id}>
        <p>公开题面</p>
        {dock.triggerForQuestion(q.id)}
        {dock.inlineForQuestion(q.id)}
      </article>
    )),
  );
}
function DockLocation() {
  const location = useLocation();
  return (
    <p data-testid="dock-location">
      {location.pathname}
      {location.search}
    </p>
  );
}
function Harness({
  entry = "/",
  ready = true,
}: {
  entry?: string;
  ready?: boolean;
}) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  capturedClient.current = client;
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Body ready={ready} />
        <DockLocation />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
async function open(id: string) {
  fireEvent.click(
    within(screen.getByRole("article", { name: id })).getByRole("button", {
      name: "AI 助教",
    }),
  );
  const region = await screen.findByRole("region", {
    name: `${id === "q1" ? "第 1 题" : "第 2 题"}的 AI 助教`,
  });
  return region;
}
const capturedClient: { current: QueryClient | null } = { current: null };
const capturedDock: { current: ReturnType<typeof useAiCompanionDock> | null } =
  { current: null };
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  bindAiDisplayAccount(null);
  bindAiDisplayAccount("display-student");
});

describe("题下助教共享会话", () => {
  it("助教绑定题与当前编辑题不同时，回题等待两题落盘", async () => {
    render(<Harness />);
    await open("q2");
    flush.mockClear();
    await act(async () => {
      await capturedDock.current?.openQuestion(task);
    });
    expect(flush).toHaveBeenCalledWith("q1");
    expect(flush).toHaveBeenCalledWith("q2");
  });
  it.each(["inline", "side", "dialog"] as const)(
    "%s 阅读中回到另一题收起回复并定位，保留题卡",
    async (layout) => {
      saveAiDisplayPreference(layout);
      render(<Harness />);
      const card = screen.getByRole("article", { name: "q2" });
      const scroll = vi.fn();
      card.scrollIntoView = scroll;
      await open("q1");
      await screen.findByText("先列出条件，再代入特殊值。");
      vi.mocked(fetchStudentAiTaskApi).mockClear();
      vi.mocked(openStudentAiReplyApi).mockClear();
      await act(async () => {
        expect(
          await capturedDock.current?.openQuestion({
            ...task,
            questionId: "q2",
          }),
        ).toBe(true);
      });
      await waitFor(() => expect(scroll).toHaveBeenCalled());
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("region", { name: /的 AI 助教/ })).toBeNull();
      expect(card.isConnected).toBe(true);
      expect(fetchStudentAiTaskApi).not.toHaveBeenCalled();
      expect(openStudentAiReplyApi).not.toHaveBeenCalled();
    },
  );
  it("回题保存失败不滚动、不收起现有阅读，其他卷与缺失题目不能定位", async () => {
    render(<Harness />);
    await open("q1");
    await screen.findByText("先列出条件，再代入特殊值。");
    const scroll = vi.fn();
    screen.getByRole("article", { name: "q2" }).scrollIntoView = scroll;
    flush.mockRejectedValueOnce(new Error("落盘失败"));
    await act(async () => {
      expect(
        await capturedDock.current?.openQuestion({ ...task, questionId: "q2" }),
      ).toBe(false);
    });
    expect(scroll).not.toHaveBeenCalled();
    expect(screen.getByText("先列出条件，再代入特殊值。")).toBeVisible();
    await act(async () => {
      expect(
        await capturedDock.current?.openQuestion({
          ...task,
          attemptId: "other",
        }),
      ).toBe(false);
      expect(
        await capturedDock.current?.openQuestion({
          ...task,
          questionId: "missing",
        }),
      ).toBe(false);
    });
    expect(scroll).not.toHaveBeenCalled();
  });
  it.each(["inline", "side", "dialog"] as const)(
    "%s 偏好下跨页回题只定位题卡，不读取或展开回复",
    async (layout) => {
      saveAiDisplayPreference(layout);
      const view = render(
        <Harness
          entry="/s/attempts/attempt?aiQuestion=q2&aiFrom=%2Fs%2Frecords"
          ready={false}
        />,
      );
      const card = screen.getByRole("article", { name: "q2" });
      const scroll = vi.fn();
      card.scrollIntoView = scroll;
      expect(scroll).not.toHaveBeenCalled();
      view.rerender(<Harness ready />);
      await waitFor(() => expect(scroll).toHaveBeenCalled());
      expect(screen.getByTestId("dock-location")).toHaveTextContent(
        "/s/attempts/attempt?aiFrom=%2Fs%2Frecords",
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("region", { name: /的 AI 助教/ })).toBeNull();
      expect(fetchStudentAiTaskApi).not.toHaveBeenCalled();
      expect(openStudentAiReplyApi).not.toHaveBeenCalled();
    },
  );
  it("保存弹窗偏好后默认打开弹窗，只有一份输入并保持纸面挂载", async () => {
    saveAiDisplayPreference("dialog");
    render(<Harness />);
    const original = screen.getByRole("article", { name: "q1" });
    await open("q1");
    const dialog = await screen.findByRole("dialog", { name: /AI 助教/ });
    expect(original.isConnected).toBe(true);
    await within(dialog).findByText("先列出条件，再代入特殊值。");
    expect(
      screen.getAllByText("先列出条件，再代入特殊值。", { exact: true }),
    ).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "这一步没懂" }));
    expect(screen.getAllByRole("textbox", { hidden: true })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "专注阅读" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭弹层" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(original).toBe(screen.getByRole("article", { name: "q1" }));
  });
  it("侧边在窄屏退为弹窗，本次阅读不随宽度恢复来回跳动", async () => {
    const width = stubElementWidth(800);
    try {
      saveAiDisplayPreference("side");
      render(<Harness />);
      await open("q1");
      await screen.findByRole("dialog", { name: /AI 助教/ });
      expect(screen.getByText(/当前空间不足/)).toBeVisible();
      act(() => width.setWidth(1440));
      expect(screen.getByRole("dialog")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "关闭弹层" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await open("q1");
      await screen.findByRole("complementary", { name: "AI 对照" });
    } finally {
      width.restore();
    }
  });
  it("阅读中修改保存偏好不搬动当前正文，下次打开生效", async () => {
    render(<Harness />);
    await open("q1");
    act(() => saveAiDisplayPreference("dialog"));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "收起 AI 助教" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "第 1 题的 AI 助教" }),
      ).toBeNull(),
    );
    await open("q1");
    await screen.findByRole("dialog", { name: /AI 助教/ });
  });
  it("别的设备读过回信也不会打断当前输入并自动展开", async () => {
    const unread = { ...task, replyDeliveredAt: null };
    vi.mocked(listStudentAiTasksApi).mockResolvedValueOnce({
      tasks: [unread],
      nextCursor: null,
    });
    render(<Harness />);
    await open("q1");
    const input = await screen.findByRole("textbox", { name: "补充问题" });
    fireEvent.change(input, { target: { value: "我仍在写自己的问题" } });
    input.focus();
    act(() =>
      capturedClient.current?.setQueryData(
        ["student", "ai-tasks", "attempt", "q1"],
        { tasks: [task], nextCursor: null },
      ),
    );
    await screen.findByRole("button", { name: "查看对话" });
    expect(screen.queryByText("先列出条件，再代入特殊值。")).toBeNull();
    expect(input).toHaveFocus();
    expect(input).toHaveValue("我仍在写自己的问题");
  });
  it("追问引用不能越过当前回复到其他题目", async () => {
    render(<Harness />);
    await open("q1");
    const reply = await screen.findByText("先列出条件，再代入特殊值。");
    const other = within(screen.getByRole("article", { name: "q2" })).getByText(
      "公开题面",
    );
    const range = document.createRange();
    range.setStart(reply, 0);
    range.setEnd(other, 1);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.click(screen.getByRole("button", { name: "这一步没懂" }));
    expect(screen.getByRole("textbox", { name: "继续追问本题" })).toHaveValue(
      "请换一种方式解释这一步。",
    );
    selection?.removeAllRanges();
  });
  it("跨页任务定位等待材料恢复，打开后消费字段且保留来源", async () => {
    const entry =
      "/s/attempts/attempt?aiTask=task-q1&aiQuestion=q1&aiFrom=%2Fs%2Frecords";
    const view = render(<Harness entry={entry} ready={false} />);
    expect(fetchStudentAiTaskApi).not.toHaveBeenCalled();
    const original = screen.getByRole("article", { name: "q1" });
    view.rerender(<Harness entry={entry} ready />);
    expect(await screen.findByText("先列出条件，再代入特殊值。")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByTestId("dock-location")).not.toHaveTextContent(
        "aiTask",
      ),
    );
    expect(screen.getByTestId("dock-location")).toHaveTextContent(
      "aiFrom=%2Fs%2Frecords",
    );
    expect(screen.getByRole("article", { name: "q1" })).toBe(original);
  });
  it("跨页题目与任务不匹配时不展开、不记录交付", async () => {
    render(
      <Harness entry="/s/attempts/attempt?aiTask=task-q1&aiQuestion=q2" />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "定位与当前练习不一致",
    );
    expect(openStudentAiReplyApi).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: "第 1 题的 AI 助教" }),
    ).toBeNull();
  });
  it("指定任务直接打开对应题与正文，不需要第二次查看", async () => {
    render(<Harness />);
    await act(async () => {
      await capturedDock.current?.openTask(task);
    });
    expect(await screen.findByText("先列出条件，再代入特殊值。")).toBeVisible();
    expect(screen.getByRole("article", { name: "q1" })).toContainElement(
      screen.getByRole("region", { name: "第 1 题的 AI 助教" }),
    );
  });
  it("读完回题后可检查新步骤，准备阶段不外发且保留原稿", async () => {
    render(<Harness />);
    const question = screen.getByRole("article", { name: "q1" });
    await open("q1");
    await screen.findByText("先列出条件，再代入特殊值。");
    fireEvent.click(screen.getByRole("button", { name: "回题试一试" }));
    await screen.findByRole("button", { name: "检查新步骤" });
    expect(
      screen.queryByRole("region", { name: "第 1 题的 AI 助教" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "检查新步骤" }));
    await screen.findByRole("textbox", { name: "补充问题" });
    expect(screen.getByText(/问法：请检查我新写的步骤/)).toBeVisible();
    expect(screen.getByRole("article", { name: "q1" })).toBe(question);
    expect(createStudentAiTaskApi).not.toHaveBeenCalled();
    expect(followupStudentAiTaskApi).not.toHaveBeenCalled();
  });
  it("缓存有旧正文但本次读取失败时不清未读", async () => {
    const unread = { ...task, replyDeliveredAt: null };
    vi.mocked(listStudentAiTasksApi).mockResolvedValueOnce({
      tasks: [unread],
      nextCursor: null,
    });
    vi.mocked(fetchStudentAiTaskApi).mockRejectedValueOnce(
      new Error("本次读取失败"),
    );
    render(<Harness />);
    capturedClient.current?.setQueryData(
      ["student", "ai-task-detail", task.id],
      {
        task: unread,
        messages: [
          {
            id: "cached",
            taskId: task.id,
            role: "assistant",
            contentMd: "旧缓存正文",
            createdAt: task.updatedAt,
          },
        ],
        facts: [],
      },
    );
    await open("q1");
    fireEvent.click(await screen.findByRole("button", { name: "查看回信" }));
    await screen.findByText("对话读取失败");
    expect(openStudentAiReplyApi).not.toHaveBeenCalled();
  });
  it("焦点因发送移回页面后Esc也能收起并返回本题入口", async () => {
    render(<Harness />);
    await open("q1");
    fireEvent.click(await screen.findByRole("button", { name: "这一步没懂" }));
    const input = await screen.findByRole("textbox", { name: "继续追问本题" });
    input.focus();
    input.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "第 1 题的 AI 助教" }),
      ).toBeNull(),
    );
    expect(
      within(screen.getByRole("article", { name: "q1" })).getByRole("button", {
        name: "AI 助教",
      }),
    ).toHaveFocus();
  });

  it("教师限制时打开即显示原因，无需再找设置入口", async () => {
    vi.mocked(fetchStudentAiStatusApi).mockResolvedValueOnce(
      connectedAiStatus({
        resolution: { usable: false, reason: "teacher_default_closed" },
      }),
    );
    render(<Harness />);
    await open("q2");
    expect(await screen.findByText(/当前模式为完成后可用/)).toBeVisible();
  });
  it("放大还原保留输入和题卡；保存失败禁止收起或切题", async () => {
    const width = stubElementWidth(1440);
    try {
      render(<Harness />);
      const question = screen.getByRole("article", { name: "q1" });
      await open("q1");
      fireEvent.click(
        await screen.findByRole("button", { name: "这一步没懂" }),
      );
      fireEvent.change(
        await screen.findByRole("textbox", { name: "继续追问本题" }),
        { target: { value: "边写边读" } },
      );
      fireEvent.click(screen.getByRole("button", { name: "放大阅读" }));
      await screen.findByRole("dialog", { name: /AI 助教/ });
      expect(screen.getByRole("textbox", { name: "继续追问本题" })).toHaveValue(
        "边写边读",
      );
      fireEvent.click(screen.getByRole("button", { name: "还原阅读" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.getByRole("article", { name: "q1" })).toBe(question);
      flush.mockRejectedValueOnce(new Error("磁盘满"));
      fireEvent.click(screen.getByRole("button", { name: "收起 AI 助教" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "重试保存后再收起",
      );
      expect(screen.getByRole("textbox", { name: "继续追问本题" })).toHaveValue(
        "边写边读",
      );
      flush.mockRejectedValueOnce(new Error("磁盘满"));
      fireEvent.click(
        within(screen.getByRole("article", { name: "q2" })).getByRole(
          "button",
          { name: "AI 助教" },
        ),
      );
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent("重试保存后再切换"),
      );
      expect(
        screen.getByRole("region", { name: "第 1 题的 AI 助教" }),
      ).toBeVisible();
    } finally {
      width.restore();
    }
  });
  it("阅读中到达的新回信只提示，主动查看才刷新正文并清未读", async () => {
    render(<Harness />);
    await open("q1");
    fireEvent.click(await screen.findByRole("button", { name: "这一步没懂" }));
    await screen.findByText("先列出条件，再代入特殊值。");
    const originalInput = screen.getByRole("textbox", { name: "继续追问本题" });
    fireEvent.change(originalInput, { target: { value: "我还在写问题" } });
    vi.mocked(fetchStudentAiTaskApi).mockResolvedValueOnce({
      task: {
        ...task,
        updatedAt: "2026-10-18T03:00:00Z",
        replyDeliveredAt: null,
      },
      messages: [
        {
          id: "new-reply",
          taskId: task.id,
          role: "assistant",
          contentMd: "新的长篇讲解",
          createdAt: "2026-10-18T03:00:00Z",
        },
      ],
      facts: [],
    });
    capturedClient.current?.setQueryData(
      ["student", "ai-tasks", "attempt", "q1"],
      {
        tasks: [
          {
            ...task,
            updatedAt: "2026-10-18T03:00:00Z",
            replyDeliveredAt: null,
          },
        ],
        nextCursor: null,
      },
    );
    const viewNew = await screen.findByRole("button", { name: "查看新回复" });
    expect(screen.queryByText("新的长篇讲解")).toBeNull();
    expect(originalInput).toHaveValue("我还在写问题");
    expect(openStudentAiReplyApi).not.toHaveBeenCalled();
    fireEvent.click(viewNew);
    expect(await screen.findByText("新的长篇讲解")).toBeVisible();
    await waitFor(() => expect(openStudentAiReplyApi).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("textbox", { name: "继续追问本题" })).toHaveValue(
      "我还在写问题",
    );
  });
  it("正文位于绑定题内且只有一个输入；带新稿另问不外发并保留追问草稿", async () => {
    render(<Harness />);
    const region = await open("q1");
    fireEvent.click(await screen.findByRole("button", { name: "这一步没懂" }));
    await within(region).findByText("先列出条件，再代入特殊值。");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    const input = screen.getByRole("textbox", { name: "继续追问本题" });
    fireEvent.change(input, { target: { value: "我还不理解第二步" } });
    fireEvent.click(screen.getByRole("button", { name: "带新稿另问" }));
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(
      await screen.findByRole("textbox", { name: "补充问题" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "查看对话" }));
    expect(screen.getByRole("textbox", { name: "继续追问本题" })).toHaveValue(
      "我还不理解第二步",
    );
    expect(createStudentAiTaskApi).not.toHaveBeenCalled();
    expect(followupStudentAiTaskApi).not.toHaveBeenCalled();
  });

  it("收起与切题后恢复每个任务的追问草稿，题面节点保持原实例", async () => {
    render(<Harness />);
    const original = screen.getByRole("article", { name: "q1" });
    await open("q1");
    fireEvent.click(await screen.findByRole("button", { name: "这一步没懂" }));
    const input = await screen.findByRole("textbox", { name: "继续追问本题" });
    fireEvent.change(input, { target: { value: "保留这句话" } });
    fireEvent.click(screen.getByRole("button", { name: "收起 AI 助教" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "第 1 题的 AI 助教" }),
      ).toBeNull(),
    );
    await open("q1");
    expect(
      await screen.findByRole("textbox", { name: "继续追问本题" }),
    ).toHaveValue("保留这句话");
    await open("q2");
    expect(
      await screen.findByRole("textbox", { name: "补充问题" }),
    ).toHaveValue("");
    await open("q1");
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "继续追问本题" })).toHaveValue(
        "保留这句话",
      ),
    );
    expect(screen.getByRole("article", { name: "q1" })).toBe(original);
    expect(fetchStudentAiTaskApi).toHaveBeenCalledWith(task.id);
  });
});

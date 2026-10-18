import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AiTaskPublic, AttemptQuestionPublic } from "@tutor/contract";
import { useState } from "react";
import { MemoryRouter } from "react-router";
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

function Body() {
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
  });
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
function Harness() {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  capturedClient.current = client;
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Body />
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
  return screen.findByRole("region", {
    name: `${id === "q1" ? "第 1 题" : "第 2 题"}的 AI 助教`,
  });
}
const capturedClient: { current: QueryClient | null } = { current: null };
beforeEach(() => vi.clearAllMocks());

describe("题下助教共享会话", () => {
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
  it("固定对照来回切换保留输入和题卡；保存失败禁止收起或切题", async () => {
    const width = stubElementWidth(1440);
    try {
      render(<Harness />);
      const question = screen.getByRole("article", { name: "q1" });
      await open("q1");
      fireEvent.change(
        await screen.findByRole("textbox", { name: "继续追问本题" }),
        { target: { value: "边写边读" } },
      );
      fireEvent.click(screen.getByRole("button", { name: "固定对照" }));
      await screen.findByRole("complementary", { name: "AI 对照" });
      expect(screen.getByRole("textbox", { name: "继续追问本题" })).toHaveValue(
        "边写边读",
      );
      fireEvent.click(screen.getByRole("button", { name: "回到题下" }));
      await waitFor(() =>
        expect(
          screen.queryByRole("complementary", { name: "AI 对照" }),
        ).toBeNull(),
      );
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
    await within(region).findByText("先列出条件，再代入特殊值。");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    const input = screen.getByRole("textbox", { name: "继续追问本题" });
    fireEvent.change(input, { target: { value: "我还不理解第二步" } });
    fireEvent.click(screen.getByRole("button", { name: "带新稿另问" }));
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "补充问题" })).toBeVisible();
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

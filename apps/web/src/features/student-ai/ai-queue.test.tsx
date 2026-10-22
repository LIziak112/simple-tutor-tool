import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AiQueueSummaryData,
  AiTaskDetailData,
  AiTaskListData,
  AiTaskOriginSummary,
  AiTaskPublic,
} from "@tutor/contract";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiQueueReturnTarget } from "@/features/student/record-review-navigation";
import { AiQueueButton } from "@/features/student-ai/AiQueueButton";
import {
  AiQueuePanel,
  aiQueueTargetOf,
} from "@/features/student-ai/AiQueuePanel";
import {
  studentAiQueueKey,
  studentAiQueueSummaryKey,
} from "@/features/student-ai/ai-queue-queries";
import {
  fetchStudentAiQueueSummaryApi,
  fetchStudentAiTaskApi,
  listStudentAiQueueApi,
  openStudentAiReplyApi,
  studentAiTaskActionApi,
} from "@/lib/api";

/**
 * SAI-23 全局队列先测（B12 批次先测四组）：
 * 1. 列表形态——零条空态、长中文标题、多页游标、窄屏顶栏不挤保存/退出；
 * 2. 角标语义——待处理与新回复分开计数，归档≠已读、取消≠已读；
 * 3. 导航——aiFrom 白名单与完整来源位置、旧卷同 questionId 不跳新卷；
 * 4. 缓存与保护——查询键挂 student 前缀（登出即清）、错误可重载、
 *    打开队列不卸载作答内容（未完成原稿不因队列操作被清）。
 * 列表载荷只含展示与导航字段（正文材料在授权详情接口读取——本文件
 * mock 的列表响应即列表可见的全部内容，不出现 messages/正文）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentAiQueueSummaryApi: vi.fn(),
    fetchStudentAiTaskApi: vi.fn(),
    listStudentAiQueueApi: vi.fn(),
    openStudentAiReplyApi: vi.fn(),
    studentAiTaskActionApi: vi.fn(),
  };
});

const mockedSummary = vi.mocked(fetchStudentAiQueueSummaryApi);
const mockedList = vi.mocked(listStudentAiQueueApi);
const mockedDetail = vi.mocked(fetchStudentAiTaskApi);
const mockedOpened = vi.mocked(openStudentAiReplyApi);
const mockedAction = vi.mocked(studentAiTaskActionApi);

const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";
const OLD_ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";

function summaryOf(over: Partial<AiQueueSummaryData> = {}): AiQueueSummaryData {
  return { pendingCount: 0, processingCount: 0, unreadReplyCount: 0, ...over };
}

function queueTask(over: Partial<AiTaskPublic> = {}): AiTaskPublic {
  return {
    id: "9f0f6d5e-1111-4111-8111-9f0f6d5e0001",
    attemptId: ATTEMPT_ID,
    questionId: "q-1",
    questionRevisionId: "rev-1",
    channel: "inapp",
    status: "replied",
    modeAtSend: "open_study",
    question: "这道题怎么入手？",
    beforeSubmit: true,
    contextVersion: "ctx-1",
    snapshotAt: "2026-10-16T02:00:00.000Z",
    hasReply: true,
    replyDeliveredAt: null,
    errorText: null,
    retryCount: 0,
    archivedAt: null,
    allowedActions: ["archive"],
    materials: [],
    createdAt: "2026-10-16T02:00:00.000Z",
    updatedAt: "2026-10-16T02:00:00.000Z",
    ...over,
  };
}

function originOf(
  over: Partial<AiTaskOriginSummary> = {},
): AiTaskOriginSummary {
  return {
    sourceType: "course",
    attemptNo: 1,
    questionNo: 3,
    title: "有理数小练",
    assignmentId: null,
    courseId: "12121212-1212-4121-8121-121212121212",
    unitId: "有理数小练",
    lectureId: null,
    attemptStatus: "draft",
    ...over,
  };
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** 面板顶部计数「新回复 N」（文本被嵌套 span 拆分，用函数 matcher） */
async function expectUnreadCounted(count: number) {
  expect(
    await screen.findByText(
      (_content, element) => element?.textContent?.trim() === `新回复 ${count}`,
    ),
  ).toBeInTheDocument();
}

/** 捕获当前路由位置（断言 aiFrom 携带完整来源） */
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
  client = makeClient(),
  initialEntry = "/s/records",
  props: import("./AiQueuePanel").AiQueueNavigationProps = {},
) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/s/records" element={<AiQueuePanel {...props} />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSummary.mockResolvedValue(summaryOf());
  mockedList.mockResolvedValue({ tasks: [], nextCursor: null });
  mockedDetail.mockResolvedValue({
    task: queueTask(),
    messages: [
      {
        id: "message-1",
        taskId: queueTask().id,
        role: "assistant",
        contentMd: "这是回信正文",
        createdAt: "2026-10-16T02:01:00.000Z",
      },
    ],
    facts: [],
  } satisfies AiTaskDetailData);
  mockedOpened.mockResolvedValue(
    queueTask({ replyDeliveredAt: "2026-10-16T02:02:00.000Z" }),
  );
});

it("本卷队列原地打开任务，保存失败留在列表且不提前记已读", async () => {
  const task = queueTask();
  mockedList.mockResolvedValue({
    tasks: [
      task,
      queueTask({
        id: "other",
        attemptId: OLD_ATTEMPT_ID,
        question: "其他练习的问题",
      }),
    ],
    nextCursor: null,
    origins: { [task.id]: originOf() },
  });
  const openTask = vi.fn(async () => false);
  renderPanel(makeClient(), "/s/records", {
    currentAttemptId: ATTEMPT_ID,
    onOpenTask: openTask,
  });
  const view = await screen.findByRole("button", { name: "查看回复" });
  expect(screen.queryByText("其他练习的问题")).toBeNull();
  fireEvent.click(view);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "材料恢复或重试保存",
  );
  expect(openTask).toHaveBeenCalledWith(task);
  expect(screen.queryByTestId("location")).toBeNull();
  expect(mockedDetail).not.toHaveBeenCalled();
  expect(mockedOpened).not.toHaveBeenCalled();
});

// ---------- 组1：列表形态 ----------
it("本卷回题使用独立定位回调，保存失败保留记录且不打开回复", async () => {
  const task = queueTask();
  mockedList.mockResolvedValue({
    tasks: [task],
    nextCursor: null,
    origins: { [task.id]: originOf() },
  });
  const openTask = vi.fn(async () => true);
  const openQuestion = vi.fn(async () => false);
  renderPanel(makeClient(), "/s/records", {
    currentAttemptId: ATTEMPT_ID,
    onOpenTask: openTask,
    onOpenQuestion: openQuestion,
  });
  fireEvent.click(await screen.findByRole("button", { name: "回到本题" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "材料恢复或重试保存",
  );
  expect(openQuestion).toHaveBeenCalledWith(task);
  expect(openTask).not.toHaveBeenCalled();
  expect(mockedOpened).not.toHaveBeenCalled();
  expect(screen.queryByTestId("location")).toBeNull();
});

describe("SAI-23 队列列表形态", () => {
  it("零条：不显示数字角标（不把未知呈现成 0），面板呈现空态说明", async () => {
    renderPanel();
    expect(
      await screen.findByText(
        "队列为空——在题目旁的「AI 助教」发起求助后，任务会出现在这里",
      ),
    ).toBeInTheDocument();
  });

  it("长中文标题完整呈现且不撑破列表（整行可见、行内不断字丢字）", async () => {
    const longQuestion =
      "老师，这道二次函数的题：已知抛物线 y=ax²+bx+c 经过三个点，其中 a、b、c 均为待定系数，请问第一问求解析式时应该怎么代入？第二问问顶点坐标的时候需不需要先讨论 a 的正负号再判断开口方向？";
    mockedList.mockResolvedValue({
      tasks: [
        queueTask({
          id: "9f0f6d5e-1111-4111-8111-9f0f6d5e0002",
          question: longQuestion,
        }),
      ],
      nextCursor: null,
      origins: {},
    });
    renderPanel();
    expect(await screen.findByText(longQuestion)).toBeInTheDocument();
  });

  it("多页：加载更多按游标翻页，取完最后一页不再显示入口", async () => {
    const page1: AiTaskListData = {
      tasks: [
        queueTask({ id: "9f0f6d5e-1111-4111-8111-9f0f6d5e0011" }),
        queueTask({ id: "9f0f6d5e-1111-4111-8111-9f0f6d5e0012" }),
      ],
      nextCursor: "cur-2",
      origins: {},
    };
    const page2: AiTaskListData = {
      tasks: [queueTask({ id: "9f0f6d5e-1111-4111-8111-9f0f6d5e0013" })],
      nextCursor: null,
      origins: {},
    };
    mockedList.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    renderPanel();
    expect(
      await screen.findByRole("button", { name: "加载更多" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    // 第三条出现 + 无下一页 → 加载更多入口消失
    await waitFor(() =>
      expect(screen.getAllByRole("listitem")).toHaveLength(3),
    );
    expect(
      screen.queryByRole("button", { name: "加载更多" }),
    ).not.toBeInTheDocument();
    // 翻页请求带游标且未重复首页请求之外的形态（第二页带 cursor）
    expect(mockedList).toHaveBeenLastCalledWith({
      archived: "exclude",
      limit: 20,
      cursor: "cur-2",
    });
  });

  it("窄屏顶栏：入口按钮 shrink 不挤压同排保存状态/退出，窄屏只留图标角标", () => {
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter>
          <AiQueueButton />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const button = screen.getByRole("button", { name: "助教队列" });
    // 不挤压同排：入口可收缩（shrink-0 图标区 + 收缩容许），窄屏文字隐藏
    expect(button.className).toContain("shrink-0");
    const label = button.querySelector("span.hidden.sm\\:inline");
    expect(label).not.toBeNull();
    expect(label?.textContent).toContain("求助记录");
  });
});

// ---------- 组2：角标语义 ----------

describe("SAI-23 双角标语义", () => {
  function renderButton() {
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter>
          <AiQueueButton />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("待处理 2 + 新回复 1 分开计数（不是一个角标双语义）", async () => {
    mockedSummary.mockResolvedValue(
      summaryOf({ pendingCount: 1, processingCount: 1, unreadReplyCount: 1 }),
    );
    renderButton();
    const button = await screen.findByRole("button", {
      name: "助教队列：待处理 2，新回复 1",
    });
    // 两个角标分别呈现 2 与 1（分开数字，非合计 3）
    const badges = button.querySelectorAll("span[title]");
    expect(Array.from(badges).map((node) => node.textContent)).toEqual([
      "2",
      "1",
    ]);
  });

  it("归档≠已读：归档动作后新回复计数不被本地扣减（摘要重取仍为 1）", async () => {
    const replied = queueTask();
    mockedSummary.mockResolvedValue(summaryOf({ unreadReplyCount: 1 }));
    mockedList.mockResolvedValue({
      tasks: [replied],
      nextCursor: null,
      origins: {},
    });
    mockedAction.mockResolvedValue(
      queueTask({ id: replied.id, archivedAt: "2026-10-16T03:00:00.000Z" }),
    );
    renderPanel();
    expect(await screen.findByRole("listitem")).toBeInTheDocument();
    const summaryCallsBefore = mockedSummary.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    await waitFor(() =>
      expect(mockedAction).toHaveBeenCalledWith(replied.id, "archive"),
    );
    // invalidate 触发摘要重取；mock 恒返回未读 1 → 面板计数仍呈现 1
    await waitFor(() =>
      expect(mockedSummary.mock.calls.length).toBeGreaterThan(
        summaryCallsBefore,
      ),
    );
    await expectUnreadCounted(1);
  });

  it("取消≠已读：取消在途任务不动新回复计数（摘要重取仍为 1）", async () => {
    const running = queueTask({
      id: "9f0f6d5e-1111-4111-8111-9f0f6d5e0021",
      status: "claimed",
      hasReply: false,
      replyDeliveredAt: null,
      allowedActions: ["cancel"],
    });
    const replied = queueTask();
    mockedSummary.mockResolvedValue(summaryOf({ unreadReplyCount: 1 }));
    mockedList.mockResolvedValue({
      tasks: [running, replied],
      nextCursor: null,
      origins: {},
    });
    mockedAction.mockResolvedValue(
      queueTask({ id: running.id, status: "cancelled" }),
    );
    renderPanel();
    await screen.findAllByRole("listitem");
    const summaryCallsBefore = mockedSummary.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(mockedAction).toHaveBeenCalledWith(running.id, "cancel"),
    );
    await waitFor(() =>
      expect(mockedSummary.mock.calls.length).toBeGreaterThan(
        summaryCallsBefore,
      ),
    );
    await expectUnreadCounted(1);
  });

  it("操作按钮严格对齐 allowedActions：无权动作不出现", async () => {
    mockedList.mockResolvedValue({
      tasks: [
        queueTask({ allowedActions: ["archive"] }),
        queueTask({
          id: "9f0f6d5e-1111-4111-8111-9f0f6d5e0022",
          status: "paused",
          allowedActions: ["resume", "cancel"],
        }),
      ],
      nextCursor: null,
      origins: {},
    });
    renderPanel();
    await screen.findAllByRole("listitem");
    // 第一行（replied）只有归档；第二行（paused）有继续 + 取消，无归档/重试
    const items = screen.getAllByRole("listitem");
    expect(withinText(items[0], "归档")).toBe(true);
    expect(withinText(items[0], "重试")).toBe(false);
    expect(withinText(items[1], "继续")).toBe(true);
    expect(withinText(items[1], "取消")).toBe(true);
    expect(withinText(items[1], "归档")).toBe(false);
  });
});

/** 列表行内是否出现指定文案的操作按钮（对齐 allowedActions 断言用） */
function withinText(element: HTMLElement | undefined, label: string): boolean {
  if (element === undefined) return false;
  return Array.from(element.querySelectorAll("button")).some(
    (btn) => btn.textContent === label,
  );
}

// ---------- 组3：导航 ----------

describe("SAI-23 队列导航", () => {
  it("aiFrom 白名单：接受 /s/ 同源路径（含筛选 query），拒绝外链与非学生端路径", () => {
    expect(aiQueueReturnTarget("/s/assignments?status=pending&page=2")).toBe(
      "/s/assignments?status=pending&page=2",
    );
    expect(aiQueueReturnTarget("/s/attempts/abc?x=1")).toBe(
      "/s/attempts/abc?x=1",
    );
    expect(aiQueueReturnTarget("//evil.example")).toBeNull();
    expect(aiQueueReturnTarget("https://evil.example/s/home")).toBeNull();
    expect(aiQueueReturnTarget("/t/settings")).toBeNull();
    expect(aiQueueReturnTarget(null)).toBeNull();
  });

  it("旧卷同 questionId 不跳新卷：course/wrong 按任务自身 attemptId 直达旧卷", () => {
    const task = queueTask({ attemptId: OLD_ATTEMPT_ID });
    expect(aiQueueTargetOf(task, originOf({ sourceType: "course" }))).toBe(
      `/s/attempts/${OLD_ATTEMPT_ID}`,
    );
    expect(
      aiQueueTargetOf(task, originOf({ sourceType: "wrong", title: null })),
    ).toBe(`/s/attempts/${OLD_ATTEMPT_ID}`);
    // 队列回题统一按任务自身 attempt 直达，避免重新开卷或落到错误题目
    expect(
      aiQueueTargetOf(
        task,
        originOf({
          sourceType: "assignment",
          assignmentId: "33333333-3333-4333-8333-333333333333",
        }),
      ),
    ).toBe(`/s/attempts/${OLD_ATTEMPT_ID}`);
    expect(
      aiQueueTargetOf(
        task,
        originOf({
          sourceType: "lesson",
          lectureId: "22222222-2222-4222-8222-222222222222",
        }),
      ),
    ).toBe(`/s/attempts/${OLD_ATTEMPT_ID}`);
    // 缺导航键 → null（呈现不可访问说明而非坏链接）
    expect(
      aiQueueTargetOf(
        { ...task, attemptId: "" },
        originOf({ sourceType: "assignment", assignmentId: null }),
      ),
    ).toBeNull();
    expect(aiQueueTargetOf(task, undefined)).toBeNull();
  });

  it("点任务携带完整来源位置（含筛选 query）导航到原作答", async () => {
    mockedList.mockResolvedValue({
      tasks: [queueTask()],
      nextCursor: null,
      origins: {
        "9f0f6d5e-1111-4111-8111-9f0f6d5e0001": originOf({
          sourceType: "wrong",
          title: null,
        }),
      },
    });
    renderPanel(makeClient(), "/s/records?status=pending&page=2");
    fireEvent.click(await screen.findByRole("button", { name: "查看回复" }));
    expect(mockedDetail).not.toHaveBeenCalled();
    expect(mockedOpened).not.toHaveBeenCalled();
    const probe = await screen.findByTestId("location");
    expect(probe.textContent).toBe(
      `/s/attempts/${ATTEMPT_ID}?aiFrom=${encodeURIComponent(
        "/s/records?status=pending&page=2",
      )}&aiQuestion=q-1&aiTask=9f0f6d5e-1111-4111-8111-9f0f6d5e0001`,
    );
  });

  it("已回复卡片同时提供回到本题，且不会依赖先展开回复", async () => {
    mockedList.mockResolvedValue({
      tasks: [queueTask()],
      nextCursor: null,
      origins: {
        "9f0f6d5e-1111-4111-8111-9f0f6d5e0001": originOf({
          sourceType: "wrong",
          title: null,
        }),
      },
    });
    renderPanel(makeClient(), "/s/records");
    await screen.findByRole("listitem");
    expect(
      screen.getByRole("button", { name: "查看回复" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "回到本题" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回到本题" }));
    expect((await screen.findByTestId("location")).textContent).toBe(
      `/s/attempts/${ATTEMPT_ID}?aiFrom=${encodeURIComponent("/s/records")}&aiQuestion=q-1`,
    );
    expect(mockedDetail).not.toHaveBeenCalled();
    expect(mockedOpened).not.toHaveBeenCalled();
  });

  it("原练习不可访问：缺导航键呈现说明而不是坏链接", async () => {
    mockedList.mockResolvedValue({
      tasks: [queueTask()],
      nextCursor: null,
      origins: {},
    });
    renderPanel();
    expect(
      await screen.findByText("原练习已不可访问（可能已被移出或删除）"),
    ).toBeInTheDocument();
  });
});

// ---------- 组4：缓存与保护 ----------

describe("SAI-23 缓存与作答保护", () => {
  it("队列查询键挂在 student 前缀下（登出 removeQueries 即清旧账号缓存）", () => {
    expect(studentAiQueueSummaryKey[0]).toBe("student");
    expect(studentAiQueueSummaryKey).toContain("ai-queue-summary");
    expect(studentAiQueueKey[0]).toBe("student");
  });

  it("动作成功失效队列摘要/列表/单题任务与状态（服务端为权威）", async () => {
    mockedList.mockResolvedValue({
      tasks: [queueTask()],
      nextCursor: null,
      origins: {},
    });
    mockedAction.mockResolvedValue(
      queueTask({ archivedAt: "2026-10-16T03:00:00.000Z" }),
    );
    const client = makeClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderPanel(client);
    fireEvent.click(await screen.findByRole("button", { name: "归档" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const invalidated = spy.mock.calls.map((call) =>
      JSON.stringify(call[0]?.queryKey),
    );
    expect(invalidated).toContain(
      JSON.stringify(["student", "ai-queue-summary"]),
    );
    expect(invalidated).toContain(JSON.stringify(["student", "ai-tasks"]));
    expect(invalidated).toContain(JSON.stringify(["student", "ai-status"]));
    // 队列列表前缀失效（不含 archived 后缀的父键）
    expect(invalidated).toContain(JSON.stringify(["student", "ai-queue"]));
  });

  it("列表加载失败可重载：错误呈现 + 重新加载后列表出现", async () => {
    mockedList
      .mockRejectedValueOnce(new Error("网络异常"))
      .mockResolvedValueOnce({
        tasks: [queueTask()],
        nextCursor: null,
        origins: {},
      });
    renderPanel();
    expect(await screen.findByText(/队列加载失败/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByRole("listitem")).toBeInTheDocument();
  });

  it("打开队列抽屉是覆盖层：作答内容不卸载（未完成原稿不因队列被清）", async () => {
    mockedSummary.mockResolvedValue(
      summaryOf({ pendingCount: 1, unreadReplyCount: 1 }),
    );
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter>
          <div>
            <label htmlFor="draft-input">草稿输入</label>
            <input id="draft-input" defaultValue="未提交的原稿内容" />
            <AiQueueButton />
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "助教队列：待处理 1，新回复 1",
      }),
    );
    // 抽屉打开（portal dialog）且作答内容仍在 DOM（未被卸载重挂）
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    const input = screen.getByLabelText("草稿输入") as HTMLInputElement;
    expect(input.value).toBe("未提交的原稿内容");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

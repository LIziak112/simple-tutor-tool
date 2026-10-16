import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AiBatchCreateData } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStudentAiBatchReviewApi,
  createStudentAiShareTicketApi,
  fetchStudentAiConnectionsApi,
} from "@/lib/api";
import type { AiBatchReviewQuestion } from "./AiBatchReviewPanel";
import { AiBatchReviewPanel } from "./AiBatchReviewPanel";
import {
  inappAiConnectionFixture,
  linkAiConnectionFixture,
} from "./student-ai-test-utils";

/**
 * SAI-31 批量复盘面板测试（B16「先测」的前端侧）：
 * - 分组与默认勾选：仅已判错默认选；待批需主动勾选（不称错题）；判对不可选；
 * - 超单批上限（30）客户端拦截，不发请求；未公布/无连接如实拦下；
 * - 一次确认才创建；载荷只含勾选题 + 通道 + 诉求 + 幂等键；
 * - 部分成功后「仅重试失败项」：重试载荷只含失败题且换新幂等键，成功项不重发；
 * - link 通道只有外部查看状态：逐题可复制链接，不出现「已回复」口径；
 * - 重开面板按最新数据重建勾选，不凭旧筛选。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    createStudentAiBatchReviewApi: vi.fn(),
    createStudentAiShareTicketApi: vi.fn(),
    fetchStudentAiConnectionsApi: vi.fn(),
  };
});

const batchApi = vi.mocked(createStudentAiBatchReviewApi);
const shareApi = vi.mocked(createStudentAiShareTicketApi);
const connectionsApi = vi.mocked(fetchStudentAiConnectionsApi);

function question(
  questionId: string,
  finalCorrect: boolean | null,
  label: string = `第 ${questionId.replace("q", "")} 题`,
): AiBatchReviewQuestion {
  return { questionId, label, finalCorrect };
}

function itemOf(
  questionId: string,
  outcome: "created" | "already_exists" | "paused" | "failed",
  error: string | null = null,
  taskId: string | null = null,
) {
  return {
    attemptId: "attempt-1",
    questionId,
    outcome,
    taskId: taskId ?? (outcome === "failed" ? null : `task-${questionId}`),
    error,
  };
}

function batchData(...items: ReturnType<typeof itemOf>[]): AiBatchCreateData {
  return {
    items,
    summary: {
      created: items.filter((item) => item.outcome === "created").length,
      alreadyExists: items.filter((item) => item.outcome === "already_exists")
        .length,
      paused: items.filter((item) => item.outcome === "paused").length,
      failed: items.filter((item) => item.outcome === "failed").length,
    },
  };
}

function renderPanel(
  questions: readonly AiBatchReviewQuestion[],
  options: { released?: boolean } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AiBatchReviewPanelForTest
        questions={questions}
        released={options.released ?? true}
      />
    </QueryClientProvider>,
  );
}

/** 直接以打开态挂载面板（重开重建用例经卸载重挂覆盖） */
function AiBatchReviewPanelForTest(props: {
  questions: readonly AiBatchReviewQuestion[];
  released: boolean;
}) {
  return (
    <AiBatchReviewPanel
      attemptId="attempt-1"
      questions={props.questions}
      released={props.released}
      open
      onOpenChange={() => {}}
    />
  );
}

const INAPP_CONNECTIONS = {
  connections: [inappAiConnectionFixture()],
};

const MULTI_CONNECTIONS = {
  connections: [inappAiConnectionFixture(), linkAiConnectionFixture()],
};

/** 第 n 次批量请求载荷的强类型取回（noUncheckedIndexedAccess 下断言助手） */
function payloadOf(call: number) {
  const entry = batchApi.mock.calls[call];
  if (entry === undefined) {
    throw new Error(`测试前提失败：第 ${call} 次批量请求不存在`);
  }
  return entry[0];
}

beforeEach(() => {
  batchApi.mockReset();
  shareApi.mockReset();
  connectionsApi.mockReset().mockResolvedValue(INAPP_CONNECTIONS);
});

afterEach(() => {
  cleanup();
});

async function submit() {
  // 连接查询异步就位前提交按钮禁用（effectiveChannel 未知）：先等可用
  const button = await screen.findByRole("button", {
    name: /加入 AI 复盘队列/,
  });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => {
    expect(screen.getByText(/成功 \d+/)).toBeInTheDocument();
  });
}

describe("SAI-31 批量面板：分组与默认勾选（先测②）", () => {
  it("仅判错题默认勾选；待批需主动勾选且不称错题；判对不可选", async () => {
    renderPanel([
      question("q1", false),
      question("q2", false),
      question("q3", null),
      question("q4", true),
    ]);
    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: "第 1 题" })).toBeChecked();
    });
    expect(screen.getByRole("checkbox", { name: "第 2 题" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "第 3 题" })).not.toBeChecked();
    // 判对题不提供勾选框（结构上不可选，不只靠默认值）
    expect(screen.queryByRole("checkbox", { name: "第 4 题" })).toBeNull();
    expect(screen.getByText(/已判对/)).toBeInTheDocument();
    // 待批分组不称错题
    expect(screen.getByText(/待批改/)).toBeInTheDocument();
    expect(screen.getByText(/不算错题/)).toBeInTheDocument();

    // 一次确认才创建：载荷只含默认勾选的判错题
    batchApi.mockResolvedValue(
      batchData(itemOf("q1", "created"), itemOf("q2", "created")),
    );
    await submit();
    expect(batchApi).toHaveBeenCalledTimes(1);
    const payload = payloadOf(0);
    expect(payload.items.map((item) => item.questionId).sort()).toEqual([
      "q1",
      "q2",
    ]);
    expect(payload.channel).toBe("inapp");
    expect(payload.mutationId).toMatch(/.+/);
    expect(payload.question.length).toBeGreaterThan(0);

    // 主动勾选待批题后，待批项进入载荷
    cleanup();
    batchApi.mockReset();
    renderPanel([
      question("q1", false),
      question("q2", false),
      question("q3", null),
      question("q4", true),
    ]);
    await waitFor(() => {
      expect(
        screen.getByRole("checkbox", { name: "第 3 题" }),
      ).not.toBeChecked();
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "第 3 题" }));
    batchApi.mockResolvedValue(
      batchData(
        itemOf("q1", "created"),
        itemOf("q2", "created"),
        itemOf("q3", "created"),
      ),
    );
    await submit();
    expect(
      payloadOf(0)
        .items.map((item) => item.questionId)
        .sort(),
    ).toEqual(["q1", "q2", "q3"]);
  });
});

describe("SAI-31 批量面板：上限与前置拦截（先测①）", () => {
  it("超过 30 题拦截提交且不发请求；减到上限内恢复可提交", async () => {
    const many = Array.from({ length: 35 }, (_, i) =>
      question(`q${i + 1}`, false, `第 ${i + 1} 题`),
    );
    renderPanel(many);
    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: "第 35 题" })).toBeChecked();
    });
    expect(
      screen.getByRole("button", { name: /加入 AI 复盘队列/ }),
    ).toBeDisabled();
    expect(screen.getByText(/单次批量最多 30 道题/)).toBeInTheDocument();

    // 取消 5 题后恢复可提交，载荷恰 30 题
    for (let i = 31; i <= 35; i++) {
      fireEvent.click(screen.getByRole("checkbox", { name: `第 ${i} 题` }));
    }
    const submitButton = screen.getByRole("button", {
      name: /加入 AI 复盘队列/,
    });
    expect(submitButton).toBeEnabled();
    batchApi.mockResolvedValue(
      batchData(
        ...Array.from({ length: 30 }, (_, i) => itemOf(`q${i + 1}`, "created")),
      ),
    );
    await submit();
    expect(payloadOf(0).items).toHaveLength(30);
  });

  it("答案未公布：横幅提示并禁用提交，零请求", async () => {
    renderPanel([question("q1", null)], { released: false });
    await waitFor(() => {
      expect(screen.getByText(/答案未公布/)).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /加入 AI 复盘队列/ }),
    ).toBeDisabled();
    expect(batchApi).not.toHaveBeenCalled();
  });

  it("无可用连接：引导先完成设置并禁用提交", async () => {
    connectionsApi.mockResolvedValue({ connections: [] });
    renderPanel([question("q1", false)]);
    await waitFor(() => {
      expect(screen.getByText(/还没有可用的 AI 连接/)).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /加入 AI 复盘队列/ }),
    ).toBeDisabled();
    expect(batchApi).not.toHaveBeenCalled();
  });
});

describe("SAI-31 批量面板：费用语义与部分成功重试（先测③ 需求§8）", () => {
  it("页内通道明示 N 次 AI 调用；链接通道明示平台不自动收到回复", async () => {
    renderPanel([question("q1", false), question("q2", false)]);
    await waitFor(() => {
      expect(screen.getByText(/共 2 次 AI 调用/)).toBeInTheDocument();
    });
    expect(screen.getByText(/每题一份上下文/)).toBeInTheDocument();
    cleanup();

    connectionsApi.mockResolvedValue(MULTI_CONNECTIONS);
    renderPanel([question("q1", false)]);
    const linkRadio = await screen.findByRole("radio", { name: /上下文链接/ });
    fireEvent.click(linkRadio);
    expect(screen.getByText(/平台不会自动收到回复/)).toBeInTheDocument();
  });

  it("三题一失败：另两题成功；仅重试失败项，成功项不重发", async () => {
    renderPanel([
      question("q1", false),
      question("q2", false),
      question("q3", false),
    ]);
    batchApi
      .mockResolvedValueOnce(
        batchData(
          itemOf("q1", "created"),
          itemOf("q2", "failed", "快照缺件"),
          itemOf("q3", "created"),
        ),
      )
      .mockResolvedValueOnce(batchData(itemOf("q2", "created")));
    await submit();

    // 逐项状态准确：两成功一失败（失败带服务端原因）
    expect(screen.getAllByText("已加入")).toHaveLength(2);
    expect(screen.getByText(/快照缺件/)).toBeInTheDocument();
    expect(screen.getByText(/失败 1/)).toBeInTheDocument();

    const firstMutationId = payloadOf(0).mutationId;
    fireEvent.click(
      screen.getByRole("button", { name: /仅重试失败项（1 题）/ }),
    );
    await waitFor(() => {
      expect(screen.getByText(/成功 3/)).toBeInTheDocument();
    });

    // 重试载荷只含失败题 + 新幂等键；成功项没有第二次请求
    expect(batchApi).toHaveBeenCalledTimes(2);
    const retryPayload = payloadOf(1);
    expect(retryPayload.items.map((item) => item.questionId)).toEqual(["q2"]);
    expect(retryPayload.mutationId).not.toBe(firstMutationId);
    expect(screen.queryByRole("button", { name: /仅重试失败项/ })).toBeNull();
  });
});

describe("SAI-31 批量面板：link 通道交付面（先测⑥）", () => {
  it("结果只有外部查看状态；逐题可复制链接；不出现「已回复」", async () => {
    connectionsApi.mockResolvedValue(MULTI_CONNECTIONS);
    renderPanel([question("q1", false), question("q2", false)]);
    const linkRadio = await screen.findByRole("radio", { name: /上下文链接/ });
    fireEvent.click(linkRadio);
    batchApi.mockResolvedValue(
      batchData(itemOf("q1", "created"), itemOf("q2", "created")),
    );
    await submit();

    // 批量创建 ≠ 已回复：结果区不出现「已回复」口径
    expect(screen.queryByText(/已回复/)).toBeNull();
    expect(screen.getByText(/回复在外部 AI/)).toBeInTheDocument();

    // 逐题复制链接（票据按题生成，任务 id 对应本题）
    shareApi.mockResolvedValue({
      ticketUrl: "http://localhost/share/tok-q1",
      snapshotAt: "2026-10-16T00:00:00.000Z",
      expiresAt: "2026-10-17T00:00:00.000Z",
    });
    const copyButtons = screen.getAllByRole("button", { name: /复制链接/ });
    const firstCopy = copyButtons[0];
    if (firstCopy === undefined)
      throw new Error("测试前提失败：应有复制链接按钮");
    fireEvent.click(firstCopy);
    await waitFor(() => {
      expect(shareApi).toHaveBeenCalledWith("task-q1");
    });
    // 链接 URL 就地展示（自动复制失败时的手动复制兜底）
    expect(
      screen.getByText(/http:\/\/localhost\/share\/tok-q1/),
    ).toBeInTheDocument();
  });
});

describe("SAI-31 批量面板：重开重建（先测⑦ 前端）", () => {
  it("面板重开按最新数据重建勾选，不凭旧筛选", async () => {
    const { unmount } = renderPanel([
      question("q1", false),
      question("q2", false),
    ]);
    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: "第 2 题" })).toBeChecked();
    });
    unmount();

    // 重进：判分变化后（q2 已判对）默认勾选只剩 q1
    renderPanel([question("q1", false), question("q2", true)]);
    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: "第 1 题" })).toBeChecked();
    });
    expect(screen.queryByRole("checkbox", { name: "第 2 题" })).toBeNull();
  });
});

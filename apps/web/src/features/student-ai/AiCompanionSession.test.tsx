import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  AttemptQuestionPublic,
  StudentQuickButtonsData,
} from "@tutor/contract";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStudentAiTaskApi,
  fetchStudentAiStatusApi,
  fetchStudentQuickButtonsApi,
  listStudentAiTasksApi,
} from "@/lib/api";
import {
  AiCompanionComposer,
  AiCompanionQuickButtons,
  AiCompanionStatusPanel,
} from "./AiCompanionSession";
import { connectedAiStatus } from "./student-ai-test-utils";
import {
  type AiSendController,
  useAiSendController,
} from "./use-ai-send-controller";

/**
 * SAI-20 伴学栏接线组件测试：真实发送控制器 + mock API 层（路由往返见
 * route-integration；布局壳见 AiCompanionRail.test）。覆盖批次完成条件
 * 「真实 task API 联调，非静态演示按钮」的组件侧：
 * - 打开只读状态不发送；模式/通道如实呈现；
 * - 快捷按钮点击即发（用其 prompt 与附件偏好），停用项不出现；
 * - 附件选择按题型呈现草稿/正式手写；发送按钮按通道换文案；
 * - 需要设置时给入口且不虚报可发送；空正文被拦给提示。
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
  };
});
vi.mock("@/features/export/ai-material-capture", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/export/ai-material-capture")
    >();
  return { ...actual, captureAiQuestionMaterials: vi.fn() };
});

const mockedStatus = vi.mocked(fetchStudentAiStatusApi);
const mockedCreate = vi.mocked(createStudentAiTaskApi);
const mockedList = vi.mocked(listStudentAiTasksApi);
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

const QUICK_BUTTONS: StudentQuickButtonsData = {
  updatedAt: "2026-10-16T00:00:00.000Z",
  buttons: [
    {
      id: "check-steps",
      name: "查当前步骤",
      prompt: "请检查我当前书写的步骤",
      orderIndex: 1,
      enabled: true,
      attachmentPref: { annotation: true, draft: true, formalInk: false },
    },
    {
      id: "hint-next",
      name: "启发下一步",
      prompt: "请只启发下一步",
      orderIndex: 2,
      enabled: true,
      attachmentPref: { annotation: false, draft: false, formalInk: false },
    },
    {
      id: "disabled-one",
      name: "停用按钮",
      prompt: "不该出现",
      orderIndex: 3,
      enabled: false,
      attachmentPref: { annotation: false, draft: false, formalInk: false },
    },
  ],
};

/** 组件外拿控制器（bind 是显式动作，不在 harness 里自动做） */
const captured: { send: AiSendController | null } = { send: null };

function SessionHarness({ paperLabel = "草稿" }: { paperLabel?: string }) {
  // 惰性初始化：状态变化重渲染不重建 client
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <BoundHarness paperLabel={paperLabel} />
    </QueryClientProvider>
  );
}

function BoundHarness({ paperLabel }: { paperLabel: string }) {
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
      <AiCompanionStatusPanel send={send} settingsHref="/s/settings/ai" />
      <AiCompanionQuickButtons send={send} />
      <AiCompanionComposer send={send} paperLabel={paperLabel} />
    </div>
  );
}

/** 绑定 A 题并等状态就绪 */
async function openBound() {
  await act(async () => {
    captured.send?.bind(QUESTION.id);
  });
  await waitFor(() => expect(captured.send?.status).toBeDefined());
}

beforeEach(() => {
  vi.clearAllMocks();
  captured.send = null;
  vi.mocked(mockedStatus).mockResolvedValue(connectedAiStatus());
  vi.mocked(mockedList).mockResolvedValue({ tasks: [], nextCursor: null });
  vi.mocked(mockedCreate).mockResolvedValue({
    id: "task-1",
    attemptId: "attempt-1",
    questionId: "q-a",
    questionRevisionId: QUESTION.questionRevisionId,
    channel: "inapp",
    status: "created",
    modeAtSend: "open_study",
    question: "问题",
    beforeSubmit: true,
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
  });
  vi.mocked(mockedQuickButtons).mockResolvedValue(QUICK_BUTTONS);
});

describe("AiCompanionSession 接线组件（SAI-20）", () => {
  it("状态区如实呈现模式与默认通道；仅打开查看不产生任何任务调用", async () => {
    render(<SessionHarness />);
    await openBound();
    expect(await screen.findByText(/当前：开放伴学/)).toBeInTheDocument();
    expect(screen.getByText(/默认：页内 AI/)).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedList).toHaveBeenCalledTimes(1); // 打开只载入历史
  });

  it("需要设置（无连接）时给设置入口；主动作如实禁用", async () => {
    vi.mocked(mockedStatus).mockResolvedValue(
      connectedAiStatus({
        channelDefault: null,
        connectionReady: false,
        firstUseRequired: true,
      }),
    );
    render(<SessionHarness />);
    await openBound();
    expect(
      await screen.findByRole("link", { name: "去设置连接" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("快捷按钮渲染启用项（停用不出现），点击即发携带其 prompt 与附件偏好", async () => {
    render(<SessionHarness />);
    await openBound();
    expect(
      await screen.findByRole("button", { name: "查当前步骤" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "停用按钮" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "查当前步骤" }));
    });
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    expect(vi.mocked(mockedCreate).mock.calls[0]?.[0].question).toBe(
      "请检查我当前书写的步骤",
    );
    expect(vi.mocked(mockedCreate).mock.calls[0]?.[0].quickButtonId).toBe(
      "check-steps",
    );
  });

  it("输入区：附件选择按题型呈现（草稿/正式手写），主按钮按通道换文案", async () => {
    render(<SessionHarness paperLabel="正式手写" />);
    await openBound();
    expect(
      await screen.findByRole("button", { name: "发送" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("正式手写")).toBeInTheDocument();
    expect(screen.queryByLabelText("草稿")).not.toBeInTheDocument();
    // 换通道到 MCP：主按钮文案切换（换通道本身不重发）
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "MCP 工具" }));
    });
    expect(
      screen.getByRole("button", { name: "加入求助队列" }),
    ).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("输入并发送走草稿正文；空正文被拦给提示", async () => {
    render(<SessionHarness />);
    await openBound();
    const sendButton = await screen.findByRole("button", { name: "发送" });
    await act(async () => {
      fireEvent.click(sendButton);
    });
    expect(
      await screen.findByText("先写一下你的问题，再点发送"),
    ).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("补充问题"), {
        target: { value: "帮我讲解思路" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
    });
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    expect(vi.mocked(mockedCreate).mock.calls[0]?.[0].question).toBe(
      "帮我讲解思路",
    );
  });
});

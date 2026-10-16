import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  AiStatusData,
  AiTaskPublic,
  AttemptQuestionPublic,
  StudentQuickButton,
} from "@tutor/contract";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiCaptureError,
  type AiCaptureSnapshot,
  captureAiQuestionMaterials,
} from "@/features/export/ai-material-capture";
import {
  createStudentAiTaskApi,
  fetchStudentAiStatusApi,
  listStudentAiTasksApi,
  uploadStudentAiTaskMaterialsApi,
} from "@/lib/api";
import { useAiSendController } from "./use-ai-send-controller";

/**
 * SAI-20 单题发送控制器测试（B11「先测」6 条逐条 + 幂等/通道语义）。
 * API 层与材料采集 mock；真实路由往返见 route-integration。
 *
 * 先测口径（批次文件）：
 * ① 只打开、滚动、看历史、换通道没有 create/provider 调用；
 * ② A题打字→点B题→回A：两题文字与附件不串；
 * ③ 连接未设→完成设置→返回：输入在、调用数仍为 0；
 * ④ 连续点三次只建一任务；失败重试不生成重复收费动作（同幂等键）；
 * ⑤ 刚写后发送包含最后正文，材料失败保留所有状态；
 * ⑥ 模式被老师关闭、换账号（换 attempt）途中迟到结果不进入新题。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentAiStatusApi: vi.fn(),
    createStudentAiTaskApi: vi.fn(),
    listStudentAiTasksApi: vi.fn(),
    uploadStudentAiTaskMaterialsApi: vi.fn(),
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
const mockedUpload = vi.mocked(uploadStudentAiTaskMaterialsApi);
const mockedCapture = vi.mocked(captureAiQuestionMaterials);

const QUESTION_A: AttemptQuestionPublic = {
  id: "q-a",
  questionRevisionId: "11111111-1111-4111-8111-111111111111",
  type: "judge",
  stemMd: "A 题面",
  knowledge: [],
  difficulty: 1,
  hintCount: 0,
};
const QUESTION_B: AttemptQuestionPublic = {
  ...QUESTION_A,
  id: "q-b",
  questionRevisionId: "22222222-2222-4222-8222-222222222222",
};

/** 已连接可用状态（inapp 默认、开放伴学、未完成） */
function connectedStatus(over: Partial<AiStatusData> = {}): AiStatusData {
  return {
    resolution: { usable: true, mode: "open_study", reason: "teacher_default" },
    completed: false,
    channelDefault: "inapp",
    connectionReady: true,
    firstUseRequired: false,
    taskSummary: { total: 0, active: 0, unreadReplies: 0 },
    ...over,
  };
}

function snapshotOf(
  question: AttemptQuestionPublic,
  pages: {
    kind: "annotation" | "draft" | "formal_ink";
    pageIndex: number;
  }[] = [{ kind: "annotation", pageIndex: 0 }],
): AiCaptureSnapshot {
  return {
    version: 1,
    attemptId: "attempt-1",
    questionId: question.id,
    questionRevisionId: question.questionRevisionId,
    phase: "scratch",
    capturedAt: Date.now(),
    selection: { annotation: true, draft: false, formalInk: false },
    pages: pages.map((page) => ({
      ...page,
      width: 320,
      height: 200,
      byteSize: 100,
      blob: new Blob(["png"], { type: "image/png" }),
    })),
  };
}

function taskOf(id: string): AiTaskPublic {
  return {
    id,
    attemptId: "attempt-1",
    questionId: "q-a",
    questionRevisionId: QUESTION_A.questionRevisionId,
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
  };
}

const QUICK: StudentQuickButton = {
  id: "check-steps",
  name: "查当前步骤",
  prompt: "请检查我当前书写的步骤",
  orderIndex: 1,
  enabled: true,
  attachmentPref: { annotation: true, draft: true, formalInk: true },
};

interface Config {
  attemptId?: string;
  active?: boolean;
}

function renderController(over: Config = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const base = {
    attemptId: over.attemptId ?? "attempt-1",
    questions: [QUESTION_A, QUESTION_B],
    isHandwritten: () => false,
    surfaceOf: () => null,
    flush: async () => {},
    titleOf: () => "第 1 题 · 练习",
    active: over.active ?? true,
  };
  const view = renderHook(
    (next: Partial<typeof base> = {}) =>
      useAiSendController({ ...base, ...next }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  return { ...view, client };
}

/** 绑定 A 题并等状态查询就绪（打开即载入，不发送；模式可用性由用例自断言） */
async function openOnA(view: ReturnType<typeof renderController>) {
  await act(async () => {
    view.result.current.bind(QUESTION_A.id);
  });
  await waitFor(() => expect(view.result.current.status).toBeDefined());
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedStatus.mockResolvedValue(connectedStatus());
  mockedList.mockResolvedValue({ tasks: [], nextCursor: null });
  mockedCreate.mockResolvedValue(taskOf("task-1"));
  mockedUpload.mockResolvedValue({
    materials: [],
    totalBytes: 0,
  });
  mockedCapture.mockResolvedValue(snapshotOf(QUESTION_A));
});

describe("useAiSendController（SAI-20 先测 6 条）", () => {
  it("先测①：只打开、看历史、换通道没有 create 与采集调用", async () => {
    const view = renderController();
    await openOnA(view);
    // 滚动不重绑：绑定保持 A（控制器输入里没有「当前题」，绑定只在显式 bind 时变）
    expect(view.result.current.boundQuestionId).toBe(QUESTION_A.id);
    expect(mockedStatus).toHaveBeenCalledWith("attempt-1", QUESTION_A.id);
    expect(mockedList).toHaveBeenCalled();
    // 换通道：本地选择切换，零出站
    await act(async () => {
      view.result.current.setChannelOverride("mcp");
    });
    expect(view.result.current.channelOverride).toBe("mcp");
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedCapture).not.toHaveBeenCalled();
  });

  it("先测②：A题打字→点B题→回A，两题文字与附件不串", async () => {
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      view.result.current.setText("A 题的问题");
      view.result.current.toggleMaterial("draft");
      view.result.current.selectPreset("check-steps");
    });
    await act(async () => {
      view.result.current.bind(QUESTION_B.id);
    });
    await act(async () => {
      view.result.current.setText("B 题的问题");
      view.result.current.toggleMaterial("annotation");
    });
    const draftB = view.result.current.draftOf(QUESTION_B.id);
    expect(draftB.text).toBe("B 题的问题");
    expect(draftB.selection).toEqual({
      annotation: true,
      draft: false,
      formalInk: false,
    });
    expect(draftB.presetId).toBeNull();
    // 回 A：A 的输入原样恢复
    await act(async () => {
      view.result.current.bind(QUESTION_A.id);
    });
    const draftA = view.result.current.draftOf(QUESTION_A.id);
    expect(draftA.text).toBe("A 题的问题");
    expect(draftA.selection).toEqual({
      annotation: false,
      draft: true,
      formalInk: false,
    });
    expect(draftA.presetId).toBe("check-steps");
  });

  it("先测③：连接未设→完成设置→返回：输入在、调用数仍为 0（回题不自动出站）", async () => {
    mockedStatus.mockResolvedValue(
      connectedStatus({
        channelDefault: null,
        connectionReady: false,
        firstUseRequired: true,
      }),
    );
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      view.result.current.setText("还没连接时写的问题");
    });
    await act(async () => {
      await view.result.current.send();
    });
    expect(view.result.current.sendState.phase).toBe("failed");
    expect(view.result.current.needsSetup).toBe(true);
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedCapture).not.toHaveBeenCalled();
    // 在设置页完成连接：状态查询返回已连接（模拟 invalidate 后重取）
    mockedStatus.mockResolvedValue(connectedStatus());
    await act(async () => {
      view.result.current.refreshStatus();
    });
    await waitFor(() => expect(view.result.current.needsSetup).toBe(false));
    // 输入保留，且没有自动发送
    expect(view.result.current.draftOf(QUESTION_A.id).text).toBe(
      "还没连接时写的问题",
    );
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedCapture).not.toHaveBeenCalled();
  });

  it("先测④：连续点三次只建一任务；失败重试复用同一幂等键", async () => {
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      view.result.current.setText("求讲解");
    });
    let resolveCreate: (task: AiTaskPublic) => void = () => {};
    mockedCreate.mockReturnValue(
      new Promise<AiTaskPublic>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    // 连续三次点击（在途）：一次动作
    await act(async () => {
      void view.result.current.send();
      void view.result.current.send();
      void view.result.current.send();
    });
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveCreate(taskOf("task-1"));
    });
    await waitFor(() =>
      expect(view.result.current.sendState.phase).toBe("sent"),
    );
    // 失败重试：create 拒绝一次后同正文重发，mutationId 不变（服务端幂等去重）
    mockedCreate.mockRejectedValueOnce(new Error("网络中断"));
    await act(async () => {
      view.result.current.setText("求讲解");
    });
    await act(async () => {
      await view.result.current.send();
    });
    expect(view.result.current.sendState.phase).toBe("failed");
    expect(view.result.current.draftOf(QUESTION_A.id).text).toBe("求讲解");
    await act(async () => {
      await view.result.current.send();
    });
    expect(view.result.current.sendState.phase).toBe("sent");
    const calls = mockedCreate.mock.calls.map(
      (call) => call[0].mutationId as string,
    );
    // 一次动作一键：三连击=1 键，失败重试=新键（而非复活成功动作的旧键）
    expect(new Set(calls).size).toBe(2);
    const retryPair = calls.slice(-2);
    expect(retryPair[0]).toBe(retryPair[1]); // 失败重试沿用同一键（同键重放=幂等）
  });

  it("先测⑤：刚写后发送包含最后正文；材料失败保留所有状态且不建任务", async () => {
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      view.result.current.setText("旧正文");
      view.result.current.toggleMaterial("annotation");
      view.result.current.selectPreset("check-steps");
    });
    mockedCapture.mockRejectedValue(
      new AiCaptureError(
        "题面圈画读取失败，请重试",
        "annotation",
        "annotation",
      ),
    );
    await act(async () => {
      view.result.current.setText("最新正文");
      await view.result.current.send();
    });
    expect(view.result.current.sendState.phase).toBe("failed");
    expect(view.result.current.sendState.message).toContain("圈画");
    const draft = view.result.current.draftOf(QUESTION_A.id);
    expect(draft.text).toBe("最新正文");
    expect(draft.selection.annotation).toBe(true);
    expect(draft.presetId).toBe("check-steps");
    expect(mockedCreate).not.toHaveBeenCalled();
    // 采集恢复后重试：发送的是最后正文
    mockedCapture.mockResolvedValue(snapshotOf(QUESTION_A));
    await act(async () => {
      await view.result.current.send();
    });
    expect(mockedCreate.mock.calls[0]?.[0].question).toBe("最新正文");
    expect(mockedUpload).toHaveBeenCalledTimes(1);
    // 成功后清理策略：正文清空（已随任务发出），附件选择与 preset 保留
    const after = view.result.current.draftOf(QUESTION_A.id);
    expect(after.text).toBe("");
    expect(after.selection.annotation).toBe(true);
    expect(after.presetId).toBe("check-steps");
  });

  it("先测⑥：模式被老师关闭给原因并刷新；换账号途中迟到结果不进入新题", async () => {
    // 模式关闭：发送被拦，给原因，并刷新状态（教师刚改设置立即生效）
    mockedStatus.mockResolvedValue(
      connectedStatus({
        resolution: { usable: false, reason: "student_closed" },
      }),
    );
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      view.result.current.setText("求启发");
    });
    await act(async () => {
      await view.result.current.send();
    });
    expect(view.result.current.sendState.phase).toBe("failed");
    // 学生视角原因文案 + 刷新提示（student_closed 对应「完成后可用」）
    expect(view.result.current.sendState.message).toContain("完成后可用");
    expect(mockedCreate).not.toHaveBeenCalled();
    // 已触发刷新（invalidate 异步重取，教师刚改设置立即生效）
    await waitFor(() =>
      expect(mockedStatus.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    view.unmount();

    // 换账号（换 attempt）：在途结果迟到不得写进新题
    mockedStatus.mockResolvedValue(connectedStatus());
    const view2 = renderController();
    await openOnA(view2);
    await act(async () => {
      view2.result.current.setText("第一次的问题");
    });
    let resolveCreate: (task: AiTaskPublic) => void = () => {};
    mockedCreate.mockReturnValue(
      new Promise<AiTaskPublic>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    // 在途即切换：send 不 await（create 悬置待后面的 resolve，await 会卡死 act）
    await act(async () => {
      void view2.result.current.send();
    });
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    // 切换到另一份作答（账号/来源变化）：本地状态按新作答隔离
    await act(async () => {
      view2.rerender({ attemptId: "attempt-2" });
    });
    expect(view2.result.current.draftOf(QUESTION_A.id).text).toBe("");
    // 新作答中重新绑定本题再输入（attempt 切换后未绑定时输入无处安放）
    await act(async () => {
      view2.result.current.bind(QUESTION_A.id);
    });
    await act(async () => {
      view2.result.current.setText("新作答的问题");
    });
    // 旧作答的迟到结果落地：不写状态、不清新作答输入
    await act(async () => {
      resolveCreate(taskOf("task-late"));
    });
    expect(view2.result.current.sendState.phase).not.toBe("sent");
    expect(view2.result.current.draftOf(QUESTION_A.id).text).toBe(
      "新作答的问题",
    );
  });
});

describe("useAiSendController（幂等与通道语义补充）", () => {
  it("快捷按钮用其 prompt 与附件默认即发；主按钮走草稿正文与当前选择", async () => {
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      view.result.current.setText("自由输入不会被快捷按钮带走");
      view.result.current.toggleMaterial("draft");
    });
    await act(async () => {
      await view.result.current.send({ quick: QUICK });
    });
    expect(mockedCapture).toHaveBeenCalledTimes(1);
    const captureInput = mockedCapture.mock.calls[0]?.[0];
    expect(captureInput?.selection).toEqual(QUICK.attachmentPref);
    expect(mockedCreate.mock.calls[0]?.[0].question).toBe(QUICK.prompt);
    expect(mockedCreate.mock.calls[0]?.[0].quickButtonId).toBe(QUICK.id);
    // 单次改附件只影响这次：草稿自身选择不被快捷按钮回写
    expect(view.result.current.draftOf(QUESTION_A.id).selection.draft).toBe(
      true,
    );
    expect(
      view.result.current.draftOf(QUESTION_A.id).selection.annotation,
    ).toBe(false);
  });

  it("通道选择影响本次发送通道；link 通道如实拦截（建设中，零出站）", async () => {
    const view = renderController();
    await openOnA(view);
    // 真实 UI 里选通道与点发送是两次独立交互（之间必有渲染提交）；
    // 同一 act 内连调会读到旧闭包，故拆开
    await act(async () => {
      view.result.current.setChannelOverride("mcp");
    });
    await act(async () => {
      await view.result.current.send({ quick: QUICK });
    });
    expect(mockedCreate.mock.calls[0]?.[0].channel).toBe("mcp");
    await act(async () => {
      view.result.current.setChannelOverride("link");
    });
    await act(async () => {
      await view.result.current.send({ quick: QUICK });
    });
    expect(view.result.current.sendState.phase).toBe("failed");
    expect(mockedCreate).toHaveBeenCalledTimes(1); // link 未新增任何调用
  });

  it("正文为空发送被拦（主按钮），不发请求", async () => {
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      await view.result.current.send();
    });
    expect(view.result.current.sendState.phase).toBe("failed");
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});

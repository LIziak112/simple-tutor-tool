import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  AiTaskPublic,
  AttemptQuestionPublic,
  StudentQuickButton,
} from "@tutor/contract";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiCaptureError,
  type AiCaptureSnapshot,
  captureAiQuestionMaterials,
} from "@/features/export/ai-material-capture";
import {
  createStudentAiShareTicketApi,
  createStudentAiTaskApi,
  fetchStudentAiStatusApi,
  listStudentAiTasksApi,
  revokeStudentAiShareTicketsApi,
  uploadStudentAiTaskMaterialsApi,
} from "@/lib/api";
import { studentAiQueueSummaryKey } from "./ai-queue-queries";
import { connectedAiStatus } from "./student-ai-test-utils";
import {
  type AiMaterialAvailability,
  useAiSendController,
} from "./use-ai-send-controller";

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
    createStudentAiShareTicketApi: vi.fn(),
    revokeStudentAiShareTicketsApi: vi.fn(),
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
const mockedShareTicket = vi.mocked(createStudentAiShareTicketApi);
const mockedRevokeShare = vi.mocked(revokeStudentAiShareTicketsApi);

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
    archivedAt: null,
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
  materials?: AiMaterialAvailability;
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
    ...(over.materials !== undefined ? { materials: over.materials } : {}),
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
  mockedStatus.mockResolvedValue(connectedAiStatus());
  mockedList.mockResolvedValue({ tasks: [], nextCursor: null });
  mockedCreate.mockResolvedValue(taskOf("task-1"));
  mockedUpload.mockResolvedValue({
    materials: [],
    totalBytes: 0,
  });
  mockedCapture.mockResolvedValue(snapshotOf(QUESTION_A));
  mockedShareTicket.mockResolvedValue(SHARE_TICKET);
  mockedRevokeShare.mockResolvedValue({ revokedCount: 1 });
});

// ---------- SAI-30：剪贴板替身（jsdom 无 clipboard API） ----------

/** 分享票据固定回执（url 哨兵便于断言复制内容） */
const SHARE_TICKET = {
  ticketUrl: "https://tutor.example.com/api/public/ai/share/AbCdEf123456",
  snapshotAt: "2026-10-16T08:00:00.000Z",
  expiresAt: "2026-10-17T08:00:00.000Z",
};

/** 换装 navigator.clipboard：undefined = HTTP 非安全上下文；函数 = writeText 替身 */
function stubClipboard(
  writeText: ((text: string) => Promise<void>) | undefined,
): void {
  Object.defineProperty(navigator, "clipboard", {
    value: writeText === undefined ? undefined : { writeText },
    configurable: true,
  });
}

afterEach(() => {
  stubClipboard(undefined);
});

describe("useAiSendController（SAI-20 先测 6 条）", () => {
  it("主动准备新稿会退出旧链接结果，不撤销旧票据也不自动发送", async () => {
    stubClipboard(async () => {});
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      view.result.current.setChannelOverride("link");
      view.result.current.setText("旧稿的问题");
    });
    await act(async () => view.result.current.send());
    expect(view.result.current.linkShare).not.toBeNull();
    act(() => view.result.current.prepareNew(QUESTION_A.id));
    expect(view.result.current.linkShare).toBeNull();
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedRevokeShare).not.toHaveBeenCalled();
  });
  it("失败后的普通重试沿用原稿，主动换新稿即使问题相同也重新采集", async () => {
    const view = renderController();
    await openOnA(view);
    act(() => {
      view.result.current.setText("检查我的步骤");
      view.result.current.toggleMaterial("annotation");
    });
    mockedUpload.mockRejectedValueOnce(new Error("上传失败"));
    await act(async () => view.result.current.send());
    expect(view.result.current.sendState.phase).toBe("failed");
    act(() => view.result.current.prepareNew(QUESTION_A.id));
    await act(async () => view.result.current.send());
    expect(mockedCapture).toHaveBeenCalledTimes(2);
    expect(mockedCreate.mock.calls[0]?.[0].mutationId).not.toBe(
      mockedCreate.mock.calls[1]?.[0].mutationId,
    );
  });
  it("打开时重新确认连接，不能沿用新鲜但已过时的未配置缓存", async () => {
    const view = renderController();
    const key = ["student", "ai-status", "attempt-1", QUESTION_A.id];
    view.client.setQueryDefaults(key, { staleTime: 60_000 });
    view.client.setQueryData(
      key,
      connectedAiStatus({
        channelDefault: null,
        connectionReady: false,
        firstUseRequired: true,
      }),
    );
    await act(async () => view.result.current.bind(QUESTION_A.id));
    await waitFor(() => expect(mockedStatus).toHaveBeenCalled());
    await waitFor(() => expect(view.result.current.needsSetup).toBe(false));
  });
  it("检查新步骤必须提供材料或文字步骤，准备问法零出站", async () => {
    const view = renderController();
    await openOnA(view);
    await act(async () =>
      view.result.current.selectPreset("check-current", "检查我的新步骤"),
    );
    expect(mockedCreate).not.toHaveBeenCalled();
    await act(async () =>
      view.result.current.send({
        questionText: "检查我的新步骤",
        requireSteps: true,
      }),
    );
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(view.result.current.sendState.message).toContain("勾选");
    await act(async () => view.result.current.setText("第一步：先移项"));
    await act(async () =>
      view.result.current.send({
        questionText: "检查我的新步骤：第一步先移项",
        requireSteps: true,
      }),
    );
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedCreate.mock.calls[0]?.[0].question).toContain("第一步先移项");
    expect(mockedCapture).not.toHaveBeenCalled();
  });
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
      connectedAiStatus({
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
    mockedStatus.mockResolvedValue(connectedAiStatus());
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

  it("遗留②专项：任务已建但材料上传失败→明示补传与不计费；同幂等键重试只补传不重复建任务", async () => {
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      view.result.current.setText("带圈画的问题");
      view.result.current.toggleMaterial("annotation");
    });
    // 上传失败（如 413 预检拒绝）：任务已创建——如实明示而非静默
    mockedUpload.mockRejectedValueOnce(new Error("413 材料过大"));
    await act(async () => {
      await view.result.current.send();
    });
    expect(view.result.current.sendState.phase).toBe("failed");
    expect(view.result.current.sendState.message).toContain("任务已创建");
    expect(view.result.current.sendState.message).toContain("413 材料过大");
    expect(view.result.current.sendState.message).toContain("不会重复计费");
    // 失败保留全部输入（正文与附件选择——与采集失败同口径）
    const draft = view.result.current.draftOf(QUESTION_A.id);
    expect(draft.text).toBe("带圈画的问题");
    expect(draft.selection.annotation).toBe(true);
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    // 重试（同正文同选择）：复用同一 mutationId → 服务端幂等重放原任务，
    // 流程回到上传补传——create 调用数不再增加即「不重复计费动作」
    await act(async () => {
      await view.result.current.send();
    });
    expect(view.result.current.sendState.phase).toBe("sent");
    expect(mockedCreate).toHaveBeenCalledTimes(2);
    const mutationIds = mockedCreate.mock.calls.map(
      (call) => call[0].mutationId,
    );
    expect(mutationIds[1]).toBe(mutationIds[0]);
    // 补传仍指向同一任务的材料
    expect(mockedUpload).toHaveBeenCalledTimes(2);
    expect(mockedUpload.mock.calls[1]?.[0]).toBe(
      mockedUpload.mock.calls[0]?.[0],
    );
    // 成功后正文清空（已随任务发出），选择保留
    const after = view.result.current.draftOf(QUESTION_A.id);
    expect(after.text).toBe("");
    expect(after.selection.annotation).toBe(true);
  });

  it("先测⑥：模式被老师关闭给原因并刷新；换账号途中迟到结果不进入新题", async () => {
    // 模式关闭：发送被拦，给原因，并刷新状态（教师刚改设置立即生效）
    mockedStatus.mockResolvedValue(
      connectedAiStatus({
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
    mockedStatus.mockResolvedValue(connectedAiStatus());
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

  it("通道选择影响本次发送通道；link 通道走票据闭环（SAI-30 起出真实链接）", async () => {
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
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    await act(async () => {
      await view.result.current.send({ quick: QUICK });
    });
    expect(mockedCreate.mock.calls[1]?.[0].channel).toBe("link");
    expect(mockedShareTicket).toHaveBeenCalledTimes(1);
    expect(view.result.current.sendState.phase).toBe("sent");
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

describe("useAiSendController 材料可选面（SAI-22 讲练/结果页收窄）", () => {
  it("结果页复盘（圈画与纸面均不可选）：快捷按钮附件偏好全开也恒空材料外发，不触发采集", async () => {
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      view.rerender({
        materials: { annotation: false, paper: false },
      });
    });
    await act(async () => {
      await view.result.current.send({ quick: QUICK });
    });
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    // 快捷按钮 attachmentPref 全开，但来源页面无采集能力 → 任务材料恒空
    expect(mockedCreate.mock.calls[0]?.[0].materials).toEqual({
      annotation: false,
      draft: false,
      formalInk: false,
    });
    expect(mockedCapture).not.toHaveBeenCalled();
    expect(view.result.current.sendState.phase).toBe("sent");
  });

  it("讲练（无圈画层）：勾选圈画发送时圈画被过滤，任务只带纸面材料", async () => {
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      view.rerender({
        materials: { annotation: false, paper: true },
      });
    });
    await act(async () => {
      view.result.current.setText("帮我看看草稿");
      view.result.current.toggleMaterial("annotation");
      view.result.current.toggleMaterial("draft");
    });
    await act(async () => {
      await view.result.current.send();
    });
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedCreate.mock.calls[0]?.[0].materials).toEqual({
      annotation: false,
      draft: true,
      formalInk: false,
    });
    // 采集输入的选择同样已过滤（annotation=false 不进采集）
    expect(mockedCapture.mock.calls[0]?.[0].selection).toEqual({
      annotation: false,
      draft: true,
      formalInk: false,
    });
  });

  it("不可选材料不落草稿：toggleMaterial 对关闭的种类是无操作", async () => {
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      view.rerender({
        materials: { annotation: false, paper: false },
      });
    });
    await act(async () => {
      view.result.current.toggleMaterial("annotation");
      view.result.current.toggleMaterial("draft");
    });
    expect(view.result.current.draftOf(QUESTION_A.id).selection).toEqual({
      annotation: false,
      draft: false,
      formalInk: false,
    });
  });
});

describe("useAiSendController（SAI-30 链接通道闭环）", () => {
  it("主流程：建任务→传材料→生成票据→复制；无效化含队列摘要（B14 遗留角标）", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const view = renderController();
    // 预挂队列摘要数据：成功回调必须把它标失效（顶栏角标即时反映）
    view.client.setQueryData(studentAiQueueSummaryKey, {
      pendingCount: 0,
      processingCount: 0,
      unreadReplyCount: 0,
    });
    await openOnA(view);
    await act(async () => {
      view.result.current.setText("链接求助这题");
      // 勾选圈画才走「采集→上传」段（主按钮发送不默认带材料）
      view.result.current.toggleMaterial("annotation");
    });
    await act(async () => {
      view.result.current.setChannelOverride("link");
    });
    await act(async () => {
      await view.result.current.send();
    });
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedCreate.mock.calls[0]?.[0].channel).toBe("link");
    expect(mockedUpload).toHaveBeenCalledTimes(1);
    expect(mockedShareTicket).toHaveBeenCalledTimes(1);
    expect(mockedShareTicket).toHaveBeenCalledWith("task-1");
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(`${SHARE_TICKET.ticketUrl}?read=`),
    );
    // 复制成功即结束：不预取分享正文（无抓取冒充外部已读）
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(view.result.current.sendState.phase).toBe("sent");
    expect(view.result.current.sendState.message).toContain(
      "已生成 AI 链接并复制",
    );
    const link = view.result.current.linkShare;
    expect(link).not.toBeNull();
    expect(link?.questionId).toBe(QUESTION_A.id);
    expect(link?.taskId).toBe("task-1");
    expect(link?.url).toBe(SHARE_TICKET.ticketUrl);
    expect(link?.copyFailed).toBe(false);
    // 正文已随任务发出；队列摘要失效（页内入队角标即时反映）
    expect(view.result.current.draftOf(QUESTION_A.id).text).toBe("");
    expect(
      view.client.getQueryState(studentAiQueueSummaryKey)?.isInvalidated,
    ).toBe(true);
    vi.unstubAllGlobals();
  });

  it("剪贴板不可用（HTTP）：链接保留+手动复制提示，重试复制不再新建票据", async () => {
    stubClipboard(undefined);
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      view.result.current.setChannelOverride("link");
    });
    await act(async () => {
      await view.result.current.send({ quick: QUICK });
    });
    // 生成成功、复制失败是两个可区分的事实：phase 是 sent 不是 failed
    expect(view.result.current.sendState.phase).toBe("sent");
    expect(view.result.current.sendState.message).toContain("自动复制失败");
    expect(view.result.current.linkShare?.copyFailed).toBe(true);
    expect(view.result.current.linkShare?.url).toBe(SHARE_TICKET.ticketUrl);
    // 重试复制只碰剪贴板，不新建任务/票据/事实
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    await act(async () => {
      await view.result.current.retryCopyLink();
    });
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(`${SHARE_TICKET.ticketUrl}?read=`),
    );
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedShareTicket).toHaveBeenCalledTimes(1);
    expect(view.result.current.linkShare?.copyFailed).toBe(false);
  });

  it("剪贴板权限拒绝：与 HTTP 不支持同形态（链接保留，可手动复制）", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      view.result.current.setChannelOverride("link");
    });
    await act(async () => {
      await view.result.current.send({ quick: QUICK });
    });
    expect(view.result.current.sendState.phase).toBe("sent");
    expect(view.result.current.linkShare?.copyFailed).toBe(true);
  });

  it("票据生成失败：与复制失败可区分（failed、无链接、任务保留）", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    mockedShareTicket.mockRejectedValueOnce(new Error("server 500"));
    const view = renderController();
    await openOnA(view);
    // 预挂队列摘要：任务已落库，即使票据生成失败角标/历史也必须即时失效
    view.client.setQueryData(studentAiQueueSummaryKey, {
      pendingCount: 0,
      processingCount: 0,
      unreadReplyCount: 0,
    });
    await act(async () => {
      view.result.current.setChannelOverride("link");
    });
    await act(async () => {
      await view.result.current.send({ quick: QUICK });
    });
    expect(view.result.current.sendState.phase).toBe("failed");
    expect(view.result.current.sendState.message).toContain("链接生成失败");
    expect(view.result.current.linkShare).toBeNull();
    // 任务已建（重试同幂等键不重复建）；材料已传不丢
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedUpload).toHaveBeenCalledTimes(1);
    // 任务创建成功即失效队列摘要/任务历史——失败 early-return 不得跳过
    expect(
      view.client.getQueryState(studentAiQueueSummaryKey)?.isInvalidated,
    ).toBe(true);
  });

  it("仅完成后未完成：link 入口同拒（零任务零票据零复制）", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    mockedStatus.mockResolvedValue(
      connectedAiStatus({
        resolution: {
          usable: false,
          mode: undefined,
          reason: "student_closed",
        },
      }),
    );
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      view.result.current.setChannelOverride("link");
    });
    await act(async () => {
      await view.result.current.send({ quick: QUICK });
    });
    expect(view.result.current.sendState.phase).toBe("failed");
    expect(view.result.current.sendState.message).toContain("完成后可用");
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedShareTicket).not.toHaveBeenCalled();
  });

  it("换题不复制上一题链接；换账号链接不跨会话；旧票据不自动切换", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      view.result.current.setChannelOverride("link");
    });
    await act(async () => {
      await view.result.current.send({ quick: QUICK });
    });
    expect(view.result.current.linkShare?.questionId).toBe(QUESTION_A.id);
    // 换题：上一题的链接不再出现，也不被拿去复制
    await act(async () => {
      view.result.current.bind(QUESTION_B.id);
    });
    expect(view.result.current.linkShare).toBeNull();
    // 换题后状态查询重新载入：等就绪再发送（否则被「正在确认 AI 状态」拦下）
    await waitFor(() => expect(view.result.current.status).toBeDefined());
    // B 题新建自己的任务与票据（不复制上一题链接）
    mockedCreate.mockResolvedValueOnce(taskOf("task-b"));
    await act(async () => {
      await view.result.current.send({ quick: QUICK });
    });
    expect(mockedCreate.mock.calls[1]?.[0].questionId).toBe(QUESTION_B.id);
    expect(view.result.current.linkShare?.taskId).toBe("task-b");
    // 换账号（换 attempt）：在途回调失效，链接状态清空
    await act(async () => {
      view.rerender({ attemptId: "attempt-2" });
    });
    await waitFor(() => expect(view.result.current.linkShare).toBeNull());
  });

  it("材料上传失败不生成票据（缺件不静默成链接）；同幂等键重试补传后才成票", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    mockedUpload.mockRejectedValueOnce(new Error("upload failed"));
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      view.result.current.setChannelOverride("link");
    });
    await act(async () => {
      await view.result.current.send({ quick: QUICK });
    });
    expect(view.result.current.sendState.phase).toBe("failed");
    expect(view.result.current.sendState.message).toContain("材料上传失败");
    expect(mockedShareTicket).not.toHaveBeenCalled();
    expect(view.result.current.linkShare).toBeNull();
    // 重试：同幂等键回到任务，补传成功后生成票据
    await act(async () => {
      await view.result.current.send({ quick: QUICK });
    });
    const firstKey = mockedCreate.mock.calls[0]?.[0].mutationId;
    const secondKey = mockedCreate.mock.calls[1]?.[0].mutationId;
    expect(secondKey).toBe(firstKey);
    expect(mockedShareTicket).toHaveBeenCalledTimes(1);
    expect(view.result.current.linkShare?.url).toBe(SHARE_TICKET.ticketUrl);
  });

  it("重新生成走旧任务（仍按当前权限由服务端裁决）；撤销清空链接状态", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      view.result.current.setChannelOverride("link");
    });
    await act(async () => {
      await view.result.current.send({ quick: QUICK });
    });
    const secondTicket = {
      ...SHARE_TICKET,
      ticketUrl: "https://tutor.example.com/api/public/ai/share/NewToken987",
    };
    mockedShareTicket.mockResolvedValueOnce(secondTicket);
    await act(async () => {
      await view.result.current.regenerateLink();
    });
    // 重新生成 = 旧任务上新票据（不建新任务），换的是新链接
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedShareTicket).toHaveBeenCalledWith("task-1");
    expect(view.result.current.linkShare?.url).toBe(secondTicket.ticketUrl);
    // 权限被关后重新生成：服务端拒绝如实呈现，旧链接状态保留不误删
    mockedShareTicket.mockRejectedValueOnce(new Error("403"));
    await act(async () => {
      await view.result.current.regenerateLink();
    });
    expect(view.result.current.sendState.phase).toBe("failed");
    expect(view.result.current.linkShare?.url).toBe(secondTicket.ticketUrl);
    // 撤销：调服务端 + 清空本地链接
    await act(async () => {
      await view.result.current.revokeLink();
    });
    expect(mockedRevokeShare).toHaveBeenCalledWith("task-1");
    expect(view.result.current.linkShare).toBeNull();
  });

  it("链接任务不冒充已回信：成功消息只讲链接，不出现收到回信口径", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const view = renderController();
    await openOnA(view);
    await act(async () => {
      view.result.current.setChannelOverride("link");
    });
    await act(async () => {
      await view.result.current.send({ quick: QUICK });
    });
    const message = view.result.current.sendState.message ?? "";
    expect(message).not.toContain("回信");
    expect(message).not.toContain("已收到");
    expect(message).toContain("外部 AI");
  });
});

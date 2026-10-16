import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AttemptResultData } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureAiQuestionMaterials } from "@/features/export/ai-material-capture";
import { connectedAiStatus } from "@/features/student-ai/student-ai-test-utils";
import {
  createStudentAiTaskApi,
  fetchStudentAiStatusApi,
  fetchStudentQuickButtonsApi,
  listStudentAiTasksApi,
} from "@/lib/api";
import { AttemptResultView } from "./AttemptResultView";

/**
 * SAI-22 结果页 AI 复盘接入（B12 执行步骤 2/5 + 参数化验收「完成」列）：
 * 完成后入口变为「AI 复盘」、绑定回看当前题、复盘态不采集材料（纯文字
 * 求助）、原稿/订正控制器不因 AI 面板挂载/打开而卸载。
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
// 原稿/订正以桩替换（同 AttemptResultView.test 口径）：桩把接线 props 落到
// data-testid，本文件用其 DOM 身份断言「不因 AI 面板卸载」
vi.mock("@/features/notes/NoteOriginalView", async () => {
  const { NoteOriginalTestStub } = await import(
    "@/features/notes/note-original-test-stub"
  );
  return { NoteOriginalView: NoteOriginalTestStub };
});
vi.mock("@/features/notes/CorrectionSection", async () => {
  const { CorrectionTestStub } = await import(
    "@/features/notes/correction-test-stub"
  );
  return { CorrectionSection: CorrectionTestStub };
});

const mockedStatus = vi.mocked(fetchStudentAiStatusApi);
const mockedCreate = vi.mocked(createStudentAiTaskApi);
const mockedList = vi.mocked(listStudentAiTasksApi);
const mockedQuickButtons = vi.mocked(fetchStudentQuickButtonsApi);
const mockedCapture = vi.mocked(captureAiQuestionMaterials);

const DATA: AttemptResultData = {
  attempt: {
    id: "attempt-result-1",
    sourceType: "assignment",
    assignmentId: "44444444-4444-4444-8444-444444444444",
    lectureId: null,
    courseId: null,
    unitId: null,
    attemptNo: 1,
    status: "submitted",
    startedAt: "2026-10-16T02:00:00.000Z",
    submittedAt: "2026-10-16T02:30:00.000Z",
    scoreAuto: 60,
  },
  title: "周末加练",
  courseName: null,
  dueAt: null,
  answersReleased: true,
  enabledCapabilities: ["ink"],
  summary: {
    total: 2,
    answered: 2,
    correct: 1,
    wrong: 1,
    pending: 0,
    unanswered: 0,
    autoGradable: 2,
    scoreFinal: null,
    pendingCount: 0,
  },
  units: [
    {
      id: "练习四",
      title: "练习四",
      questions: [
        {
          questionId: "练习四-1",
          snapshot: {
            id: "练习四-1",
            type: "judge",
            difficulty: 1,
            knowledge: ["有理数的概念"],
            stemMd: "$0$ 既不是正数，也不是负数。[[正确]]",
            hintCount: 0,
          },
          answers: { kind: "judge", value: true },
          solutionMd: "分界点说明。",
          answer: { kind: "judge", value: false },
          autoCorrect: false,
          teacherMark: null,
          teacherComment: null,
          finalCorrect: false,
          hintsOpened: [],
        },
        {
          questionId: "练习四-2",
          snapshot: {
            id: "练习四-2",
            type: "choice",
            difficulty: 1,
            knowledge: ["相反数"],
            stemMd: "$-5$ 的相反数是（　）",
            options: ["$-5$", "$5$"],
            hintCount: 0,
          },
          answers: { kind: "choice", index: 1 },
          solutionMd: null,
          answer: { kind: "choice", index: 1 },
          autoCorrect: true,
          teacherMark: null,
          teacherComment: null,
          finalCorrect: true,
          hintsOpened: [],
        },
      ],
    },
  ],
};

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AttemptResultView data={DATA} onBackHome={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // 完成态：服务端按 attempt+question 裁决——已交卷 → completed 复盘
  mockedStatus.mockResolvedValue(
    connectedAiStatus({
      resolution: {
        usable: true,
        mode: "open_study",
        reason: "completed",
      },
      completed: true,
    }),
  );
  mockedList.mockResolvedValue({ tasks: [], nextCursor: null });
  mockedQuickButtons.mockResolvedValue({
    buttons: [],
    updatedAt: "2026-10-16T00:00:00.000Z",
  });
  mockedCreate.mockResolvedValue({
    id: "task-1",
    attemptId: "attempt-result-1",
    questionId: "练习四-1",
    questionRevisionId: "rev-1",
    channel: "inapp",
    status: "created",
    modeAtSend: "open_study",
    question: "这道题为什么错？",
    beforeSubmit: false,
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
  });
});

describe("结果页 AI 复盘（SAI-22）", () => {
  it("完成后入口为「AI 复盘」：打开绑定回看当前题并按完成态呈现复盘模式", async () => {
    renderView();
    const trigger = screen.getByRole("button", { name: "AI 复盘" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    // 窄屏（jsdom）→ 独立面板（Sheet portal）
    const panel = await screen.findByRole("dialog");
    expect(panel).toBeInTheDocument();
    // 绑定回看当前题（首题）——状态查询以 attempt+question 定位
    await waitFor(() =>
      expect(mockedStatus).toHaveBeenCalledWith("attempt-result-1", "练习四-1"),
    );
    // 完成态复盘：状态区呈现复盘口径（开放伴学复盘）与绑定题号
    expect(
      await screen.findByText("第 1 题", { selector: "p" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("当前：开放伴学")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("复盘不采集材料：输入区无随信材料勾选，发送创建空材料任务", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "AI 复盘" }));
    await screen.findByRole("dialog");
    await waitFor(() =>
      expect(mockedStatus).toHaveBeenCalledWith("attempt-result-1", "练习四-1"),
    );
    // 复盘态无材料勾选（结果页无作答会话，不提供圈画/草稿/手写材料）
    expect(screen.queryByRole("group", { name: "随信材料" })).toBeNull();
    const textarea = await screen.findByPlaceholderText("写下你想问的问题");
    fireEvent.change(textarea, { target: { value: "这道题为什么错？" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    expect(mockedCreate.mock.calls[0]?.[0]).toMatchObject({
      attemptId: "attempt-result-1",
      questionId: "练习四-1",
      question: "这道题为什么错？",
      materials: { annotation: false, draft: false, formalInk: false },
    });
    expect(mockedCapture).not.toHaveBeenCalled();
  });

  it("打开 AI 面板不卸载原稿/订正控制器（DOM 身份稳定）", async () => {
    const { container } = renderView();
    // 原稿/订正桩（每题一份，材质控制器挂载其中）
    const originalsBefore = container.querySelectorAll(
      '[data-testid="note-original-stub"]',
    );
    const correctionsBefore = container.querySelectorAll(
      '[data-testid="correction-stub"]',
    );
    expect(originalsBefore.length).toBeGreaterThan(0);
    expect(correctionsBefore.length).toBeGreaterThan(0);
    const [firstOriginal] = originalsBefore;
    const [firstCorrection] = correctionsBefore;
    if (firstOriginal === undefined || firstCorrection === undefined)
      throw new Error("测试前置失败：原稿/订正桩未渲染");
    fireEvent.click(screen.getByRole("button", { name: "AI 复盘" }));
    await screen.findByRole("dialog");
    await waitFor(() =>
      expect(mockedStatus).toHaveBeenCalledWith("attempt-result-1", "练习四-1"),
    );
    // 同一 DOM 节点仍在文档中（控制器未卸载重挂）
    expect(firstOriginal.isConnected).toBe(true);
    expect(firstCorrection.isConnected).toBe(true);
    expect(
      container.querySelectorAll('[data-testid="note-original-stub"]').length,
    ).toBe(originalsBefore.length);
    expect(
      container.querySelectorAll('[data-testid="correction-stub"]').length,
    ).toBe(correctionsBefore.length);
  });

  it("复盘追问语境：题号随回看定位题（切题后重开绑定新当前题）", async () => {
    renderView();
    // 回看导航跳到第 2 题（底部操作条「下一题」）
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    fireEvent.click(screen.getByRole("button", { name: "AI 复盘" }));
    await screen.findByRole("dialog");
    await waitFor(() =>
      expect(mockedStatus).toHaveBeenCalledWith("attempt-result-1", "练习四-2"),
    );
  });
});

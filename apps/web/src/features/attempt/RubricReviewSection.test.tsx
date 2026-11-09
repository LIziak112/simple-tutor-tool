import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AttemptResultQuestion, RubricReview } from "@tutor/contract";
import { beforeEach, expect, it, vi } from "vitest";
import { createStudentAiTaskApi, fetchStudentAiStatusApi } from "@/lib/api";
import { saveRubricFinalApi, saveRubricSelfApi } from "@/lib/rubric-api";
import { RubricReviewSection } from "./RubricReviewSection";

/**
 * 模块 3 量表评价交互件：无量表题不渲染；自评表单逐项必填、保存后并排显示；
 * 「请 Agent 判卷」按状态门发任务（purpose=rubric_opinion）并进入等待态；
 * 自评与 Agent 分歧行高亮；裁定按钮按前提出现。
 */

vi.mock("@/lib/rubric-api", () => ({
  saveRubricSelfApi: vi.fn(),
  saveRubricFinalApi: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentAiStatusApi: vi.fn(),
    createStudentAiTaskApi: vi.fn(),
  };
});
const mockedSelf = vi.mocked(saveRubricSelfApi);
const mockedFinal = vi.mocked(saveRubricFinalApi);
const mockedStatus = vi.mocked(fetchStudentAiStatusApi);
const mockedCreate = vi.mocked(createStudentAiTaskApi);

const RUBRIC = {
  items: [
    { id: "r1", title: "要点覆盖", desc: "是否点明观点" },
    { id: "r2", title: "结构" },
  ],
  levels: 4 as const,
};
const AT = "2026-11-09T00:00:00.000Z";

const reviewOf = (overrides: Partial<RubricReview> = {}): RubricReview => ({
  rubric: RUBRIC,
  self: null,
  agent: null,
  final: null,
  pendingAgentTaskId: null,
  ...overrides,
});

const questionOf = (rubricReview: RubricReview | null): AttemptResultQuestion =>
  ({
    questionId: "q1",
    snapshot: {
      id: "q1",
      type: "solve",
      difficulty: 3,
      knowledge: ["短评"],
      stemMd: "写一段短评",
      hintCount: 0,
    },
    answers: null,
    solutionMd: null,
    answer: { kind: "final", finalAnswer: "我的短评" },
    autoCorrect: null,
    teacherMark: null,
    teacherComment: null,
    finalCorrect: null,
    gradingPolicy: "manual_only",
    selfReview: { record: null, revision: 0 },
    hintsOpened: [],
    ...(rubricReview !== null ? { rubricReview } : {}),
  }) as unknown as AttemptResultQuestion;

const statusOf = (
  channelDefault: "mcp" | null,
  connectionReady: boolean,
): Awaited<ReturnType<typeof fetchStudentAiStatusApi>> => ({
  resolution: { usable: true, mode: "open_study", reason: "teacher_default" },
  completed: true,
  channelDefault,
  connectionReady,
  firstUseRequired: false,
  taskSummary: { total: 0, active: 0, unreadReplies: 0 },
});

function renderSection(question: AttemptResultQuestion) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <RubricReviewSection attemptId="att-1" question={question} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

it("无量表题不渲染；有量表且无记录时显示自评入口与 Agent 入口", () => {
  const { unmount } = renderSection(questionOf(null));
  expect(screen.queryByLabelText("本题量表评价")).toBeNull();
  unmount();

  renderSection(questionOf(reviewOf()));
  expect(screen.getByLabelText("本题量表评价")).toBeTruthy();
  expect(screen.getByRole("button", { name: "按量表自评" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "请 Agent 判卷" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "保留我的" })).toBeNull();
  expect(screen.queryByRole("button", { name: "采纳 Agent" })).toBeNull();
});

it("自评表单：未评齐不能保存；评齐后保存并回显合计", async () => {
  mockedSelf.mockResolvedValue(
    reviewOf({
      self: {
        source: "self",
        ratings: [
          { id: "r1", level: 4 },
          { id: "r2", level: 2, evidence: "结尾没收住" },
        ],
        note: "",
        at: AT,
      },
    }),
  );
  renderSection(questionOf(reviewOf()));
  fireEvent.click(screen.getByRole("button", { name: "按量表自评" }));
  const save = screen.getByRole("button", { name: "保存自评" });
  expect(save.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("还有 2 项未评")).toBeTruthy();

  fireEvent.click(
    screen
      .getByRole("radiogroup", { name: "要点覆盖 档位" })
      .querySelector('input[value="4"]') as HTMLInputElement,
  );
  fireEvent.click(
    screen
      .getByRole("radiogroup", { name: "结构 档位" })
      .querySelector('input[value="2"]') as HTMLInputElement,
  );
  fireEvent.change(screen.getByLabelText("结构 依据"), {
    target: { value: "结尾没收住" },
  });
  expect(screen.getByText("合计 6 / 8")).toBeTruthy();
  expect(save.hasAttribute("disabled")).toBe(false);
  fireEvent.click(save);

  await waitFor(() => expect(mockedSelf).toHaveBeenCalledTimes(1));
  expect(mockedSelf).toHaveBeenCalledWith("att-1", "q1", {
    ratings: [
      { id: "r1", level: 4 },
      { id: "r2", level: 2, evidence: "结尾没收住" },
    ],
    note: "",
  });
  await waitFor(() =>
    expect(screen.getByRole("status", { name: "" }).textContent).toContain(
      "生效 6 / 8",
    ),
  );
  expect(screen.getByRole("button", { name: "修改自评" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "保留我的" })).toBeTruthy();
});

it("请 Agent 判卷：连接未就绪只提示；就绪则建 purpose=rubric_opinion 任务并进入等待态", async () => {
  mockedStatus.mockResolvedValueOnce(statusOf(null, false));
  renderSection(questionOf(reviewOf()));
  fireEvent.click(screen.getByRole("button", { name: "请 Agent 判卷" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("AI 连接"),
  );
  expect(mockedCreate).not.toHaveBeenCalled();

  mockedStatus.mockResolvedValueOnce(statusOf("mcp", true));
  mockedCreate.mockResolvedValueOnce({ id: "task-1" } as Awaited<
    ReturnType<typeof createStudentAiTaskApi>
  >);
  fireEvent.click(screen.getByRole("button", { name: "请 Agent 判卷" }));
  await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
  expect(mockedCreate.mock.calls[0]?.[0]).toMatchObject({
    attemptId: "att-1",
    questionId: "q1",
    channel: "mcp",
    purpose: "rubric_opinion",
  });
  expect(screen.getByText("Agent 判卷中…回信后自动显示")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "请 Agent 判卷" })).toBeNull();
});

it("自评与 Agent 分歧行高亮；采纳 Agent 走裁定接口", async () => {
  const self = {
    source: "self" as const,
    ratings: [
      { id: "r1", level: 4 },
      { id: "r2", level: 2 },
    ],
    note: "",
    at: AT,
  };
  const agent = {
    source: "agent" as const,
    ratings: [
      { id: "r1", level: 3, evidence: "理由只有一条" },
      { id: "r2", level: 2 },
    ],
    note: "整体达标",
    at: AT,
    taskId: "task-1",
  };
  mockedFinal.mockResolvedValue(
    reviewOf({
      self,
      agent,
      final: { decision: "agent", ratings: agent.ratings, note: "", at: AT },
    }),
  );
  const { container } = renderSection(questionOf(reviewOf({ self, agent })));
  const rows = container.querySelectorAll('tr[data-disagreement="true"]');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.textContent).toContain("要点覆盖");
  expect(screen.getByText("r1：理由只有一条")).toBeTruthy();
  expect(screen.getByText("整体达标")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "采纳 Agent" }));
  await waitFor(() => expect(mockedFinal).toHaveBeenCalledTimes(1));
  expect(mockedFinal).toHaveBeenCalledWith("att-1", "q1", {
    decision: "agent",
    note: "",
  });
  await waitFor(() =>
    expect(screen.getByRole("status", { name: "" }).textContent).toContain(
      "裁定：采纳 Agent",
    ),
  );
});

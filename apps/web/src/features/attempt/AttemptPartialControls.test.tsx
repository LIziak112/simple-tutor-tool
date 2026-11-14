import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AttemptDraftData } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttemptPartialControls } from "./AttemptPartialControls";
import { workflowOf } from "./practice-test-fixtures";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  settle: vi.fn(),
  read: vi.fn(),
  load: vi.fn(),
}));
vi.mock("./prepare-question-submission", () => ({
  prepareQuestionSubmission: mocks.prepare,
}));
vi.mock("./settlement-api", () => ({
  settleAttempt: mocks.settle,
  readSettlement: mocks.read,
}));
vi.mock("./draft-store", () => ({
  draftStore: { loadDraft: mocks.load, peekInk: () => null },
}));
vi.mock("./attempt-queries", () => ({
  pauseAttemptDetailPolling: vi.fn(),
  resumeAttemptDetailPolling: vi.fn(),
  studentAttemptKey: (id: string) => ["student", "attempt", id],
}));
vi.mock("./ResultQuestionCard", () => ({
  ResultQuestionCard: () => <p>本批题目结果</p>,
}));
const data = (): AttemptDraftData => ({
  attempt: {
    id: "11111111-1111-4111-8111-111111111111",
    sourceType: "wrong",
    assignmentId: null,
    lectureId: null,
    courseId: null,
    unitId: null,
    attemptNo: 1,
    status: "draft",
    startedAt: "2026-11-14T00:00:00Z",
    submittedAt: null,
    scoreAuto: null,
  },
  title: "练习",
  courseName: null,
  dueAt: null,
  answerRelease: "on_submit",
  legacyUnverified: false,
  enabledCapabilities: [],
  hintsOpened: {},
  units: [
    {
      id: "unit",
      title: "练习",
      questions: [1, 2].map((no) => ({
        id: `q${no}`,
        type: "judge",
        difficulty: 1,
        knowledge: [],
        stemMd: "题目",
        hintCount: 0,
        questionRevisionId: `rev${no}`,
      })),
    },
  ],
  drafts: { q1: { kind: "judge", value: true } },
  draftRevisions: { q1: 3 },
  practiceWorkflow: workflowOf({ canSettlePartially: true }),
  questionProgress: [1, 2].map((no) => ({
    questionId: `q${no}`,
    submittedAt: null,
    feedbackReadable: false,
  })),
});
function mount(input = data()) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AttemptPartialControls
        data={input}
        answers={input.drafts}
        progress={input.questionProgress ?? []}
        disabled={false}
        beforeSubmit={async () => true}
        syncNow={async () => {}}
        flushQuestion={async () => true}
        flushQuestionLocal={async () => true}
        inkControllers={{ current: new Map() }}
      />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepare.mockResolvedValue({
    declarations: [{ questionId: "q1", state: "none" }],
    problems: [],
  });
  mocks.load.mockResolvedValue({ answerRevisions: { q1: 3 } });
});
describe("分批确认", () => {
  it("只默认选择已做题，保存失败不发提交请求", async () => {
    mocks.prepare.mockResolvedValue({
      declarations: null,
      problems: [{ reason: "草稿冲突" }],
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "提交已做的 1 题" }));
    await screen.findByRole("button", { name: "确认提交" });
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "确认提交" }));
    await screen.findByText("草稿冲突");
    expect(mocks.settle).not.toHaveBeenCalled();
  });
  it("网络失败重试复用原请求，不重读证据和版本", async () => {
    mocks.settle
      .mockRejectedValueOnce(new Error("网络中断"))
      .mockResolvedValueOnce({
        settlement: { seq: 1, questionCount: 1 },
        questions: [],
        answersReleased: true,
      });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "提交已做的 1 题" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认提交" }));
    await screen.findByText("网络中断");
    fireEvent.click(screen.getByRole("button", { name: "重试原请求" }));
    await screen.findByText("第 1 批结果");
    expect(mocks.settle.mock.calls[1]).toEqual(mocks.settle.mock.calls[0]);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.settle.mock.calls[0]?.[1].questions).toMatchObject([
      { questionId: "q1", expectedAnswerRevision: 3 },
    ]);
  });
  it("读取旧批失败只允许重试读取", async () => {
    const input = data();
    input.settlementProgress = {
      settlements: [
        {
          seq: 1,
          kind: "partial",
          questionCount: 1,
          activeSec: null,
          createdAt: "2026-11-14T00:00:00Z",
        },
      ],
      membership: { q1: 1 },
      nextQuestionId: "q2",
    };
    mocks.read.mockRejectedValue(new Error("读取失败"));
    mount(input);
    fireEvent.click(screen.getByRole("button", { name: "第 1 批 · 1 题" }));
    await screen.findByText("读取失败");
    expect(screen.queryByRole("button", { name: "确认提交" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试读取本批结果" }));
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    expect(mocks.settle).not.toHaveBeenCalled();
  });
});

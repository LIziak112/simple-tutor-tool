import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  AttemptDraftData,
  AttemptResultData,
  AttemptResultQuestion,
  PracticeQuestionSubmitData,
} from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  installAnnotationBackend,
  memoryAnnotationBackend,
} from "@/features/annotation/annotation-store";
import {
  bindAnnotationSession,
  resetAnnotationSession,
} from "@/features/annotation/annotation-sync";
import {
  installNoteBackend,
  memoryNoteBackend,
} from "@/features/notes/note-store";
import { bindNoteSession, resetNoteSession } from "@/features/notes/note-sync";
import {
  ApiError,
  fetchAttemptApi,
  fetchPracticeQuestionFeedbackApi,
  fetchStudentNoteHeadsApi,
  saveAttemptAnswerApi,
  submitAttemptApi,
  submitPracticeQuestionApi,
} from "@/lib/api";
import StudentAttemptPage from "@/pages/student/StudentAttemptPage";
import { getAttemptRecoveryState } from "./attempt-material-recovery";
import { installDraftBackend, memoryBackend } from "./draft-store";
import {
  bindPracticePreferenceAccount,
  savePracticePreference,
} from "./practice-preference-store";
import { workflowOf } from "./practice-test-fixtures";

/**
 * 逐题提交交互闭环（M3-D2，§7.2/§8/§9.1/§11）：v1 新协议卷的主操作状态机——
 * 提交本题（五字段请求）→ 回执 overlay（反馈/进度/工作流基线）→ 已提交行
 * 原位只读并追加反馈；busy 禁切题；失败重试复用 mutationId；最后一题收尾
 * 不自动 refetch。列表模式每题 footer 提交区 + 底栏已提交进度。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAnnotationViewApi: vi.fn(async () => ({
      base: null,
      maxWidthPx: 1440,
      doc: null,
      annotation: null,
    })),
    fetchAttemptApi: vi.fn(),
    fetchAttemptMaterialRevisionsApi: vi.fn(async () => ({
      notes: {},
      annotations: {},
      ink: {},
    })),
    submitPracticeQuestionApi: vi.fn(),
    fetchPracticeQuestionFeedbackApi: vi.fn(),
    saveAttemptAnswerApi: vi.fn(),
    createCorrectionApi: vi.fn(),
    sealCorrectionApi: vi.fn(),
    fetchStudentNotebookApi: vi.fn(),
    fetchStudentNoteHeadsApi: vi.fn(),
    submitAttemptApi: vi.fn(),
    sealAttemptAnnotationsApi: vi.fn(async () => undefined),
    postAttemptEventsApi: vi.fn(async () => ({ accepted: 1 })),
  };
});
const mockedFetch = vi.mocked(fetchAttemptApi);
const mockedSubmit = vi.mocked(submitPracticeQuestionApi);
const mockedFeedbackGet = vi.mocked(fetchPracticeQuestionFeedbackApi);

const ATTEMPT_ID = "66666666-6666-4666-8666-666666666666";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const attemptOf = (): AttemptDraftData["attempt"] => ({
  id: ATTEMPT_ID,
  sourceType: "course",
  assignmentId: null,
  lectureId: null,
  courseId: "12121212-1212-4121-8121-121212121212",
  unitId: "有理数小练",
  attemptNo: 1,
  status: "draft",
  startedAt: "2026-10-23T02:00:00.000Z",
  submittedAt: null,
  scoreAuto: null,
});

/** 三题草稿：q1 判断、q2 填空、q3 判断；drafts/draftRevisions/进度可覆写 */
const baseDraft = (options?: {
  drafts?: AttemptDraftData["drafts"];
  draftRevisions?: AttemptDraftData["draftRevisions"];
  questionProgress?: AttemptDraftData["questionProgress"];
}): AttemptDraftData => ({
  attempt: attemptOf(),
  title: "有理数小练",
  courseName: "初一上",
  dueAt: null,
  units: [
    {
      id: "有理数小练",
      title: "有理数小练",
      questions: [
        {
          id: "q1",
          type: "judge",
          difficulty: 1,
          knowledge: ["有理数的概念"],
          stemMd: "$0$ 既不是正数，也不是负数。[[]]",
          hintCount: 0,
          questionRevisionId: "rev-q1",
        },
        {
          id: "q2",
          type: "fill",
          difficulty: 2,
          knowledge: ["有理数加法"],
          stemMd: "计算：$(-3)+7=$ [[]]。",
          hintCount: 0,
          questionRevisionId: "rev-q2",
        },
        {
          id: "q3",
          type: "judge",
          difficulty: 2,
          knowledge: ["有理数减法"],
          stemMd: "$5-8$ 是负数。[[]]",
          hintCount: 0,
          questionRevisionId: "rev-q3",
        },
      ],
    },
  ],
  drafts: options?.drafts ?? {},
  draftRevisions: options?.draftRevisions,
  hintsOpened: {},
  legacyUnverified: false,
  answerRelease: "on_submit",
  enabledCapabilities: ["steps", "ink"],
  practiceWorkflow: workflowOf(),
  questionProgress:
    options?.questionProgress ??
    progressOf([{ id: "q1" }, { id: "q2" }, { id: "q3" }]),
});

const progressOf = (
  rows: Array<{ id: string; readable?: boolean; submitted?: boolean }>,
): NonNullable<AttemptDraftData["questionProgress"]> =>
  rows.map((row) => ({
    questionId: row.id,
    submittedAt: row.submitted ? "2026-10-23T02:10:00.000Z" : null,
    feedbackReadable: row.readable ?? false,
  }));

const releasedQuestionOf = (
  questionId: string,
  overrides: Partial<AttemptResultQuestion> = {},
): AttemptResultQuestion => ({
  questionId,
  snapshot: {
    id: questionId,
    type: "judge",
    difficulty: 1,
    knowledge: [],
    stemMd: "题面",
    hintCount: 0,
  },
  answers: { kind: "judge", value: true },
  solutionMd: "零既不是正数也不是负数。",
  answer: { kind: "judge", value: true },
  autoCorrect: true,
  teacherMark: null,
  teacherComment: null,
  finalCorrect: true,
  answered: true,
  studentFlag: null,
  hintsOpened: [],
  ...overrides,
});

const submitReceipt = (overrides: {
  feedback?: PracticeQuestionSubmitData["feedback"];
  questionProgress?: PracticeQuestionSubmitData["questionProgress"];
  attemptStatus?: "draft" | "submitted" | "graded";
  questionId?: string;
}): PracticeQuestionSubmitData => ({
  feedback: overrides.feedback ?? {
    status: "released",
    question: releasedQuestionOf(overrides.questionId ?? "q1"),
  },
  questionProgress:
    overrides.questionProgress ??
    progressOf([
      { id: overrides.questionId ?? "q1", submitted: true, readable: true },
      { id: "q2" },
      { id: "q3" },
    ]),
  attempt: { ...attemptOf(), status: overrides.attemptStatus ?? "draft" },
  practiceWorkflow: workflowOf(),
});

/** 结果视图详情（查看本次结果收敛用；通过 attemptDetailDataSchema 结果分支） */
const resultDataOf = (): AttemptResultData => ({
  attempt: {
    ...attemptOf(),
    status: "submitted",
    submittedAt: "2026-10-23T02:20:00.000Z",
    scoreAuto: 100,
  },
  title: "有理数小练",
  courseName: "初一上",
  dueAt: null,
  answersReleased: true,
  summary: {
    total: 3,
    answered: 3,
    correct: 3,
    wrong: 0,
    pending: 0,
    unanswered: 0,
    autoGradable: 3,
    scoreFinal: 100,
    pendingCount: 0,
  },
  units: [],
  enabledCapabilities: ["steps", "ink"],
});

function renderPage(
  search = "",
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/s/attempts/${ATTEMPT_ID}${search}`]}>
        <Routes>
          <Route
            path="/s/attempts/:attemptId"
            element={<StudentAttemptPage />}
          />
          <Route path="*" element={<p data-testid="route-stub">未匹配</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function renderSingle(draft: AttemptDraftData, search = "") {
  savePracticePreference({
    layout: "single",
    keyboardShortcuts: true,
    feedback: null,
  });
  mockedFetch.mockResolvedValue(draft);
  const view = renderPage(search);
  await view.findByText(/第 \d+ \/ 3 题 · 已提交 \d+ 题/);
  return view;
}

beforeEach(() => {
  localStorage.clear();
  // 草稿仓换新内存后端：用例间零串扰（缓存/待写一并作废，draft-store 约定）
  installDraftBackend(memoryBackend());
  bindPracticePreferenceAccount(null);
  bindPracticePreferenceAccount("m3d2-test");
  mockedFetch.mockReset();
  mockedSubmit.mockReset();
  mockedFeedbackGet.mockReset();
  vi.mocked(submitAttemptApi).mockReset();
  mockedSubmit.mockResolvedValue(submitReceipt({}));
  mockedFeedbackGet.mockResolvedValue({
    feedback: { status: "not_submitted" },
  });
  // 草稿答案保存链（提交前 flush/追平）：jsdom 无后端，回执成功即视为已同步；
  // 回执不带 revision（schema 可选）——不打扰 expectedAnswerRevision 基线断言
  vi.mocked(saveAttemptAnswerApi).mockImplementation(
    async (_attemptId, questionId) => ({
      questionId,
      changeCount: 1,
    }),
  );
  vi.mocked(fetchStudentNoteHeadsApi).mockImplementation(
    async (_attemptId, ids) =>
      ids.map(() => ({
        note: null,
        images: [],
        evidence: null,
        corrections: [],
        supplements: [],
      })),
  );
});

// ---------- 单题模式：提交闭环 ----------

afterEach(() => {
  resetNoteSession();
  resetAnnotationSession();
});

it.each(["list", "single"] as const)(
  "%s：本页逐题提交后交卷，版本校验覆盖全卷，证据仅覆盖剩余题并进入结果",
  // 全流程闭环（提交→封存→结果态）在 jsdom 内本身 5-7s，全量并发下会越 5s 默认超时
  { timeout: 15_000 },
  async (layout) => {
    installNoteBackend(memoryNoteBackend());
    installAnnotationBackend(memoryAnnotationBackend());
    const session = { origin: "https://page.test", studentId: "submit-test" };
    bindNoteSession(session);
    bindAnnotationSession(session);
    savePracticePreference({ layout, keyboardShortcuts: true, feedback: null });
    mockedFetch.mockResolvedValue(baseDraft());
    renderPage();
    await screen.findByRole("button", { name: "第 1 题更多" });
    await waitFor(() =>
      expect(getAttemptRecoveryState(ATTEMPT_ID).state).toBe("ready"),
    );
    // 使用本页提交回执推进进度，防止只消费初次取卷的过期进度。
    const answer = screen.getAllByRole("radio", { name: "对" })[0];
    if (!answer) throw new Error("缺少首题作答入口");
    fireEvent.click(answer);
    const submitButton = (
      await screen.findAllByRole("button", { name: "提交本题" })
    )[0];
    if (!submitButton) throw new Error("缺少首题提交入口");
    fireEvent.click(submitButton);
    await screen.findByText("回答正确");
    vi.mocked(submitAttemptApi).mockImplementation(async () => {
      const result = resultDataOf();
      mockedFetch.mockResolvedValue(result);
      return result;
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: layout === "single" ? "提前交卷" : "交卷",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "确认交卷" }));
    await waitFor(() => expect(submitAttemptApi).toHaveBeenCalledOnce());
    expect(vi.mocked(submitAttemptApi).mock.calls[0]).toEqual([
      ATTEMPT_ID,
      [
        { questionId: "q1", questionRevisionId: "rev-q1" },
        { questionId: "q2", questionRevisionId: "rev-q2" },
        { questionId: "q3", questionRevisionId: "rev-q3" },
      ],
      [
        { questionId: "q2", state: "none" },
        { questionId: "q3", state: "none" },
      ],
    ]);
    await screen.findByText("批改结果", {}, { timeout: 10_000 });
  },
);

it("提交本题：请求体五字段齐备，回执反馈原位呈现且该题切只读", async () => {
  const { container } = await renderSingle(baseDraft());
  const pickTrue = screen.getByRole("radio", { name: "对" });
  expect(pickTrue).toBeEnabled();
  fireEvent.click(pickTrue);
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  await screen.findByText("回答正确");
  expect(mockedSubmit).toHaveBeenCalledTimes(1);
  expect(mockedSubmit.mock.calls[0]?.[0]).toBe(ATTEMPT_ID);
  expect(mockedSubmit.mock.calls[0]?.[1]).toBe("q1");
  expect(mockedSubmit.mock.calls[0]?.[2]).toMatchObject({
    workflowVersion: 1,
    workflowRevision: 0,
    questionRevisionId: "rev-q1",
    expectedAnswerRevision: 0,
  });
  expect(mockedSubmit.mock.calls[0]?.[2]?.submissionMutationId).toMatch(
    UUID_RE,
  );
  expect(mockedSubmit.mock.calls[0]?.[2]?.evidence).toMatchObject({
    questionId: "q1",
    state: "none",
  });
  // 反馈区原位追加（同一张题卡），解析默认展开
  expect(screen.getByText("解析")).toBeInTheDocument();
  // 该题只读（断言限当前题卡：其余题在单题模式 display:none 但仍在 DOM）
  const q1Card = container.querySelector('[data-question-id="q1"]');
  expect(q1Card).not.toBeNull();
  expect(screen.getByRole("radio", { name: "对" })).toBeDisabled();
  expect(q1Card?.querySelector('[title="圈画题干"]')).toBeNull();
  expect(q1Card?.querySelector('[title="草稿纸"]')).toBeNull();
  expect(
    screen.getByRole("button", { name: "第 1 题更多" }),
  ).toBeInTheDocument();
  // 进度与导航四态更新；主动作变下一题（主导作 + 侧栏导航钮）
  expect(screen.getByText("第 1 / 3 题 · 已提交 1 题")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "第 1 题，已提交" }),
  ).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "下一题" })).toHaveLength(1);
});

it("expectedAnswerRevision 取自本机草稿版本（draftRevisions 播种）", async () => {
  await renderSingle(
    baseDraft({
      drafts: { q1: { kind: "judge", value: false } },
      draftRevisions: { q1: 4 },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  await screen.findByText("回答正确");
  expect(mockedSubmit.mock.calls[0]?.[2]?.expectedAnswerRevision).toBe(4);
});

it("未作答：仅「不会，提交并看解析」发空答案提交", async () => {
  await renderSingle(baseDraft());
  expect(screen.queryByRole("button", { name: "提交本题" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "不会，提交并看解析" }));
  await screen.findByText("回答正确");
  expect(mockedSubmit.mock.calls[0]?.[1]).toBe("q1");
  expect(mockedSubmit.mock.calls[0]?.[2]?.expectedAnswerRevision).toBe(0);
  expect(mockedSubmit.mock.calls[0]?.[2]?.evidence).toMatchObject({
    questionId: "q1",
    state: "none",
  });
});

it("busy：提交中上一题/下一题/导航跳题禁用，按钮显示正在提交且不可重复提交", async () => {
  let resolveSubmit: () => void = () => {};
  mockedSubmit.mockImplementation(
    () =>
      new Promise<PracticeQuestionSubmitData>((resolve) => {
        resolveSubmit = () => resolve(submitReceipt({}));
      }),
  );
  await renderSingle(baseDraft());
  fireEvent.click(screen.getByRole("radio", { name: "对" }));
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  const busyButton = await screen.findByRole("button", { name: "正在提交…" });
  expect(busyButton).toBeDisabled();
  expect(screen.getByRole("button", { name: "上一题" })).toBeDisabled();
  expect(screen.getAllByRole("button", { name: "下一题" })[0]).toBeDisabled();
  expect(screen.getByRole("button", { name: /第 3 题/ })).toBeDisabled();
  // 重复提交被禁（主按钮唯一且禁用）
  expect(screen.queryByRole("button", { name: "提交本题" })).toBeNull();
  resolveSubmit();
  await screen.findByText("回答正确");
  expect(mockedSubmit).toHaveBeenCalledTimes(1);
  // 收尾解除：切题恢复可用（当前在 q1，上一题本就无上一题可去）
  expect(screen.getAllByRole("button", { name: "下一题" })[0]).toBeEnabled();
  expect(screen.getByRole("button", { name: /第 3 题/ })).toBeEnabled();
});

it("网络失败后重试复用同一 mutationId，成功后收敛", async () => {
  mockedSubmit
    .mockImplementationOnce(() => Promise.reject(new Error("网络异常")))
    .mockImplementationOnce(async () => submitReceipt({}));
  await renderSingle(baseDraft());
  fireEvent.click(screen.getByRole("radio", { name: "对" }));
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  await screen.findByText("网络异常");
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  await screen.findByText("回答正确");
  expect(mockedSubmit).toHaveBeenCalledTimes(2);
  const first = mockedSubmit.mock.calls[0]?.[2]?.submissionMutationId;
  const second = mockedSubmit.mock.calls[1]?.[2]?.submissionMutationId;
  expect(first).toMatch(UUID_RE);
  expect(second).toBe(first);
});

it("最后一题收尾：不自动重发详情查询，主动作换查看本次结果", async () => {
  mockedSubmit.mockResolvedValue(
    submitReceipt({
      attemptStatus: "submitted",
      questionId: "q3",
      questionProgress: progressOf([
        { id: "q1", submitted: true, readable: true },
        { id: "q2", submitted: true, readable: true },
        { id: "q3", submitted: true, readable: true },
      ]),
    }),
  );
  await renderSingle(
    baseDraft({
      questionProgress: progressOf([
        { id: "q1", submitted: true, readable: true },
        { id: "q2", submitted: true, readable: true },
        { id: "q3" },
      ]),
    }),
  );
  expect(mockedFetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("radio", { name: "对" }));
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  await screen.findByText("回答正确");
  // 回执已收尾：不自动 refetch（详情查询仍是首屏那一次）；主动作换查看本次结果
  expect(mockedFetch).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: "查看本次结果" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "下一题" })).toBeNull();
});

it("末题提交失败后恢复详情读取，不把作答永久暂停", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  savePracticePreference({
    layout: "single",
    keyboardShortcuts: true,
    feedback: null,
  });
  mockedFetch.mockResolvedValue(
    baseDraft({
      questionProgress: progressOf([
        { id: "q1", submitted: true, readable: true },
        { id: "q2", submitted: true, readable: true },
        { id: "q3" },
      ]),
    }),
  );
  mockedSubmit.mockRejectedValue(new Error("末题网络异常"));
  renderPage("", client);
  await screen.findByText("第 3 / 3 题 · 已提交 2 题");
  fireEvent.click(screen.getByRole("radio", { name: "对" }));
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  await screen.findByText("末题网络异常");
  const calls = mockedFetch.mock.calls.length;
  await act(async () => {
    await client.invalidateQueries({
      queryKey: ["student", "attempt", ATTEMPT_ID],
    });
  });
  expect(mockedFetch.mock.calls.length).toBeGreaterThan(calls);
});

it("末题提交回执迟到时，期间详情重取也不能提前切到结果", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const draft = baseDraft({
    questionProgress: progressOf([
      { id: "q1", submitted: true, readable: true },
      { id: "q2", submitted: true, readable: true },
      { id: "q3" },
    ]),
  });
  savePracticePreference({
    layout: "single",
    keyboardShortcuts: true,
    feedback: null,
  });
  mockedFetch.mockResolvedValueOnce(draft).mockResolvedValue(resultDataOf());
  let complete: ((data: PracticeQuestionSubmitData) => void) | undefined;
  mockedSubmit.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  renderPage("", client);
  await screen.findByText("第 3 / 3 题 · 已提交 2 题");
  fireEvent.click(screen.getByRole("radio", { name: "对" }));
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  await waitFor(() => expect(mockedSubmit).toHaveBeenCalledOnce());
  try {
    await act(async () => {
      await client.invalidateQueries({
        queryKey: ["student", "attempt", ATTEMPT_ID],
      });
    });
    expect(
      client.getQueryData<AttemptDraftData>(["student", "attempt", ATTEMPT_ID])
        ?.attempt.status,
    ).toBe("draft");
  } finally {
    await act(async () => {
      complete?.(
        submitReceipt({
          questionId: "q3",
          attemptStatus: "submitted",
          questionProgress: progressOf([
            { id: "q1", submitted: true, readable: true },
            { id: "q2", submitted: true, readable: true },
            { id: "q3", submitted: true, readable: true },
          ]),
        }),
      );
    });
  }
});

// ---------- 列表模式：逐题 footer + 底栏进度 ----------

it("离开页面后末题回执迟到，不阻止重新进入读取权威结果", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const draft = baseDraft({
    questionProgress: progressOf([
      { id: "q1", submitted: true, readable: true },
      { id: "q2", submitted: true, readable: true },
      { id: "q3" },
    ]),
  });
  savePracticePreference({
    layout: "single",
    keyboardShortcuts: true,
    feedback: null,
  });
  mockedFetch.mockResolvedValueOnce(draft).mockResolvedValue(resultDataOf());
  let complete: ((data: PracticeQuestionSubmitData) => void) | undefined;
  mockedSubmit.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const view = renderPage("", client);
  await screen.findByText("第 3 / 3 题 · 已提交 2 题");
  fireEvent.click(screen.getByRole("radio", { name: "对" }));
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  await waitFor(() => expect(mockedSubmit).toHaveBeenCalledOnce());
  view.unmount();
  await act(async () => {
    complete?.(submitReceipt({ questionId: "q3", attemptStatus: "submitted" }));
  });
  renderPage("", client);
  await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
  expect(
    client.getQueryData<AttemptDraftData>(["student", "attempt", ATTEMPT_ID])
      ?.attempt.status,
  ).toBe("submitted");
});

it("列表模式：每题 footer 提交区按作答态启停，提交后底栏进度与只读更新", async () => {
  savePracticePreference({
    layout: "list",
    keyboardShortcuts: true,
    feedback: null,
  });
  mockedFetch.mockResolvedValue(
    baseDraft({
      drafts: { q2: { kind: "fill", values: ["4"] } },
      draftRevisions: { q2: 1 },
    }),
  );
  mockedSubmit.mockResolvedValue(
    submitReceipt({
      questionId: "q2",
      feedback: {
        status: "released",
        question: releasedQuestionOf("q2", {
          snapshot: {
            id: "q2",
            type: "fill",
            difficulty: 2,
            knowledge: [],
            stemMd: "计算：$(-3)+7=$ [[]]。",
            hintCount: 0,
          },
          answers: { kind: "fill", blanks: [["4"]] },
          solutionMd: "先符号后绝对值。",
          answer: { kind: "fill", values: ["4"] },
          autoCorrect: true,
          finalCorrect: true,
        }),
      },
      questionProgress: progressOf([
        { id: "q1" },
        { id: "q2", submitted: true, readable: true },
        { id: "q3" },
      ]),
    }),
  );
  const { container } = renderPage();
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  expect(
    container.querySelectorAll('[data-slot="practice-question-submit"]'),
  ).toHaveLength(3);
  const [q1Button, q2Button] = screen.getAllByRole("button", {
    name: "提交本题",
  });
  if (q1Button === undefined || q2Button === undefined)
    throw new Error("提交按钮未按题渲染");
  expect(q1Button).toBeDisabled(); // q1 未作答
  expect(q2Button).toBeEnabled(); // q2 已作答
  fireEvent.click(q2Button);
  await screen.findByText(/已提交 1 \/ 3 题/);
  // q2 卡只读：填空输入禁用、反馈原位呈现
  expect(screen.getByRole("textbox", { name: "第1空" })).toBeDisabled();
  const q2Card = container.querySelector('[data-question-id="q2"]');
  expect(
    q2Card?.querySelector('[data-slot="practice-question-feedback"]'),
  ).not.toBeNull();
  // 已提交卡的 footer 提交区让位反馈区
  expect(
    container.querySelectorAll('[data-slot="practice-question-submit"]'),
  ).toHaveLength(2);
});

it.each(["list", "single"] as const)(
  "%s：交卷后查看不提供逐题提交入口",
  async (layout) => {
    savePracticePreference({ layout, keyboardShortcuts: true, feedback: null });
    mockedFetch.mockResolvedValue({
      ...baseDraft(),
      practiceWorkflow: workflowOf({
        feedbackMode: "after_attempt",
        canSubmitQuestion: false,
      }),
    });
    renderPage();
    await screen.findByRole("button", { name: "第 1 题更多" });
    const answer = screen.getAllByRole("radio", { name: "对" })[0];
    if (!answer) throw new Error("缺少首题选项");
    fireEvent.click(answer);
    expect(screen.queryByRole("button", { name: "提交本题" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "不会，提交并看解析" }),
    ).toBeNull();
    expect(mockedSubmit).not.toHaveBeenCalled();
  },
);

it("after_attempt 冒烟（单题）：回执待公布时反馈区按统一公布呈现，主动作下一题", async () => {
  savePracticePreference({
    layout: "single",
    keyboardShortcuts: true,
    feedback: null,
  });
  mockedFetch.mockResolvedValue({
    ...baseDraft(),
    practiceWorkflow: workflowOf({
      feedbackMode: "after_attempt",
      canChangeFeedback: false,
      allowedFeedbackModes: ["after_attempt"],
    }),
  });
  mockedSubmit.mockResolvedValue(
    submitReceipt({
      feedback: { status: "pending_attempt" },
      questionProgress: progressOf([
        { id: "q1", submitted: true },
        { id: "q2" },
        { id: "q3" },
      ]),
    }),
  );
  renderPage();
  await screen.findByText(/第 \d+ \/ 3 题 · 已提交 \d+ 题/);
  fireEvent.click(screen.getByRole("radio", { name: "对" }));
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  await screen.findByText("已提交，交卷后统一公布");
  expect(screen.getAllByRole("button", { name: "下一题" })).toHaveLength(1);
  // 导航只报提交事实（待公布），无对错泄露
  expect(
    screen.getByRole("button", { name: "第 1 题，已提交，反馈待公布" }),
  ).toBeInTheDocument();
});

// ---------- 题级反馈按需 GET（§10.1）：不为未提交/不可读题发请求 ----------

it("反馈按需 GET：进入页面只为已提交可读的当前题取反馈", async () => {
  mockedFeedbackGet.mockResolvedValue({
    feedback: { status: "released", question: releasedQuestionOf("q1") },
  });
  // 无 q 参数时单题模式定位首道未提交题（q2）——直达已提交的 q1 需显式 q
  await renderSingle(
    baseDraft({
      questionProgress: progressOf([
        { id: "q1", submitted: true, readable: true },
        { id: "q2" },
        { id: "q3", submitted: true }, // 已提交但统一公布：不可读
      ]),
    }),
    "?q=q1",
  );
  await screen.findByText("回答正确");
  expect(mockedFeedbackGet).toHaveBeenCalledTimes(1);
  expect(mockedFeedbackGet).toHaveBeenCalledWith(ATTEMPT_ID, "q1");
  expect(mockedFeedbackGet).not.toHaveBeenCalledWith(ATTEMPT_ID, "q2");
  expect(mockedFeedbackGet).not.toHaveBeenCalledWith(ATTEMPT_ID, "q3");
});

it("反馈读取失败可重试：重试入口再取一次并收敛", async () => {
  mockedFeedbackGet
    .mockRejectedValueOnce(new Error("网络异常"))
    .mockResolvedValueOnce({
      feedback: { status: "released", question: releasedQuestionOf("q1") },
    });
  await renderSingle(
    baseDraft({
      questionProgress: progressOf([
        { id: "q1", submitted: true, readable: true },
        { id: "q2" },
        { id: "q3" },
      ]),
    }),
    "?q=q1",
  );
  expect(await screen.findByText("本题反馈暂时没有读取到")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  await screen.findByText("回答正确");
  expect(mockedFeedbackGet).toHaveBeenCalledTimes(2);
});

it("列表模式：可读卡进入视口才惰性取反馈，未提交题不发请求", async () => {
  // jsdom 无 IntersectionObserver：桩实现 observe 即报告相交（真实浏览器的
  // 视口语义由 hook 的 rootMargin/阈值参数承担，此处只验证取数纪律）
  class MockIntersectionObserver {
    callback: (
      entries: Array<{ target: Element; isIntersecting: boolean }>,
    ) => void;
    constructor(
      callback: (
        entries: Array<{ target: Element; isIntersecting: boolean }>,
      ) => void,
    ) {
      this.callback = callback;
    }
    observe(target: Element) {
      this.callback([{ target, isIntersecting: true }]);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  try {
    savePracticePreference({
      layout: "list",
      keyboardShortcuts: true,
      feedback: null,
    });
    mockedFeedbackGet.mockResolvedValue({
      feedback: { status: "released", question: releasedQuestionOf("q1") },
    });
    mockedFetch.mockResolvedValue(
      baseDraft({
        questionProgress: progressOf([
          { id: "q1", submitted: true, readable: true },
          { id: "q2", submitted: true, readable: true },
          { id: "q3" }, // 未提交：永不取
        ]),
      }),
    );
    const { container } = renderPage();
    await screen.findByText(/做题方式：列表 · 每题提交后查看/);
    await waitFor(() => expect(mockedFeedbackGet).toHaveBeenCalledTimes(2));
    expect(mockedFeedbackGet).toHaveBeenCalledWith(ATTEMPT_ID, "q1");
    expect(mockedFeedbackGet).toHaveBeenCalledWith(ATTEMPT_ID, "q2");
    expect(mockedFeedbackGet).not.toHaveBeenCalledWith(ATTEMPT_ID, "q3");
    await waitFor(() =>
      expect(
        container.querySelectorAll('[data-slot="practice-question-feedback"]'),
      ).toHaveLength(2),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

// ---------- 错误分诊（§10.3）：静默收敛 / 就地刷新提示 ----------

it("QUESTION_ALREADY_SUBMITTED：不弹错，静默 refetch 详情收敛", async () => {
  await renderSingle(baseDraft());
  mockedSubmit.mockRejectedValueOnce(
    new ApiError("QUESTION_ALREADY_SUBMITTED", "这道题已经提交过", 409),
  );
  fireEvent.click(screen.getByRole("radio", { name: "对" }));
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("WORKFLOW_RESTRICTED：不弹错误，refetch 草稿视图按受限呈现", async () => {
  await renderSingle(baseDraft());
  mockedSubmit.mockRejectedValueOnce(
    new ApiError("WORKFLOW_RESTRICTED", "老师已调整反馈方式", 409),
  );
  fireEvent.click(screen.getByRole("radio", { name: "对" }));
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("QUESTION_REVISION_STALE：就地提示刷新，可直接重试收敛", async () => {
  await renderSingle(baseDraft());
  mockedSubmit.mockRejectedValueOnce(
    new ApiError("QUESTION_REVISION_STALE", "题目版本已变化", 409),
  );
  fireEvent.click(screen.getByRole("radio", { name: "对" }));
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  expect(
    await screen.findByText("页面内容已过期，请刷新后重试"),
  ).toBeInTheDocument();
  mockedSubmit.mockResolvedValueOnce(submitReceipt({}));
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  await screen.findByText("回答正确");
  expect(screen.queryByText("页面内容已过期，请刷新后重试")).toBeNull();
});

// ---------- M3-D3：提交流接入按题 flush（§11-4 提交第 8 题不等第 19 题在途） ----------

it("提交本题只确认本题答案同步，其他题保存失败不拦本题提交", async () => {
  savePracticePreference({
    layout: "list",
    keyboardShortcuts: true,
    feedback: null,
  });
  // q3 保存恒失败（模拟第 19 题网络重试中），q1 正常回执
  vi.mocked(saveAttemptAnswerApi).mockImplementation(
    async (_attemptId, questionId) => {
      if (questionId === "q3") throw new Error("q3 网络失败");
      return { questionId, changeCount: 1 };
    },
  );
  mockedFetch.mockResolvedValue(baseDraft());
  renderPage();
  await screen.findByText(/做题方式：列表 · 每题提交后查看/);
  const wrongRadios = screen.getAllByRole("radio", { name: "错" });
  const q3Wrong = wrongRadios[1];
  if (q3Wrong === undefined) throw new Error("q3 判断选项未渲染");
  fireEvent.click(q3Wrong);
  const trueRadios = screen.getAllByRole("radio", { name: "对" });
  const q1True = trueRadios[0];
  if (q1True === undefined) throw new Error("q1 判断选项未渲染");
  fireEvent.click(q1True);
  const [q1Submit] = screen.getAllByRole("button", { name: "提交本题" });
  if (q1Submit === undefined) throw new Error("q1 提交按钮未渲染");
  fireEvent.click(q1Submit);
  // 旧全局 flush 会因 q3 未同步抛「答案尚未保存」拦下提交；按题 flush 只
  // 确认 q1 → POST 正常发出（§11-4 提交第 8 题不等第 19 题网络重试）
  await waitFor(() => expect(mockedSubmit).toHaveBeenCalledTimes(1));
  expect(mockedSubmit.mock.calls[0]?.[1]).toBe("q1");
});

it("本题答案同步失败：就地提示且不发提交请求", async () => {
  vi.mocked(saveAttemptAnswerApi).mockRejectedValue(new Error("断网"));
  await renderSingle(baseDraft());
  fireEvent.click(screen.getByRole("radio", { name: "对" }));
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  expect(
    await screen.findByText("本题答案尚未保存完成，请检查网络后重试"),
  ).toBeInTheDocument();
  expect(mockedSubmit).not.toHaveBeenCalled();
});

// ---------- 收尾后的收敛入口（§10.3）：查看本次结果 ----------

it("查看本次结果：显式点击才重发详情并切换结果视图", async () => {
  mockedSubmit.mockResolvedValue(
    submitReceipt({
      attemptStatus: "submitted",
      questionId: "q3",
      questionProgress: progressOf([
        { id: "q1", submitted: true },
        { id: "q2", submitted: true },
        { id: "q3", submitted: true, readable: true },
      ]),
    }),
  );
  await renderSingle(
    baseDraft({
      questionProgress: progressOf([
        { id: "q1", submitted: true },
        { id: "q2", submitted: true },
        { id: "q3" },
      ]),
    }),
  );
  expect(mockedFetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("radio", { name: "对" }));
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  await screen.findByText("回答正确");
  // 回执已收尾：不自动 refetch
  expect(mockedFetch).toHaveBeenCalledTimes(1);
  // 显式点击才重发详情：第二响应为结果视图数据 → 作答视图切换为结果视图
  mockedFetch.mockResolvedValueOnce(resultDataOf());
  fireEvent.click(screen.getByRole("button", { name: "查看本次结果" }));
  await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "查看本次结果" })).toBeNull(),
  );
});

it("收尾暂停期间窗口焦点重取被抑制，查看本次结果后恢复（闸门修复）", async () => {
  mockedSubmit.mockResolvedValue(
    submitReceipt({
      attemptStatus: "submitted",
      questionId: "q3",
      questionProgress: progressOf([
        { id: "q1", submitted: true },
        { id: "q2", submitted: true },
        { id: "q3", submitted: true, readable: true },
      ]),
    }),
  );
  await renderSingle(
    baseDraft({
      questionProgress: progressOf([
        { id: "q1", submitted: true },
        { id: "q2", submitted: true },
        { id: "q3" },
      ]),
    }),
  );
  expect(mockedFetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("radio", { name: "对" }));
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  await screen.findByText("回答正确");
  expect(mockedFetch).toHaveBeenCalledTimes(1);
  // 切窗再切回（visibilitychange 触发 focus 重取）：暂停集内不得绕过
  // 「显式查看才收敛」（refetchOnWindowFocus 谓词同受暂停集约束）
  window.dispatchEvent(new Event("visibilitychange"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(mockedFetch).toHaveBeenCalledTimes(1);
  // 显式查看本次结果：解除暂停并重发详情（第二响应为结果视图）
  mockedFetch.mockResolvedValueOnce(resultDataOf());
  fireEvent.click(screen.getByRole("button", { name: "查看本次结果" }));
  await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
});

it("后台重取清空反馈缓存后当前题自动补取，不悬在等待态（闸门修复）", async () => {
  const released = {
    feedback: {
      status: "released" as const,
      question: releasedQuestionOf("q1"),
    },
  };
  mockedFeedbackGet.mockResolvedValue(released);
  await renderSingle(
    baseDraft({
      questionProgress: progressOf([
        { id: "q1", submitted: true, readable: true },
        { id: "q2" },
        { id: "q3" },
      ]),
    }),
    "?q=q1",
  );
  await screen.findByText("回答正确");
  expect(mockedFeedbackGet).toHaveBeenCalledTimes(1);
  // focus 重取草稿视图且服务端有真实变化（他端提交了 q3——structural sharing
  // 下深相等响应保留旧引用不触发重置，属「无变化缓存继续有效」的正常路径）
  // → 缓存整体重置 → 当前已提交可读题须自动补取（否则停在「正在读取本题反馈…」）
  mockedFetch.mockResolvedValue(
    baseDraft({
      questionProgress: progressOf([
        { id: "q1", submitted: true, readable: true },
        { id: "q2" },
        { id: "q3", submitted: true, readable: true },
      ]),
    }),
  );
  window.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(mockedFeedbackGet).toHaveBeenCalledTimes(2));
  // 当前题（q1）反馈区收敛回已读态：不悬在「正在读取本题反馈…」
  // （隐藏卡 q3 的等待态属正常——切到该题才按需读取）
  const stem = await screen.findByText(/既不是正数，也不是负数/);
  const q1Card = stem.closest("li");
  expect(q1Card?.textContent).toContain("回答正确");
  expect(q1Card?.textContent).not.toContain("正在读取本题反馈");
});

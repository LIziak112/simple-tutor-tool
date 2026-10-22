import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type {
  AttemptDraftData,
  AttemptResultQuestion,
  PracticeQuestionSubmitData,
  PracticeWorkflow,
} from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import {
  fetchAttemptApi,
  fetchPracticeQuestionFeedbackApi,
  fetchStudentNoteHeadsApi,
  saveAttemptAnswerApi,
  submitPracticeQuestionApi,
} from "@/lib/api";
import StudentAttemptPage from "@/pages/student/StudentAttemptPage";
import { installDraftBackend, memoryBackend } from "./draft-store";
import {
  bindPracticePreferenceAccount,
  savePracticePreference,
} from "./practice-preference-store";

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
    submitPracticeQuestionApi: vi.fn(),
    fetchPracticeQuestionFeedbackApi: vi.fn(),
    saveAttemptAnswerApi: vi.fn(),
    createCorrectionApi: vi.fn(),
    sealCorrectionApi: vi.fn(),
    fetchStudentNotebookApi: vi.fn(),
    fetchStudentNoteHeadsApi: vi.fn(),
  };
});
const mockedFetch = vi.mocked(fetchAttemptApi);
const mockedSubmit = vi.mocked(submitPracticeQuestionApi);
const mockedFeedbackGet = vi.mocked(fetchPracticeQuestionFeedbackApi);

const ATTEMPT_ID = "66666666-6666-4666-8666-666666666666";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const workflowOf = (
  overrides: Partial<PracticeWorkflow> = {},
): PracticeWorkflow => ({
  version: 1,
  feedbackMode: "per_question",
  revision: 0,
  canChangeFeedback: true,
  allowedFeedbackModes: ["per_question", "after_attempt"],
  canSubmitQuestion: true,
  restrictionReason: null,
  releaseAt: null,
  ...overrides,
});

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

function renderPage(search = "") {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
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

async function renderSingle(draft: AttemptDraftData) {
  savePracticePreference({ layout: "single", keyboardShortcuts: true });
  mockedFetch.mockResolvedValue(draft);
  const view = renderPage();
  await view.findByText(/做题方式：单题 · 每题提交后查看/);
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
  expect(screen.getAllByRole("button", { name: "下一题" })).toHaveLength(2);
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

it("未作答：提交本题禁用，「不会，提交并看解析」发空答案提交", async () => {
  await renderSingle(baseDraft());
  expect(screen.getByRole("button", { name: "提交本题" })).toBeDisabled();
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
  expect(screen.getAllByRole("button", { name: "下一题" })).toHaveLength(1);
});

// ---------- 列表模式：逐题 footer + 底栏进度 ----------

it("列表模式：每题 footer 提交区按作答态启停，提交后底栏进度与只读更新", async () => {
  savePracticePreference({ layout: "list", keyboardShortcuts: true });
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

it("after_attempt 冒烟（单题）：回执待公布时反馈区按统一公布呈现，主动作下一题", async () => {
  savePracticePreference({ layout: "single", keyboardShortcuts: true });
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
  await screen.findByText(/做题方式：单题 · 交卷后查看/);
  fireEvent.click(screen.getByRole("radio", { name: "对" }));
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  await screen.findByText("已提交，交卷后统一公布");
  expect(screen.getAllByRole("button", { name: "下一题" })).toHaveLength(2);
  // 导航只报提交事实（待公布），无对错泄露
  expect(
    screen.getByRole("button", { name: "第 1 题，已提交，反馈待公布" }),
  ).toBeInTheDocument();
});

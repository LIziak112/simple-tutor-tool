import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AttemptDraftData,
  PracticeQuestionSubmitData,
} from "@tutor/contract";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import {
  bindKeyboardBindingsAccount,
  saveKeyboardBindings,
} from "@/features/keyboard/keyboard-binding-store";
import {
  detectKeyboardDeviceForTest,
  resetKeyboardDeviceForTest,
} from "@/features/keyboard/keyboard-device";
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
import { workflowOf } from "./practice-test-fixtures";

// 重 UI 流程文件（平均用例 >3.5s）：本机常驻负载会让墙钟在安静窗口间漂移 ±40%，
// 5s 默认超时随机击中本文件任意用例——统一 15s（仍保留挂死检测，真卡死 3 倍即报）。
vi.setConfig({ testTimeout: 15_000 });

/**
 * 单题专注键盘方案（M3-D3，计划 §9.2）：Enter 主动作 / ←→ 切题 / 1-9 选项。
 * 守门矩阵：文本编辑区（composedPath 含 shadow DOM）不劫持；按钮/链接保留
 * 自身 Enter；repeat/合成/弹层/busy 不推进；一次 keydown 一个动作（提交成功
 * 后需新 keydown 才下一题）；偏好开关关闭后三类键全部失效；legacy/lesson
 * 不注册（既有套件回归）。
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
    // QM-08：作答会话消费冻结上下文投影——本用例无材料/组，空投影即可
    fetchAttemptContextApi: vi.fn(async (attemptId: string) => ({
      attemptId,
      materials: [],
      groups: [],
    })),
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

const ATTEMPT_ID = "77777777-7777-4777-8777-777777777777";

/** 四题草稿：q1 判断、q2 填空、q3 单选（3 项）、q4 多选（4 项），全部未提交 */
const kbDraft = (): AttemptDraftData => ({
  attempt: {
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
  },
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
          type: "choice",
          difficulty: 2,
          knowledge: ["有理数乘法"],
          stemMd: "下列说法正确的是：",
          options: ["甲", "乙", "丙"],
          hintCount: 0,
          questionRevisionId: "rev-q3",
        },
        {
          id: "q4",
          type: "multi",
          difficulty: 3,
          knowledge: ["有理数混合"],
          stemMd: "选出所有正确项：",
          options: ["A一", "B二", "C三", "D四"],
          hintCount: 0,
          questionRevisionId: "rev-q4",
        },
      ],
    },
  ],
  drafts: {},
  hintsOpened: {},
  legacyUnverified: false,
  answerRelease: "on_submit",
  enabledCapabilities: ["steps", "ink"],
  practiceWorkflow: workflowOf(),
  questionProgress: [
    { questionId: "q1", submittedAt: null, feedbackReadable: false },
    { questionId: "q2", submittedAt: null, feedbackReadable: false },
    { questionId: "q3", submittedAt: null, feedbackReadable: false },
    { questionId: "q4", submittedAt: null, feedbackReadable: false },
  ],
});

const submitReceipt = (questionId: string): PracticeQuestionSubmitData => ({
  feedback: { status: "pending_attempt" },
  questionProgress: (kbDraft().questionProgress ?? []).map((row) =>
    row.questionId === questionId
      ? {
          ...row,
          submittedAt: "2026-10-23T02:10:00.000Z",
          feedbackReadable: false,
        }
      : row,
  ),
  attempt: { ...kbDraft().attempt },
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

/** 进入单题专注模式并返回工作区容器（含进度行、题卡、操作条的外层容器） */
async function renderSingle(search = "") {
  savePracticePreference({
    layout: "single",
    keyboardShortcuts: true,
    feedback: null,
  });
  mockedFetch.mockResolvedValue(kbDraft());
  const view = renderPage(search);
  await view.findByText(/第 \d+ \/ 4 题 · 已提交 \d+ 题/);
  const container = document.querySelector<HTMLElement>(
    '[data-slot="practice-single-workspace"]',
  );
  if (container === null) throw new Error("单题工作区容器未渲染");
  return { view, container };
}

const progressRow = () => screen.getByText(/第 \d+ \/ 4 题/);

function press(
  target: Element,
  key: string,
  extra: KeyboardEventInit = {},
): void {
  fireEvent.keyDown(target, { key, ...extra });
}

beforeEach(() => {
  localStorage.clear();
  installDraftBackend(memoryBackend());
  bindPracticePreferenceAccount(null);
  bindKeyboardBindingsAccount(null);
  bindPracticePreferenceAccount("m3d3-kbd");
  // 键盘设备语境：统一先探测，避免依赖「首个按键顺带探测」的隐式副作用；
  // 需要未探测态的用例自行 reset
  detectKeyboardDeviceForTest();
  mockedFetch.mockReset();
  mockedSubmit.mockReset();
  mockedFeedbackGet.mockReset();
  mockedSubmit.mockImplementation(async (_attemptId, questionId) =>
    submitReceipt(questionId),
  );
  mockedFeedbackGet.mockResolvedValue({
    feedback: { status: "not_submitted" },
  });
  vi.mocked(saveAttemptAnswerApi).mockImplementation(
    async (_attemptId, questionId) => ({ questionId, changeCount: 1 }),
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

// ---------- Enter 主动作 ----------

it("文本输入聚焦时 Enter 不提交（输入控件保留自身语义）", async () => {
  await renderSingle("?q=q2");
  const input = screen.getByRole("textbox", { name: "第1空" });
  fireEvent.change(input, { target: { value: "4" } });
  input.focus();
  press(input, "Enter");
  expect(mockedSubmit).not.toHaveBeenCalled();
});

it("radio 聚焦时 Enter 执行主动作（提交本题）", async () => {
  const { container } = await renderSingle("?q=q1");
  const radio = screen.getByRole("radio", { name: "对" });
  fireEvent.click(radio);
  radio.focus();
  press(radio, "Enter");
  await screen.findByText(/已提交 1 题/);
  expect(mockedSubmit.mock.calls[0]?.[1]).toBe("q1");
  expect(container).toBeInTheDocument();
});

it("工作区容器聚焦时 Enter 执行主动作；长按 repeat、输入法合成与修饰键不推进", async () => {
  await renderSingle("?q=q2");
  const input = screen.getByRole("textbox", { name: "第1空" });
  fireEvent.change(input, { target: { value: "4" } });
  const container = document.querySelector<HTMLElement>(
    '[data-slot="practice-single-workspace"]',
  );
  if (container === null) throw new Error("容器未渲染");
  container.focus();
  press(container, "Enter", { repeat: true });
  press(container, "Enter", { isComposing: true });
  press(container, "Enter", { altKey: true });
  expect(mockedSubmit).not.toHaveBeenCalled();
  press(container, "Enter");
  await screen.findByText(/已提交 1 题/);
  expect(mockedSubmit.mock.calls[0]?.[1]).toBe("q2");
});

it("按钮聚焦时 Enter 不触发主动作（保留按钮自身语义）", async () => {
  await renderSingle("?q=q2");
  fireEvent.change(screen.getByRole("textbox", { name: "第1空" }), {
    target: { value: "4" },
  });
  const button = screen.getByRole("button", { name: "提交本题" });
  button.focus();
  press(button, "Enter");
  expect(mockedSubmit).not.toHaveBeenCalled();
  fireEvent.click(button);
  await screen.findByText(/已提交 1 题/);
  expect(mockedSubmit).toHaveBeenCalledTimes(1);
});

// ---------- busy 与一次 keydown 一个动作 ----------

it("提交中 Enter 与 ←→ 均无效；提交成功后需新 keydown 才切下一题", async () => {
  let resolveSubmit: () => void = () => {};
  mockedSubmit.mockImplementation(
    () =>
      new Promise<PracticeQuestionSubmitData>((resolve) => {
        resolveSubmit = () => resolve(submitReceipt("q1"));
      }),
  );
  const { container } = await renderSingle("?q=q1");
  fireEvent.click(screen.getByRole("radio", { name: "对" }));
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  await screen.findByRole("button", { name: "正在提交…" });
  container.focus();
  press(container, "Enter");
  press(container, "ArrowRight");
  expect(mockedSubmit).toHaveBeenCalledTimes(1);
  expect(progressRow().textContent).toContain("第 1 / 4 题");
  // 回执到达：主动作变下一题；同一轮按键不再推进，新 keydown 才切题
  resolveSubmit();
  await screen.findByText("已提交，交卷后统一公布");
  expect(progressRow().textContent).toContain("第 1 / 4 题");
  press(container, "Enter");
  await waitFor(() =>
    expect(progressRow().textContent).toContain("第 2 / 4 题"),
  );
});

// ---------- ←/→ 切题 ----------

it("←→ 仅工作区容器焦点生效；input 内方向键保持原生；弹层打开时不推进", async () => {
  const { container } = await renderSingle("?q=q2");
  // input 聚焦：方向键保持输入语义，不切题
  const input = screen.getByRole("textbox", { name: "第1空" });
  input.focus();
  press(input, "ArrowRight");
  expect(progressRow().textContent).toContain("第 2 / 4 题");
  // 容器聚焦：→ 下一题、← 上一题
  container.focus();
  press(container, "ArrowRight");
  await waitFor(() =>
    expect(progressRow().textContent).toContain("第 3 / 4 题"),
  );
  press(container, "ArrowLeft");
  await waitFor(() =>
    expect(progressRow().textContent).toContain("第 2 / 4 题"),
  );
  // 导航弹层打开：方向键不切题
  fireEvent.click(screen.getByRole("button", { name: "答题卡" }));
  await screen.findByRole("dialog");
  container.focus();
  press(container, "ArrowRight");
  expect(progressRow().textContent).toContain("第 2 / 4 题");
  fireEvent.click(screen.getByRole("button", { name: "关闭弹层" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  container.focus();
  press(container, "ArrowRight");
  await waitFor(() =>
    expect(progressRow().textContent).toContain("第 3 / 4 题"),
  );
});

// ---------- 1-9 选项 ----------

it("1-9 按可见选项作答：判断两项、单选第 n 项、多选切换、超界忽略", async () => {
  const { container } = await renderSingle("?q=q1");
  // 判断：1=对、2=错；3 超界忽略
  container.focus();
  press(container, "1");
  expect(screen.getByRole("radio", { name: "对" })).toBeChecked();
  press(container, "2");
  expect(screen.getByRole("radio", { name: "错" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "对" })).not.toBeChecked();
  press(container, "3");
  expect(screen.getByRole("radio", { name: "错" })).toBeChecked();
  // 单选：2=第 2 项（乙）；5 超界忽略（切题后焦点回落容器，连续导航可用）
  container.focus();
  press(container, "ArrowRight");
  await waitFor(() =>
    expect(progressRow().textContent).toContain("第 2 / 4 题"),
  );
  container.focus();
  press(container, "ArrowRight");
  await waitFor(() =>
    expect(progressRow().textContent).toContain("第 3 / 4 题"),
  );
  container.focus();
  press(container, "2");
  expect(screen.getByRole("radio", { name: /乙/ })).toBeChecked();
  press(container, "5");
  expect(screen.getByRole("radio", { name: /丙/ })).not.toBeChecked();
  // 多选：1 勾选、再按取消、4 勾选
  container.focus();
  press(container, "ArrowRight");
  await waitFor(() =>
    expect(progressRow().textContent).toContain("第 4 / 4 题"),
  );
  container.focus();
  press(container, "1");
  expect(screen.getByRole("checkbox", { name: /A一/ })).toBeChecked();
  press(container, "1");
  expect(screen.getByRole("checkbox", { name: /A一/ })).not.toBeChecked();
  press(container, "4");
  expect(screen.getByRole("checkbox", { name: /D四/ })).toBeChecked();
});

it("已提交只读题 1-9 不生效", async () => {
  const { container } = await renderSingle("?q=q1");
  fireEvent.click(screen.getByRole("radio", { name: "对" }));
  fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
  await screen.findByText("已提交，交卷后统一公布");
  container.focus();
  press(container, "2");
  expect(screen.getByRole("radio", { name: "对" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "错" })).not.toBeChecked();
});

// ---------- 偏好开关 ----------

it("快捷键关闭后 Enter、←→、1-9 全部不生效", async () => {
  savePracticePreference({
    layout: "single",
    keyboardShortcuts: false,
    feedback: null,
  });
  mockedFetch.mockResolvedValue(kbDraft());
  renderPage("?q=q2");
  await screen.findByText(/第 \d+ \/ 4 题 · 已提交 \d+ 题/);
  const container = document.querySelector<HTMLElement>(
    '[data-slot="practice-single-workspace"]',
  );
  if (container === null) throw new Error("容器未渲染");
  const input = screen.getByRole("textbox", { name: "第1空" });
  fireEvent.change(input, { target: { value: "4" } });
  container.focus();
  press(container, "Enter");
  press(container, "ArrowRight");
  press(container, "1");
  expect(mockedSubmit).not.toHaveBeenCalled();
  expect(progressRow().textContent).toContain("第 2 / 4 题");
  // 输入未被键盘动作清动（数字未误触选项、Enter 未提交）
  expect(input).toHaveValue("4");
});

// ---------- 帮助入口 ----------

it("「更多」菜单提供快捷键帮助入口，弹层列出键位", async () => {
  await renderSingle();
  // 设备门控（2026-10-28 快捷键体系）：模拟键盘设备接入后菜单入口才渲染
  detectKeyboardDeviceForTest();
  fireEvent.pointerDown(screen.getByRole("button", { name: "练习更多" }), {
    button: 0,
    ctrlKey: false,
  });
  const help = await screen.findByRole("menuitem", { name: /快捷键/ });
  fireEvent.click(help);
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("键盘快捷键");
  expect(dialog).toHaveTextContent(/Enter/);
  expect(dialog).toHaveTextContent(/←/);
  expect(dialog).toHaveTextContent(/1–9/);
});

// ---------- 键位自定义与设备门控（2026-10-28 快捷键体系） ----------

it("自定义键位即时生效：j 切下一题、默认 → 失效；帮助面板显示当前键位与固定标注", async () => {
  bindKeyboardBindingsAccount("m3d3-kbd");
  saveKeyboardBindings({ "practice.next-question": ["j"] });
  const { container } = await renderSingle("?q=q1");
  container.focus();
  press(container, "ArrowRight");
  expect(progressRow().textContent).toContain("第 1 / 4 题");
  press(container, "j");
  await waitFor(() =>
    expect(progressRow().textContent).toContain("第 2 / 4 题"),
  );
  fireEvent.pointerDown(screen.getByRole("button", { name: "练习更多" }), {
    button: 0,
    ctrlKey: false,
  });
  const help = await screen.findByRole("menuitem", { name: /快捷键/ });
  fireEvent.click(help);
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("j");
  expect(dialog).toHaveTextContent("固定");
});

it("? 打开快捷键帮助（默认键位）", async () => {
  const { container } = await renderSingle("?q=q2");
  container.focus();
  press(container, "?", { shiftKey: true });
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("键盘快捷键");
});

it("固定命令先匹配：open-help 改到 1 也不抢选项数字（1 仍选第 1 项）", async () => {
  bindKeyboardBindingsAccount("m3d3-kbd");
  // 键位撞固定键由设置页冲突检测拒存；此处直接写 store 验证派发优先级兜底
  saveKeyboardBindings({ "practice.open-help": ["1"] });
  const { container } = await renderSingle("?q=q1");
  container.focus();
  press(container, "1");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("radio", { name: "对" })).toBeChecked();
});

it("默认键位沿用 Shift 变体：Shift+Enter 提交本题、Shift+→ 切下一题", async () => {
  const { container } = await renderSingle("?q=q2");
  const input = screen.getByRole("textbox", { name: "第1空" });
  fireEvent.change(input, { target: { value: "4" } });
  container.focus();
  press(container, "Enter", { shiftKey: true });
  await screen.findByText(/已提交 1 题/);
  expect(mockedSubmit.mock.calls[0]?.[1]).toBe("q2");
  press(container, "ArrowRight", { shiftKey: true });
  await waitFor(() =>
    expect(progressRow().textContent).toContain("第 3 / 4 题"),
  );
});

it("键盘设备未探测时「快捷键」入口不出现；探测成功当次会话出现", async () => {
  resetKeyboardDeviceForTest();
  await renderSingle();
  fireEvent.pointerDown(screen.getByRole("button", { name: "练习更多" }), {
    button: 0,
    ctrlKey: false,
  });
  expect(screen.queryByRole("menuitem", { name: /快捷键/ })).toBeNull();
  // 探测：派发合格 keydown（等价 iPad 接入实体键盘首键，同时关掉菜单）
  detectKeyboardDeviceForTest();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.pointerDown(screen.getByRole("button", { name: "练习更多" }), {
    button: 0,
    ctrlKey: false,
  });
  expect(
    await screen.findByRole("menuitem", { name: /快捷键/ }),
  ).toBeInTheDocument();
});

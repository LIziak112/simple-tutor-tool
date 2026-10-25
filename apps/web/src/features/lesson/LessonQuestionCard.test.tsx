import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AttemptQuestionPublic,
  AttemptResultQuestion,
  HintOpenedEntry,
  StudentAnswer,
} from "@tutor/contract";
import type { ReactNode } from "react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AttemptEditorProvider } from "@/features/attempt/AttemptEditorContext";
import { LessonQuestionCard } from "./LessonQuestionCard";
import type {
  LessonQuestionHandlers,
  LessonSubmitOutcome,
} from "./use-lesson-attempt";

/**
 * 讲练页题卡（2026-10 讲练一体）组件测试：
 * - 作答态：题干投影（QuestionSurface）+ 按题型作答 + 提示面板 + 「显示答案」
 *   （一键直达：教师演示场景，未作答不警示、不弹确认层；仅缺稿 problems /
 *   stale / error 时弹兜底层：缺稿明确选择、出错文案与重试）；
 * - 结果态（教师演示简化形态）：对错徽章（null=无自动判定不显示）+ 参考答案
 *   + 解析直接展示；不渲染本题历史/结果页链接/批改块/提示回显/待批刷新；
 * - 只读防御态：无 handlers 且无 released。
 */

const ATTEMPT_ID = "66666666-6666-4666-8666-666666666666";

it("讲练客观题作答态提供草稿与标画，已提交后不能继续编辑", () => {
  const view = renderCard();
  expect(screen.getByRole("button", { name: /草稿纸/ })).toBeVisible();
  expect(screen.getByRole("button", { name: /圈画题干/ })).toBeVisible();
  view.unmount();
  renderCard({ released: RELEASED_Q1 });
  expect(screen.queryByRole("button", { name: /草稿纸/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /圈画题干/ })).toBeNull();
});

const QUESTION: AttemptQuestionPublic = {
  id: "lesson-q1",
  type: "choice",
  difficulty: 2,
  knowledge: ["有理数"],
  stemMd: "下列各数中，正数是（）",
  options: ["$+7$", "$-3.5$", "$0$"],
  hintCount: 0,
  questionRevisionId: "rev-q1",
};

const HINT_QUESTION: AttemptQuestionPublic = {
  ...QUESTION,
  id: "lesson-q2",
  hintCount: 1,
  questionRevisionId: "rev-q2",
};

/** 已提交（choice 判对）的当题释放形态 */
const RELEASED_Q1: AttemptResultQuestion = {
  questionId: "lesson-q1",
  snapshot: {
    id: "lesson-q1",
    type: "choice",
    difficulty: 2,
    knowledge: ["有理数"],
    stemMd: "下列各数中，正数是（）",
    options: ["$+7$", "$-3.5$", "$0$"],
    hintCount: 0,
  },
  answers: { kind: "choice", index: 0 },
  solutionMd: "正数是 $+7$。",
  answer: { kind: "choice", index: 0 },
  answered: true,
  studentFlag: null,
  autoCorrect: true,
  teacherMark: null,
  teacherComment: null,
  finalCorrect: true,
  hintsOpened: [],
};

/** 基础 handlers 桩（各用例按需覆盖 submit） */
function baseHandlers(
  overrides?: Partial<LessonQuestionHandlers>,
): LessonQuestionHandlers {
  return {
    onAnswer: vi.fn(),
    onHintUnlocked: vi.fn(),
    registerInkController: vi.fn(),
    registerCard: vi.fn(),
    submit: vi.fn(
      async (): Promise<LessonSubmitOutcome> => ({ kind: "submitted" }),
    ),
    ...overrides,
  };
}

function renderCard(props?: {
  question?: AttemptQuestionPublic;
  answer?: StudentAnswer;
  hints?: readonly HintOpenedEntry[];
  released?: AttemptResultQuestion;
  handlers?: LessonQuestionHandlers | null;
  index?: number;
}) {
  return render(
    <TestProviders>
      <MemoryRouter>
        <LessonQuestionCard
          index={props?.index ?? 0}
          question={props?.question ?? QUESTION}
          attemptId={ATTEMPT_ID}
          answer={props?.answer}
          hints={props?.hints ?? []}
          released={props?.released}
          handlers={
            props?.handlers === null
              ? undefined
              : (props?.handlers ?? baseHandlers())
          }
        />
      </MemoryRouter>
    </TestProviders>,
  );
}

/** 提交流程联动桩：submit 成功后把卡切到结果态（模拟页面 released 更新） */
function FlowHarness({
  submit,
  question = QUESTION,
  released = RELEASED_Q1,
}: {
  submit: LessonQuestionHandlers["submit"];
  question?: AttemptQuestionPublic;
  released?: AttemptResultQuestion;
}) {
  const [releasedState, setReleased] = useState<
    AttemptResultQuestion | undefined
  >(undefined);
  const handlers: LessonQuestionHandlers = {
    ...baseHandlers(),
    submit: async (questionId, opts) => {
      const outcome = await submit(questionId, opts);
      if (outcome.kind === "submitted") setReleased(released);
      return outcome;
    },
  };
  return (
    <TestProviders>
      <MemoryRouter>
        <LessonQuestionCard
          index={0}
          question={question}
          attemptId={ATTEMPT_ID}
          answer={undefined}
          hints={[]}
          released={releasedState}
          handlers={handlers}
        />
      </MemoryRouter>
    </TestProviders>
  );
}

describe("LessonQuestionCard：作答态", () => {
  it("渲染题号、题型徽章、题干与选项；作答回调上抛", () => {
    const handlers = baseHandlers();
    renderCard({ handlers });
    expect(screen.getByText("第 1 题")).toBeInTheDocument();
    expect(screen.getByText("单选")).toBeInTheDocument();
    expect(screen.getByText("下列各数中，正数是（）")).toBeInTheDocument();
    // 同既有题卡测试：含公式的选项不做 accessible-name 匹配（jsdom 样式解析坑），
    // 按序取第一个 radio
    const [firstRadio] = screen.getAllByRole("radio");
    if (firstRadio === undefined) throw new Error("单选选项缺失");
    fireEvent.click(firstRadio);
    expect(handlers.onAnswer).toHaveBeenCalledWith(
      "lesson-q1",
      { kind: "choice", index: 0 },
      false,
    );
  });

  it("hintCount>0 渲染提示面板；已解锁提示回显", () => {
    renderCard({
      question: HINT_QUESTION,
      hints: [{ index: 0, text: "正数大于 0。" }],
    });
    expect(screen.getByText("提示 1")).toBeInTheDocument();
    expect(screen.getByText("正数大于 0。")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /给我一点提示/ }),
    ).not.toBeInTheDocument();
  });

  it("显示答案：一键直达调 submit（无确认弹层、未作答不警示），成功后转结果态", async () => {
    const submit = vi.fn(
      async (
        _questionId: string,
        _opts?: { allowMissing?: boolean },
      ): Promise<LessonSubmitOutcome> => ({ kind: "submitted" }),
    );
    render(<FlowHarness submit={submit} />);
    fireEvent.click(screen.getByRole("button", { name: "显示答案" }));
    // 教师演示场景：未选答案也直接显示，不弹确认层
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]?.[0]).toBe("lesson-q1");
    expect(submit.mock.calls[0]?.[1]).toBeUndefined();
    // 成功 → 卡片转结果态（对错徽章出现）
    expect(await screen.findByText("答对")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "显示答案" }),
    ).not.toBeInTheDocument();
  });

  it("已选答案后点击显示答案：同样直达，不弹确认层", async () => {
    const submit = vi.fn(
      async (): Promise<LessonSubmitOutcome> => ({ kind: "submitted" }),
    );
    renderCard({
      answer: { kind: "choice", index: 0 },
      handlers: baseHandlers({ submit }),
    });
    fireEvent.click(screen.getByRole("button", { name: "显示答案" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("缺稿弹层选「返回作答」：不带 allowMissing 重试，回到作答态", async () => {
    const submit = vi.fn(
      async (
        _questionId: string,
        opts?: { allowMissing?: boolean },
      ): Promise<LessonSubmitOutcome> =>
        opts?.allowMissing
          ? { kind: "submitted" }
          : {
              kind: "problems",
              problems: [
                {
                  questionId: "lesson-q1",
                  reason: "草稿尚未保存完整（网络不稳定，正在重试）",
                },
              ],
            },
    );
    render(<FlowHarness submit={submit} />);
    fireEvent.click(screen.getByRole("button", { name: "显示答案" }));
    fireEvent.click(await screen.findByRole("button", { name: "返回作答" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    // 只有初次直达那次调用，未带 allowMissing 重交
    expect(submit).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "显示答案" }),
    ).toBeInTheDocument();
  });

  it("problems（草稿未保存完整）：弹层转明确选择分支，确认缺稿后带 allowMissing 重交", async () => {
    const submit = vi.fn(
      async (
        _questionId: string,
        opts?: { allowMissing?: boolean },
      ): Promise<LessonSubmitOutcome> =>
        opts?.allowMissing
          ? { kind: "submitted" }
          : {
              kind: "problems",
              problems: [
                {
                  questionId: "lesson-q1",
                  reason: "草稿尚未保存完整（网络不稳定，正在重试）",
                },
              ],
            },
    );
    render(<FlowHarness submit={submit} />);
    fireEvent.click(screen.getByRole("button", { name: "显示答案" }));
    // 直接弹缺稿明确选择（无确认层前置）
    expect(
      await screen.findByText("这道题的草稿未保存完整："),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /显示答案，草稿未保存完整/ }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /显示答案，草稿未保存完整/ }),
    );
    await waitFor(() =>
      expect(submit).toHaveBeenLastCalledWith("lesson-q1", {
        allowMissing: true,
      }),
    );
    expect(await screen.findByText("答对")).toBeInTheDocument();
  });

  it("stale（题目版本过期）：弹层提示刷新，不转结果态", async () => {
    const submit = vi.fn(
      async (): Promise<LessonSubmitOutcome> => ({
        kind: "stale",
        message: "页面内容已过期，请刷新后重试",
      }),
    );
    render(<FlowHarness submit={submit} />);
    fireEvent.click(screen.getByRole("button", { name: "显示答案" }));
    expect(
      await screen.findByText("页面内容已过期，请刷新后重试"),
    ).toBeInTheDocument();
    // 仍在作答态（弹层开启期间对弹层外元素避免 accessible-name 查询——
    // jsdom 对 react-remove-scroll 注入样式做 getComputedStyle 会崩，用文本查询）
    expect(screen.getByText("显示答案")).toBeInTheDocument();
  });

  it("error（保存失败等）：弹层显示错误信息，关闭后可再点重试", async () => {
    let calls = 0;
    const submit = vi.fn(async (): Promise<LessonSubmitOutcome> => {
      calls += 1;
      return calls === 1
        ? { kind: "error", message: "答案尚未保存，请检查网络后重试" }
        : { kind: "submitted" };
    });
    render(<FlowHarness submit={submit} />);
    fireEvent.click(screen.getByRole("button", { name: "显示答案" }));
    expect(
      await screen.findByText("答案尚未保存，请检查网络后重试"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "显示答案" }));
    expect(await screen.findByText("答对")).toBeInTheDocument();
  });
});

describe("LessonQuestionCard：结果态", () => {
  it("对错徽章 + 参考答案 + 解析直接展示；不渲染折叠按钮与本题历史", () => {
    renderCard({ released: RELEASED_Q1 });
    expect(screen.getByText("答对")).toBeInTheDocument();
    expect(screen.getByText("参考答案：")).toBeInTheDocument();
    // 解析直接展示（不折叠、无需点击；前缀锚定详解段——题干也含「正数是」字样）
    expect(screen.getByText(/^正数是/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "查看详解" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /本题历史/ }),
    ).not.toBeInTheDocument();
  });

  it("选项标记正确项与本人选择", () => {
    renderCard({ released: RELEASED_Q1 });
    expect(screen.getByText("正确项 · 你的选择")).toBeInTheDocument();
  });

  it("无自动判定（finalCorrect=null，如填空/手写）：不渲染判定徽章与刷新，仍展示参考答案与解析", () => {
    renderCard({
      released: {
        ...RELEASED_Q1,
        answers: null,
        autoCorrect: null,
        finalCorrect: null,
        solutionMd: "参考答案见比对区。",
      },
    });
    expect(screen.queryByText("答对")).not.toBeInTheDocument();
    expect(screen.queryByText("答错")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "刷新" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("参考答案：")).toBeInTheDocument();
    expect(screen.getByText("解析")).toBeInTheDocument();
    expect(screen.getByText("参考答案见比对区。")).toBeInTheDocument();
  });
});

describe("LessonQuestionCard：只读防御态", () => {
  it("无 handlers 且无 released：显示需刷新提示，不渲染作答控件", () => {
    renderCard({ handlers: null });
    expect(screen.getByText("第 1 题")).toBeInTheDocument();
    expect(
      screen.getByText("本题暂时不能作答，请刷新页面后重试。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "显示答案" }),
    ).not.toBeInTheDocument();
  });
});

function TestProviders({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <AttemptEditorProvider>{children}</AttemptEditorProvider>
    </QueryClientProvider>
  );
}

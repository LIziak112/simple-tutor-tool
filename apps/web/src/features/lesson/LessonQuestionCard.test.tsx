import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AttemptQuestionPublic,
  AttemptResultQuestion,
  HintOpenedEntry,
  StudentAnswer,
} from "@tutor/contract";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { LessonQuestionCard } from "./LessonQuestionCard";
import type {
  LessonQuestionHandlers,
  LessonSubmitOutcome,
} from "./use-lesson-attempt";

/**
 * 讲练页题卡（2026-10 讲练一体）组件测试：
 * - 作答态：题干投影（QuestionSurface）+ 按题型作答 + 提示面板 + 「提交本题」
 *   （提交前确认弹层；未作答警示；problems → 缺稿明确选择；stale/error 文案）；
 * - 结果态：对错徽章（null=待老师批改 + 刷新）+ 参考答案 + 详解折叠 +
 *   已解锁提示回显 + 本题历史链接 +（attempt 收尾后）完整结果页链接；
 * - 只读防御态：无 handlers 且无 released。
 */

const ATTEMPT_ID = "66666666-6666-4666-8666-666666666666";

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
  attemptCompleted?: boolean;
  handlers?: LessonQuestionHandlers | null;
  onRefresh?: () => void;
  index?: number;
}) {
  return render(
    <MemoryRouter>
      <LessonQuestionCard
        index={props?.index ?? 0}
        question={props?.question ?? QUESTION}
        attemptId={ATTEMPT_ID}
        answer={props?.answer}
        hints={props?.hints ?? []}
        released={props?.released}
        attemptCompleted={props?.attemptCompleted ?? false}
        handlers={
          props?.handlers === null
            ? undefined
            : (props?.handlers ?? baseHandlers())
        }
        onRefresh={props?.onRefresh ?? vi.fn()}
      />
    </MemoryRouter>,
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
    <MemoryRouter>
      <LessonQuestionCard
        index={0}
        question={question}
        attemptId={ATTEMPT_ID}
        answer={undefined}
        hints={[]}
        released={releasedState}
        attemptCompleted={false}
        handlers={handlers}
        onRefresh={vi.fn()}
      />
    </MemoryRouter>
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

  it("提交本题：先确认（未作答警示），确认后调 submit 并转结果态", async () => {
    const submit = vi.fn(
      async (
        _questionId: string,
        _opts?: { allowMissing?: boolean },
      ): Promise<LessonSubmitOutcome> => ({ kind: "submitted" }),
    );
    render(<FlowHarness submit={submit} />);
    fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
    expect(
      await screen.findByRole("dialog", { name: "提交本题吗？" }),
    ).toBeInTheDocument();
    // 未作答警示（choice 未选）
    expect(screen.getByText(/还没有作答/)).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认提交" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]?.[0]).toBe("lesson-q1");
    // 提交成功 → 卡片转结果态（对错徽章出现、弹层关闭）
    expect(await screen.findByText("答对")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "提交本题" }),
    ).not.toBeInTheDocument();
  });

  it("已作答时确认弹层提示提交后不可修改", async () => {
    renderCard({
      answer: { kind: "choice", index: 0 },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
    expect(
      await screen.findByRole("dialog", { name: "提交本题吗？" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/提交后.*不能再修改/)).toBeInTheDocument();
    expect(screen.queryByText(/还没有作答/)).not.toBeInTheDocument();
  });

  it("取消确认：不调 submit，回到作答", async () => {
    const submit = vi.fn(
      async (): Promise<LessonSubmitOutcome> => ({ kind: "submitted" }),
    );
    render(<FlowHarness submit={submit} />);
    fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
    fireEvent.click(await screen.findByRole("button", { name: "继续作答" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(submit).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "提交本题" }),
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
    fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认提交" }));
    // 明确选择分支：问题清单 + 缺稿提交按钮
    expect(
      await screen.findByText("这道题的草稿未保存完整："),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /提交答案，草稿未保存完整/ }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /提交答案，草稿未保存完整/ }),
    );
    await waitFor(() =>
      expect(submit).toHaveBeenLastCalledWith("lesson-q1", {
        allowMissing: true,
      }),
    );
    expect(await screen.findByText("答对")).toBeInTheDocument();
  });

  it("stale（题目版本过期）：提示刷新，不转结果态", async () => {
    const submit = vi.fn(
      async (): Promise<LessonSubmitOutcome> => ({
        kind: "stale",
        message: "页面内容已过期，请刷新后重试",
      }),
    );
    render(<FlowHarness submit={submit} />);
    fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认提交" }));
    expect(
      await screen.findByText("页面内容已过期，请刷新后重试"),
    ).toBeInTheDocument();
    // 仍在作答态（弹层开启期间对弹层外元素避免 accessible-name 查询——
    // jsdom 对 react-remove-scroll 注入样式做 getComputedStyle 会崩，用文本查询）
    expect(screen.getByText("提交本题")).toBeInTheDocument();
  });

  it("error（保存失败等）：弹层显示错误信息，可重试提交", async () => {
    let calls = 0;
    const submit = vi.fn(async (): Promise<LessonSubmitOutcome> => {
      calls += 1;
      return calls === 1
        ? { kind: "error", message: "答案尚未保存，请检查网络后重试交卷" }
        : { kind: "submitted" };
    });
    render(<FlowHarness submit={submit} />);
    fireEvent.click(screen.getByRole("button", { name: "提交本题" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认提交" }));
    expect(
      await screen.findByText("答案尚未保存，请检查网络后重试交卷"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认提交" }));
    expect(await screen.findByText("答对")).toBeInTheDocument();
  });
});

describe("LessonQuestionCard：结果态", () => {
  it("对错徽章 + 参考答案 + 详解折叠 + 本题历史链接", async () => {
    renderCard({ released: RELEASED_Q1 });
    expect(screen.getByText("答对")).toBeInTheDocument();
    expect(screen.getByText("参考答案：")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "第 1 题本题历史" }),
    ).toBeInTheDocument();
    // 详解默认折叠，展开后可见（前缀锚定详解段——题干也含「正数是」字样）
    expect(screen.queryByText("正数是 $+7$。")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看详解" }));
    await waitFor(() =>
      expect(screen.getByText(/^正数是/)).toBeInTheDocument(),
    );
  });

  it("选项标记正确项与本人选择", () => {
    renderCard({ released: RELEASED_Q1 });
    expect(screen.getByText("正确项 · 你的选择")).toBeInTheDocument();
  });

  it("已解锁提示回显（released.hintsOpened）", () => {
    renderCard({
      released: {
        ...RELEASED_Q1,
        hintsOpened: [{ index: 0, text: "正数大于 0。" }],
      },
    });
    expect(screen.getByText("做题时看过的提示（1 条）")).toBeInTheDocument();
    expect(screen.getByText("正数大于 0。")).toBeInTheDocument();
  });

  it("教师批改块（teacherMark/teacherComment）", () => {
    renderCard({
      released: {
        ...RELEASED_Q1,
        autoCorrect: null,
        finalCorrect: false,
        teacherMark: "wrong",
        teacherComment: "注意正数的定义。",
      },
    });
    expect(screen.getByText("答错")).toBeInTheDocument();
    expect(screen.getByText(/注意正数的定义/)).toBeInTheDocument();
  });

  it("待批（finalCorrect=null）：显示「待老师批改」+ 刷新按钮调 onRefresh", () => {
    const onRefresh = vi.fn();
    renderCard({
      released: {
        ...RELEASED_Q1,
        answers: null,
        autoCorrect: null,
        finalCorrect: null,
      },
      onRefresh,
    });
    expect(screen.getByText("待老师批改")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it("attempt 已收尾：附「查看完整结果页」链接指向 /s/attempts/:id", () => {
    renderCard({ released: RELEASED_Q1, attemptCompleted: true });
    const link = screen.getByRole("link", { name: "查看完整结果页" });
    expect(link).toHaveAttribute("href", `/s/attempts/${ATTEMPT_ID}`);
  });

  it("未收尾：不渲染完整结果页链接", () => {
    renderCard({ released: RELEASED_Q1, attemptCompleted: false });
    expect(
      screen.queryByRole("link", { name: "查看完整结果页" }),
    ).not.toBeInTheDocument();
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
      screen.queryByRole("button", { name: "提交本题" }),
    ).not.toBeInTheDocument();
  });
});

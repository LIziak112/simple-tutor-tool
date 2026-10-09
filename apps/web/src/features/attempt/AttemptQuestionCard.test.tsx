import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  HintOpenedEntry,
  QuestionPublic,
  StudentAnswer,
} from "@tutor/contract";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { EnabledCapabilitiesProvider } from "@/features/capability/enabled-capabilities";
import { NOTE_QUESTION_SHARE } from "@/features/notes/note-layout";
import { makeResizeObserverStub } from "@/features/notes/note-test-utils";
import { openAttemptHintApi } from "@/lib/api";
import { AttemptQuestionCard } from "./AttemptQuestionCard";

/**
 * 答题页题卡组件测试（T2.6）：题头元信息（题号/题型徽章/难度/考点）与
 * 各题型作答控件交互——判断对/错、单选、多选（可取消）、填空内联输入、
 * 手写题最终答案输入；onAnswer 的形态与防抖标记。
 * T2.8：手写题控件接入手写区/上传状态机——题卡测试 mock 笔迹 API
 * （fetchAttemptInkApi → null 即无历史笔迹），手写区展开/上传/flush 的
 * 行为在 HandwrittenControls.test.tsx 与 use-ink-upload.test.ts 单独覆盖。
 *
 * 交互用有状态 Harness（answer 随 onAnswer 回写），还原真实页面的受控数据流。
 */

vi.mock("@/lib/api", () => ({
  fetchAttemptInkApi: vi.fn(async () => null),
  putAttemptInkApi: vi.fn(async () => ({
    questionId: "",
    inkId: "",
    strokeCount: 0,
    width: 0,
    height: 0,
    updatedAt: "",
  })),
  studentInkPngUrl: (attemptId: string, questionId: string) =>
    `/api/student/attempts/${attemptId}/ink/${questionId}.png`,
  // T2.11：提示解锁（HintPanel 使用；点击流用例里断言调用参数）
  openAttemptHintApi: vi.fn(async () => ({
    questionId: "",
    index: 0,
    hint: "",
    hintCount: 0,
    hintsUsed: 0,
    hintsRemaining: 0,
  })),
}));

function baseQuestion(overrides: Partial<QuestionPublic>): QuestionPublic {
  return {
    id: "练习四-1",
    type: "judge",
    difficulty: 2,
    knowledge: ["有理数加法"],
    stemMd: "题干",
    hintCount: 0,
    ...overrides,
  };
}

/** 记录 onAnswer 调用并把答案回写给卡片（受控组件的真实行为）。手写题传 attemptId */
function renderStatefulCard(
  question: QuestionPublic,
  options: {
    attemptId?: string;
    /** T2.11：已解锁提示（缺省不渲染提示面板） */
    hints?: readonly HintOpenedEntry[];
    onHintUnlocked?: (entry: HintOpenedEntry) => void;
    /** T7.7：辅助能力启用集（缺省不包 Provider=全启用） */
    capabilities?: { steps: boolean; ink: boolean };
  } = {},
) {
  const onAnswer = vi.fn();
  function Harness() {
    const [answer, setAnswer] = useState<StudentAnswer | undefined>(undefined);
    const [hints, setHints] = useState<readonly HintOpenedEntry[]>(
      options.hints ?? [],
    );
    return (
      <AttemptQuestionCard
        index={2}
        question={question}
        answer={answer}
        onAnswer={(next, defer) => {
          // 与页面一致：缺省 defer 记为 false（离散控件立即保存的语义）
          onAnswer(next, defer ?? false);
          setAnswer(next);
        }}
        {...(options.attemptId !== undefined
          ? { attemptId: options.attemptId }
          : {})}
        {...(options.onHintUnlocked !== undefined
          ? {
              hints,
              onHintUnlocked: (entry: HintOpenedEntry) => {
                options.onHintUnlocked?.(entry);
                setHints((prev) => [...prev, entry]);
              },
            }
          : {})}
      />
    );
  }
  // T6R.9：草稿层经 react-query 拉 head——测试 harness 提供独立 client
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      {options.capabilities === undefined ? (
        <Harness />
      ) : (
        <EnabledCapabilitiesProvider value={options.capabilities}>
          <Harness />
        </EnabledCapabilitiesProvider>
      )}
    </QueryClientProvider>,
  );
  return { ...utils, onAnswer };
}

describe("题头元信息", () => {
  it("渲染题号（+1）、题型徽章中文、难度星、考点 tag", () => {
    renderStatefulCard(baseQuestion({ type: "judge", difficulty: 3 }));
    expect(screen.getByText("第 3 题")).toBeInTheDocument();
    expect(screen.getByText("判断")).toBeInTheDocument();
    expect(screen.getByText("有理数加法")).toBeInTheDocument();
    expect(screen.getByLabelText("难度 3 星（满分 5 星）")).toBeInTheDocument();
  });

  it("判断题题干尾部 [[]] 替换为（　）空括号", () => {
    const { container } = renderStatefulCard(
      baseQuestion({
        type: "judge",
        stemMd: "$0$ 既不是正数，也不是负数。[[]]",
      }),
    );
    expect(container.textContent).toContain("（　）");
  });
});

describe("判断题控件", () => {
  it("点「对」提交 {kind:'judge', value:true}；选中态体现在 checked", () => {
    const { onAnswer } = renderStatefulCard(baseQuestion({ type: "judge" }));
    fireEvent.click(screen.getByRole("radio", { name: "对" }));
    expect(onAnswer).toHaveBeenCalledWith(
      { kind: "judge", value: true },
      false,
    );
    expect(screen.getByRole("radio", { name: "对" })).toBeChecked();
    // 切换到「错」
    fireEvent.click(screen.getByRole("radio", { name: "错" }));
    expect(onAnswer).toHaveBeenLastCalledWith(
      { kind: "judge", value: false },
      false,
    );
    expect(screen.getByRole("radio", { name: "错" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "对" })).not.toBeChecked();
  });
});

describe("单选题控件", () => {
  const choice = baseQuestion({
    type: "choice",
    stemMd: "$-5$ 的相反数是（　）",
    options: ["$-5$", "$5$", "$\\frac{1}{5}$"],
  });

  it("选项列表带字母；点选提交 {kind:'choice', index} 并回显选中", () => {
    const { onAnswer } = renderStatefulCard(choice);
    fireEvent.click(screen.getByRole("radio", { name: "选项 B" }));
    expect(onAnswer).toHaveBeenCalledWith({ kind: "choice", index: 1 }, false);
    expect(screen.getByRole("radio", { name: "选项 B" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "选项 A" })).not.toBeChecked();
  });
});

describe("多选题控件", () => {
  const multi = baseQuestion({
    type: "multi",
    stemMd: "选出结果为正数的算式",
    options: ["$(-3)+7$", "$(-2)+(-5)$", "$0+4.8$"],
  });

  it("多选累加、再点取消；提交 {kind:'multi', indexes}", () => {
    const { onAnswer } = renderStatefulCard(multi);
    fireEvent.click(screen.getByRole("checkbox", { name: "选项 A" }));
    expect(onAnswer).toHaveBeenLastCalledWith(
      { kind: "multi", indexes: [0] },
      false,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "选项 C" }));
    expect(onAnswer).toHaveBeenLastCalledWith(
      { kind: "multi", indexes: [0, 2] },
      false,
    );
    // 再点 A → 从选中集中移除
    fireEvent.click(screen.getByRole("checkbox", { name: "选项 A" }));
    expect(onAnswer).toHaveBeenLastCalledWith(
      { kind: "multi", indexes: [2] },
      false,
    );
    expect(screen.getByRole("checkbox", { name: "选项 A" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "选项 C" })).toBeChecked();
  });
});

describe("填空题：题干空位内联输入", () => {
  const fill = baseQuestion({
    type: "fill",
    stemMd: "计算：$(-3)+7=$ [[]]；$(-2)+(-5)=$ [[]]。",
  });

  it("空位渲染为输入框（第1空/第2空），输入触发防抖保存的 fill 答案并累计", () => {
    const { onAnswer } = renderStatefulCard(fill);
    const first = screen.getByLabelText("第1空");
    expect(first).toBeInTheDocument();
    expect(screen.getByLabelText("第2空")).toBeInTheDocument();

    fireEvent.change(first, { target: { value: "4" } });
    expect(onAnswer).toHaveBeenLastCalledWith(
      { kind: "fill", values: ["4"] },
      true,
    );
    // 第二空的值在第一空基础上累计（answer 已回写）
    fireEvent.change(screen.getByLabelText("第2空"), {
      target: { value: "-7" },
    });
    expect(onAnswer).toHaveBeenLastCalledWith(
      { kind: "fill", values: ["4", "-7"] },
      true,
    );
    // 回显
    expect(screen.getByLabelText("第1空")).toHaveValue("4");
    expect(screen.getByLabelText("第2空")).toHaveValue("-7");
  });

  it("跨段落的多空题干空序连续编号（第 3 空不因换段重置）", () => {
    const { onAnswer } = renderStatefulCard(
      baseQuestion({
        type: "fill",
        stemMd:
          "计算：$(-3)+7=$ [[]]；$(-2)+(-5)=$ [[]]。\n\n写等价形式：$0.5=$ [[]]。",
      }),
    );
    // 三空齐全（回归：此前非指令子树的计数不回传，第二段的空会重置为第 1 空）
    expect(screen.getByLabelText("第1空")).toBeInTheDocument();
    expect(screen.getByLabelText("第2空")).toBeInTheDocument();
    expect(screen.getByLabelText("第3空")).toBeInTheDocument();
    // 第 3 空的输入累计前两空的值
    fireEvent.change(screen.getByLabelText("第1空"), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByLabelText("第2空"), {
      target: { value: "-7" },
    });
    fireEvent.change(screen.getByLabelText("第3空"), {
      target: { value: "1/2" },
    });
    expect(onAnswer).toHaveBeenLastCalledWith(
      { kind: "fill", values: ["4", "-7", "1/2"] },
      true,
    );
  });
});

describe("手写题（solve/apply/find-error）控件", () => {
  const solve = baseQuestion({
    type: "solve",
    stemMd: "计算 $-2^2+(-3)\\times(-\\frac{1}{3})$，写出过程。",
  });

  it("显示「展开手写区」（默认收起）与最终答案输入；输入触发防抖保存并回显", () => {
    const { onAnswer } = renderStatefulCard(solve, { attemptId: "att-1" });
    // T2.8：手写区默认收起（节省首屏），不再显示占位文案
    expect(screen.queryByText(/手写作答区即将开放/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /展开手写区/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /全屏作答/ }),
    ).toBeInTheDocument();
    const input = screen.getByLabelText("最终答案");
    fireEvent.change(input, { target: { value: "-3" } });
    expect(onAnswer).toHaveBeenLastCalledWith(
      { kind: "final", finalAnswer: "-3" },
      true,
    );
    expect(screen.getByLabelText("最终答案")).toHaveValue("-3");
  });
});

describe("分步提示面板（T2.11）", () => {
  const mockedOpen = vi.mocked(openAttemptHintApi);

  it("hintCount=0 的题不显示提示按钮（即使提供了 attemptId 与回调）", () => {
    renderStatefulCard(baseQuestion({ type: "judge", hintCount: 0 }), {
      attemptId: "att-1",
      onHintUnlocked: () => {},
    });
    expect(screen.queryByRole("button", { name: /给我一点提示/ })).toBeNull();
  });

  it("hintCount>0：点「给我一点提示」请求下一条（index=已解锁数）并展示；初值回显已解锁条目", async () => {
    renderStatefulCard(baseQuestion({ type: "choice", hintCount: 2 }), {
      attemptId: "att-1",
      hints: [{ index: 0, text: "只有符号不同的两个数互为相反数。" }],
      onHintUnlocked: () => {},
    });
    // 初值回显：第 1 条已在列表，剩余 1 条
    expect(screen.getByText("提示 1")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "给我一点提示（剩余 1 条）" }),
    ).toBeInTheDocument();

    mockedOpen.mockResolvedValueOnce({
      questionId: "练习四-1",
      index: 1,
      hint: "注意符号的确定方法。",
      hintCount: 2,
      hintsUsed: 2,
      hintsRemaining: 0,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "给我一点提示（剩余 1 条）" }),
    );
    await waitFor(() => {
      expect(mockedOpen).toHaveBeenCalledWith("att-1", "练习四-1", 1);
    });
    // 解锁完：按钮消失、两条都在列表
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /给我一点提示/ })).toBeNull();
    });
    expect(screen.getByText("提示 2")).toBeInTheDocument();
  });

  it("未提供 onHintUnlocked（如结果视图外的纯展示场景）不渲染提示面板", () => {
    renderStatefulCard(baseQuestion({ type: "choice", hintCount: 2 }));
    expect(screen.queryByRole("button", { name: /给我一点提示/ })).toBeNull();
  });
});

describe("题卡草稿层（T6R.9）", () => {
  /** 桩 ResizeObserver：按需推送题卡宽度（共享桩，分栏判定驱动源） */
  function stubCardWidth() {
    const stub = makeResizeObserverStub();
    vi.stubGlobal("ResizeObserver", stub.cls);
    return { push: (w: number) => act(() => stub.push(w)) };
  }

  it("选择/判断/填空题渲染草稿层标记（默认收起）；手写题不渲染", () => {
    const choice = renderStatefulCard(
      baseQuestion({ type: "choice", options: ["$1$", "$2$"] }),
      { attemptId: "att-1" },
    );
    expect(screen.getByRole("button", { name: /草稿纸/ })).toBeInTheDocument();
    choice.unmount();

    const solve = renderStatefulCard(baseQuestion({ type: "solve" }), {
      attemptId: "att-1",
    });
    expect(screen.queryByRole("button", { name: /草稿纸/ })).toBeNull();
    solve.unmount();
  });

  it("无 attemptId 不渲染草稿层（预览等场景）", () => {
    renderStatefulCard(baseQuestion({ type: "judge" }));
    expect(screen.queryByRole("button", { name: /草稿纸/ })).toBeNull();
  });

  it("T7.7 ink 关闭：草稿纸入口隐藏（数据保留服务端，恢复开关后回来看）", () => {
    const off = renderStatefulCard(baseQuestion({ type: "judge" }), {
      attemptId: "att-1",
      capabilities: { steps: true, ink: false },
    });
    expect(screen.queryByRole("button", { name: /草稿纸/ })).toBeNull();
    off.unmount();
    // 对照：默认（无 Provider=全启用）入口回来
    renderStatefulCard(baseQuestion({ type: "judge" }), { attemptId: "att-1" });
    expect(screen.getByRole("button", { name: /草稿纸/ })).toBeInTheDocument();
  });

  it("宽容器展开走侧栏分栏（55/45 两列）；窄容器回退 below（任务清单失败测试）", async () => {
    const ro = stubCardWidth();
    renderStatefulCard(
      baseQuestion({ type: "choice", options: ["$1$", "$2$"] }),
      { attemptId: "att-1" },
    );
    await ro.push(1024); // 宽题卡：两列达标
    fireEvent.click(screen.getByRole("button", { name: /草稿纸/ }));
    const row = document.querySelector('[data-slot="note-body-row"]');
    expect(row?.getAttribute("data-layout")).toBe("side");
    // 列宽由常量渲染（复审⑨）：55% 与阈值同源
    expect((row?.firstElementChild as HTMLElement)?.style.width).toBe(
      `${NOTE_QUESTION_SHARE * 100}%`,
    );

    // 收窄到竖屏宽度：auto 回退 below（复审③：恒定树只切样式不换结构）
    await ro.push(700);
    expect(row?.getAttribute("data-layout")).toBe("below");
    // 草稿区仍在（below 形态，题干下方整宽）
    expect(document.querySelector('[data-slot="note-layer"]')).not.toBeNull();
  });

  it("窄容器直接展开也走 below；草稿展开不遮挡填空输入（可继续作答）", async () => {
    const ro = stubCardWidth();
    const fill = baseQuestion({
      type: "fill",
      stemMd: "计算：$1+1=$ [[]]。",
    });
    const { onAnswer } = renderStatefulCard(fill, { attemptId: "att-1" });
    await ro.push(700);
    fireEvent.click(screen.getByRole("button", { name: /草稿纸/ }));
    expect(
      document
        .querySelector('[data-slot="note-body-row"]')
        ?.getAttribute("data-layout"),
    ).toBe("below");
    // 展开草稿后填空输入仍可用（工具条常规文档流，不覆盖输入）
    const input = screen.getByLabelText("第1空");
    fireEvent.change(input, { target: { value: "2" } });
    expect(onAnswer).toHaveBeenLastCalledWith(
      { kind: "fill", values: ["2"] },
      true,
    );
  });

  it("side 布局开合不重挂题干子树（填空输入保持焦点——复审③）", async () => {
    const ro = stubCardWidth();
    const fill = baseQuestion({
      type: "fill",
      stemMd: "计算：$1+1=$ [[]]。",
    });
    renderStatefulCard(fill, { attemptId: "att-1" });
    await ro.push(1024); // auto → side
    const input = screen.getByLabelText("第1空");
    input.focus();
    expect(document.activeElement).toBe(input);
    // 展开草稿（below 分支 → side 分支）：同一棵子树只切样式，输入不失焦
    fireEvent.click(screen.getByRole("button", { name: /草稿纸/ }));
    expect(
      document
        .querySelector('[data-slot="note-body-row"]')
        ?.getAttribute("data-layout"),
    ).toBe("side");
    expect(document.activeElement).toBe(input);
    expect(input).toHaveValue("");
  });
});

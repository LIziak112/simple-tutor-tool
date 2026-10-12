import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QuestionPlaceholderDirective } from "./directives/Question";
import { QuestionViewProvider } from "./directives/question-view";
import { RichMarkdown } from "./RichMarkdown";

/**
 * 题块占位卡（教师语境，2026-10 讲练一体）组件测试：
 * - questionPlaceholder 模式：::::question 块渲染占位卡（题号/题型/难度 +
 *   「内容请在题库编辑」），题干内容不渲染；展开折叠可见题块**原文**
 *   （[[参考答案]] 原样保留——渲染管线会丢弃答案，占位视图不丢）；
 * - 默认（无 prop）：题块照常渲染题干（既有行为回归——题目编辑抽屉等依赖）；
 * - 占位卡只读：无任何编辑入口（题目内容编辑走题库，防双源漂移）；
 * - 降级：原文区间缺失（sourceRange 未提供）时渲染「题目」占位框，不崩溃。
 */

const LESSON_MD = [
  "---",
  "kind: lesson",
  "---",
  "",
  "# 讲练 有理数热身",
  "",
  "正文一段。",
  "",
  '::::question{type=judge difficulty=3 id="w1"}',
  "$0$ 是最小的正整数。[[错误]]",
  "",
  ":::solution",
  "1 才是最小的正整数。",
  ":::",
  "::::",
  "",
  "题后一段正文。",
].join("\n");

describe("RichMarkdown questionPlaceholder（教师讲练语境）", () => {
  it("占位模式：题块渲染占位卡（题号/题型/难度 + 内容请在题库编辑），题干与详解不渲染", () => {
    render(<RichMarkdown source={LESSON_MD} questionPlaceholder />);

    // 讲义正文照常渲染；题块以占位卡出现
    expect(screen.getByText("正文一段。")).toBeInTheDocument();
    expect(screen.getByText("题后一段正文。")).toBeInTheDocument();
    expect(screen.getByText("第 1 题")).toBeInTheDocument();
    expect(screen.getByText("判断题")).toBeInTheDocument();
    expect(screen.getByText("内容请在题库编辑")).toBeInTheDocument();
    // 题干内容与详解**不**渲染（内容编辑走题库，教师预览不看题面）
    expect(screen.queryByText("$0$ 是最小的正整数。")).toBeNull();
    expect(screen.queryByText("1 才是最小的正整数。")).toBeNull();
  });

  it("占位模式：展开折叠显示题块原文（[[参考答案]] 原样保留）", () => {
    render(<RichMarkdown source={LESSON_MD} questionPlaceholder />);

    // 折叠默认收起：原文不在可访问树（jsdom 不展开 details 内容展示，
    // 但文本仍在 DOM——用初始未展开状态断言 summary 存在，展开后可见原文）
    fireEvent.click(screen.getByText("查看题目原文"));
    expect(
      screen.getByText(/是最小的正整数。\[\[错误\]\]/),
    ).toBeInTheDocument();
    expect(screen.getByText(/:::solution/)).toBeInTheDocument();
  });

  it("默认模式（无 prop）：题块照常渲染题干（既有行为回归）", () => {
    const { container } = render(<RichMarkdown source={LESSON_MD} />);

    // 题卡完整渲染：题号与题干文本可见（$…$ 走 KaTeX，按文本片段断言）、无占位说明
    expect(screen.getByText("第 1 题")).toBeInTheDocument();
    expect(screen.queryByText("内容请在题库编辑")).toBeNull();
    expect(container.textContent).toContain("是最小的正整数。");
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("占位模式只读：占位卡内无按钮/输入等编辑入口", () => {
    const { container } = render(
      <RichMarkdown source={LESSON_MD} questionPlaceholder />,
    );
    const card = screen.getByText("第 1 题").closest("section");
    expect(card).not.toBeNull();
    expect(card?.querySelector("button, input, textarea, select")).toBeNull();
    void container;
  });

  it("降级：原文区间缺失（sourceRange 未提供）时渲染「题目」占位框，不崩溃、无折叠", () => {
    render(
      <QuestionViewProvider value={{ placeholder: true, source: LESSON_MD }}>
        <QuestionPlaceholderDirective
          name="question"
          index={1}
          docIndex={1}
          attrs={{ type: "judge", difficulty: 3 }}
        >
          <p>被忽略的已渲染子树</p>
        </QuestionPlaceholderDirective>
      </QuestionViewProvider>,
    );
    // 有 attrs 仍显示题型；无 sourceRange → 无折叠入口，只剩占位说明
    expect(screen.getByText("判断题")).toBeInTheDocument();
    expect(screen.getByText("内容请在题库编辑")).toBeInTheDocument();
    expect(screen.queryByText("查看题目原文")).toBeNull();
  });
});

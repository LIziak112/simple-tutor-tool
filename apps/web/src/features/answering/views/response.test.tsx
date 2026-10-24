import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { responseView } from "./response";

/**
 * response 开放作答呈现（QM-09 细项1/2）：
 * - Input：可选标题 + 多行正文（KaTeX 公式与分段经既有 RichMarkdown 只读
 *   呈现；输入面是纯文本 textarea，正文与标题都支持 $…$ 公式）；文本输入
 *   defer=true 防抖（I05 回调节奏与 fill 同款）；
 * - 字数口径：契约单源 countResponseWords（中文按字含中文标点、英文按词），
 *   UI 只显示不重算；word-min/max 是建议提示，超限不硬拦不截断（§5.4.1）；
 * - 输入法组合输入（composition 事件）不截断中间态；
 * - 完成度：body 非空白或正式笔迹任一即 filled（决策记录 §5.7.3）。
 */

const model = {
  kind: "response",
  scopeId: "q-test",
  stemMd: "根据给定资料，概括主要特点。要求：不超过 250 字。",
} as const;

const modelWithHints = {
  ...model,
  wordMin: 150,
  wordMax: 250,
};

describe("responseView.Input（开放作答输入面）", () => {
  it("标题（可选）+ 正文多行输入；正文更新 defer=true（文本防抖，I05）", () => {
    const update = vi.fn();
    render(responseView.Input({ model, answer: undefined, update }));
    const body = screen.getByRole("textbox", { name: "正文" });
    fireEvent.change(body, { target: { value: "第一段……" } });
    expect(update).toHaveBeenCalledWith(
      { kind: "response", body: "第一段……" },
      true,
    );
    const title = screen.getByRole("textbox", { name: "标题（可选）" });
    fireEvent.change(title, { target: { value: "治理的起点" } });
    expect(update).toHaveBeenCalledWith(
      { kind: "response", title: "治理的起点", body: "" },
      true,
    );
  });

  it("已有答案回填：title 与 body 原样进入输入框（含分段与公式源码）", () => {
    render(
      responseView.Input({
        model,
        update: vi.fn(),
        answer: {
          kind: "response",
          title: "分歧与治理",
          body: "第一段：$x^2$ 的意义。\n\n第二段：结论。",
        },
      }),
    );
    expect(screen.getByRole("textbox", { name: "标题（可选）" })).toHaveValue(
      "分歧与治理",
    );
    expect(screen.getByRole("textbox", { name: "正文" })).toHaveValue(
      "第一段：$x^2$ 的意义。\n\n第二段：结论。",
    );
  });

  it("字数口径：契约单源（中英混排按字+词），word-min/max 仅建议提示", () => {
    const update = vi.fn();
    render(
      responseView.Input({
        model: modelWithHints,
        update,
        answer: {
          kind: "response",
          body: "概括主要特点，no more than 250 words。",
        },
      }),
    );
    // 「概括主要特点，」7 + 5 词 + 「。」1 = 13（契约口径原样展示，UI 不重算）
    expect(screen.getByText(/正文已写 13 字/)).toBeInTheDocument();
    expect(screen.getByText(/建议 150–250 字/)).toBeInTheDocument();
    // 超出建议字数仍可继续输入（提示变化但不硬拦不截断）
    fireEvent.change(screen.getByRole("textbox", { name: "正文" }), {
      target: { value: "超".repeat(300) },
    });
    expect(update).toHaveBeenCalledWith(
      { kind: "response", body: "超".repeat(300) },
      true,
    );
  });

  it("输入法组合输入不截断：composition 中间态与最终态都完整进入受控值", () => {
    const update = vi.fn();
    render(responseView.Input({ model, answer: undefined, update }));
    const body = screen.getByRole("textbox", { name: "正文" });
    fireEvent.compositionStart(body);
    fireEvent.change(body, { target: { value: "zheng ce" } });
    expect(update).toHaveBeenLastCalledWith(
      { kind: "response", body: "zheng ce" },
      true,
    );
    fireEvent.compositionEnd(body, { target: { value: "政策" } });
    fireEvent.change(body, { target: { value: "政策" } });
    expect(update).toHaveBeenLastCalledWith(
      { kind: "response", body: "政策" },
      true,
    );
  });

  it("disabled：已提交只读时输入控件禁用", () => {
    render(
      responseView.Input({
        model,
        answer: undefined,
        update: vi.fn(),
        disabled: true,
      }),
    );
    expect(screen.getByRole("textbox", { name: "正文" })).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: "标题（可选）" }),
    ).toBeDisabled();
  });
});

describe("responseView.ReadOnly（本人答案列）", () => {
  it("title 前置一行 + 正文经 RichMarkdown 渲染（公式与分段保留）", () => {
    const { container } = render(
      responseView.ReadOnly({
        model,
        answer: {
          kind: "response",
          title: "关于测试的讨论",
          body: "第一段：$x+1=2$。\n\n第二段：结论。",
        },
      }),
    );
    expect(screen.getByText("关于测试的讨论")).toBeInTheDocument();
    // 分段保留（两段文本都在；行内公式把段落拆成多节点，按整体文本断言）
    expect(container.textContent).toContain("第一段：");
    expect(container.textContent).toContain("第二段：结论。");
    // KaTeX 公式渲染（$…$ 源码不残留在文本里）
    expect(container.textContent).not.toContain("$x+1=2$");
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("仅手写形态（body 空串）：明示未填写正文，不算未作答", () => {
    render(
      responseView.ReadOnly({
        model,
        answer: { kind: "response", body: "" },
      }),
    );
    expect(screen.getByText("未填写正文")).toBeInTheDocument();
  });

  it("无答案：未作答", () => {
    render(responseView.ReadOnly({ model, answer: undefined }));
    expect(screen.getByText("未作答")).toBeInTheDocument();
  });
});

describe("responseView.Reference / Comparison（参考与对照）", () => {
  const reference = {
    kind: "response" as const,
    referenceMd: "参考：气温在波动中回升（$-3$ ℃ → $2$ ℃）。",
    variantsMd: ["备选一：整体呈上升趋势。"],
  };

  it("Reference：主参考渲染 + variants 逐条列出（§5.7.3 备选表达）", () => {
    render(responseView.Reference({ model, reference }));
    expect(screen.getByText(/气温在波动中回升/)).toBeInTheDocument();
    expect(screen.getByText(/备选表达 1/)).toBeInTheDocument();
    expect(screen.getByText(/整体呈上升趋势/)).toBeInTheDocument();
  });

  it("Comparison：unavailable 不渲染参考内容（I09）；available 两列对照", () => {
    const { rerender } = render(
      responseView.Comparison({
        model,
        answer: { kind: "response", body: "我的概括。" },
        reference: { status: "unavailable" },
      }),
    );
    expect(screen.getByText("你的答案：")).toBeInTheDocument();
    expect(
      screen.getByText(/参考答案与详解将在截止后公布/),
    ).toBeInTheDocument();
    rerender(
      responseView.Comparison({
        model,
        answer: { kind: "response", body: "我的概括。" },
        reference: { status: "available", reference },
      }),
    );
    expect(screen.getByText("我的概括。")).toBeInTheDocument();
    expect(screen.getByText(/气温在波动中回升/)).toBeInTheDocument();
  });
});

describe("responseView.completion（完整度，QM-09 口径）", () => {
  it("body 非空白或正式笔迹任一即 filled；空白与错配不算", () => {
    expect(
      responseView.completion(
        model,
        { kind: "response", body: "概括。" },
        false,
      ),
    ).toEqual({ state: "filled", filledSlots: 1, expectedSlots: 1 });
    expect(
      responseView.completion(model, { kind: "response", body: "" }, true),
    ).toEqual({ state: "filled", filledSlots: 1, expectedSlots: 1 });
    expect(
      responseView.completion(model, { kind: "response", body: " \n " }, false),
    ).toEqual({ state: "empty", filledSlots: 0, expectedSlots: 1 });
    expect(responseView.completion(model, undefined, false)).toEqual({
      state: "empty",
      filledSlots: 0,
      expectedSlots: 1,
    });
  });
});

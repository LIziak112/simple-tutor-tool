import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BlankAnswersProvider } from "./BlankAnswersContext";
import { richMarkdownRemarkPlugins } from "./pipeline";
import { RichMarkdown } from "./RichMarkdown";

const parsed = vi.fn();
function countParsing() {
  return () => {
    parsed();
  };
}
beforeEach(() => {
  parsed.mockClear();
  richMarkdownRemarkPlugins.push(countParsing);
});
afterEach(() => {
  const index = richMarkdownRemarkPlugins.indexOf(countParsing);
  if (index >= 0) richMarkdownRemarkPlugins.splice(index, 1);
});

it("父层无关重渲染不重复解析相同 Markdown，内容变化仍重新解析", () => {
  const view = render(<RichMarkdown source="原题 $x^2$" />);
  const initial = parsed.mock.calls.length;
  expect(initial).toBeGreaterThan(0);
  view.rerender(<RichMarkdown source="原题 $x^2$" />);
  expect(parsed).toHaveBeenCalledTimes(initial);
  view.rerender(<RichMarkdown source="新题 $x^3$" />);
  expect(parsed.mock.calls.length).toBeGreaterThan(initial);
  expect(screen.getByText(/新题/)).toBeInTheDocument();
});

it("相同题面下外层填空值、禁用态和回调更新仍传入输入控件", () => {
  const before = vi.fn();
  const after = vi.fn();
  const view = render(
    <BlankAnswersProvider
      state={{ values: ["原值"], disabled: false, onChange: before }}
    >
      <RichMarkdown source="填写 [[]]" />
    </BlankAnswersProvider>,
  );
  expect(screen.getByRole("textbox")).toHaveValue("原值");
  view.rerender(
    <BlankAnswersProvider
      state={{ values: ["新值"], disabled: true, onChange: after }}
    >
      <RichMarkdown source="填写 [[]]" />
    </BlankAnswersProvider>,
  );
  expect(screen.getByRole("textbox")).toHaveValue("新值");
  expect(screen.getByRole("textbox")).toBeDisabled();
  view.rerender(
    <BlankAnswersProvider
      state={{ values: ["新值"], disabled: false, onChange: after }}
    >
      <RichMarkdown source="填写 [[]]" />
    </BlankAnswersProvider>,
  );
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "编辑值" },
  });
  expect(after).toHaveBeenCalledWith(0, "编辑值");
  expect(before).not.toHaveBeenCalled();
});

it("属性回调与样式变化生效，折叠指令仍可独立展开", () => {
  const before = vi.fn();
  const after = vi.fn();
  const source = ':::fold{title="拓展阅读"}\n内部内容ABC\n:::';
  const view = render(
    <RichMarkdown source={source} onDirectiveTelemetry={before} />,
  );
  view.rerender(
    <RichMarkdown
      source={source}
      className="updated-style"
      onDirectiveTelemetry={after}
    />,
  );
  expect(view.container.querySelector(".rich-markdown")).toHaveClass(
    "updated-style",
  );
  fireEvent.click(screen.getByRole("button", { name: /拓展阅读/ }));
  expect(screen.getByText("内部内容ABC")).toBeVisible();
  expect(after).toHaveBeenCalledWith(
    expect.objectContaining({ action: "open" }),
  );
  expect(before).not.toHaveBeenCalled();
});

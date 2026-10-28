import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { richMarkdownRemarkPlugins } from "./pipeline";
import {
  clearMarkdownRenderCache,
  markdownRenderCacheSize,
  renderMarkdownCached,
} from "./render-cache";

const parsed = vi.fn();
function countParsing() {
  return () => {
    parsed();
  };
}
const components = {};
const base = { lrNodes: false, compact: false } as const;

beforeEach(() => {
  parsed.mockClear();
  clearMarkdownRenderCache();
  richMarkdownRemarkPlugins.push(countParsing);
});
afterEach(() => {
  const index = richMarkdownRemarkPlugins.indexOf(countParsing);
  if (index >= 0) richMarkdownRemarkPlugins.splice(index, 1);
  clearMarkdownRenderCache();
});

it("同 source 卸载后重新挂载不重解析（懒挂载反复挂载的关键收益）", () => {
  const first = render(
    <div>{renderMarkdownCached("原题 $x^2$", base, components)}</div>,
  );
  const afterFirst = parsed.mock.calls.length;
  expect(afterFirst).toBeGreaterThan(0);
  first.unmount();
  render(<div>{renderMarkdownCached("原题 $x^2$", base, components)}</div>);
  expect(parsed).toHaveBeenCalledTimes(afterFirst);
  expect(screen.getByText(/原题/)).toBeInTheDocument();
});

it("不同 source 各自解析，不同管线变体不共缓存", () => {
  render(<div>{renderMarkdownCached("甲题", base, components)}</div>);
  const firstSource = parsed.mock.calls.length;
  render(<div>{renderMarkdownCached("乙题", base, components)}</div>);
  expect(parsed.mock.calls.length).toBeGreaterThan(firstSource);
  const twoSources = parsed.mock.calls.length;
  // 同一 source、不同变体（LR 节点开关）必须另占一条缓存：键漏了变体就会
  // 串内容（LR 插件表是模块加载期拷贝，计数器进不去，故以缓存条数为断言）。
  render(
    <div>
      {renderMarkdownCached(
        "甲题",
        { lrNodes: true, compact: false },
        components,
      )}
    </div>,
  );
  expect(markdownRenderCacheSize()).toBe(3);
  expect(parsed.mock.calls.length).toBeGreaterThanOrEqual(twoSources);
});

it("超长 source 不入缓存（避免整篇讲义占用）", () => {
  const long = `长${"文".repeat(20_000)}`;
  render(<div>{renderMarkdownCached(long, base, components)}</div>);
  const once = parsed.mock.calls.length;
  render(<div>{renderMarkdownCached(long, base, components)}</div>);
  expect(parsed.mock.calls.length).toBeGreaterThan(once);
  expect(markdownRenderCacheSize()).toBe(0);
});

import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render-with-portal";
import { PwaUpdateNotice } from "./PwaUpdateNotice";

const mocks = vi.hoisted(() => ({
  state: {
    available: true,
    busy: false,
    dismissed: false,
    error: null as string | null,
  },
  apply: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("@/lib/pwa", () => ({
  getPwaUpdateSnapshot: () => mocks.state,
  subscribePwaUpdate: () => () => {},
  applyPwaUpdate: mocks.apply,
  dismissPwaUpdate: mocks.dismiss,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = { available: true, busy: false, dismissed: false, error: null };
});
it("发现更新只显示非阻断提示，用户点击后才保存更新", () => {
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  render(<PwaUpdateNotice />);
  expect(screen.getByText("发现新版本")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(document.activeElement).toBe(input);
  expect(mocks.apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "保存并更新" }));
  expect(mocks.apply).toHaveBeenCalledTimes(1);
  input.remove();
});
it("稍后更新可以隐藏提示，保存失败时展示原因和重试入口", () => {
  const view = render(<PwaUpdateNotice />);
  fireEvent.click(screen.getByRole("button", { name: "稍后" }));
  expect(mocks.dismiss).toHaveBeenCalledTimes(1);
  mocks.state = { ...mocks.state, error: "草稿本机保存失败" };
  view.rerender(<PwaUpdateNotice />);
  expect(screen.getByRole("alert")).toHaveTextContent("草稿本机保存失败");
  expect(screen.getByRole("button", { name: "重试保存并更新" })).toBeEnabled();
});
it("保存期间禁用操作并说明正在保存", () => {
  mocks.state = { ...mocks.state, busy: true };
  render(<PwaUpdateNotice />);
  expect(
    screen.getByRole("button", { name: "正在保存并更新…" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "稍后" })).toBeDisabled();
});

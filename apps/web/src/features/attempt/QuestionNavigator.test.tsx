import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  type QuestionNavigationItem,
  QuestionNavigator,
} from "./QuestionNavigator";

const items: QuestionNavigationItem[] = [
  {
    id: "a",
    index: 0,
    completion: { state: "filled", filledSlots: 1, expectedSlots: 1 },
    flagged: false,
  },
  {
    id: "b",
    index: 1,
    completion: { state: "partial", filledSlots: 1, expectedSlots: 2 },
    flagged: true,
  },
  {
    id: "c",
    index: 2,
    completion: { state: "empty", filledSlots: 0, expectedSlots: 1 },
    flagged: false,
  },
];

it("下一道未答包含部分填写，并保留题号定位", () => {
  const jump = vi.fn();
  render(<QuestionNavigator items={items} currentId="a" onJump={jump} />);
  fireEvent.click(screen.getByRole("button", { name: "下一道未答" }));
  expect(jump).toHaveBeenLastCalledWith("b");
  fireEvent.click(screen.getByRole("button", { name: "第 3 题，未填写" }));
  expect(jump).toHaveBeenLastCalledWith("c");
});

it("从当前题向后寻找，到卷尾回到前面的未答题", () => {
  const jump = vi.fn();
  const { rerender } = render(
    <QuestionNavigator items={items} currentId="b" onJump={jump} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "下一道未答" }));
  expect(jump).toHaveBeenLastCalledWith("c");
  rerender(<QuestionNavigator items={items} currentId="c" onJump={jump} />);
  fireEvent.click(screen.getByRole("button", { name: "下一道未答" }));
  expect(jump).toHaveBeenLastCalledWith("b");
});

it("没有当前位置时从第一道未答开始", () => {
  const jump = vi.fn();
  render(<QuestionNavigator items={items} currentId={null} onJump={jump} />);
  fireEvent.click(screen.getByRole("button", { name: "下一道未答" }));
  expect(jump).toHaveBeenCalledWith("b");
});

it("全部填写后说明完成，禁用未答定位", () => {
  const jump = vi.fn();
  render(
    <QuestionNavigator
      items={items.filter((item) => item.id === "a")}
      currentId="a"
      onJump={jump}
    />,
  );
  const button = screen.getByRole("button", { name: "全部已填写" });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(jump).not.toHaveBeenCalled();
});

it("空卷不声称全部已填写", () => {
  render(<QuestionNavigator items={[]} currentId={null} onJump={vi.fn()} />);
  expect(screen.getByRole("button", { name: "暂无题目" })).toBeDisabled();
});

it("题号列表独立滚动，未答按钮固定在滚动区域外的底部", () => {
  render(<QuestionNavigator items={items} currentId="a" onJump={vi.fn()} />);
  const nav = screen.getByRole("navigation", { name: "答题卡" });
  const list = screen.getByRole("list");
  const action = screen.getByRole("button", { name: "下一道未答" });
  expect(nav).toHaveClass("flex", "min-h-0", "flex-col", "overflow-hidden");
  expect(list).toHaveClass("min-h-0", "overflow-y-auto", "overscroll-contain");
  expect(list.contains(action)).toBe(false);
  expect(action.parentElement).toBe(nav);
  expect(list.nextElementSibling).toBe(action);
  expect(action).toHaveClass("shrink-0");
  fireEvent.scroll(list, { target: { scrollTop: 200 } });
  expect(list.nextElementSibling).toBe(action);
});

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { type AnswerCardFilter, AttemptAnswerCard } from "./AttemptAnswerCard";
import type { QuestionNavigationItem } from "./QuestionNavigator";

const empty = { state: "empty", filledSlots: 0, expectedSlots: 2 } as const;
const items: QuestionNavigationItem[] = [
  { id: "a", index: 0, completion: empty, flagged: false },
  { id: "b", index: 1, completion: empty, flagged: true, unsure: true },
  {
    id: "c",
    index: 2,
    completion: { state: "partial", filledSlots: 1, expectedSlots: 2 },
    flagged: false,
  },
  {
    id: "d",
    index: 3,
    completion: { state: "filled", filledSlots: 2, expectedSlots: 2 },
    flagged: true,
  },
];

it("使用笔迹区分部分作答，个人标记可叠加，点击题号才跳转", () => {
  const onJump = vi.fn();
  function Card() {
    const [filter, setFilter] = useState<AnswerCardFilter>("all");
    return (
      <AttemptAnswerCard
        items={items}
        currentId="b"
        filter={filter}
        onFilterChange={setFilter}
        workIds={new Set(["b", "d"])}
        onJump={onJump}
      />
    );
  }
  render(<Card />);
  fireEvent.click(screen.getByRole("button", { name: "部分作答" }));
  const inkOnly = screen.getByRole("button", {
    name: "第 2 题，部分作答，待检查，标过不会",
  });
  expect(inkOnly).toHaveClass("bg-primary/10");
  expect(inkOnly.querySelector("span")).toBeNull();
  expect(inkOnly).toHaveAttribute("aria-current", "location");
  expect(screen.getByRole("status")).toHaveTextContent("2 题");
  expect(onJump).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "未填写" }));
  expect(screen.queryByRole("button", { name: /^第 2 题/ })).toBeNull();
  expect(screen.getByRole("button", { name: "第 1 题，未填写" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "待检查" }));
  expect(screen.getByRole("status")).toHaveTextContent("2 题");
  fireEvent.click(screen.getByRole("button", { name: "不会" }));
  expect(screen.getByRole("status")).toHaveTextContent("1 题");
  fireEvent.click(screen.getByRole("button", { name: /^第 2 题/ }));
  expect(onJump).toHaveBeenCalledWith("b");
  fireEvent.click(screen.getByRole("button", { name: "已填写" }));
  expect(
    screen.getByRole("button", { name: /^第 4 题，已填写/ }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: /下一道未答|交卷/ })).toBeNull();
});

it("笔迹尚未核对时不把未知题目列为未填写", () => {
  render(
    <AttemptAnswerCard
      items={items}
      currentId={null}
      filter="empty"
      onFilterChange={vi.fn()}
      workIds={null}
      onJump={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "未填写" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "部分作答" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "全部" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    screen.getByRole("button", { name: "第 1 题，作答状态尚未确认" }),
  ).toBeVisible();
});

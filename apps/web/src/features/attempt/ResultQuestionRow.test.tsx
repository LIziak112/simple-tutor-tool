import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render-with-portal";
import { LazyMountWindow } from "./lazy-mount-window";
import { ResultQuestionRow } from "./ResultQuestionRow";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("远端题卡不执行首挂，键盘进入占位后立即显示并保留局部状态", () => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const controller = new LazyMountWindow({ unload: false });
  const mounted = vi.fn();
  function Card() {
    mounted();
    const [open, setOpen] = useState(false);
    return (
      <article>
        <h3 tabIndex={-1} data-review-heading>
          第 30 题
        </h3>
        <button type="button" onClick={() => setOpen(!open)}>
          详解
        </button>
        {open && <p>已展开的解析</p>}
      </article>
    );
  }
  const { rerender } = render(
    <ol>
      <ResultQuestionRow
        questionId="q30"
        index={29}
        height={400}
        controller={controller}
        lazy
      >
        <Card />
      </ResultQuestionRow>
    </ol>,
  );
  expect(mounted).not.toHaveBeenCalled();
  fireEvent.focus(screen.getByRole("button", { name: "显示第 30 题" }));
  expect(screen.getByRole("heading", { name: "第 30 题" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "详解" }));
  rerender(
    <ol>
      <ResultQuestionRow
        questionId="q30"
        index={29}
        height={400}
        controller={controller}
        lazy
      >
        <Card />
      </ResultQuestionRow>
    </ol>,
  );
  expect(screen.getByText("已展开的解析")).toBeInTheDocument();
  controller.dispose();
});

it("缺少观察器时直接显示题卡", () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const controller = new LazyMountWindow({ unload: false });
  render(
    <ol>
      <ResultQuestionRow
        questionId="q"
        index={0}
        height={400}
        controller={controller}
        lazy
      >
        <p>题目内容</p>
      </ResultQuestionRow>
    </ol>,
  );
  expect(screen.getByText("题目内容")).toBeInTheDocument();
  act(() => controller.dispose());
});

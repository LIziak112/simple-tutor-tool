import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ResultQuestionRow } from "./ResultQuestionRow";
import { useResultMountWindow } from "./use-result-mount-window";

afterEach(() => vi.unstubAllGlobals());

function Fixture({ attemptId }: { attemptId: string }) {
  const { controller, beforeJump } = useResultMountWindow(attemptId, true);
  return (
    <>
      <button type="button" onClick={() => beforeJump("q")}>
        跳题
      </button>
      <ol key={attemptId}>
        <ResultQuestionRow
          questionId="q"
          index={2}
          height={400}
          controller={controller}
          lazy
        >
          <p>{attemptId}的结果</p>
        </ResultQuestionRow>
      </ol>
    </>
  );
}

it("严格模式重放后仍能挂载，切换作答不会沿用上一轮挂载状态", () => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const view = render(
    <StrictMode>
      <Fixture attemptId="a" />
    </StrictMode>,
  );
  expect(screen.queryByText("a的结果")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "跳题" }));
  expect(screen.getByText("a的结果")).toBeInTheDocument();
  view.rerender(
    <StrictMode>
      <Fixture attemptId="b" />
    </StrictMode>,
  );
  expect(screen.queryByText("a的结果")).not.toBeInTheDocument();
  expect(screen.queryByText("b的结果")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "跳题" }));
  expect(screen.getByText("b的结果")).toBeInTheDocument();
});

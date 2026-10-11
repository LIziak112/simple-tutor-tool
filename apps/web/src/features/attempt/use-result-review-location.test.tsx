import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import {
  normalizeReviewLocation,
  useResultReviewLocation,
} from "./use-result-review-location";

vi.mock("@/features/notes/use-note-head", () => ({
  useNoteSessionRef: () => ({ origin: "http://test", studentId: "student" }),
}));

const ids = ["q1", "q2"];
function ReadingFixture() {
  const root = useRef<HTMLDivElement>(null);
  const location = useResultReviewLocation("attempt", ids, true, root);
  return (
    <div ref={root}>
      <output>{location.currentId}</output>
      {ids.map((id) => (
        <article key={id} data-review-question={id}>
          <h3 data-review-heading tabIndex={-1}>
            {id}
          </h3>
        </article>
      ))}
    </div>
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function prepareRestore() {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  sessionStorage.setItem(
    'result-reading:["http://test","student","attempt"]',
    "q2",
  );
  render(
    <MemoryRouter>
      <ReadingFixture />
    </MemoryRouter>,
  );
  return () =>
    act(() => {
      while (frames.length) frames.shift()?.(0);
    });
}

it("恢复学生自己的阅读题号，不混用答案存储", () => {
  const flush = prepareRestore();
  flush();
  expect(screen.getByRole("status")).toHaveTextContent("q2");
});

it("学生开始滚动后取消延迟阅读恢复", () => {
  const flush = prepareRestore();
  fireEvent.wheel(window);
  flush();
  expect(screen.getByRole("status")).toHaveTextContent("q1");
});

it("非法范围与不存在的题回退，未公布不恢复判错范围", () => {
  expect(
    normalizeReviewLocation(
      new URLSearchParams("reviewQuestion=q2&reviewScope=wrong"),
      ["q1", "q2"],
      true,
    ),
  ).toEqual({ questionId: "q2", scope: "wrong" });
  expect(
    normalizeReviewLocation(
      new URLSearchParams("reviewQuestion=secret&reviewScope=wrong"),
      ["q1"],
      false,
    ),
  ).toEqual({ questionId: "q1", scope: "all" });
  expect(normalizeReviewLocation(new URLSearchParams(), [], true)).toEqual({
    questionId: null,
    scope: "all",
  });
});

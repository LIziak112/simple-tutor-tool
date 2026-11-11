import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useRef } from "react";
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
      <button type="button" onClick={() => location.jump("q2")}>
        定位末题
      </button>
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

function prepareRestore(strict = false) {
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
  const fixture = (
    <MemoryRouter>
      <ReadingFixture />
    </MemoryRouter>
  );
  render(strict ? <StrictMode>{fixture}</StrictMode> : fixture);
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

it("严格模式重放副作用不会在恢复前用首题覆盖历史位置", () => {
  const flush = prepareRestore(true);
  expect(
    sessionStorage.getItem(
      'result-reading:["http://test","student","attempt"]',
    ),
  ).toBe("q2");
  flush();
  expect(screen.getByRole("status")).toHaveTextContent("q2");
});

it("学生开始滚动后取消延迟阅读恢复", () => {
  const flush = prepareRestore();
  fireEvent.wheel(window);
  flush();
  expect(screen.getByRole("status")).toHaveTextContent("q1");
});

it("显式定位到末题后保留当前题，滚离该题后恢复视口跟踪", () => {
  type Observation = { target: Element; isIntersecting: boolean };
  let report = (_entries: readonly Observation[]) => {};
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof report) {
        report = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const flush = prepareRestore();
  flush();
  const heading = screen.getByRole("heading", { name: "q2" });
  const headingRect = vi
    .spyOn(heading, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 500, 100, 24));
  const first = screen.getAllByRole("article")[0];
  if (!first) throw new Error("缺少首题");
  vi.spyOn(first, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 100, 100, 100),
  );

  fireEvent.click(screen.getByRole("button", { name: "定位末题" }));
  flush();
  expect(heading).toHaveFocus();
  act(() => report([{ target: first, isIntersecting: true }]));
  expect(screen.getByRole("status")).toHaveTextContent("q2");

  headingRect.mockReturnValue(new DOMRect(0, window.innerHeight + 10, 100, 24));
  act(() => report([{ target: first, isIntersecting: true }]));
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

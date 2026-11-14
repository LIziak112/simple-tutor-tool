import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AttemptDraftData } from "@tutor/contract";
import { useRef, useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { useAttemptQuestionLocation } from "./use-attempt-question-location.ts";
import { useReadingPosition } from "./use-reading-position.ts";

vi.mock("../annotation/use-annotation-record.ts", () => ({
  useAnnotationSessionRef: () => ({
    origin: "https://review.test",
    studentId: "student",
  }),
}));
vi.mock("./practice-preference-store.ts", () => ({
  currentLayout: () => "single",
  usePracticePreference: () => ({
    accountId: "student",
    keyboardShortcuts: false,
  }),
}));
vi.mock("./attempt-start-intent.ts", () => ({
  consumeAttemptStartLayoutIntent: () => null,
}));
afterEach(cleanup);
it.each([
  ["/s/attempts/attempt", "q3"],
  ["/s/attempts/attempt?q=q1", "q1"],
])(
  "入口%s保留显式题位，否则首次恢复本机未提交位置",
  async (entry, expected) => {
    localStorage.setItem(
      "attempt-reading:" +
        JSON.stringify(["https://review.test", "student", "attempt"]),
      JSON.stringify({ questionId: "q3", offset: 45 }),
    );
    window.scrollTo = vi.fn();
    const ids = ["q1", "q2", "q3"];
    const data = {
      attempt: { id: "attempt", status: "draft" },
      practiceWorkflow: { version: 1, feedbackMode: "after_attempt" },
      questionProgress: ids.map((questionId, index) => ({
        questionId,
        submittedAt: index === 0 ? "2026-11-14T00:00:00Z" : null,
      })),
      settlementProgress: { nextQuestionId: "q2" },
    } as unknown as AttemptDraftData;
    function Harness() {
      const cards = useRef(new Map<string, HTMLLIElement>());
      const [current, setCurrent] = useState<string | null>(null);
      const mount = useRef(() => {}).current;
      useReadingPosition("attempt", cards, setCurrent, mount, 0, {
        nextQuestionId: "q2",
        submittedQuestionIds: ["q1"],
      });
      const location = useAttemptQuestionLocation({
        data,
        questionIds: ids,
        currentQuestionId: current,
      });
      return (
        <>
          <output data-testid="state">
            {JSON.stringify({
              current,
              resolved: location.resolvedSingleQuestionId,
            })}
          </output>
          {ids.map((id) => (
            <li
              key={id}
              hidden={location.resolvedSingleQuestionId !== id}
              ref={(element) => {
                if (element) {
                  element.getBoundingClientRect = () => ({
                    top: 100,
                    bottom: 200,
                    left: 0,
                    right: 100,
                    height: 100,
                    width: 100,
                    x: 0,
                    y: 100,
                    toJSON() {},
                  });
                  cards.current.set(id, element);
                }
              }}
            >
              {id}
            </li>
          ))}
        </>
      );
    }
    render(
      <MemoryRouter initialEntries={[entry]}>
        <Harness />
      </MemoryRouter>,
    );
    await waitFor(
      () =>
        expect(screen.getByTestId("state").textContent).toContain(
          '"current":"q3"',
        ),
      { timeout: 3000 },
    );
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toContain(
        '"resolved":"' + expected + '"',
      ),
    );
  },
);

it("本机恢复后后台轮询不得因当前题已提交而跳题", () => {
  const ids = ["q1", "q2", "q3"];
  const makeData = (submitted: boolean) =>
    ({
      attempt: { id: "attempt", status: "draft" },
      practiceWorkflow: { version: 1, feedbackMode: "after_attempt" },
      questionProgress: ids.map((questionId) => ({
        questionId,
        submittedAt:
          submitted && questionId === "q3" ? "2026-11-14T00:00:00Z" : null,
      })),
      settlementProgress: { nextQuestionId: "q1" },
    }) as unknown as AttemptDraftData;
  const { result, rerender } = renderHook(
    ({ submitted }) =>
      useAttemptQuestionLocation({
        data: makeData(submitted),
        questionIds: ids,
        currentQuestionId: "q3",
      }),
    {
      initialProps: { submitted: false },
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={["/s/attempts/attempt"]}>
          {children}
        </MemoryRouter>
      ),
    },
  );
  expect(result.current.resolvedSingleQuestionId).toBe("q3");
  rerender({ submitted: true });
  expect(result.current.resolvedSingleQuestionId).toBe("q3");
});

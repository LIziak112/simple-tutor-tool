import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { AttemptQuestionPublic } from "@tutor/contract";
import { forwardRef, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { AttemptEditorProvider } from "./AttemptEditorContext";
import { AttemptQuestionCard } from "./AttemptQuestionCard";

const probe = vi.hoisted(() => ({ questions: [] as AttemptQuestionPublic[] }));
vi.mock("@/features/annotation/QuestionAnnotationOverlay", () => ({
  QuestionAnnotationOverlay: forwardRef(function Overlay(
    {
      question,
      children,
    }: { question: AttemptQuestionPublic; children: ReactNode },
    _ref,
  ) {
    probe.questions.push(question);
    return children;
  }),
}));
vi.mock("@/features/notes/NoteLayer", () => ({ NoteLayer: () => null }));

it("无关题卡更新不重建标画题目对象，真正换题面仍更新", () => {
  const question: AttemptQuestionPublic = {
    id: "q",
    questionRevisionId: "11111111-1111-4111-8111-111111111111",
    type: "judge",
    stemMd: "公开题面",
    knowledge: [],
    difficulty: 1,
    hintCount: 0,
  };
  const client = new QueryClient();
  const view = (flagged: boolean, current = question) => (
    <QueryClientProvider client={client}>
      <AttemptEditorProvider>
        <AttemptQuestionCard
          question={current}
          answer={undefined}
          index={0}
          attemptId="attempt"
          flagged={flagged}
          onAnswer={() => undefined}
        />
      </AttemptEditorProvider>
    </QueryClientProvider>
  );
  const rendered = render(view(false));
  const initial = probe.questions.at(-1);
  rendered.rerender(view(true));
  expect(probe.questions.at(-1)).toBe(initial);
  rendered.rerender(view(true, { ...question, stemMd: "更新题面" }));
  expect(probe.questions.at(-1)).not.toBe(initial);
  expect(probe.questions.at(-1)?.stemMd).toBe("更新题面");
});

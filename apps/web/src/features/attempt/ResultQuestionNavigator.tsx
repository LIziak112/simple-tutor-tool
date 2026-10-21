import type { AttemptResultQuestion } from "@tutor/contract";
import {
  inReviewScope,
  type ReviewScope,
  reviewQuestionState,
} from "./result-review-model";

export function ResultQuestionNavigator({
  questions,
  released,
  scope,
  currentId,
  onJump,
}: {
  questions: readonly AttemptResultQuestion[];
  released: boolean;
  scope: ReviewScope;
  currentId: string | null;
  onJump(id: string): void;
}) {
  const items = questions
    .map((question, index) => ({ question, index }))
    .filter(({ question }) => inReviewScope(question, scope, released));
  return (
    <nav aria-label="回看题号" className="min-w-0">
      <p className="mb-3 text-xs text-muted-foreground">
        {released
          ? "✓ 答对 · × 判错 · ◷ 待批 · — 未作答"
          : "— 未作答 · ✓ 答案已记录"}
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">此范围没有题目</p>
      ) : (
        <ol className="grid grid-cols-[repeat(auto-fill,44px)] gap-2 p-1">
          {items.map(({ question, index }) => {
            const state = reviewQuestionState(question, released);
            const label = [
              state.unanswered ? "未作答" : "已作答",
              ...(released
                ? [
                    state.verdict === true
                      ? "答对"
                      : state.verdict === false
                        ? "判错"
                        : "待批",
                  ]
                : []),
            ].join("，");
            return (
              <li key={question.questionId}>
                <button
                  type="button"
                  aria-label={`第 ${index + 1} 题，${label}`}
                  aria-current={
                    currentId === question.questionId ? "location" : undefined
                  }
                  onClick={() => onJump(question.questionId)}
                  className={`relative flex size-11 items-center justify-center rounded-md border text-sm tabular-nums outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${!released ? "border-border bg-card" : state.verdict === true ? "border-emerald-600 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : state.verdict === false ? "border-red-600 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200" : "border-amber-600 bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200"} ${currentId === question.questionId ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""}`}
                >
                  {index + 1}
                  <span
                    aria-hidden
                    className="absolute right-0.5 bottom-0 text-[10px]"
                  >
                    {state.unanswered
                      ? "—"
                      : !released
                        ? "✓"
                        : state.verdict === true
                          ? "✓"
                          : state.verdict === false
                            ? "×"
                            : "◷"}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </nav>
  );
}

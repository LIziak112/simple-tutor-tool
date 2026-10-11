import type { AttemptResultQuestion } from "@tutor/contract";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import {
  formatReferenceAnswers,
  formatStudentAnswer,
  mathifyAnswerText,
} from "./answer-format";
import { getQuestionCompletion } from "./question-completion";

export function ResultAnswerComparison({
  question,
  released,
}: {
  question: Pick<AttemptResultQuestion, "snapshot" | "answer" | "answers">;
  released: boolean;
}) {
  const own = question.answer?.kind === "fill" ? question.answer.values : [];
  const reference =
    released && question.answers?.kind === "fill"
      ? question.answers.blanks
      : [];
  const length =
    question.snapshot.type === "fill"
      ? Math.max(
          getQuestionCompletion(question.snapshot, question.answer ?? undefined)
            .expectedSlots,
          own.length,
          reference.length,
        )
      : 0;
  const rows = (values: string[], label: string) => (
    <ol aria-label={label} className="flex flex-col gap-2">
      {Array.from({ length }, (_, index) => index + 1).map((no) => (
        <li
          key={no}
          className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2"
        >
          <span className="text-muted-foreground">第{no}空</span>
          {values[no - 1]?.trim() ? (
            <RichMarkdown
              source={values[no - 1] ?? ""}
              className="min-w-0 font-medium [&_p]:my-0"
            />
          ) : (
            <span className="text-muted-foreground">未填</span>
          )}
        </li>
      ))}
    </ol>
  );
  return (
    <div className="grid min-w-0 gap-3 border-t border-border pt-3 text-sm sm:grid-cols-2 sm:gap-6">
      <div className="min-w-0">
        <p className="mb-1 text-muted-foreground">你的答案：</p>
        {length > 0 ? (
          rows(own.map(mathifyAnswerText), "你的填空答案")
        ) : (
          <p className="break-words font-medium [overflow-wrap:anywhere]">
            {formatStudentAnswer(question.answer)}
          </p>
        )}
      </div>
      {released && (
        <div className="min-w-0">
          <p className="mb-1 text-muted-foreground">参考答案：</p>
          {question.answers === null ? (
            <p className="font-medium">暂无参考答案</p>
          ) : length > 0 && question.answers.kind === "fill" ? (
            rows(
              reference.map((blank) =>
                formatReferenceAnswers({ kind: "fill", blanks: [blank] }),
              ),
              "参考填空答案",
            )
          ) : (
            <RichMarkdown
              source={formatReferenceAnswers(question.answers)}
              className="min-w-0 font-medium [&_p]:my-0"
            />
          )}
        </div>
      )}
    </div>
  );
}

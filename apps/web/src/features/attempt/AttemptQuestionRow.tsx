import type { HintOpenedEntry } from "@tutor/contract";
import { type ComponentProps, memo, type RefObject, useCallback } from "react";
import { AttemptQuestionCard } from "./AttemptQuestionCard";
import type { AttemptAnswersState } from "./use-attempt-answers";
import type { useAttemptEvents } from "./use-attempt-events";

type CardProps = ComponentProps<typeof AttemptQuestionCard>;
type RowProps = Omit<
  CardProps,
  | "onAnswer"
  | "onToggleFlag"
  | "onHintUnlocked"
  | "onInkStroke"
  | "onInkEdit"
  | "onInkFullscreen"
  | "hints"
> & {
  hints?: CardProps["hints"];
  onAnswer: AttemptAnswersState["setAnswer"];
  onToggleFlag(id: string): void;
  onHintUnlocked(id: string, entry: HintOpenedEntry): void;
  cardElements: RefObject<Map<string, HTMLElement>>;
  events: Pick<
    ReturnType<typeof useAttemptEvents>,
    | "registerCard"
    | "noteInteraction"
    | "trackInkStrokes"
    | "trackInkEdit"
    | "trackInkFullscreen"
  >;
};
const emptyHints: readonly HintOpenedEntry[] = [];

/** 按题绑定稳定操作；顶栏同步状态不重跑整卷Markdown和版式核对。 */
export const AttemptQuestionRow = memo(function AttemptQuestionRow({
  question,
  onAnswer,
  onToggleFlag,
  onHintUnlocked,
  cardElements,
  events,
  ...props
}: RowProps) {
  const register = useCallback(
    (element: HTMLLIElement | null) => {
      events.registerCard(question.id, element);
      if (element) cardElements.current.set(question.id, element);
      else cardElements.current.delete(question.id);
    },
    [events, cardElements, question.id],
  );
  return (
    <li ref={register}>
      <AttemptQuestionCard
        {...props}
        aiTrigger={props.aiTrigger}
        question={question}
        hints={props.hints ?? emptyHints}
        onAnswer={(answer, defer) =>
          onAnswer(question.id, answer, defer ?? false)
        }
        onToggleFlag={() => onToggleFlag(question.id)}
        onHintUnlocked={(entry) => onHintUnlocked(question.id, entry)}
        onInkStroke={(strokes) => {
          events.noteInteraction(question.id);
          events.trackInkStrokes(question.id, strokes);
        }}
        onInkEdit={(reason) => {
          events.noteInteraction(question.id);
          events.trackInkEdit(question.id, reason);
        }}
        onInkFullscreen={(on) => {
          events.noteInteraction(question.id);
          events.trackInkFullscreen(question.id, on);
        }}
      />
    </li>
  );
});

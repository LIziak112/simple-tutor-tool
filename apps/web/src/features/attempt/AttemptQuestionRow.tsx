import type { HintOpenedEntry, StudentAnswer } from "@tutor/contract";
import {
  type ComponentProps,
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
} from "react";
import { AttemptQuestionCard } from "./AttemptQuestionCard";
import type { AttemptAnswersState } from "./use-attempt-answers";
import type { useAttemptEvents } from "./use-attempt-events";

type CardProps = ComponentProps<typeof AttemptQuestionCard>;
type RowProps = Omit<
  CardProps,
  | "onAnswer"
  | "onToggleFlag"
  | "onToggleUnsure"
  | "onHintUnlocked"
  | "onInkStroke"
  | "onInkEdit"
  | "onInkFullscreen"
  | "hints"
> & {
  hints?: CardProps["hints"];
  aiContent?: ReactNode;
  onAnswer: AttemptAnswersState["setAnswer"];
  onToggleFlag(id: string): void;
  onToggleUnsure(id: string): void;
  onHintUnlocked(id: string, entry: HintOpenedEntry): void;
  cardElements: RefObject<Map<string, HTMLElement>>;
  /**
   * 单题专注模式隐藏非当前题（M3-D1，§11 纪律 1）：仅改呈现（display:none，
   * 离开可访问树且不可聚焦），不卸载题卡、不动 key——切回列表原 DOM 复用。
   */
  hidden?: boolean | undefined;
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
  onToggleUnsure,
  onHintUnlocked,
  cardElements,
  events,
  aiContent,
  hidden = false,
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
  const handleAnswer = useCallback(
    (value: StudentAnswer, defer?: boolean) =>
      onAnswer(question.id, value, defer ?? false),
    [onAnswer, question.id],
  );
  return (
    <li ref={register} hidden={hidden}>
      <AttemptQuestionCard
        {...props}
        aiTrigger={props.aiTrigger}
        question={question}
        hints={props.hints ?? emptyHints}
        onAnswer={handleAnswer}
        onToggleFlag={() => onToggleFlag(question.id)}
        onToggleUnsure={() => onToggleUnsure(question.id)}
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
      {aiContent}
    </li>
  );
});

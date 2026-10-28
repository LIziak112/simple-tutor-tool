import type {
  HintOpenedEntry,
  QuestionPublic,
  StudentAnswer,
} from "@tutor/contract";
import {
  type ComponentProps,
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
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
  /**
   * 行 li 的附加类（QM-08 审查 P1 修复：题组单元 compare 网格里组行落次列、
   * 组外行跨两列）。只改 className 不改树位，绝不用它承载重挂语义。
   */
  className?: string | undefined;
  /**
   * 视口懒挂载（性能：大量习题加载卡顿，2026-10-28）：true 时题卡按视口
   * 挂载——先只渲染等高占位，进入视口上下各一屏才挂真卡。li 本身常驻
   * （跳题滚动、阅读位置恢复、题卡元素注册表都不依赖卡片是否已挂载）。
   * 单题专注模式传 false：非当前题只是 hidden，切题要求同步可见。
   */
  lazyMount?: boolean | undefined;
  /** 外部强制挂载（跳题、阅读位置恢复的目标题）：true 时跳过视口判断 */
  forceMount?: boolean | undefined;
  /** 题卡首次挂载回调（判分反馈观察器按新挂载的题重建观察列表） */
  onCardMounted?: ((questionId: string) => void) | undefined;
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
  className,
  lazyMount = false,
  forceMount = false,
  onCardMounted,
  ...props
}: RowProps) {
  const liRef = useRef<HTMLLIElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const register = useCallback(
    (element: HTMLLIElement | null) => {
      liRef.current = element;
      events.registerCard(question.id, element);
      if (element) cardElements.current.set(question.id, element);
      else cardElements.current.delete(question.id);
    },
    [events, cardElements, question.id],
  );
  // 视口观察：进入视口（上下各留一屏）即挂载，挂载后不再回退——
  // 回退卸载会丢圈画/草稿的就地状态（切回列表的 DOM 复用收益已在
  // singleMode 之外的懒挂载中由 Markdown 渲染缓存承担）。
  useEffect(() => {
    if (!lazyMount || mounted) return;
    const element = liRef.current;
    if (element === null) return;
    if (typeof IntersectionObserver === "undefined") {
      setMounted(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setMounted(true);
      },
      { rootMargin: "50% 0px 100% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [lazyMount, mounted]);
  const showCard = lazyMount === false || mounted || forceMount;
  useEffect(() => {
    if (showCard) onCardMounted?.(question.id);
  }, [showCard, onCardMounted, question.id]);
  const handleAnswer = useCallback(
    (value: StudentAnswer, defer?: boolean) =>
      onAnswer(question.id, value, defer ?? false),
    [onAnswer, question.id],
  );
  return (
    <li ref={register} hidden={hidden} className={className}>
      {showCard ? (
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
      ) : (
        // 等高占位：估算高度按题干长度与选项数取整，挂载后由真实高度替换。
        // 估算偏小会带来一次下方内容位移（浏览器滚动锚定兜底），偏大则空白。
        <div
          data-slot="question-placeholder"
          className="rounded-[8px] border border-dashed border-border/70 bg-card/40"
          style={{ minHeight: placeholderHeight(question) }}
        >
          <span className="sr-only">
            第 {props.index + 1} 题，滚动到此处后显示
          </span>
        </div>
      )}
      {aiContent}
    </li>
  );
});

/** 懒挂载占位高度估算：题头 + 题干行数 + 选项行数（不含答案区/反馈区）。 */
export function placeholderHeight(question: QuestionPublic): number {
  const stemLength = question.stemMd?.length ?? 0;
  const options = Array.isArray(question.options) ? question.options.length : 0;
  const stemRows = Math.ceil(stemLength / 32);
  return Math.min(1200, 132 + stemRows * 28 + options * 56);
}

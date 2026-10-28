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
  useSyncExternalStore,
} from "react";
import { AttemptQuestionCard } from "./AttemptQuestionCard";
import { LazyMountWindow } from "./lazy-mount-window";
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
   * 视口懒挂载 + 窗口化虚拟列表（性能：大量习题加载卡顿，2026-10-28）：
   * true 时题卡挂载/卸载由窗口控制器（mountWindow）调度——先只渲染等高
   * 占位，进入视口带经调度挂真卡；整行离开卸载窗口后卸回实测等高占位
   * （绘制中不卸载等守卫在控制器）。li 本身常驻（跳题滚动、阅读位置恢复、
   * 题卡元素注册表都不依赖卡片是否已挂载）。单题专注模式传 false。
   */
  lazyMount?: boolean | undefined;
  /** 外部强制挂载（跳题、阅读位置恢复的目标题）：true 时跳过视口判断 */
  forceMount?: boolean | undefined;
  /**
   * 窗口控制器（性能第三步，2026-10-28）：会话层为懒挂载列表提供共享实例
   * （进视口调度 + 远端卸载 + 守卫都在控制器）。undefined（独立使用/单测）
   * 时行内自建实例，行为退化为第一版懒挂载（只挂不卸）。
   */
  mountWindow?: LazyMountWindow | undefined;
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
  mountWindow,
  ...props
}: RowProps) {
  const liRef = useRef<HTMLLIElement | null>(null);
  // 会话层未提供共享控制器（独立使用/单测）时行内自建：第一版懒挂载语义。
  // 回调经 ref 取最新值，实例只建一次不随 props 翻新。
  const onCardMountedRef = useRef(onCardMounted);
  useEffect(() => {
    onCardMountedRef.current = onCardMounted;
  }, [onCardMounted]);
  const [fallbackWindow] = useState<LazyMountWindow | undefined>(() =>
    lazyMount && mountWindow === undefined
      ? new LazyMountWindow({
          onSettle: () => onCardMountedRef.current?.(question.id),
        })
      : undefined,
  );
  useEffect(
    () => () => {
      fallbackWindow?.dispose();
    },
    [fallbackWindow],
  );
  const mountCtl = mountWindow ?? fallbackWindow;
  const register = useCallback(
    (element: HTMLLIElement | null) => {
      liRef.current = element;
      events.registerCard(question.id, element);
      if (element) cardElements.current.set(question.id, element);
      else cardElements.current.delete(question.id);
      mountCtl?.attach(question.id, element);
    },
    [events, cardElements, question.id, mountCtl],
  );
  const subscribeMounted = useCallback(
    (listener: () => void) =>
      mountCtl?.subscribe(question.id, listener) ?? (() => {}),
    [mountCtl, question.id],
  );
  const readMounted = useCallback(
    () => mountCtl?.isMounted(question.id) ?? false,
    [mountCtl, question.id],
  );
  const controllerMounted = useSyncExternalStore(
    subscribeMounted,
    readMounted,
    readMounted,
  );
  const showCard = lazyMount === false || controllerMounted || forceMount;
  // 常驻行（单题模式/小卷）保留首次挂载上报；懒挂载行的挂载/卸载结算由
  // 控制器统一触发（挂载版本号 rAF 合帧，驱动判分反馈观察列表与阅读位置重捕）。
  useEffect(() => {
    if (!lazyMount) onCardMounted?.(question.id);
  }, [lazyMount, onCardMounted, question.id]);
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
        // 等高占位：首挂前按题干/选项数估算；窗口化卸载后回填实测高度，
        // 重挂零位移（估算偏小带来的一次位移仍由浏览器滚动锚定兜底）。
        <div
          data-slot="question-placeholder"
          className="rounded-[8px] border border-dashed border-border/70 bg-card/40"
          style={{
            minHeight:
              mountCtl?.measuredHeight(question.id) ??
              placeholderHeight(question),
          }}
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

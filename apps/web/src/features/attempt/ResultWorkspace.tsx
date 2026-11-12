import type { AttemptResultQuestion, AttemptStatus } from "@tutor/contract";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { MemoQuickCaptureButton } from "@/features/memos/MemoQuickCapture";
import { AttemptFooter, AttemptNavigatorButton } from "./AttemptBottomBar";
import { AttemptNavigationDialog } from "./AttemptNavigationDialog";
import { AttemptWorkspace } from "./AttemptWorkspace";
import { ResultQuestionNavigator } from "./ResultQuestionNavigator";
import {
  inReviewScope,
  REVIEW_SCOPE_LABELS,
  type ReviewScope,
  reviewScopes,
} from "./result-review-model";
import { useResultReviewLocation } from "./use-result-review-location";

export function ResultWorkspace({
  title,
  attemptId,
  questions,
  released,
  status,
  onBack,
  backLabel,
  children,
  actions,
  primaryAction,
  rootRef,
  reviewLocation,
}: {
  title: string;
  attemptId: string;
  questions: readonly AttemptResultQuestion[];
  released: boolean;
  status: AttemptStatus;
  onBack(): void;
  backLabel: string;
  children: ReactNode;
  /** 标题右侧扩展动作位（SAI-22 AI 复盘入口；不传不占位） */
  actions?: ReactNode;
  /**
   * 顶栏主动作位（整卷复盘入口）：宽屏排在图标动作前面；窄屏（< lg）单独
   * 占顶栏第二行，按钮文字完整显示、不和图标挤在一起。渲染为空时不占位。
   */
  primaryAction?: ReactNode;
  /** 主区根 ref（调用方持有回看定位时一并传入；缺省内部自建） */
  rootRef?: RefObject<HTMLDivElement | null>;
  /** 调用方持有的回看定位（AI 面板绑定回看当前题需要 currentId；
   *  缺省内部自建——两实例对同一 URL/存储写同值，幂等无冲突） */
  reviewLocation?: ReturnType<typeof useResultReviewLocation>;
}) {
  const ownRoot = useRef<HTMLDivElement>(null);
  const root = rootRef ?? ownRoot;
  const ids = useMemo(
    () => questions.map((question) => question.questionId),
    [questions],
  );
  const ownLocation = useResultReviewLocation(attemptId, ids, released, root);
  const location = reviewLocation ?? ownLocation;
  const [open, setOpen] = useState(false);
  const jumping = useRef<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const range = questions.filter((question) =>
    inReviewScope(question, location.scope, released),
  );
  const cursor = range.findIndex(
    (question) => question.questionId === location.currentId,
  );
  const previous = cursor > 0 ? range[cursor - 1] : undefined;
  const next = cursor >= 0 ? range[cursor + 1] : range[0];
  return (
    <AttemptWorkspace>
      <header
        data-slot="attempt-header"
        className="sticky top-0 z-30 -mx-3 flex flex-wrap items-start gap-2 border-b border-border bg-background px-3 py-3 sm:-mx-6 sm:px-6"
      >
        <Button
          variant="ghost"
          className="size-11 shrink-0 p-0"
          aria-label={backLabel}
          title={backLabel}
          onClick={onBack}
        >
          <ArrowLeft aria-hidden className="size-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="break-words text-xl leading-snug font-semibold [overflow-wrap:anywhere]">
            {title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {!released
              ? "已交卷 · 待公布"
              : status === "graded"
                ? "已批改 · 结果回看"
                : "已交卷 · 待批改"}
          </p>
        </div>
        <div
          data-slot="attempt-header-primary"
          className="order-last flex basis-full justify-end empty:hidden lg:order-none lg:shrink-0 lg:basis-auto"
        >
          {primaryAction}
        </div>
        <div className="flex shrink-0 items-center">
          {actions}
          <MemoQuickCaptureButton />
        </div>
      </header>
      <div ref={root} className="min-w-0">
        {children}
      </div>
      <AttemptFooter>
        <AttemptNavigatorButton
          onOpen={(button) => {
            trigger.current = button;
            setOpen(true);
          }}
        >
          答题卡 ·{" "}
          {location.currentId
            ? `第 ${ids.indexOf(location.currentId) + 1} / ${ids.length} 题`
            : "暂无题目"}
        </AttemptNavigatorButton>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            className="size-11 shrink-0 p-0"
            aria-label="上一题"
            title="上一题"
            disabled={!previous}
            onClick={() => previous && location.jump(previous.questionId)}
          >
            <ChevronLeft aria-hidden className="size-5" />
          </Button>
          <Button
            variant="outline"
            className="size-11 shrink-0 p-0"
            aria-label="下一题"
            title="下一题"
            disabled={!next}
            onClick={() => next && location.jump(next.questionId)}
          >
            <ChevronRight aria-hidden className="size-5" />
          </Button>
        </div>
      </AttemptFooter>
      <AttemptNavigationDialog
        open={open}
        onOpenChange={setOpen}
        onCloseFocus={() => {
          const target = jumping.current;
          jumping.current = null;
          if (target) location.jump(target);
          else trigger.current?.focus();
        }}
        description="按原卷题号定位"
      >
        <label className="flex shrink-0 flex-col gap-1 text-sm">
          定位范围
          <select
            aria-label="回看定位范围"
            value={location.scope}
            onChange={(event) =>
              location.setScope(event.target.value as ReviewScope)
            }
            className="h-11 min-w-0 rounded-md border border-input bg-background px-3 text-base"
          >
            {reviewScopes(released).map((scope) => (
              <option key={scope} value={scope}>
                {REVIEW_SCOPE_LABELS[scope]}
              </option>
            ))}
          </select>
        </label>
        <ResultQuestionNavigator
          questions={questions}
          released={released}
          scope={location.scope}
          currentId={location.currentId}
          onJump={(id) => {
            jumping.current = id;
            setOpen(false);
          }}
          onResetScope={() => location.setScope("all")}
        />
      </AttemptNavigationDialog>
    </AttemptWorkspace>
  );
}

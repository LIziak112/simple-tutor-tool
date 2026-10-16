import type { AttemptResultQuestion, AttemptStatus } from "@tutor/contract";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ListOrdered,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  const [collapsed, setCollapsed] = useState(false);
  const navigationId = useId();
  const anchor = useRef<{ element: HTMLElement; top: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies(collapsed): 开合提交布局后恢复当前题卡位置。
  useLayoutEffect(() => {
    const saved = anchor.current;
    if (saved) {
      window.scrollBy({
        top: saved.element.getBoundingClientRect().top - saved.top,
        behavior: "instant",
      });
      anchor.current = null;
    }
  }, [collapsed]);
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
  const navigator = (
    <>
      <label className="mb-3 flex flex-col gap-1 text-sm">
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
          jumping.current = open ? id : null;
          setOpen(false);
          location.jump(id);
        }}
      />
      {range.length === 0 && location.scope !== "all" && (
        <Button
          variant="outline"
          className="mt-3 min-h-11"
          onClick={() => location.setScope("all")}
        >
          返回全部题目
        </Button>
      )}
    </>
  );
  return (
    <AttemptWorkspace>
      <header
        data-slot="attempt-header"
        className="sticky top-0 z-30 -mx-3 flex items-start gap-2 border-b border-border bg-background px-3 py-3 sm:-mx-6 sm:px-6"
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
        {actions != null && (
          <div className="flex shrink-0 items-center">{actions}</div>
        )}
      </header>
      <div
        className={`grid min-w-0 gap-6 ${collapsed ? "lg:grid-cols-[44px_minmax(0,1fr)]" : "lg:grid-cols-[240px_minmax(0,1fr)]"}`}
      >
        <aside
          className="sticky top-[calc(var(--attempt-header-height,96px)+16px)] hidden max-h-[calc(var(--attempt-viewport-height,100dvh)-var(--attempt-header-height,96px)-var(--attempt-footer-height,64px)-32px)] overflow-y-auto overscroll-contain lg:block"
          aria-label="结果定位"
        >
          <Button
            variant="outline"
            className={`sticky top-0 z-10 mb-3 min-h-11 ${collapsed ? "size-11 p-0" : "w-full justify-between"}`}
            aria-label={collapsed ? "展开题号栏" : "收起题号栏"}
            title={collapsed ? "展开题号栏" : "收起题号栏"}
            aria-expanded={!collapsed}
            aria-controls={navigationId}
            onClick={() => {
              const element = [
                ...(root.current?.querySelectorAll<HTMLElement>(
                  "[data-review-question]",
                ) ?? []),
              ].find(
                (card) => card.dataset.reviewQuestion === location.currentId,
              );
              if (element)
                anchor.current = {
                  element,
                  top: element.getBoundingClientRect().top,
                };
              setCollapsed((value) => !value);
            }}
          >
            {!collapsed && <span>回看题号</span>}
            {collapsed ? (
              <PanelLeftOpen aria-hidden className="size-4" />
            ) : (
              <PanelLeftClose aria-hidden className="size-4" />
            )}
          </Button>
          <div id={navigationId} hidden={collapsed}>
            {navigator}
          </div>
        </aside>
        <div ref={root} className="min-w-0">
          {children}
        </div>
      </div>
      <footer
        data-slot="attempt-bottom-bar"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background pb-[env(safe-area-inset-bottom)]"
      >
        <div className="mx-auto flex max-w-[1440px] items-center gap-2 px-3 py-2 sm:px-6">
          <Button
            variant="outline"
            className="min-h-11 lg:hidden"
            aria-label="打开回看题号"
            ref={trigger}
            onClick={() => setOpen(true)}
          >
            <ListOrdered aria-hidden className="size-4" />
            题号
          </Button>
          <p className="min-w-0 flex-1 text-sm tabular-nums">
            {location.currentId
              ? `第 ${ids.indexOf(location.currentId) + 1} 题 / ${ids.length} 题`
              : "暂无题目"}
          </p>
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
      </footer>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="flex max-h-[80dvh] w-[calc(100%-24px)] flex-col rounded-lg"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (jumping.current) location.jump(jumping.current);
            else trigger.current?.focus();
            jumping.current = null;
          }}
        >
          <DialogHeader>
            <DialogTitle>回看题号</DialogTitle>
            <DialogDescription>按原卷题号定位</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto overscroll-contain">
            {navigator}
          </div>
        </DialogContent>
      </Dialog>
    </AttemptWorkspace>
  );
}

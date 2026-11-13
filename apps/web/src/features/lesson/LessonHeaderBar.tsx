import { ArrowLeft, Sparkles } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { Link } from "react-router";
import { useAttemptEditor } from "@/features/attempt/AttemptEditorContext";
import { MemoQuickCaptureButton } from "@/features/memos/MemoQuickCapture";
import { useReadingToolbar } from "@/features/student/use-reading-toolbar";
import { useDesktopViewport } from "@/lib/use-desktop-viewport";
export function LessonHeaderBar({
  title,
  backTo,
  backLabel,
  actions,
  context,
  toc,
  readingBlocked = false,
}: {
  title: string;
  /** 返回目标（落地页 /s/lectures/:id/lesson） */
  backTo: string;
  backLabel: string;
  actions: ReactNode;
  context: ReactNode;
  /** 目录入口（讲练页正文视图传入；加载/错误态不传） */
  toc?: ReactNode;
  /** 阅读态工具栏锁定（窄屏目录弹层打开时不随滚动收起） */
  readingBlocked?: boolean;
}) {
  const editor = useAttemptEditor();
  const isDesktop = useDesktopViewport();
  const toolbar = useReadingToolbar({
    blocked: readingBlocked || editor?.active != null,
  });
  // 目录跳转的滚动锚点：按实际工具栏高度预留，标题不被 sticky 头遮住。
  useEffect(() => {
    const element = toolbar.ref.current;
    if (!element) return;
    const root = document.documentElement;
    const previousPadding = root.style.scrollPaddingTop;
    const updateHeight = () => {
      root.style.scrollPaddingTop = `${element.getBoundingClientRect().height + 16}px`;
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.scrollPaddingTop = previousPadding;
    };
  }, [toolbar.ref]);
  return (
    <>
      <nav
        ref={toolbar.ref}
        data-slot="lesson-header"
        data-reading-hidden={toolbar.hidden}
        aria-label="讲练页工具栏"
        className="reading-toolbar sticky top-0 z-20 -mx-3 flex min-h-14 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-background px-3 py-1.5 sm:-mx-6 sm:min-h-16 sm:px-6 sm:py-2"
      >
        <Link
          to={backTo}
          aria-label={backLabel}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ArrowLeft aria-hidden className="size-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm leading-relaxed font-semibold break-words sm:text-base">
            <Sparkles aria-hidden className="size-4 shrink-0 text-primary" />
            <span className="min-w-0 truncate sm:whitespace-normal sm:break-words">
              {title}
            </span>
          </p>
          {isDesktop && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {context}
            </div>
          )}
        </div>
        {toc}
        <MemoQuickCaptureButton unanchored />
        {actions !== null && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        )}
      </nav>
      {!isDesktop && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {context}
        </div>
      )}
    </>
  );
}

import { ArrowLeft, Dumbbell, ListTree } from "lucide-react";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  EnabledCapabilitiesProvider,
  toEnabledCapabilities,
} from "@/features/capability/enabled-capabilities";
import type { DirectiveTelemetryInfo } from "@/features/markdown/directives/expand-context";
import { LectureOutline } from "@/features/markdown/LectureOutline";
import { extractOutline } from "@/features/markdown/outline";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import {
  LECTURE_HEADING_SELECTOR,
  useLectureSectionFocus,
} from "@/features/markdown/use-lecture-section-focus";
import { lessonHref } from "@/features/student/lesson-navigation";
import { useStudentLecture } from "@/features/student/student-queries";
import {
  StudentErrorPanel,
  StudentListSkeleton,
} from "@/features/student/student-ui";
import { useStudentWorkspace } from "@/features/student/student-workspace-layout";
import { createEventQueue } from "@/lib/event-queue";

const LectureMarkdown = memo(RichMarkdown);
const DESKTOP_QUERY = "(min-width: 1024px)";
function subscribeDesktop(onChange: () => void): () => void {
  const media = window.matchMedia(DESKTOP_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
function getDesktopSnapshot(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

/**
 * /s/lectures/:id 讲义阅读页（T2.3，§5.3 讲义渲染；T2A.5 加课程上下文与配套练习）。
 * - 全文用 T1.8 的 <RichMarkdown> 渲染（KaTeX/指令组件随其管线按需工作，
 *   :::solution 等讲解块以折叠件呈现、点开查看）；
 * - T2A.5：URL 携带 ?courseId=（课程目录/讲义列表带出）；标题下显示「课程：名」；
 *   返回键回课程目录（无 courseId 时回讲义列表）；
 * - T2A.5（D8）：底部「本课配套练习」——同课程可见的配套单元（题数 +「即将开放」，
 *   作答入口 T2A.6 开放，先不可点击）；
 * - 学习痕迹（T2.10 + T4.0a/b）：lecture scope 队列（无 attempt 上下文，带
 *   lectureId 供队列层注入 lecture_visible/hidden、net、idle）；折叠开/合与
 *   steps 揭晓报 directive_interact（host=lecture，T4.0b 起新客户端不再发
 *   lecture_expand）；「当前阅读节」切换报 lecture_section_focus（迟滞防抖，
 *   §5.0-C13）；目录点击报 lecture_toc_jump。讲义域位置/交互事件带
 *   lectureUpdatedAt（版本定位，§4.4.2 前提 1）；队列 dispose 时尽力 flush；
 * - 自动目录（H2/H3）：目录条目顺序 = 正文 h2/h3 顺序，点击滚动到对应标题；
 * - 专用阅读栏常驻返回与目录入口，章节状态复用既有位置观察器；
 * - iPad 适配：窄屏目录弹层；横屏（lg:）目录固定在左侧 sticky 双栏，
 *   两侧都不出现横向滚动（公式块 overflow 由 rich-markdown 样式内部消化）。
 */

/** 滚动正文中的第 index 个 H2/H3 标题到视口（目录条目与渲染标题一一对应） */
function scrollToHeading(index: number): void {
  const target = document.querySelectorAll<HTMLElement>(
    LECTURE_HEADING_SELECTOR,
  )[index];
  if (!target) return;
  target.tabIndex = -1;
  target.focus({ preventScroll: true });
  target.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
    block: "start",
  });
}

export default function StudentLectureViewPage() {
  useStudentWorkspace();
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  /** 课程上下文（课程目录/讲义列表带出；缺省时服务端取第一个可见该讲义的课程） */
  const courseId = searchParams.get("courseId") ?? undefined;
  const lectureQuery = useStudentLecture(id, courseId);
  const isDesktop = useSyncExternalStore(
    subscribeDesktop,
    getDesktopSnapshot,
    () => false,
  );
  /** 桌面侧栏默认展开；窄屏只通过阅读栏进入目录。 */
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [mobileOutlineOpen, setMobileOutlineOpen] = useState(false);
  const [currentIndex, setCurrentIndex] = useState<number | null>(0);
  const toolbarRef = useRef<HTMLElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const outlineTriggerRef = useRef<HTMLButtonElement>(null);
  const desktopOutlineScrollRef = useRef<HTMLDivElement>(null);
  const mobileOutlineScrollRef = useRef<HTMLDivElement>(null);
  const pendingHeadingRef = useRef<number | null>(null);
  const capabilities = useMemo(
    () => toEnabledCapabilities(lectureQuery.data?.enabledCapabilities ?? []),
    [lectureQuery.data?.enabledCapabilities],
  );

  // 标题换行、文字放大后仍按实际工具栏高度预留锚点和键盘焦点位置。
  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const root = document.documentElement;
    const previousPadding = root.style.scrollPaddingTop;
    const updateHeight = () => {
      const offset = `${toolbar.getBoundingClientRect().height + 16}px`;
      articleRef.current?.style.setProperty("--lecture-toolbar-offset", offset);
      root.style.scrollPaddingTop = offset;
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(toolbar);
    return () => {
      observer.disconnect();
      root.style.scrollPaddingTop = previousPadding;
    };
  }, []);

  useEffect(() => {
    if (isDesktop) setMobileOutlineOpen(false);
  }, [isDesktop]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 切换讲义或重新载入正文时重置阅读状态，不沿用上一份讲义的下标。
  useEffect(() => {
    setCurrentIndex(0);
    pendingHeadingRef.current = null;
  }, [id, lectureQuery.data?.markdown]);

  // 学习痕迹（T2.10 + T4.0a/b）：lecture scope 队列（无 attempt 上下文，带
  // lectureId 供队列层注入 lecture_visible/hidden、net、idle）。回调经 ref 转发——
  // RichMarkdown 不因队列创建而重渲染/重挂载。
  const queueRef = useRef<ReturnType<typeof createEventQueue> | null>(null);
  useEffect(() => {
    if (id === "") return;
    const queue = createEventQueue({
      scope: { kind: "lecture", lectureId: id },
    });
    queueRef.current = queue;
    return () => {
      queue.dispose();
      queueRef.current = null;
    };
  }, [id]);

  /** 讲义版本定位（§4.4.2 前提 1）：正文加载后填入位置/交互事件 payload；
   *  经 ref 转发——数据晚于稳定回调创建到达，不重建回调引用 */
  const lectureUpdatedAtRef = useRef<string | null>(null);
  lectureUpdatedAtRef.current = lectureQuery.data?.updatedAt ?? null;

  // T4.0b 交互族：折叠开/合、steps 揭晓 → directive_interact（host=lecture）。
  // index=文档全局指令序号（docIndex）；reveal 额外带容器内步序号 step
  //（契约按 action 判别联合，分支构造让 TS 精确收窄）。
  const onDirectiveTelemetry = useRef((event: DirectiveTelemetryInfo): void => {
    const queue = queueRef.current;
    if (queue === null) return;
    const version = lectureUpdatedAtRef.current;
    if (event.action === "reveal" && event.step !== undefined) {
      queue.track({
        type: "directive_interact",
        clientTs: Date.now(),
        host: "lecture",
        lectureId: id,
        name: event.name,
        index: event.index,
        action: "reveal",
        step: event.step,
        ...(version !== null ? { lectureUpdatedAt: version } : {}),
      });
      return;
    }
    if (event.action === "open" || event.action === "close") {
      queue.track({
        type: "directive_interact",
        clientTs: Date.now(),
        host: "lecture",
        lectureId: id,
        name: event.name,
        index: event.index,
        action: event.action,
        ...(version !== null ? { lectureUpdatedAt: version } : {}),
      });
    }
  }).current;

  // T4.0b 位置族：「当前阅读节」切换 → lecture_section_focus（迟滞防抖 §5.0-C13）
  const trackSectionFocus = useRef((headingIndex: number): void => {
    setCurrentIndex(headingIndex);
    queueRef.current?.track({
      type: "lecture_section_focus",
      clientTs: Date.now(),
      lectureId: id,
      headingIndex,
      ...(lectureUpdatedAtRef.current !== null
        ? { lectureUpdatedAt: lectureUpdatedAtRef.current }
        : {}),
    });
  }).current;
  useLectureSectionFocus({
    enabled: lectureQuery.data !== undefined,
    sourceKey: lectureQuery.data?.markdown ?? "",
    onSectionFocus: trackSectionFocus,
  });

  // T4.0b 位置族：目录点击 → lecture_toc_jump（headingIndex 与自动目录下标同源）
  function navigateOutline(headingIndex: number): void {
    queueRef.current?.track({
      type: "lecture_toc_jump",
      clientTs: Date.now(),
      lectureId: id,
      headingIndex,
      ...(lectureUpdatedAtRef.current !== null
        ? { lectureUpdatedAt: lectureUpdatedAtRef.current }
        : {}),
    });
    setCurrentIndex(headingIndex);
    if (!isDesktop) {
      // Radix 完成弹层关闭后再聚焦正文，避免焦点被模态圈闭抢回。
      pendingHeadingRef.current = headingIndex;
      setMobileOutlineOpen(false);
    } else {
      scrollToHeading(headingIndex);
    }
  }

  const outline = useMemo(
    // 2026-10 讲练一体：kind=lesson 时 markdown 恒 null（安全投影）——本页对
    // lesson 重定向到讲练页（下方分支），这里空串兜底（纯讲义不受影响）
    () =>
      lectureQuery.data ? extractOutline(lectureQuery.data.markdown ?? "") : [],
    [lectureQuery.data],
  );

  // 2026-10 讲练一体：讲练页（kind=lesson）的学生入口是 /s/lectures/:id/lesson
  // （单题作答 + 即时反馈）——本阅读页对 lesson 详情重定向过去（保留 courseId
  // 课程上下文；讲义列表/课程目录行的点击由此直达讲练页）
  if (lectureQuery.data?.kind === "lesson") {
    return (
      <Navigate replace to={lessonHref(id, courseId)} />
    );
  }

  return (
    <article
      ref={articleRef}
      aria-label="讲义阅读"
      className="lecture-reading flex flex-col gap-5 pb-8"
    >
      <nav
        ref={toolbarRef}
        aria-label="讲义阅读工具栏"
        className="sticky top-0 z-20 -mx-3 flex min-h-16 items-center gap-2 border-b border-border bg-background px-3 py-2 sm:-mx-6 sm:px-6"
      >
        <Link
          to={courseId !== undefined ? `/s/courses/${courseId}` : "/s/lectures"}
          aria-label={courseId !== undefined ? "返回课程目录" : "返回讲义列表"}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ArrowLeft aria-hidden className="size-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-relaxed font-semibold break-words sm:text-base">
            {lectureQuery.data?.title ?? "讲义"}
          </p>
        </div>
        {outline.length > 0 && (
          <button
            ref={outlineTriggerRef}
            type="button"
            aria-expanded={isDesktop ? outlineOpen : mobileOutlineOpen}
            aria-haspopup={!isDesktop ? "dialog" : undefined}
            aria-controls={
              isDesktop ? "lecture-desktop-outline" : "lecture-mobile-outline"
            }
            onClick={() =>
              isDesktop
                ? setOutlineOpen((value) => !value)
                : setMobileOutlineOpen(true)
            }
            className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <ListTree aria-hidden className="size-4" />
            {isDesktop && outlineOpen ? "收起目录" : "展开目录"}
          </button>
        )}
      </nav>

      <Dialog
        open={!isDesktop && mobileOutlineOpen}
        onOpenChange={setMobileOutlineOpen}
      >
        {!isDesktop && (
          <DialogContent
            id="lecture-mobile-outline"
            className="w-[calc(100%-2rem)] max-w-md overflow-hidden p-4"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const index = pendingHeadingRef.current;
              pendingHeadingRef.current = null;
              if (index !== null) scrollToHeading(index);
              else outlineTriggerRef.current?.focus({ preventScroll: true });
            }}
          >
            <DialogHeader className="pr-11">
              <DialogTitle className="leading-normal">讲义目录</DialogTitle>
              <DialogDescription>选择章节，跳转到正文</DialogDescription>
            </DialogHeader>
            <div
              ref={mobileOutlineScrollRef}
              className="min-h-0 overflow-y-auto overscroll-contain"
            >
              <LectureOutline
                key={lectureQuery.data?.markdown}
                items={outline}
                currentIndex={currentIndex}
                scrollContainerRef={mobileOutlineScrollRef}
                onNavigate={navigateOutline}
              />
            </div>
          </DialogContent>
        )}
      </Dialog>

      {lectureQuery.isPending && (
        <StudentListSkeleton label="正在加载讲义" rows={2} />
      )}

      {lectureQuery.isError && (
        <StudentErrorPanel
          title="讲义加载失败"
          message={
            lectureQuery.error instanceof Error
              ? lectureQuery.error.message
              : "网络异常，请稍后重试"
          }
          onRetry={() => void lectureQuery.refetch()}
        />
      )}

      {lectureQuery.data && (
        <>
          <div className="flex min-w-0 flex-col gap-5 lg:flex-row lg:items-start">
            {isDesktop && outlineOpen && outline.length > 0 && (
              <div
                id="lecture-desktop-outline"
                className="sticky top-[var(--lecture-toolbar-offset,5rem)] w-64 shrink-0 rounded-xl border border-border bg-card p-3"
              >
                <p className="mb-3 px-3 text-xs font-semibold text-muted-foreground">
                  讲义目录
                </p>
                <div
                  ref={desktopOutlineScrollRef}
                  className="max-h-[calc(100dvh-var(--lecture-toolbar-offset,5rem)-4rem)] overflow-y-auto overscroll-contain pr-1"
                >
                  <LectureOutline
                    key={lectureQuery.data?.markdown}
                    items={outline}
                    currentIndex={currentIndex}
                    scrollContainerRef={desktopOutlineScrollRef}
                    onNavigate={navigateOutline}
                  />
                </div>
              </div>
            )}

            {/* 正文（讲义全文；rich-markdown 内部处理公式块横向滚动；
              折叠开合/步骤揭晓经 onDirectiveTelemetry 上报 directive_interact
              〔host=lecture〕，T4.0b；旧 lecture_expand 不再产生）。
              T7.7：steps 揭晓遵循教师启用集（关闭时完整展开），Provider 包裹
              使 RichMarkdown 内全部指令组件可读 */}
            <div className="min-w-0 flex-1 rounded-2xl border border-border bg-card px-4 py-5 shadow-xs sm:px-6 lg:px-8">
              <p className="mb-4 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-relaxed text-muted-foreground">
                <span>课程：{lectureQuery.data.courseName}</span>
                <span>
                  更新于{" "}
                  {new Intl.DateTimeFormat("zh-CN", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  }).format(new Date(lectureQuery.data.updatedAt))}
                </span>
              </p>
              <EnabledCapabilitiesProvider value={capabilities}>
                {/* kind=lesson 时 markdown 恒 null，讲练页路由接入前空串兜底 */}
                <LectureMarkdown
                  source={lectureQuery.data.markdown ?? ""}
                  className="lecture-body"
                  onDirectiveTelemetry={onDirectiveTelemetry}
                />
              </EnabledCapabilitiesProvider>
            </div>
          </div>

          {/* 本课配套练习（D8）：同课程可见的配套单元——进入单元落地页作答（T2A.6） */}
          {lectureQuery.data.companionUnits.length > 0 && (
            <section
              aria-labelledby="lecture-companions"
              className="rounded-2xl border border-border bg-card p-4 shadow-xs"
            >
              <h2
                id="lecture-companions"
                className="flex items-center gap-2 text-base font-semibold"
              >
                <Dumbbell aria-hidden className="size-5 text-primary" />
                本课配套练习
              </h2>
              <ul className="mt-3 flex flex-col gap-2">
                {lectureQuery.data.companionUnits.map((unit) => (
                  <li key={unit.id}>
                    <Link
                      to={`/s/courses/${lectureQuery.data.courseId}/units/${unit.id}`}
                      aria-label={`配套练习 ${unit.title}（${unit.questionCount} 题）`}
                      className="flex min-h-14 items-center gap-3 rounded-xl border border-border bg-card px-4 py-2 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <Dumbbell
                        aria-hidden
                        className="size-5 shrink-0 text-primary"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {unit.title}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {unit.questionCount} 题
                      </span>
                      <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                        去练习
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </article>
  );
}

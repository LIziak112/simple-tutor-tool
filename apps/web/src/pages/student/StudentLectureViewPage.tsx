import { ArrowLeft, Dumbbell, ListTree } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { DirectiveTelemetryInfo } from "@/features/markdown/directives/expand-context";
import type { OutlineItem } from "@/features/markdown/outline";
import { extractOutline } from "@/features/markdown/outline";
import { OutlineInlineMath } from "@/features/markdown/outline-inline-math";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { useLectureSectionFocus } from "@/features/markdown/use-lecture-section-focus";
import { useStudentLecture } from "@/features/student/student-queries";
import {
  StudentErrorPanel,
  StudentListSkeleton,
} from "@/features/student/student-ui";
import { createEventQueue } from "@/lib/event-queue";
import { formatCnTime } from "@/lib/time";

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
 * - 目录可折叠（长讲义收起目录专注正文）；
 * - iPad 适配：竖屏目录在正文上方；横屏（lg:）目录固定在左侧 sticky 双栏，
 *   两侧都不出现横向滚动（公式块 overflow 由 rich-markdown 样式内部消化）。
 */

/** 滚动正文中的第 index 个 H2/H3 标题到视口（目录条目与渲染标题一一对应） */
function scrollToHeading(index: number): void {
  const headings = document.querySelectorAll<HTMLElement>(
    ".rich-markdown h2, .rich-markdown h3",
  );
  headings[index]?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** 目录区块（条目为 ≥44px 触控目标的按钮；H3 缩进体现层级） */
function LectureOutline({
  items,
  onNavigate,
}: {
  items: OutlineItem[];
  onNavigate: (index: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="讲义目录"
      className="rounded-xl border border-border bg-card p-2"
    >
      <ol className="flex flex-col">
        {items.map((item, index) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onNavigate(index)}
              className={`flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${
                item.depth === 3 ? "pl-7 text-muted-foreground" : "font-medium"
              }`}
            >
              {/* 标题公式按 $...$ 渲染行内 KaTeX（P2-4），不再暴露原始 LaTeX */}
              <span className="truncate">
                <OutlineInlineMath text={item.text} />
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export default function StudentLectureViewPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  /** 课程上下文（课程目录/讲义列表带出；缺省时服务端取第一个可见该讲义的课程） */
  const courseId = searchParams.get("courseId") ?? undefined;
  const lectureQuery = useStudentLecture(id, courseId);
  /** 目录折叠状态（长讲义可收起；默认展开方便跳转） */
  const [outlineOpen, setOutlineOpen] = useState(true);

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
  const onOutlineNavigate = useRef((headingIndex: number): void => {
    queueRef.current?.track({
      type: "lecture_toc_jump",
      clientTs: Date.now(),
      lectureId: id,
      headingIndex,
      ...(lectureUpdatedAtRef.current !== null
        ? { lectureUpdatedAt: lectureUpdatedAtRef.current }
        : {}),
    });
    scrollToHeading(headingIndex);
  }).current;

  const outline = useMemo(
    () => (lectureQuery.data ? extractOutline(lectureQuery.data.markdown) : []),
    [lectureQuery.data],
  );

  return (
    <article aria-label="讲义阅读" className="flex flex-col gap-4">
      <header className="flex items-center gap-2">
        <Link
          to={courseId !== undefined ? `/s/courses/${courseId}` : "/s/lectures"}
          aria-label={courseId !== undefined ? "返回课程目录" : "返回讲义列表"}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ArrowLeft aria-hidden className="size-5" />
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">
            {lectureQuery.data?.title ?? "讲义"}
          </h1>
          {lectureQuery.data && (
            <p className="truncate text-xs text-muted-foreground">
              课程：{lectureQuery.data.courseName} · 更新于{" "}
              {formatCnTime(lectureQuery.data.updatedAt)}
            </p>
          )}
        </div>
      </header>

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
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
            {/* 目录：竖屏在正文上方（可折叠）；横屏固定左侧 sticky */}
            {outline.length > 0 && (
              <div className="lg:sticky lg:top-20 lg:w-60 lg:shrink-0">
                <button
                  type="button"
                  aria-expanded={outlineOpen}
                  onClick={() => setOutlineOpen((v) => !v)}
                  className="flex min-h-11 w-full items-center gap-2 rounded-lg px-1 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ListTree aria-hidden className="size-4 shrink-0" />
                  {outlineOpen ? "收起目录" : "展开目录"}
                </button>
                {outlineOpen && (
                  <div className="max-h-[40dvh] overflow-y-auto lg:max-h-[70dvh]">
                    <LectureOutline
                      items={outline}
                      onNavigate={onOutlineNavigate}
                    />
                  </div>
                )}
              </div>
            )}

            {/* 正文（讲义全文；rich-markdown 内部处理公式块横向滚动；
              折叠开合/步骤揭晓经 onDirectiveTelemetry 上报 directive_interact
              〔host=lecture〕，T4.0b；旧 lecture_expand 不再产生） */}
            <RichMarkdown
              source={lectureQuery.data.markdown}
              className="min-w-0 flex-1 rounded-2xl border border-border bg-card px-4 py-5 shadow-xs sm:px-6 lg:px-8"
              onDirectiveTelemetry={onDirectiveTelemetry}
            />
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

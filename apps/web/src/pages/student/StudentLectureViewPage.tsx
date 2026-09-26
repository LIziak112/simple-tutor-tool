import { ArrowLeft, ListTree } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import type { OutlineItem } from "@/features/markdown/outline";
import { extractOutline } from "@/features/markdown/outline";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { useStudentLecture } from "@/features/student/student-queries";
import {
  StudentErrorPanel,
  StudentListSkeleton,
} from "@/features/student/student-ui";
import { formatCnTime } from "@/lib/time";

/**
 * /s/lectures/:id 讲义阅读页（T2.3，§5.3 讲义渲染）。
 * - 全文用 T1.8 的 <RichMarkdown> 渲染（KaTeX/指令组件随其管线按需工作，
 *   :::solution 等讲解块以折叠件呈现、点开查看——事件上报是 T2.10，本任务不做）；
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
              <span className="truncate">{item.text}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export default function StudentLectureViewPage() {
  const { id = "" } = useParams<{ id: string }>();
  const lectureQuery = useStudentLecture(id);
  /** 目录折叠状态（长讲义可收起；默认展开方便跳转） */
  const [outlineOpen, setOutlineOpen] = useState(true);

  const outline = useMemo(
    () => (lectureQuery.data ? extractOutline(lectureQuery.data.markdown) : []),
    [lectureQuery.data],
  );

  return (
    <article aria-label="讲义阅读" className="flex flex-col gap-4">
      <header className="flex items-center gap-2">
        <Link
          to="/s/lectures"
          aria-label="返回讲义列表"
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ArrowLeft aria-hidden className="size-5" />
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">
            {lectureQuery.data?.title ?? "讲义"}
          </h1>
          {lectureQuery.data && (
            <p className="text-xs text-muted-foreground">
              更新于 {formatCnTime(lectureQuery.data.updatedAt)}
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
                    onNavigate={(index) => scrollToHeading(index)}
                  />
                </div>
              )}
            </div>
          )}

          {/* 正文（讲义全文；rich-markdown 内部处理公式块横向滚动） */}
          <RichMarkdown
            source={lectureQuery.data.markdown}
            className="min-w-0 flex-1 rounded-xl border border-border bg-card px-4 py-4 sm:px-6 lg:px-8"
          />
        </div>
      )}
    </article>
  );
}

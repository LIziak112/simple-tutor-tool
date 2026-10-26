import { useQueryClient } from "@tanstack/react-query";
import type {
  StudentCourseDetailData,
  StudentCourseItem,
} from "@tutor/contract";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Dumbbell,
  Folder,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { LessonBadge } from "@/components/source-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { catalogTreeRows } from "@/features/courses/catalog-tree";
import { lessonHref } from "./lesson-navigation";

type View = {
  q: string;
  type: string;
  status: string;
  collapsed: string[];
  anchor: string | null;
};
/** 查看状态随学生角色查询缓存隔离；退出/切换账号沿用已有清理机制。 */
export function StudentCourseCatalog({
  course,
  renderStatus,
}: {
  course: StudentCourseDetailData;
  renderStatus: (item: StudentCourseItem) => ReactNode;
}) {
  const cache = useQueryClient();
  const key = useMemo(
    () => ["student", "course-catalog-view", course.id],
    [course.id],
  );
  const [params, setParams] = useSearchParams();
  const lastParams = useRef(params.toString());
  const saved = useRef(cache.getQueryData<View>(key));
  const [view, setView] = useState<View>(() => ({
    q: params.get("q") ?? saved.current?.q ?? "",
    type: params.get("type") ?? saved.current?.type ?? "all",
    status: params.get("status") ?? saved.current?.status ?? "all",
    collapsed: saved.current?.collapsed ?? [],
    anchor: saved.current?.anchor ?? null,
  }));
  const [composing, setComposing] = useState(false);
  const type =
    view.type === "lecture" || view.type === "unit" ? view.type : "all";
  const status =
    type === "unit" && ["new", "draft", "submitted"].includes(view.status)
      ? view.status
      : "all";
  const q = view.q.trim().toLocaleLowerCase();
  const rows = catalogTreeRows(course.items);
  const matched = rows.filter(({ item, path }) => {
    if (
      item.kind === "section" ||
      (type !== "all" && item.kind !== type) ||
      (q && !path.toLocaleLowerCase().includes(q))
    )
      return false;
    if (status === "all") return true;
    const state = item.attempt?.hasDraft
      ? "draft"
      : (item.attempt?.submittedCount ?? 0) > 0
        ? "submitted"
        : "new";
    return state === status;
  });
  const matchingIds = new Set(
    matched.flatMap((row) => [row.item.id, ...row.ancestors]),
  );
  const filtering = !!q || type !== "all" || status !== "all";
  useEffect(() => {
    if (params.toString() !== lastParams.current) {
      lastParams.current = params.toString();
      setView((prev) => ({
        ...prev,
        q: params.get("q") ?? "",
        type: params.get("type") ?? "all",
        status: params.get("status") ?? "all",
      }));
      return;
    }
    cache.setQueryData(key, view);
    if (composing) return;
    const next = new URLSearchParams();
    if (view.q) next.set("q", view.q);
    if (type !== "all") next.set("type", type);
    if (status !== "all") next.set("status", status);
    if (params.toString() !== next.toString()) {
      lastParams.current = next.toString();
      setParams(next, { replace: true });
    }
  }, [cache, view, composing, type, status, params, setParams, key]);
  useEffect(() => {
    const anchor = saved.current?.anchor;
    if (anchor)
      document
        .getElementById(`course-item-${anchor}`)
        ?.scrollIntoView?.({ block: "center" });
  }, []);
  function patch(next: Partial<View>) {
    const value = { ...view, ...next };
    cache.setQueryData(key, value);
    setView(value);
  }
  return (
    <div className="flex flex-col gap-2">
      <Input
        aria-label="搜索讲义或练习名称"
        placeholder="搜索名称或文件夹"
        value={view.q}
        onChange={(e) => patch({ q: e.target.value })}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        className="min-h-12 text-base"
      />
      <fieldset
        className="flex flex-wrap items-center gap-1"
        aria-label="内容类型"
      >
        {[
          ["all", "全部"],
          ["lecture", "讲义"],
          ["unit", "练习"],
        ].map(([value, label]) => (
          <Button
            key={value}
            variant={type === value ? "secondary" : "ghost"}
            className="min-h-12 px-3"
            aria-pressed={type === value}
            onClick={() => patch({ type: value ?? "all", status: "all" })}
          >
            {label}
          </Button>
        ))}
      </fieldset>
      {type === "unit" && (
        <fieldset className="flex flex-wrap gap-1" aria-label="练习状态">
          {[
            ["all", "全部练习"],
            ["new", "未开始"],
            ["draft", "进行中"],
            ["submitted", "已交卷"],
          ].map(([value, label]) => (
            <Button
              key={value}
              variant={status === value ? "secondary" : "ghost"}
              className="min-h-12 px-3"
              aria-pressed={status === value}
              onClick={() => patch({ status: value ?? "all" })}
            >
              {label}
            </Button>
          ))}
        </fieldset>
      )}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span role="status">
          {filtering ? "找到" : "共"} {matched.length} 项内容
        </span>
        {filtering && (
          <Button
            variant="ghost"
            className="min-h-12"
            onClick={() => patch({ q: "", type: "all", status: "all" })}
          >
            清除筛选
          </Button>
        )}
      </div>
      {matched.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {filtering
            ? "没有匹配的内容，试试其他名称或清除筛选。"
            : "老师还没有发布内容。"}
        </div>
      ) : (
        <ol className="divide-y divide-border rounded-xl border border-border bg-card">
          {rows
            .filter(
              (row) =>
                matchingIds.has(row.item.id) &&
                (filtering ||
                  !row.ancestors.some((id) => view.collapsed.includes(id))),
            )
            .map(({ item, depth, path }) => (
              <li
                key={item.id}
                id={`course-item-${item.id}`}
                style={{ paddingInlineStart: `${Math.min(depth, 3) * 12}px` }}
              >
                {item.kind === "section" ? (
                  <button
                    type="button"
                    aria-expanded={
                      filtering || !view.collapsed.includes(item.id)
                    }
                    className="flex min-h-12 w-full items-center gap-2 rounded-lg px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() =>
                      patch({
                        collapsed: view.collapsed.includes(item.id)
                          ? view.collapsed.filter((id) => id !== item.id)
                          : [...view.collapsed, item.id],
                      })
                    }
                  >
                    {view.collapsed.includes(item.id) && !filtering ? (
                      <ChevronRight aria-hidden className="size-4 shrink-0" />
                    ) : (
                      <ChevronDown aria-hidden className="size-4 shrink-0" />
                    )}
                    <Folder
                      aria-hidden
                      className="size-4 shrink-0 text-primary"
                    />
                    <span className="min-w-0 break-words text-sm font-semibold">
                      {item.title}
                    </span>
                  </button>
                ) : (
                  <Link
                    onClick={() => patch({ anchor: item.id })}
                    aria-label={
                      item.kind === "unit"
                        ? `打开练习 ${item.title}（${item.questionCount ?? 0} 题）`
                        : `${item.docKind === "lesson" ? "打开讲练" : "阅读讲义"} ${item.title}`
                    }
                    to={
                      item.kind === "unit"
                        ? `/s/courses/${course.id}/units/${item.refId}`
                        : item.docKind === "lesson"
                          ? lessonHref(String(item.refId), course.id)
                          : `/s/lectures/${item.refId}?courseId=${course.id}`
                    }
                    className="flex min-h-14 items-center gap-2 rounded-lg px-3 py-2 transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {item.kind === "lecture" ? (
                      <BookOpen
                        aria-hidden
                        className="size-4 shrink-0 text-primary"
                      />
                    ) : (
                      <Dumbbell
                        aria-hidden
                        className="size-4 shrink-0 text-primary"
                      />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="break-words text-sm font-medium">
                        {item.docKind === "lesson" && <LessonBadge />}
                        {item.title}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {item.kind === "unit" ? (
                          <>
                            练习 · <span>{item.questionCount ?? 0} 题</span>
                          </>
                        ) : (
                          `讲义${item.docKind === "lesson" ? " · 可边学边练" : ""}`
                        )}
                      </span>
                      {item.kind === "unit" && renderStatus(item)}
                      {depth > 3 && (
                        <span className="break-words text-xs text-muted-foreground">
                          {path}
                        </span>
                      )}
                    </span>
                    <ChevronRight
                      aria-hidden
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                  </Link>
                )}
              </li>
            ))}
        </ol>
      )}
    </div>
  );
}

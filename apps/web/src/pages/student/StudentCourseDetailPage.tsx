import { ArrowLeft, BookOpen, Dumbbell, Lock, School } from "lucide-react";
import { Link, useParams } from "react-router";
import { useStudentCourse } from "@/features/student/student-queries";
import {
  StudentErrorPanel,
  StudentListSkeleton,
} from "@/features/student/student-ui";
import { ApiError } from "@/lib/api";

/**
 * /s/courses/:id 课程目录页（T2A.5）：按 D5 过滤的可见目录——
 * 分节标题（仅文字）、讲义项（进入阅读页，带 courseId 上下文）、单元项
 * （题数 +「即将开放」——作答入口 T2A.6 开放）。
 * 越权（D22）：非成员/课程已归档 → 403 COURSE_ACCESS_DENIED，展示中文引导
 * （可能已被移出）；课程不存在 → 404（服务端不暴露存在性，前端统一「打不开了」）。
 */
export default function StudentCourseDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const courseQuery = useStudentCourse(id);

  const accessDenied =
    courseQuery.error instanceof ApiError &&
    courseQuery.error.code === "COURSE_ACCESS_DENIED";

  return (
    <section aria-label="课程目录" className="flex flex-col gap-4">
      <header className="flex items-center gap-2">
        <Link
          to="/s/courses"
          aria-label="返回我的课程"
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ArrowLeft aria-hidden className="size-5" />
        </Link>
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 truncate text-lg font-semibold">
            <School aria-hidden className="size-5 shrink-0 text-primary" />
            {courseQuery.data?.name ?? "课程"}
          </h1>
          {courseQuery.data?.description && (
            <p className="truncate text-xs text-muted-foreground">
              {courseQuery.data.description}
            </p>
          )}
        </div>
      </header>

      {courseQuery.isPending && (
        <StudentListSkeleton label="正在加载课程目录" />
      )}

      {courseQuery.isError &&
        (accessDenied ? (
          <div
            role="alert"
            className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
          >
            <p className="text-sm font-medium">暂时看不到这门课</p>
            <p className="text-sm text-muted-foreground">
              你可能已被移出这门课，或课程已结束归档。有疑问请联系老师。
            </p>
            <Link
              to="/s/courses"
              className="flex min-h-11 items-center rounded-lg border border-border px-4 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              返回我的课程
            </Link>
          </div>
        ) : (
          <StudentErrorPanel
            title="课程目录加载失败"
            message={
              courseQuery.error instanceof Error
                ? courseQuery.error.message
                : "网络异常，请稍后重试"
            }
            onRetry={() => void courseQuery.refetch()}
          />
        ))}

      {courseQuery.data &&
        (courseQuery.data.items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
            <BookOpen aria-hidden className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">老师还没有发布内容</p>
            <p className="text-sm text-muted-foreground">
              课程内容发布后会自动出现在这里。
            </p>
          </div>
        ) : (
          <ol className="flex flex-col gap-2">
            {courseQuery.data.items.map((item) =>
              item.kind === "section" ? (
                // 分节标题：仅文字分组（li 保持列表语义）
                <li
                  key={item.id}
                  aria-label={`分节 ${item.title}`}
                  className="pt-3 text-sm font-semibold text-muted-foreground first:pt-0"
                >
                  {item.title}
                </li>
              ) : item.kind === "lecture" ? (
                <li key={item.id}>
                  <Link
                    to={`/s/lectures/${item.refId}?courseId=${courseQuery.data.id}`}
                    aria-label={`阅读讲义 ${item.title}`}
                    className="flex min-h-14 items-center gap-3 rounded-xl border border-border bg-card px-4 py-2 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <BookOpen
                      aria-hidden
                      className="size-5 shrink-0 text-primary"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {item.title}
                    </span>
                  </Link>
                </li>
              ) : (
                // 单元项：题数 + 即将开放（作答入口 T2A.6 开放；不可点击）
                <li
                  key={item.id}
                  aria-label={`练习 ${item.title}（${item.questionCount ?? 0} 题，即将开放）`}
                  className="flex min-h-14 items-center gap-3 rounded-xl border border-dashed border-border bg-muted/40 px-4 py-2"
                >
                  <Dumbbell
                    aria-hidden
                    className="size-5 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">
                    {item.title}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {item.questionCount ?? 0} 题
                  </span>
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                    <Lock aria-hidden className="size-3.5" />
                    即将开放
                  </span>
                </li>
              ),
            )}
          </ol>
        ))}
    </section>
  );
}

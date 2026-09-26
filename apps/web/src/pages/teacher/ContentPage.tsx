import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ContentTreeCourse, ContentTreeUnit } from "@tutor/contract";
import { cn } from "cn";
import {
  BookOpen,
  ChevronRight,
  CircleAlert,
  FileStack,
  PencilLine,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  LectureEditSheet,
  QuestionEditSheet,
} from "@/features/content/ContentEditSheet";
import {
  contentTreeKey,
  useContentTree,
} from "@/features/content/content-queries";
import { DeleteConfirmDialog } from "@/features/content/DeleteConfirmDialog";
import {
  difficultyStars,
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "@/features/content/question-meta";
import { deleteLectureApi, deleteQuestionApi } from "@/lib/api";
import { formatRelativeTime } from "@/lib/time";

/**
 * /t/content 教师端内容页（T1.11 列表；T1.12 增加单条编辑/删除）：
 * 按课程分组展示讲义列表与练习单元列表；单元可展开显示题目摘要
 * （题号、题型徽章、难度 ★×n、考点 chips、version）。
 * 讲义行与题目行提供编辑（抽屉：CodeMirror + 实时预览 + lint）与删除
 * （确认弹层：题目软删、讲义物理删除，文案说明恢复方式）。
 * 三态齐全（加载骨架/错误重试/空态引导去导入页）；触控目标 ≥44px。
 * ImportPage 提交成功后带 location.state 跳回本页，顶部显示成功提示条。
 */

/** location.state 的已知形态（导入成功跳转携带） */
interface ContentLocationState {
  importSuccess?: string;
}

/** 成功提示条的自动收起延时（之后同步清掉 history state，刷新/后退不再重复弹出） */
const BANNER_AUTO_DISMISS_MS = 6000;

/** 待删除对象（确认弹层打开期间） */
interface DeletingTarget {
  kind: "question" | "lecture";
  id: string;
  /** 展示名：题目 id / 讲义标题 */
  name: string;
}

export function ContentPage() {
  const treeQuery = useContentTree();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const state = location.state as ContentLocationState | null;
  const importSuccess = state?.importSuccess;
  const [bannerVisible, setBannerVisible] = useState(
    importSuccess !== undefined,
  );

  /** 编辑抽屉：正在编辑的题目/讲义 id（null = 关闭） */
  const [editingQuestionId, setEditingQuestionId] = useState<string | null>(
    null,
  );
  const [editingLectureId, setEditingLectureId] = useState<string | null>(null);
  /** 删除确认弹层的对象 */
  const [deleting, setDeleting] = useState<DeletingTarget | null>(null);
  /** 删除失败的行内提示（含重试入口的数据由用户重新点删除） */
  const [actionError, setActionError] = useState<string | null>(null);

  /** 收起提示条并清掉 history state */
  const dismissBanner = useCallback((): void => {
    setBannerVisible(false);
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, navigate]);

  // 6 秒后自动收起（手动点 × 走同一入口）
  useEffect(() => {
    if (importSuccess === undefined) return;
    const timer = setTimeout(dismissBanner, BANNER_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [importSuccess, dismissBanner]);

  const invalidateTree = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: contentTreeKey });
  }, [queryClient]);

  const deleteQuestionMutation = useMutation({
    mutationFn: (id: string) => deleteQuestionApi(id),
    onSuccess: async () => {
      setDeleting(null);
      setActionError(null);
      await invalidateTree();
    },
    onError: (err) => {
      setDeleting(null);
      setActionError(
        err instanceof Error ? err.message : "删除题目失败，请稍后重试",
      );
    },
  });

  const deleteLectureMutation = useMutation({
    mutationFn: (id: string) => deleteLectureApi(id),
    onSuccess: async () => {
      setDeleting(null);
      setActionError(null);
      await invalidateTree();
    },
    onError: (err) => {
      setDeleting(null);
      setActionError(
        err instanceof Error ? err.message : "删除讲义失败，请稍后重试",
      );
    },
  });

  const deletingPending =
    deleting === null
      ? false
      : deleting.kind === "question"
        ? deleteQuestionMutation.isPending
        : deleteLectureMutation.isPending;

  function confirmDelete(): void {
    if (deleting === null) return;
    if (deleting.kind === "question") {
      deleteQuestionMutation.mutate(deleting.id);
    } else {
      deleteLectureMutation.mutate(deleting.id);
    }
  }

  return (
    <section className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">内容</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            已导入的讲义与练习单元，点开单元可查看题目摘要
          </p>
        </div>
        <Button asChild className="min-h-11 px-4">
          <Link to="/t/import">
            <Upload aria-hidden />
            导入内容
          </Link>
        </Button>
      </header>

      {bannerVisible && importSuccess !== undefined && (
        <p
          role="status"
          className="mt-4 flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-700 dark:text-emerald-300"
        >
          <span className="min-w-0 flex-1 break-all">{importSuccess}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={dismissBanner}
            className="-m-1 flex size-8 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-emerald-500/10 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X aria-hidden className="size-4" />
          </button>
        </p>
      )}

      {actionError !== null ? (
        <p
          role="alert"
          className="mt-4 flex items-start justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
        >
          <span className="min-w-0 flex-1 break-all">{actionError}</span>
          <button
            type="button"
            aria-label="关闭错误提示"
            onClick={() => setActionError(null)}
            className="-m-1 flex size-8 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-destructive/10 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X aria-hidden className="size-4" />
          </button>
        </p>
      ) : null}

      <div className="mt-4">
        {treeQuery.isPending ? <TreeSkeleton /> : null}
        {treeQuery.isError ? (
          <TreeError
            message={
              treeQuery.error instanceof Error
                ? treeQuery.error.message
                : "网络异常，请稍后重试"
            }
            onRetry={() => void treeQuery.refetch()}
          />
        ) : null}
        {treeQuery.data !== undefined && treeQuery.data.courses.length === 0 ? (
          <TreeEmpty />
        ) : null}
        {treeQuery.data?.courses.map((course) => (
          <CourseSection
            key={course.id}
            course={course}
            onEditLecture={(id) => setEditingLectureId(id)}
            onDeleteLecture={(target) => setDeleting(target)}
            onEditQuestion={(id) => setEditingQuestionId(id)}
            onDeleteQuestion={(target) => setDeleting(target)}
          />
        ))}
      </div>

      {/* 编辑抽屉与删除确认（同一时刻至多一个） */}
      {editingQuestionId !== null ? (
        <QuestionEditSheet
          questionId={editingQuestionId}
          onClose={() => setEditingQuestionId(null)}
        />
      ) : null}
      {editingLectureId !== null ? (
        <LectureEditSheet
          lectureId={editingLectureId}
          onClose={() => setEditingLectureId(null)}
        />
      ) : null}
      {deleting !== null ? (
        <DeleteConfirmDialog
          title={deleting.kind === "question" ? "删除题目" : "删除讲义"}
          targetName={deleting.name}
          description={
            deleting.kind === "question"
              ? "删除后该题不再出现在列表中。题目为软删除：历史作答与统计保留，重新导入包含该题的文档即可恢复。"
              : "讲义将被永久删除（可重新导入恢复）。关联到这篇讲义的练习单元会自动解除关联，单元与题目不受影响。"
          }
          pending={deletingPending}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </section>
  );
}

/** 加载态：课程分组的骨架屏 */
function TreeSkeleton() {
  return (
    <div aria-live="polite" className="space-y-4">
      {[0, 1].map((i) => (
        <div key={i} className="animate-pulse space-y-3">
          <div className="h-6 w-40 rounded-md bg-muted" />
          <div className="h-11 rounded-lg bg-muted" />
          <div className="h-11 rounded-lg bg-muted" />
        </div>
      ))}
      <p className="text-center text-sm text-muted-foreground">正在加载内容…</p>
    </div>
  );
}

/** 错误态：原因 + 重试 */
function TreeError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-12 text-center"
    >
      <CircleAlert aria-hidden className="size-8 text-destructive" />
      <p className="text-sm font-medium text-destructive">内容加载失败</p>
      <p className="max-w-sm text-xs break-all text-muted-foreground">
        {message}
      </p>
      <Button variant="outline" className="min-h-11 px-6" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

/** 空态：解释 + 去导入页的动作入口 */
function TreeEmpty() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
      <FileStack aria-hidden className="size-10 text-muted-foreground" />
      <p className="text-sm font-medium">还没有导入任何内容</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        把练习或讲义的 Markdown 文档导入进来，就能布置作业、跟踪学情。
      </p>
      <Button asChild className="mt-2 min-h-11 px-5">
        <Link to="/t/import">
          <Upload aria-hidden />
          去导入第一份文档
        </Link>
      </Button>
    </div>
  );
}

/** 课程分组的操作回调（编辑/删除由页面级状态承接） */
interface CourseSectionActions {
  onEditLecture: (id: string) => void;
  onDeleteLecture: (target: DeletingTarget) => void;
  onEditQuestion: (id: string) => void;
  onDeleteQuestion: (target: DeletingTarget) => void;
}

/** 单个课程分组：讲义列表 + 可展开的练习单元列表 */
function CourseSection({
  course,
  onEditLecture,
  onDeleteLecture,
  onEditQuestion,
  onDeleteQuestion,
}: { course: ContentTreeCourse } & CourseSectionActions) {
  const isEmpty = course.lectures.length === 0 && course.units.length === 0;
  return (
    <section className="mt-6 first:mt-0" aria-label={`课程：${course.title}`}>
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <BookOpen aria-hidden className="size-4 text-muted-foreground" />
        {course.title}
      </h2>

      {isEmpty ? (
        <p className="mt-2 rounded-lg bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground">
          本课程暂无讲义与练习。
        </p>
      ) : null}

      {course.lectures.length > 0 ? (
        <div className="mt-3">
          <h3 className="px-1 text-xs font-medium tracking-wide text-muted-foreground">
            讲义（{course.lectures.length}）
          </h3>
          <ul className="mt-1.5 space-y-1.5">
            {course.lectures.map((lecture) => (
              <li key={lecture.id}>
                <div className="flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5">
                  <p className="min-w-0 flex-1 truncate text-sm font-medium">
                    {lecture.title}
                  </p>
                  <time
                    dateTime={lecture.updatedAt}
                    className="hidden shrink-0 text-xs text-muted-foreground sm:inline"
                  >
                    {formatRelativeTime(lecture.updatedAt)}
                  </time>
                  <Button
                    type="button"
                    variant="ghost"
                    className="size-11 shrink-0"
                    aria-label={`编辑讲义 ${lecture.title}`}
                    onClick={() => onEditLecture(lecture.id)}
                  >
                    <PencilLine aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="size-11 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`删除讲义 ${lecture.title}`}
                    onClick={() =>
                      onDeleteLecture({
                        kind: "lecture",
                        id: lecture.id,
                        name: lecture.title,
                      })
                    }
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {course.units.length > 0 ? (
        <div className="mt-4">
          <h3 className="px-1 text-xs font-medium tracking-wide text-muted-foreground">
            练习单元（{course.units.length}）
          </h3>
          <ul className="mt-1.5 space-y-1.5">
            {course.units.map((unit) => (
              <UnitRow
                key={unit.id}
                unit={unit}
                onEditQuestion={onEditQuestion}
                onDeleteQuestion={onDeleteQuestion}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** 可展开的练习单元行：点击标题展开题目摘要表 */
function UnitRow({
  unit,
  onEditQuestion,
  onDeleteQuestion,
}: {
  unit: ContentTreeUnit;
} & Pick<CourseSectionActions, "onEditQuestion" | "onDeleteQuestion">) {
  return (
    <li>
      <details className="group rounded-lg border border-border bg-card">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {unit.title}
          </span>
          {unit.topic !== null && (
            <span className="hidden max-w-40 truncate rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary sm:inline-block">
              {unit.topic}
            </span>
          )}
          <span className="shrink-0 text-xs text-muted-foreground">
            {unit.questions.length} 题 · {formatRelativeTime(unit.updatedAt)}
          </span>
        </summary>

        <div className="border-t border-border px-3 py-2">
          {unit.questions.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              本单元暂无题目（题目可能已被删除）。
            </p>
          ) : (
            <QuestionSummaryTable
              questions={unit.questions}
              onEditQuestion={onEditQuestion}
              onDeleteQuestion={onDeleteQuestion}
            />
          )}
        </div>
      </details>
    </li>
  );
}

/** 题目摘要表：题号、题型徽章、难度、考点 chips、version、操作 */
function QuestionSummaryTable({
  questions,
  onEditQuestion,
  onDeleteQuestion,
}: {
  questions: ContentTreeUnit["questions"];
} & Pick<CourseSectionActions, "onEditQuestion" | "onDeleteQuestion">) {
  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">
        单元内题目摘要（题号、题型、难度、考点、版本、操作）
      </caption>
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th scope="col" className="py-1.5 pr-2 font-medium">
            题号
          </th>
          <th scope="col" className="py-1.5 pr-2 font-medium">
            题型
          </th>
          <th scope="col" className="py-1.5 pr-2 font-medium">
            难度
          </th>
          <th scope="col" className="py-1.5 pr-2 font-medium">
            考点
          </th>
          <th scope="col" className="py-1.5 pr-2 font-medium">
            版本
          </th>
          <th scope="col" className="py-1.5 font-medium">
            <span className="sr-only">操作</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {questions.map((question, index) => (
          <tr
            key={question.id}
            className="border-t border-border/60 align-middle"
          >
            <th scope="row" className="py-2 pr-2 text-left font-normal">
              <span className="font-medium">{index + 1}</span>
              <span className="ml-1.5 text-xs break-all text-muted-foreground">
                {question.id}
              </span>
            </th>
            <td className="py-2 pr-2">
              <span
                className={cn(
                  "inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
                  QUESTION_TYPE_BADGE_CLASS[question.type],
                )}
              >
                {QUESTION_TYPE_LABELS[question.type]}
              </span>
            </td>
            <td
              className="py-2 pr-2 text-amber-500"
              aria-label={`难度 ${question.difficulty}/5`}
            >
              <span aria-hidden>{difficultyStars(question.difficulty)}</span>
            </td>
            <td className="py-2 pr-2">
              {question.knowledge.length === 0 ? (
                <span className="text-xs text-muted-foreground">—</span>
              ) : (
                <span className="flex flex-wrap gap-1">
                  {question.knowledge.map((name) => (
                    <span
                      key={name}
                      className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                    >
                      {name}
                    </span>
                  ))}
                </span>
              )}
            </td>
            <td className="py-2 pr-2 text-xs text-muted-foreground">
              v{question.version}
            </td>
            <td className="py-1 pl-0 text-right whitespace-nowrap">
              <Button
                type="button"
                variant="ghost"
                className="size-11"
                aria-label={`编辑题目 ${question.id}`}
                onClick={() => onEditQuestion(question.id)}
              >
                <PencilLine aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="size-11 text-destructive hover:bg-destructive/10 hover:text-destructive"
                aria-label={`删除题目 ${question.id}`}
                onClick={() =>
                  onDeleteQuestion({
                    kind: "question",
                    id: question.id,
                    name: question.id,
                  })
                }
              >
                <Trash2 aria-hidden />
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// 供 App.tsx 路由级懒加载
export default ContentPage;

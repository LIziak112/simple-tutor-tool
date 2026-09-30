import { useQueryClient } from "@tanstack/react-query";
import type { PendingMarkCard } from "@tutor/contract";
import { TEACHER_COMMENT_MAX } from "@tutor/contract";
import { cn } from "cn";
import {
  Check,
  Clock3,
  Lightbulb,
  PenLine,
  RotateCcw,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { useTeacherAssignments } from "@/features/assignments/assignment-queries";
import {
  formatReferenceAnswers,
  letterOf,
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "@/features/attempt/answer-format";
import { useTeacherCourses } from "@/features/courses/course-queries";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { useStudents } from "@/features/students/student-queries";
import { formatActiveSec } from "@/features/teacher-attempts/AttemptDetailQuestionCard";
import { sourceContextOf } from "@/features/teacher-attempts/attempt-views";
import { InkLightbox } from "@/features/teacher-attempts/InkLightbox";
import {
  type PendingMarkListParams,
  useMarkResponse,
  usePendingMarks,
} from "@/features/teacher-attempts/mark-queries";
import { formatCnTime } from "@/lib/time";

/**
 * /t/data/pending 待批队列页（T3.2b，D4）：单题卡片连续批改。
 * - 队列来自 GET /pending-marks（submittedAt 升序，先交先批）；筛选
 *   courseId/assignmentId/studentId 同步在 URL query（刷新不丢），选项取自
 *   现有课程 / 作业 / 学生接口；
 * - 队列是「进入 / 切换筛选」时的本地工作副本：批改与撤销只改本地（乐观
 *   更新，失败提示并回滚），后续同参数的重取不覆盖本地（连续批改不被打断）；
 * - 快捷键（桌面键盘）：J 下一题 / K 上一题 / 1 标对 / 2 标错 / 0 清除判定 /
 *   U 撤销上一题——输入框聚焦或笔迹放大层打开时不触发；1/2/0 同时是按钮
 *   （iPad 可点，触控 ≥44px）；
 * - 标对/标错后卡片立即离队；待批题无教师判定且 autoCorrect 为 null，
 *   「清除判定」不改变待批状态（等价于按当前评语框保存，卡片保留）；
 * - 撤销语义：保留最近一次「标对/标错」提交前的 { 卡片, 原位, 原评语 }
 *   （队列题原判定恒 null），U 键用原值再调一次 mark 接口恢复，并把该题
 *   插回队列原位；
 * - 顶部批改进度 x/y：y = 进入（或切换筛选）时的队列总数，x = 本地已处理
 *   （撤销会把 x 退回去）；
 * - 批注成功后 mark mutation 统一失效 D2 联动缓存（见 mark-queries），
 *   其他页面（数据页 / 详情 / 名单 / 进度矩阵）随后自然刷新。
 */

/** 撤销快照：最近一次「标对/标错」提交前的状态（队列题原判定恒 null） */
interface UndoSnapshot {
  card: PendingMarkCard;
  /** 提交时该卡在队列中的下标（撤销插回原位） */
  index: number;
  /** 提交前该题已保存的评语（null = 无）——撤销时用它恢复 */
  comment: string | null;
}

/** 评语框 → 归一化提交值（与契约口径一致：trim 后空串按 null） */
function normalizeComment(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** 快捷键说明（页头一行；桌面键盘用，按钮为 iPad 等触屏等效入口） */
function ShortcutHints() {
  const entries = [
    { keys: ["J"], label: "下一题" },
    { keys: ["K"], label: "上一题" },
    { keys: ["1"], label: "标对" },
    { keys: ["2"], label: "标错" },
    { keys: ["0"], label: "清除判定" },
    { keys: ["U"], label: "撤销上一题" },
  ] as const;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {entries.map(({ keys, label }) => (
        <span key={label} className="flex items-center gap-1">
          {keys.map((key) => (
            <kbd
              key={key}
              className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono"
            >
              {key}
            </kbd>
          ))}
          {label}
        </span>
      ))}
      <span className="text-muted-foreground/80">（输入框聚焦时不触发）</span>
    </p>
  );
}

/** 待批队列筛选条（课程/作业/学生下拉；变化写回 URL） */
function QueueFilters({
  courseId,
  assignmentId,
  studentId,
  courses,
  assignments,
  students,
  listsPending,
  onPatch,
  onReset,
}: {
  courseId: string | null;
  assignmentId: string | null;
  studentId: string | null;
  courses: { id: string; title: string }[];
  assignments: { id: string; title: string }[];
  students: { id: string; displayName: string }[];
  /** 三个选项列表任一在加载中（显示「筛选选项加载中」提示，不阻塞） */
  listsPending: boolean;
  onPatch: (patch: {
    courseId?: string | null;
    assignmentId?: string | null;
    studentId?: string | null;
  }) => void;
  onReset: () => void;
}) {
  const hasFilter =
    courseId !== null || assignmentId !== null || studentId !== null;
  const selectClass =
    "min-h-11 rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="pending-course-filter" className="text-sm">
          课程
        </label>
        <select
          id="pending-course-filter"
          className={selectClass}
          value={courseId ?? ""}
          onChange={(e) =>
            onPatch({
              courseId: e.target.value === "" ? null : e.target.value,
            })
          }
        >
          <option value="">全部课程</option>
          {courses.map((course) => (
            <option key={course.id} value={course.id}>
              {course.title}
            </option>
          ))}
        </select>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="pending-assignment-filter" className="text-sm">
          作业
        </label>
        <select
          id="pending-assignment-filter"
          className={selectClass}
          value={assignmentId ?? ""}
          onChange={(e) =>
            onPatch({
              assignmentId: e.target.value === "" ? null : e.target.value,
            })
          }
        >
          <option value="">全部作业</option>
          {assignments.map((assignment) => (
            <option key={assignment.id} value={assignment.id}>
              {assignment.title}
            </option>
          ))}
        </select>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="pending-student-filter" className="text-sm">
          学生
        </label>
        <select
          id="pending-student-filter"
          className={selectClass}
          value={studentId ?? ""}
          onChange={(e) =>
            onPatch({
              studentId: e.target.value === "" ? null : e.target.value,
            })
          }
        >
          <option value="">全部学生</option>
          {students.map((student) => (
            <option key={student.id} value={student.id}>
              {student.displayName}
            </option>
          ))}
        </select>
      </div>

      {listsPending && (
        <p className="text-sm text-muted-foreground">筛选选项加载中…</p>
      )}
      {hasFilter && (
        <Button variant="outline" className="min-h-11" onClick={onReset}>
          <RotateCcw aria-hidden />
          清除筛选
        </Button>
      )}
    </div>
  );
}

/** 手写笔迹缩略图（懒加载 + 点击放大；放大层与详情页共用 InkLightbox） */
function QueueInkThumbnail({
  card,
  onZoomChange,
}: {
  card: PendingMarkCard;
  onZoomChange: (zoomed: boolean) => void;
}) {
  const ink = card.ink;
  const [zoomed, setZoomed] = useState(false);
  const [available, setAvailable] = useState(true);
  if (ink === null || !available) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        <PenLine aria-hidden className="size-4" />
        手写笔迹
        {!ink.hasStrokes && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
            有笔迹记录但无笔画
          </span>
        )}
      </p>
      <button
        type="button"
        className="min-h-11 w-full rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label={`放大查看 ${card.studentName} 这道题的手写笔迹`}
        onClick={() => {
          setZoomed(true);
          onZoomChange(true);
        }}
      >
        <img
          src={ink.pngUrl}
          alt={`${card.studentName} 这道题的手写笔迹`}
          loading="lazy"
          className="w-full rounded-lg border border-border bg-white"
          onError={() => setAvailable(false)}
        />
      </button>
      {zoomed && (
        <InkLightbox
          pngUrl={ink.pngUrl}
          alt={`${card.studentName} 这道题的手写笔迹`}
          onClose={() => {
            setZoomed(false);
            onZoomChange(false);
          }}
        />
      )}
    </div>
  );
}

/** 单张待批卡片：来源上下文 + 题干/选项 + 参考答案/学生答案 + 笔迹 +
 * 行为统计 + 批改操作区（判定按钮与快捷键同款） */
function PendingCard({
  card,
  position,
  commentValue,
  markPending,
  onCommentChange,
  onMark,
  onClear,
  onSaveComment,
  onZoomChange,
}: {
  card: PendingMarkCard;
  /** 当前是剩余中的第几张（批改会话内定位） */
  position: { index: number; total: number };
  commentValue: string;
  /** 本题提交中（按钮防重复点击） */
  markPending: boolean;
  onCommentChange: (value: string) => void;
  onMark: (mark: "correct" | "wrong") => void;
  onClear: () => void;
  onSaveComment: () => void;
  onZoomChange: (zoomed: boolean) => void;
}) {
  return (
    <article
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 text-card-foreground sm:p-5"
      aria-label={`待批卡片：${card.studentName}`}
    >
      {/* 来源上下文：学生 + 来源徽章/上下文 + 交卷时间 */}
      <header className="flex flex-col gap-1.5 border-b border-border pb-3">
        <p className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold">{card.studentName}</span>
          <span className="text-xs text-muted-foreground">
            第 {position.index} / {position.total} 张
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            交卷：{formatCnTime(card.submittedAt)}
          </span>
        </p>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
              card.sourceType === "assignment"
                ? "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300"
                : "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300",
            )}
          >
            {card.sourceType === "assignment" ? "作业" : "课程练习"}
          </span>
          <span className="min-w-0">{sourceContextOf(card)}</span>
        </p>
      </header>

      {/* 题型 / 难度 / 考点 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${QUESTION_TYPE_BADGE_CLASS[card.type]}`}
        >
          {QUESTION_TYPE_LABELS[card.type]}
        </span>
        <span
          role="img"
          className="text-xs text-amber-500"
          aria-label={`难度 ${card.difficulty} 星`}
        >
          {"★".repeat(card.difficulty)}
          <span className="text-muted-foreground/60">
            {"★".repeat(5 - card.difficulty)}
          </span>
        </span>
        {card.knowledge.map((name) => (
          <span
            key={name}
            className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
          >
            {name}
          </span>
        ))}
      </div>

      {/* 题干（快照原文）与选项 */}
      <RichMarkdown source={card.stemMd} className="text-base" />
      {card.options !== undefined && (
        <ol className="flex flex-col gap-1.5" aria-label="选项">
          {card.options.map((option, index) => (
            <li
              key={option}
              className="flex min-h-11 items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <span className="mt-0.5 w-5 shrink-0 font-semibold">
                {letterOf(index)}
              </span>
              <RichMarkdown
                source={option}
                className="min-w-0 flex-1 text-sm"
              />
            </li>
          ))}
        </ol>
      )}

      {/* 参考答案 + 学生最终答案（div：参考答案走 RichMarkdown 会产出块级 p，
          不能嵌在 <p> 里） */}
      <div className="flex flex-col gap-1.5 rounded-lg bg-muted/40 px-4 py-3 text-sm sm:flex-row sm:gap-6">
        <div className="flex min-w-0 flex-wrap gap-1.5">
          <span className="shrink-0 text-muted-foreground">参考答案：</span>
          {card.answers === null ? (
            <span className="font-medium">无标准答案（由你裁定）</span>
          ) : (
            <RichMarkdown
              source={formatReferenceAnswers(card.answers)}
              className="min-w-0 font-medium [&_p]:my-0"
            />
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className="shrink-0 text-muted-foreground">学生最终答案：</span>
          <span
            className={cn(
              "font-medium",
              card.answerText === null && "text-muted-foreground",
            )}
          >
            {card.answerText === null ? "未作答（仅笔迹）" : card.answerText}
          </span>
        </div>
      </div>

      {/* 手写笔迹（懒加载 + 点击放大） */}
      <QueueInkThumbnail card={card} onZoomChange={onZoomChange} />

      {/* 学习行为统计 */}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>用时 {formatActiveSec(card.activeSec)}</span>
        <span className="flex items-center gap-1">
          <Lightbulb aria-hidden className="size-3.5" />
          提示 {card.hintsUsed} 次
        </span>
        <span>改答 {card.changeCount} 次</span>
      </p>

      {/* 批改操作区：判定按钮（与快捷键同款）+ 评语框 */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-background/60 p-3">
        <div className="flex flex-wrap gap-2">
          <Button
            className="min-h-11 bg-emerald-600 px-6 hover:bg-emerald-700"
            disabled={markPending}
            onClick={() => onMark("correct")}
          >
            <Check aria-hidden />
            标对（1）
          </Button>
          <Button
            variant="destructive"
            className="min-h-11 px-6"
            disabled={markPending}
            onClick={() => onMark("wrong")}
          >
            <X aria-hidden />
            标错（2）
          </Button>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={markPending}
            onClick={onClear}
          >
            清除判定（0）
          </Button>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="pending-comment-input" className="text-sm">
            评语（标对 / 标错 / 清除判定时会带上当前内容一并提交）
          </label>
          <textarea
            id="pending-comment-input"
            className="min-h-22 rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            maxLength={TEACHER_COMMENT_MAX}
            rows={3}
            value={commentValue}
            placeholder="写给学生的批改评语（可不填）"
            onChange={(e) => onCommentChange(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            className="min-h-11"
            disabled={markPending}
            onClick={onSaveComment}
          >
            保存评语
          </Button>
          {markPending && (
            <span className="text-sm text-muted-foreground">提交中…</span>
          )}
        </div>
      </div>
    </article>
  );
}

export function PendingMarkQueuePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const courseId = searchParams.get("courseId");
  const assignmentId = searchParams.get("assignmentId");
  const studentId = searchParams.get("studentId");

  const params = useMemo<PendingMarkListParams>(
    () => ({
      ...(courseId !== null ? { courseId } : {}),
      ...(assignmentId !== null ? { assignmentId } : {}),
      ...(studentId !== null ? { studentId } : {}),
    }),
    [courseId, assignmentId, studentId],
  );

  const marksQuery = usePendingMarks(params);
  // 筛选选项（加载失败不阻塞页面——下拉只显示「全部 xx」）
  const coursesQuery = useTeacherCourses(false);
  const assignmentsQuery = useTeacherAssignments(undefined, false);
  const studentsQuery = useStudents(true);
  const markMutation = useMarkResponse();

  // ---------- 本地队列（进入 / 切换筛选时从服务端数据初始化一次） ----------
  const [queue, setQueue] = useState<PendingMarkCard[]>([]);
  /** y：进入（或切换筛选）时的队列总数；批改与撤销只动队列不动它 */
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [undoState, setUndoState] = useState<UndoSnapshot | null>(null);
  /** 评语框草稿（responseId → 文本） */
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>(
    {},
  );
  /** 各题最近一次已保存的评语（撤销恢复原值用；null = 无评语） */
  const [savedComments, setSavedComments] = useState<
    Record<string, string | null>
  >({});
  const [actionError, setActionError] = useState<string | null>(null);
  /** 笔迹放大层打开时禁用快捷键 */
  const [inkZoomed, setInkZoomed] = useState(false);

  const queryClient = useQueryClient();

  // 服务端数据 → 本地工作副本：只在「新参数的数据到达」时同步一次
  // （进入或切换筛选）；同参数的后台重取不打断本地连续批改。params 是
  // useMemo 产物，筛选值不变则引用稳定。
  const data = marksQuery.data;
  const [syncedParams, setSyncedParams] =
    useState<PendingMarkListParams | null>(null);
  if (data !== undefined && params !== syncedParams) {
    setSyncedParams(params);
    setQueue(data.marks);
    setTotal(data.marks.length);
    setCursor(0);
    setUndoState(null);
  }

  const current = queue[cursor] ?? null;
  const done = total - queue.length;
  const commentOf = (responseId: string): string =>
    commentDrafts[responseId] ?? "";

  /** 提交批注并维护本地队列（D3：判定与评语两字段一次提交） */
  function runMark(
    card: PendingMarkCard,
    request: { mark: "correct" | "wrong" | null; comment: string },
    options: { removal: boolean; removeIndex: number; undo?: UndoSnapshot },
  ): void {
    if (options.removal) {
      // 乐观离队（标对/标错）；失败在 onError 插回原位
      setQueue((prev) =>
        prev.filter((item) => item.responseId !== card.responseId),
      );
      setCursor((prev) => Math.min(prev, Math.max(0, queue.length - 2)));
      if (options.undo !== undefined) setUndoState(options.undo);
    }
    markMutation.mutate(
      {
        responseId: card.responseId,
        mark: request.mark,
        comment: request.comment,
      },
      {
        onSuccess: () => {
          setActionError(null);
          setSavedComments((prev) => ({
            ...prev,
            [card.responseId]: normalizeComment(request.comment),
          }));
        },
        onError: (err: Error) => {
          setActionError(
            `「${card.studentName}」这道题批改未保存：${
              err instanceof Error ? err.message : "网络异常，请重试"
            }`,
          );
          if (options.removal) {
            // 回滚：插回原位，撤销快照作废
            setQueue((prev) => {
              const index = Math.min(options.removeIndex, prev.length);
              const next = [...prev];
              next.splice(index, 0, card);
              return next;
            });
            setCursor(
              Math.min(options.removeIndex, Math.max(0, queue.length - 1)),
            );
            if (options.undo !== undefined) setUndoState(null);
          }
        },
      },
    );
  }

  /** 标对/标错（快捷键 1/2 与按钮共用）：乐观离队 + 记录撤销快照 */
  function gradeCurrent(mark: "correct" | "wrong"): void {
    const card = current;
    if (card === null) return;
    // 撤销快照：队列题原判定恒 null；原评语 = 本会话最近保存值
    const snapshot: UndoSnapshot = {
      card,
      index: cursor,
      comment: savedComments[card.responseId] ?? null,
    };
    runMark(
      card,
      { mark, comment: commentOf(card.responseId) },
      { removal: true, removeIndex: cursor, undo: snapshot },
    );
  }

  /** 清除判定（快捷键 0）：待批题 autoCorrect 为 null → 仍待批，卡片保留 */
  function clearCurrent(): void {
    const card = current;
    if (card === null) return;
    runMark(
      card,
      { mark: null, comment: commentOf(card.responseId) },
      { removal: false, removeIndex: cursor },
    );
  }

  /** 评语单独保存（把当前判定一并带上——待批题即 null） */
  function saveComment(): void {
    clearCurrent();
  }

  /** 撤销上一题（快捷键 U）：用原值再调一次 mark 恢复，并把该题插回队列原位 */
  function undoLast(): void {
    if (undoState === null) return;
    const { card, index, comment } = undoState;
    setUndoState(null);
    // 乐观插回原位
    setQueue((prev) => {
      const at = Math.min(index, prev.length);
      const next = [...prev];
      next.splice(at, 0, card);
      return next;
    });
    setCursor(Math.min(index, queue.length));
    markMutation.mutate(
      { responseId: card.responseId, mark: null, comment },
      {
        onSuccess: () => {
          setActionError(null);
          setSavedComments((prev) => ({ ...prev, [card.responseId]: comment }));
          setCommentDrafts((prev) => ({
            ...prev,
            [card.responseId]: comment ?? "",
          }));
        },
        onError: (err: Error) => {
          setActionError(
            `撤销未成功：${err instanceof Error ? err.message : "网络异常，请重试"}`,
          );
          // 撤销失败：该题仍是已批状态，不留队列；恢复快照供再次尝试
          setQueue((prev) =>
            prev.filter((item) => item.responseId !== card.responseId),
          );
          setUndoState({ card, index, comment });
        },
      },
    );
  }

  // ---------- 快捷键（输入框聚焦 / 笔迹放大时不触发；ref 每渲染刷新防过期闭包） ----------
  const onKey = (event: KeyboardEvent): void => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (inkZoomed) return;
    switch (event.key.toLowerCase()) {
      case "j":
        setCursor((prev) => Math.min(prev + 1, Math.max(0, queue.length - 1)));
        break;
      case "k":
        setCursor((prev) => Math.max(prev - 1, 0));
        break;
      case "1":
        gradeCurrent("correct");
        break;
      case "2":
        gradeCurrent("wrong");
        break;
      case "0":
        clearCurrent();
        break;
      case "u":
        undoLast();
        break;
      default:
        break;
    }
  };
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => onKeyRef.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  /** 筛选变化：写回 URL query（数据到达后本地队列自然重建） */
  function applyPatch(patch: {
    courseId?: string | null;
    assignmentId?: string | null;
    studentId?: string | null;
  }): void {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) next.delete(key);
      else next.set(key, value);
    }
    void setSearchParams(next);
    // 让其它参数的队列缓存也标记过期（回到旧筛选时重新拉取）
    void queryClient.invalidateQueries({
      queryKey: ["teacher", "pending-marks"],
    });
  }

  function resetFilters(): void {
    applyPatch({ courseId: null, assignmentId: null, studentId: null });
  }

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-6 md:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold">待批队列</h1>
          <p className="text-sm text-muted-foreground">
            按交卷时间先后逐题批改（手写题与无标准答案题）；进度与撤销只统计本次进入后的操作。
          </p>
          <ShortcutHints />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="min-h-11" asChild>
            <Link to="/t/data">返回数据页</Link>
          </Button>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={undoState === null}
            onClick={undoLast}
          >
            <Undo2 aria-hidden />
            撤销上一题（U）
          </Button>
        </div>
      </header>

      {/* 批改进度（x = 本地已处理；y = 进入时队列总数） */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-3">
        <p aria-live="polite" className="text-sm font-medium">
          批改进度{" "}
          <span
            data-testid="mark-progress"
            className="font-semibold text-primary"
          >
            {done}/{total}
          </span>
        </p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock3 aria-hidden className="size-3.5" />
          剩余 {queue.length} 张卡片，先交先批
        </p>
      </div>

      <QueueFilters
        courseId={courseId}
        assignmentId={assignmentId}
        studentId={studentId}
        courses={
          coursesQuery.data !== undefined
            ? coursesQuery.data.courses.map((course) => ({
                id: course.id,
                title: course.name,
              }))
            : []
        }
        assignments={assignmentsQuery.data?.assignments ?? []}
        students={studentsQuery.data?.students ?? []}
        listsPending={
          coursesQuery.isPending ||
          assignmentsQuery.isPending ||
          studentsQuery.isPending
        }
        onPatch={applyPatch}
        onReset={resetFilters}
      />

      {actionError !== null && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      {marksQuery.isPending && (
        <div
          role="status"
          aria-label="正在加载待批队列"
          className="flex flex-col gap-3"
        >
          <div className="h-40 animate-pulse rounded-xl border border-border bg-muted/50" />
          <p className="text-sm text-muted-foreground">正在加载待批队列…</p>
        </div>
      )}

      {marksQuery.isError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            待批队列加载失败
          </p>
          <p className="text-sm text-muted-foreground">
            {marksQuery.error instanceof Error
              ? marksQuery.error.message
              : "网络异常，请稍后重试"}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => void marksQuery.refetch()}
          >
            重试
          </Button>
        </div>
      )}

      {data !== undefined &&
        (current === null ? (
          total === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
              <p className="text-sm font-medium">没有待批题</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                学生交卷后，手写题与无标准答案的题会出现在这里等待批改。
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
              <p className="text-sm font-medium">本组待批题已全部批完</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                共 {total} 题，批改进度 {done}/{total}
                {undoState !== null && "；如需改回，可按 U 撤销上一题。"}
              </p>
              <Button variant="outline" className="min-h-11" asChild>
                <Link to="/t/data">去数据页核对</Link>
              </Button>
            </div>
          )
        ) : (
          <PendingCard
            key={current.responseId}
            card={current}
            position={{ index: cursor + 1, total: queue.length }}
            commentValue={commentOf(current.responseId)}
            markPending={
              markMutation.isPending &&
              markMutation.variables?.responseId === current.responseId
            }
            onCommentChange={(value) =>
              setCommentDrafts((prev) => ({
                ...prev,
                [current.responseId]: value,
              }))
            }
            onMark={gradeCurrent}
            onClear={clearCurrent}
            onSaveComment={saveComment}
            onZoomChange={setInkZoomed}
          />
        ))}
    </section>
  );
}

// 供 App.tsx 路由级懒加载
export default PendingMarkQueuePage;

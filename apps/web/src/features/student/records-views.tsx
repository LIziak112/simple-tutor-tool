import type {
  AttemptSource,
  AttemptStatus,
  StudentRecordRow,
  TeacherAttemptSource,
} from "@tutor/contract";
import { ChevronLeft, ChevronRight, Clock3 } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "@/lib/time";

/**
 * /s/records 我的记录列表的卡片与分页（T3.5，D10）：
 * - 卡片：来源徽章（作业/课程练习）、来源上下文（作业标题或「单元标题 ·
 *   第 n 次」+ 课程名）、状态徽章（进行中/已交卷/已批改）、待批徽章、得分
 *   （服务端已按 scoreFinal ?? scoreAuto 口径下发；未公布显示「待公布」）、
 *   最近活动时间；整卡为触控目标（≥44px）；
 * - 点击：已交/已批 → /s/attempts/:attemptId（结果视图）；进行中 → 同一
 *   路由（AttemptSession 按 status 分支进答题视图，即「继续作答」）。
 */

/** 状态中文（与教师数据页同词表） */
export const RECORD_STATUS_LABELS: Record<AttemptStatus, string> = {
  draft: "进行中",
  submitted: "已交卷",
  graded: "已批改",
};

/** 状态徽章配色：进行中实心蓝（显著），已交琥珀、已批绿 */
const STATUS_BADGE_CLASS: Record<AttemptStatus, string> = {
  draft: "bg-sky-500 font-medium text-white",
  submitted:
    "bg-amber-500/15 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  graded:
    "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
};

/** 状态徽章（列表卡片用） */
function RecordStatusBadge({ status }: { status: AttemptStatus }) {
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs ${STATUS_BADGE_CLASS[status]}`}
    >
      {RECORD_STATUS_LABELS[status]}
    </span>
  );
}

/** 来源徽章配色：作业蓝、课程练习紫、错题重练橙（与教师数据页同配色词表） */
const SOURCE_BADGE_CLASS: Record<AttemptSource, string> = {
  assignment: "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300",
  course:
    "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300",
  wrong:
    "bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300",
};

/** 来源中文（作业 / 课程练习 / 错题重练；与教师数据页同词表） */
const SOURCE_LABELS: Record<AttemptSource, string> = {
  assignment: "作业",
  course: "课程练习",
  wrong: "错题重练",
};

/** 来源徽章（与教师数据页同配色） */
export function RecordSourceBadge({
  sourceType,
}: {
  sourceType: AttemptSource;
}) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${SOURCE_BADGE_CLASS[sourceType]}`}
    >
      {SOURCE_LABELS[sourceType]}
    </span>
  );
}

/**
 * 来源标题（行主标题）：作业 → 作业标题；课程练习 → 「单元标题 · 第 n 次」；
 * 错题重练 → 「错题重练 · 第 n 次」（2026-10）。与结果视图/教师端同口径
 * （teacherAttemptSourceSchema 的展示约定）。
 */
export function recordTitleOf(row: TeacherAttemptSource): string {
  if (row.sourceType === "assignment") {
    return row.assignmentTitle ?? "（作业已删除）";
  }
  if (row.sourceType === "wrong") {
    return `错题重练 · 第 ${row.attemptNo} 次`;
  }
  return `${row.unitTitle ?? ""} · 第 ${row.attemptNo} 次`;
}

/**
 * 得分展示（D10）：服务端已按 scoreFinal ?? scoreAuto 口径算好 score——
 * - null 且未公布（answersReleased=false，after_due 未到截止）→ 「待公布」；
 * - null 且已公布 → 无可判分或全待批 → 「待批」；
 * - draft 不渲染得分（无结果可看）。
 */
function RecordScore({ row }: { row: StudentRecordRow }) {
  if (row.status === "draft") return null;
  if (row.score === null) {
    return row.answersReleased ? (
      <span className="text-sm text-muted-foreground">得分 待批</span>
    ) : (
      <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
        待公布
      </span>
    );
  }
  return (
    <span className="text-sm text-muted-foreground">
      得分 <b className="font-semibold text-foreground">{row.score}</b>
    </span>
  );
}

/** 单条记录卡片（整卡可点，触控目标 ≥44px） */
export function RecordCard({ row }: { row: StudentRecordRow }) {
  const activityAt = row.submittedAt ?? row.startedAt;
  const isDraft = row.status === "draft";
  return (
    <li>
      <Link
        to={`/s/attempts/${row.attemptId}`}
        aria-label={`${isDraft ? "继续作答" : "查看结果"}：${recordTitleOf(row)}（${RECORD_STATUS_LABELS[row.status]}）`}
        className="flex min-h-11 flex-col gap-1.5 rounded-xl border border-border bg-card px-4 py-3 text-card-foreground outline-none transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <p className="flex flex-wrap items-center gap-2">
          <RecordSourceBadge sourceType={row.sourceType} />
          <RecordStatusBadge status={row.status} />
          <span className="ml-auto text-xs text-muted-foreground">
            {formatRelativeTime(activityAt)}
          </span>
        </p>
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="min-w-0 truncate font-semibold">
            {recordTitleOf(row)}
          </span>
          {/* 课程名（作业挂课程配课程名；课程练习前置「课程：」） */}
          {row.courseName !== null && (
            <span className="min-w-0 truncate text-muted-foreground">
              {row.sourceType === "course"
                ? `课程：${row.courseName}`
                : `（${row.courseName}）`}
            </span>
          )}
        </p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <RecordScore row={row} />
          {/* 待批徽章（D4 口径；未公布时服务端置 null，不显示） */}
          {row.pendingCount !== null && row.pendingCount > 0 && (
            <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
              <Clock3 aria-hidden className="size-3" />
              待批 {row.pendingCount}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1 text-sm font-medium text-primary">
            {isDraft ? "继续作答" : "查看结果"}
          </span>
        </p>
      </Link>
    </li>
  );
}

/** 分页条（上一页/下一页 + 共 N 条；offset 分页，与教师数据页同交互） */
export function RecordsPagination({
  offset,
  limit,
  total,
  onOffsetChange,
}: {
  offset: number;
  limit: number;
  total: number;
  onOffsetChange: (offset: number) => void;
}) {
  const page = Math.floor(offset / limit) + 1;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;
  if (total <= limit && offset === 0) {
    // 单页且在第一页：只显示总数，不渲染翻页按钮
    return (
      <p aria-live="polite" className="text-sm text-muted-foreground">
        共 {total} 条记录
      </p>
    );
  }
  return (
    <nav
      aria-label="我的记录分页"
      className="flex flex-wrap items-center justify-between gap-3"
    >
      <p aria-live="polite" className="text-sm text-muted-foreground">
        共 {total} 条 · 第 {page} / {pageCount} 页
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          className="min-h-11"
          disabled={!hasPrev}
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}
        >
          <ChevronLeft aria-hidden />
          上一页
        </Button>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={!hasNext}
          onClick={() => onOffsetChange(offset + limit)}
        >
          下一页
          <ChevronRight aria-hidden />
        </Button>
      </div>
    </nav>
  );
}

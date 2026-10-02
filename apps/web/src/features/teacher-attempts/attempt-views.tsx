import type {
  AttemptSource,
  AttemptStatus,
  TeacherAttemptCard,
  TeacherAttemptSource,
} from "@tutor/contract";
import { ChevronLeft, ChevronRight, Clock3 } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "@/lib/time";
import type { AttemptViewMode } from "./attempt-filters";

/**
 * /t/data 列表的三视图分组渲染与卡片（T3.1，D6）：
 * - 同一份平铺列表（按最近活动时间倒序）在前端分组——按课程（默认；课程练习
 *   历次 + 该课程关联作业混排）/ 按作业（课程练习按单元单独成组）/ 按学生；
 * - 组与组内顺序都保持列表原序（倒序），组按「组内最近一次活动」出现；
 * - 卡片：学生名、来源徽章与上下文、题数、状态徽章（进行中显著）、得分
 *   （scoreFinal ?? scoreAuto，无分「—」）、待批数徽章、时间；整卡为触控目标
 *   （≥44px）跳详情 /t/data/attempts/:id。
 */

/** 状态中文（与作业名单徽章同词表） */
export const ATTEMPT_STATUS_LABELS: Record<AttemptStatus, string> = {
  draft: "进行中",
  submitted: "已交卷",
  graded: "已批改",
};

/**
 * 状态徽章配色：draft 用实心蓝（D5「进行中要显著」），submitted 琥珀、
 * graded 绿（与作业名单徽章配色同族）。
 */
const STATUS_BADGE_CLASS: Record<AttemptStatus, string> = {
  draft: "bg-sky-500 font-medium text-white",
  submitted: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  graded: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
};

/** 状态徽章（列表卡片与详情页头共用） */
export function AttemptStatusBadge({ status }: { status: AttemptStatus }) {
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs ${STATUS_BADGE_CLASS[status]}`}
    >
      {ATTEMPT_STATUS_LABELS[status]}
    </span>
  );
}

/** 来源徽章（作业 / 课程练习 / 错题重练；与学生端记录卡同配色词表） */
const SOURCE_BADGE_CLASS: Record<AttemptSource, string> = {
  assignment: "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300",
  course:
    "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300",
  wrong:
    "bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300",
};

function SourceBadge({ sourceType }: { sourceType: AttemptSource }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${SOURCE_BADGE_CLASS[sourceType]}`}
    >
      {sourceType === "assignment"
        ? "作业"
        : sourceType === "course"
          ? "课程练习"
          : "错题重练"}
    </span>
  );
}

/** 来源上下文描述（与详情页头同口径；T3.2b 起待批队列卡片共用） */
export function sourceContextOf(card: TeacherAttemptSource): string {
  if (card.sourceType === "assignment") {
    // 挂课程时配课程名；未挂课程只显示作业标题
    return card.courseName !== null
      ? `${card.assignmentTitle ?? ""}（${card.courseName}）`
      : (card.assignmentTitle ?? "");
  }
  if (card.sourceType === "wrong") {
    return `错题重练 · 第 ${card.attemptNo} 次`;
  }
  return `${card.courseName ?? ""} · ${card.unitTitle ?? ""} · 第 ${card.attemptNo} 次`;
}

/** 展示得分（D2 口径：scoreFinal ?? scoreAuto；无分「—」） */
export function displayScoreOf(card: {
  scoreFinal: number | null;
  scoreAuto: number | null;
}): string {
  const score = card.scoreFinal ?? card.scoreAuto;
  return score === null ? "—" : String(score);
}

/** 分组键与组标题（按视图；不依赖列表顺序的纯映射） */
function groupOf(
  card: TeacherAttemptCard,
  view: AttemptViewMode,
): { key: string; title: string } {
  if (view === "student") {
    return { key: card.studentId, title: card.studentName };
  }
  if (view === "assignment") {
    // 作业来源按作业分组；课程练习按「课程 · 单元」单独成组（不属于任何作业）；
    // 错题重练无作业归属，统一进「错题重练」组（2026-10）
    if (card.sourceType === "assignment") {
      return {
        key: `a:${card.assignmentId ?? ""}`,
        title: card.assignmentTitle ?? "（作业已删除）",
      };
    }
    if (card.sourceType === "wrong") {
      return { key: "w:wrong", title: "错题重练" };
    }
    return {
      key: `c:${card.courseId ?? ""}:${card.unitId ?? ""}`,
      title: `课程练习 · ${card.unitTitle ?? ""}`,
    };
  }
  // 按课程：未挂课程的作业进「未挂课程」组
  return {
    key: card.courseId ?? "none",
    title: card.courseName ?? "未挂课程的作业",
  };
}

/** 单张作答卡片（整卡可点，触控目标 ≥44px） */
function AttemptCard({ card }: { card: TeacherAttemptCard }) {
  const activityAt = card.submittedAt ?? card.startedAt;
  return (
    <li>
      <Link
        to={`/t/data/attempts/${card.attemptId}`}
        aria-label={`查看 ${card.studentName} 的作答详情（${ATTEMPT_STATUS_LABELS[card.status]}）`}
        className="flex min-h-11 flex-col gap-1.5 rounded-xl border border-border bg-card px-4 py-3 text-card-foreground outline-none transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <p className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{card.studentName}</span>
          <AttemptStatusBadge status={card.status} />
          <span className="ml-auto text-xs text-muted-foreground">
            {formatRelativeTime(activityAt)}
          </span>
        </p>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <SourceBadge sourceType={card.sourceType} />
          <span className="min-w-0 truncate">{sourceContextOf(card)}</span>
        </p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>{card.questionCount} 题</span>
          <span>
            得分{" "}
            <b className="font-semibold text-foreground">
              {displayScoreOf(card)}
            </b>
          </span>
          {card.pendingCount > 0 && (
            <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
              <Clock3 aria-hidden className="size-3" />
              待批 {card.pendingCount}
            </span>
          )}
        </p>
      </Link>
    </li>
  );
}

/** 三视图分组渲染（组与组内顺序保持传入的倒序） */
export function AttemptGroupedList({
  attempts,
  view,
}: {
  attempts: TeacherAttemptCard[];
  view: AttemptViewMode;
}) {
  // 首次出现顺序即组序（列表倒序 → 组按组内最近活动排列）
  const groups: { key: string; title: string; cards: TeacherAttemptCard[] }[] =
    [];
  const byKey = new Map<
    string,
    { key: string; title: string; cards: TeacherAttemptCard[] }
  >();
  for (const card of attempts) {
    const group = groupOf(card, view);
    let bucket = byKey.get(group.key);
    if (bucket === undefined) {
      bucket = { ...group, cards: [] };
      byKey.set(group.key, bucket);
      groups.push(bucket);
    }
    bucket.cards.push(card);
  }
  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <section
          key={group.key}
          aria-label={group.title}
          className="flex flex-col gap-2"
        >
          <h2 className="flex items-center gap-2 border-b border-border pb-1.5 text-sm font-semibold text-muted-foreground">
            {group.title}
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal">
              {group.cards.length} 条
            </span>
          </h2>
          <ul className="flex flex-col gap-2">
            {group.cards.map((card) => (
              <AttemptCard key={card.attemptId} card={card} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** 分页条（上一页/下一页 + 共 N 条；作用于底层数据的 offset 分页） */
export function AttemptListPagination({
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
        共 {total} 条
      </p>
    );
  }
  return (
    <nav
      aria-label="作答列表分页"
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

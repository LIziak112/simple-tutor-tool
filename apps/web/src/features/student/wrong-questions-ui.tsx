import type { WrongQuestionCard } from "@tutor/contract";
import { cn } from "cn";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { CheckCircle2, ChevronDown, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SolutionFold } from "@/features/attempt/AttemptResultView";
import {
  formatReferenceAnswers,
  letterOf,
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
  stemWithoutOptionList,
} from "@/features/attempt/answer-format";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { DISPLAY_TZ, formatRelativeTime } from "@/lib/time";
import { RecordSourceBadge, recordTitleOf } from "./records-views";

// 与 lib/time.ts 同一 dayjs 单例（extend 幂等；本文件分组函数独立可用）
dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * /s/wrong 错题本的 URL 状态、分组与卡片（T3.5，D11；2026-10 升为一级路由；
 * 2026-10 轮次史改版）：
 * - 页面统一拉全量形态（includeResolved=true）一次，「待复习/已攻克」tab 与
 *   分组维度全部本地计算；tab 与分组维度同步 URL query（刷新、返回不丢）；
 * - 旧 URL 参数兼容：includeResolved=true 映射为 tab=conquered（旧「显示已
 *   攻克」开关的书签/深链不丢语义）；旧 knowledge 筛选被「按考点」分组取代，
 *   忽略不报错；
 * - 条目默认紧凑行（题型徽章 + 题干纯文本摘要 + 错 N 次 + 最近一轮 ✓/✗ +
 *   相对时间），点击行展开完整卡片；
 * - 展开卡：题干（快照 RichMarkdown 渲染，[[答案]] 标记渲染为空框）、本人
 *   最近答案、正确答案、详解折叠（共用结果视图的 SolutionFold）、首次是否
 *   做对标记、轮次史区块（已做错 N 次 · 做对 M 次 + 每轮一行）、最近来源。
 */

/** 错题本页 tab（成员由本地攻克标准从 rounds 计算） */
export type WrongTab = "pending" | "conquered";

/** 分组维度 */
export type WrongGroupMode = "unit" | "time" | "knowledge";

/** 错题本页 URL 状态（单一事实来源是 URL query） */
export interface WrongQuestionsUrlState {
  tab: WrongTab;
  group: WrongGroupMode;
}

/** 默认状态（待复习 + 按练习分组） */
export const DEFAULT_WRONG_QUESTIONS_URL_STATE: WrongQuestionsUrlState = {
  tab: "pending",
  group: "unit",
};

/**
 * URLSearchParams → 页面状态。
 * 兼容（2026-10 改版前的旧参数，见模块头注释）：includeResolved=true →
 * tab=conquered；knowledge 忽略（被「按考点」分组取代）；非法值回默认。
 */
export function parseWrongQuestionsUrl(
  search: URLSearchParams,
): WrongQuestionsUrlState {
  const group = search.get("group");
  return {
    tab:
      search.get("tab") === "conquered" ||
      search.get("includeResolved") === "true"
        ? "conquered"
        : "pending",
    group: group === "time" || group === "knowledge" ? group : "unit",
  };
}

/** 页面状态 → URLSearchParams（只写非默认项，保持地址干净） */
export function wrongQuestionsUrlQuery(
  state: WrongQuestionsUrlState,
): URLSearchParams {
  const params = new URLSearchParams();
  if (state.tab !== DEFAULT_WRONG_QUESTIONS_URL_STATE.tab) {
    params.set("tab", state.tab);
  }
  if (state.group !== DEFAULT_WRONG_QUESTIONS_URL_STATE.group) {
    params.set("group", state.group);
  }
  return params;
}

// ---------- 分组 ----------

/** 分组结果（组内条目按 lastAt 倒序——入参即服务端排序，逐组保序收集） */
export interface WrongQuestionGroup {
  /** 组键（单元 id / 时间桶 key / 考点名） */
  key: string;
  /** 组头标题（单元标题 / 本周 / 考点名） */
  title: string;
  /** 组内题目（lastAt 倒序） */
  questions: WrongQuestionCard[];
}

/** 时间桶（按 lastAt 相对今天，显示时区 Asia/Shanghai 的自然周/自然月） */
interface TimeBucket {
  key: string;
  title: string;
  /** 展示顺序（小在前） */
  rank: number;
}

/** lastAt → 时间桶：本周（本周一起）/ 上周 / 本月（本月 1 日起）/ 更早 */
function timeBucketOf(lastAt: string, now: Date): TimeBucket {
  const time = dayjs.utc(lastAt).tz(DISPLAY_TZ);
  const today = dayjs(now).tz(DISPLAY_TZ).startOf("day");
  // 周一为一周起点（dayjs startOf("week") 受 locale 影响，显式计算更稳）
  const thisMonday = today.subtract((today.day() + 6) % 7, "day");
  if (!time.isBefore(thisMonday))
    return { key: "this-week", title: "本周", rank: 0 };
  const lastMonday = thisMonday.subtract(7, "day");
  if (!time.isBefore(lastMonday))
    return { key: "last-week", title: "上周", rank: 1 };
  if (!time.isBefore(today.startOf("month"))) {
    return { key: "this-month", title: "本月", rank: 2 };
  }
  return { key: "earlier", title: "更早", rank: 3 };
}

/** 组头最新活动时间（组排序用：最近活跃的组在前） */
function latestAtOf(group: WrongQuestionGroup): string {
  return group.questions[0]?.lastAt ?? "";
}

/**
 * 按维度分组当前 tab 的条目（组内保持 lastAt 倒序）：
 * - unit：按题目归属单元（originUnitId；null 落「未归类」组）——历史合并作业
 *   里的错题也按题挂回各自单元；
 * - time：本周 / 上周 / 本月 / 更早（固定顺序，空桶不显示）；
 * - knowledge：按考点分组。**取第一考点归组**（一道题多考点时只出现在第一个
 *   考点组，避免同题重复出现在多组——考点完整清单仍在展开卡内展示）。
 */
export function groupWrongQuestions(
  questions: WrongQuestionCard[],
  mode: WrongGroupMode,
  now: Date = new Date(),
): WrongQuestionGroup[] {
  if (mode === "time") {
    const byBucket = new Map<
      string,
      WrongQuestionGroup & { bucket: TimeBucket }
    >();
    for (const question of questions) {
      const bucket = timeBucketOf(question.lastAt, now);
      const group = byBucket.get(bucket.key) ?? {
        key: bucket.key,
        title: bucket.title,
        questions: [],
        bucket,
      };
      group.questions.push(question);
      byBucket.set(bucket.key, group);
    }
    return [...byBucket.values()]
      .sort((a, b) => a.bucket.rank - b.bucket.rank)
      .map(({ bucket: _bucket, ...group }) => group);
  }
  const byKey = new Map<string, WrongQuestionGroup>();
  for (const question of questions) {
    const key =
      mode === "unit"
        ? (question.originUnitId ?? "")
        : (question.knowledge[0] ?? "");
    const title =
      mode === "unit"
        ? (question.originUnitTitle ?? "未归类")
        : (question.knowledge[0] ?? "未标注考点");
    const group = byKey.get(key) ?? { key, title, questions: [] };
    group.questions.push(question);
    byKey.set(key, group);
  }
  // 组间按最近活跃倒序（同刻按组头标题稳定兜底）
  return [...byKey.values()].sort(
    (a, b) =>
      latestAtOf(b).localeCompare(latestAtOf(a)) ||
      a.title.localeCompare(b.title, "zh"),
  );
}

/** tab 的组头计数文案（当前 tab 口径） */
export function groupCountLabel(tab: WrongTab, count: number): string {
  return tab === "pending" ? `待复习 ${count} 题` : `已攻克 ${count} 题`;
}

// ---------- 紧凑行 ----------

/**
 * 题干纯文本摘要（单行截断预览）：[[答案]] 标记替换为空框（绝不显示答案原文），
 * 指令围栏与强调记号剥除、公式取内文（LaTeX 命令保留原文——预览不求精美，
 * 完整渲染看展开卡）。仅为行内预览口径。
 */
export function stemSummaryOf(stemMd: string): string {
  return (
    stemWithoutOptionList(stemMd)
      .replace(/\[\[[^\]]*\]\]/g, "（　）")
      .replace(/:::+[a-zA-Z-]*/g, " ")
      .replace(/\$\$?([^$]+)\$\$?/g, "$1")
      .replace(/[*_`>#~]/g, "")
      // 只折叠 ASCII 空白（\s 会把全角空格 U+3000 一并折叠，破坏「（　）」空框）
      .replace(/[ \t\r\n]+/g, " ")
      .trim()
  );
}

/**
 * 单条错题紧凑行（默认形态；点击展开完整卡片）。触控 ≥44px。
 */
export function WrongQuestionRow({
  question,
  expanded,
  onToggle,
}: {
  question: WrongQuestionCard;
  expanded: boolean;
  onToggle: () => void;
}) {
  const lastRound = question.rounds[question.rounds.length - 1];
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className={cn(
        "flex min-h-12 w-full items-center gap-x-3 gap-y-1 rounded-2xl border bg-card px-4 py-2.5 text-left text-card-foreground shadow-xs outline-none transition-colors hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50",
        expanded ? "border-primary/50 bg-accent/40" : "border-border",
      )}
    >
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${QUESTION_TYPE_BADGE_CLASS[question.type]}`}
      >
        {QUESTION_TYPE_LABELS[question.type]}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">
        {stemSummaryOf(question.stemMd)}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        错 {question.wrongCount} 次
      </span>
      {lastRound !== undefined &&
        (lastRound.correct ? (
          <CheckCircle2
            aria-label="最近一轮做对"
            className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
          />
        ) : (
          <XCircle
            aria-label="最近一轮做错"
            className="size-4 shrink-0 text-red-600 dark:text-red-400"
          />
        ))}
      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
        {formatRelativeTime(question.lastAt)}
      </span>
      <ChevronDown
        aria-hidden
        className={cn(
          "size-4 shrink-0 text-muted-foreground transition-transform",
          expanded && "rotate-180",
        )}
      />
    </button>
  );
}

// ---------- 展开卡（沿用旧卡片 + 轮次史区块） ----------

/** 首次是否做对标记（最早一次已判定作答；D11 条目标注） */
function FirstCorrectMark({ firstCorrect }: { firstCorrect: boolean }) {
  return firstCorrect ? (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
      <CheckCircle2 aria-hidden className="size-3" />
      首次做对
    </span>
  ) : (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-300">
      <XCircle aria-hidden className="size-3" />
      首次做错
    </span>
  );
}

/**
 * 轮次史区块（2026-10）：「已做错 N 次 · 做对 M 次」汇总 + 每轮一行
 * （第 k 轮 ✓/✗ · 相对时间 · 来源标题）。攻克判定由端上按学生自选标准
 * 从本区块的原料（rounds）计算，服务端不下发规则。
 */
function RoundsHistory({ question }: { question: WrongQuestionCard }) {
  return (
    <section
      aria-label="轮次史"
      className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 px-4 py-3"
    >
      <p className="text-sm font-medium">
        已做错 {question.wrongCount} 次 · 做对 {question.correctCount} 次
      </p>
      <ol className="flex flex-col gap-1.5">
        {question.rounds.map((round, index) => (
          <li
            key={round.attemptId}
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground"
          >
            <span className="font-medium text-foreground">
              第 {index + 1} 轮
            </span>
            {round.correct ? (
              <span className="flex shrink-0 items-center gap-1 font-medium text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 aria-hidden className="size-3.5" />
                做对
              </span>
            ) : (
              <span className="flex shrink-0 items-center gap-1 font-medium text-red-700 dark:text-red-300">
                <XCircle aria-hidden className="size-3.5" />
                做错
              </span>
            )}
            <span className="shrink-0">
              {formatRelativeTime(round.submittedAt)}
            </span>
            <span className="min-w-0 truncate">
              {round.sourceTitle}
              {round.courseName !== null && `（${round.courseName}）`}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** 选项列表（仅 choice/multi；正确项标记，本人选择不在此回显——答案是文本行） */
function WrongOptions({ question }: { question: WrongQuestionCard }) {
  const options = question.options;
  if (options === undefined) return null;
  const correct =
    question.answers?.kind === "choice"
      ? [question.answers.index]
      : question.answers?.kind === "multi"
        ? question.answers.indexes
        : [];
  return (
    <ol className="flex flex-col gap-1.5" aria-label="选项">
      {options.map((option, index) => {
        const isCorrect = correct.includes(index);
        return (
          <li
            key={option}
            className={cn(
              "flex min-h-11 items-start gap-2 rounded-lg border px-3 py-2 text-sm",
              isCorrect &&
                "border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10",
              !isCorrect && "border-transparent",
            )}
          >
            <span className="mt-0.5 w-5 shrink-0 font-semibold">
              {letterOf(index)}
            </span>
            <RichMarkdown source={option} className="min-w-0 flex-1 text-sm" />
            {isCorrect && (
              <span className="shrink-0 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                正确项
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** 单条错题完整卡片（紧凑行点击展开；待复习/已攻克两形态共用） */
export function WrongQuestionItem({
  question,
}: {
  question: WrongQuestionCard;
}) {
  return (
    <article className="flex flex-col gap-4 rounded-2xl border border-primary/30 bg-card p-4 text-card-foreground shadow-xs sm:p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <FirstCorrectMark firstCorrect={question.firstCorrect} />
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${QUESTION_TYPE_BADGE_CLASS[question.type]}`}
        >
          {QUESTION_TYPE_LABELS[question.type]}
        </span>
        <span
          role="img"
          className="text-xs text-amber-500"
          aria-label={`难度 ${question.difficulty} 星`}
        >
          {"★".repeat(question.difficulty)}
          <span className="text-muted-foreground/60">
            {"★".repeat(5 - question.difficulty)}
          </span>
        </span>
        {question.knowledge.map((name) => (
          <span
            key={name}
            className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
          >
            {name}
          </span>
        ))}
      </div>

      {/* 题干快照（[[答案]] 标记渲染为空框，答案在下方面板单独展示） */}
      <RichMarkdown
        source={
          question.options !== undefined
            ? stemWithoutOptionList(question.stemMd)
            : question.stemMd
        }
        className="text-base"
      />
      <WrongOptions question={question} />

      <div className="flex flex-col gap-1.5 rounded-lg bg-muted/40 px-4 py-3 text-sm sm:flex-row sm:gap-6">
        <p className="flex min-w-0 flex-wrap gap-1.5">
          <span className="shrink-0 text-muted-foreground">我的最近答案：</span>
          <span
            className={cn(
              "font-medium",
              question.answerText === null && "text-muted-foreground",
            )}
          >
            {question.answerText ?? "未作答"}
          </span>
        </p>
        {/* 正确答案走 RichMarkdown（裸 LaTeX 由 formatReferenceAnswers 显示侧
            包 $，与结果视图同一管线渲染） */}
        <div className="flex min-w-0 flex-wrap gap-1.5">
          <span className="shrink-0 text-muted-foreground">正确答案：</span>
          {question.answers === null ? (
            <span className="font-medium">由老师批改后公布</span>
          ) : (
            <RichMarkdown
              source={formatReferenceAnswers(question.answers)}
              className="min-w-0 font-medium [&_p]:my-0"
            />
          )}
        </div>
      </div>

      <SolutionFold solutionMd={question.solutionMd} />

      <RoundsHistory question={question} />

      <p className="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <RecordSourceBadge sourceType={question.sourceType} />
        <span className="min-w-0 truncate">
          最近来源：{recordTitleOf(question)}
          {question.courseName !== null && `（${question.courseName}）`}
        </span>
        <span className="ml-auto shrink-0">
          {formatRelativeTime(question.lastAt)}
        </span>
      </p>
    </article>
  );
}

// ---------- 页内控件 ----------

/**
 * 重练按钮（2026-10 错题重练入口；页头「重练全部」与组头「重练本组」共用）：
 * - 示数：按钮文案携带范围题数（「重练全部（N 题）」/「重练本组（x 题）」）；
 * - 0 题禁用（空 tab/空组示数但不发请求）；提交中 loading（旋转图标 + 「正在组卷…」）
 *   并禁用——防重复建卷；
 * - 组头用 compact 形态（小尺寸内边距，触控高度仍 ≥44px）。
 */
export function WrongPracticeButton({
  label,
  count,
  loading = false,
  compact = false,
  onPractice,
}: {
  /** 范围文案（重练全部 / 重练本组） */
  label: string;
  /** 范围内题数（示数与禁用判据） */
  count: number;
  /** 提交中（组卷请求进行时） */
  loading?: boolean;
  /** 组头紧凑形态 */
  compact?: boolean;
  onPractice: () => void;
}) {
  return (
    <Button
      variant={compact ? "outline" : "default"}
      className={compact ? "min-h-11 px-3" : "min-h-11 px-5"}
      disabled={count === 0 || loading}
      aria-label={
        count === 0
          ? `${label}（当前没有可重练的题）`
          : `${label}（${count} 题）`
      }
      onClick={onPractice}
    >
      <RotateCcw
        aria-hidden
        className={loading ? "size-4 animate-spin" : "size-4"}
      />
      {loading ? "正在组卷…" : `${label}（${count} 题）`}
    </Button>
  );
}

/** 分段控件按钮样式（灰底胶囊里的一段；选中白底主色字；触控 ≥44px） */
function segmentClass(active: boolean): string {
  return cn(
    "flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
    active
      ? "bg-card text-primary shadow-sm"
      : "text-muted-foreground hover:text-foreground",
  );
}

/** tab 分段控件（待复习/已攻克；aria-pressed 表当前，触控 ≥44px） */
export function WrongTabSwitch({
  tab,
  pendingCount,
  conqueredCount,
  onSelect,
}: {
  tab: WrongTab;
  pendingCount: number;
  conqueredCount: number;
  onSelect: (tab: WrongTab) => void;
}) {
  return (
    <fieldset
      aria-label="错题分区"
      className="flex items-center gap-1 rounded-xl bg-muted p-1"
    >
      <button
        type="button"
        className={segmentClass(tab === "pending")}
        aria-pressed={tab === "pending"}
        onClick={() => onSelect("pending")}
      >
        待复习 {pendingCount} 题
      </button>
      <button
        type="button"
        className={segmentClass(tab === "conquered")}
        aria-pressed={tab === "conquered"}
        onClick={() => onSelect("conquered")}
      >
        已攻克 {conqueredCount} 题
      </button>
    </fieldset>
  );
}

/** 分组维度分段控件（按练习/按时间/按考点；触控 ≥44px） */
export function WrongGroupSwitch({
  group,
  onSelect,
}: {
  group: WrongGroupMode;
  onSelect: (group: WrongGroupMode) => void;
}) {
  const options: Array<{ value: WrongGroupMode; label: string }> = [
    { value: "unit", label: "按练习" },
    { value: "time", label: "按时间" },
    { value: "knowledge", label: "按考点" },
  ];
  return (
    <fieldset
      aria-label="分组维度"
      className="flex items-center gap-1 rounded-xl bg-muted p-1"
    >
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={segmentClass(group === option.value)}
          aria-pressed={group === option.value}
          onClick={() => onSelect(option.value)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

import type { WrongQuestionCard } from "@tutor/contract";
import { displayStemMd } from "@tutor/md-dsl";
import { cn } from "cn";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  RotateCcw,
  X,
  XCircle,
} from "lucide-react";
import { Link } from "react-router";
import { SourceBadge } from "@/components/source-badge";
import { Button } from "@/components/ui/button";
import { SolutionFold } from "@/features/attempt/AttemptResultView";
import {
  formatReferenceAnswers,
  letterOf,
  QUESTION_TYPE_BADGE_CLASS,
  QUESTION_TYPE_LABELS,
} from "@/features/attempt/answer-format";
import { InlineMarkdown } from "@/features/markdown/InlineMarkdown";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { DISPLAY_TZ, formatCnTime } from "@/lib/time";
import { recordTitleOf } from "./records-views";

// 与 lib/time.ts 同一 dayjs 单例（extend 幂等；本文件分组函数独立可用）
dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * /s/wrong 错题本的 URL 状态、分组与卡片（T3.5，D11；2026-10 升为一级路由；
 * 2026-10 轮次史改版）：
 * - 页面统一拉全量形态（includeResolved=true）一次，「待复习/已攻克」tab、
 *   分组维度、课程筛选全部本地计算；tab 与分组维度同步 URL query（刷新、
 *   返回不丢）；
 * - 课程筛选（2026-10）：页头「课程」下拉（默认全部课程；选项 = 我的课程
 *   接口），选中课程 C 时保留 rounds 任一轮 courseId 命中 C 的题（错题重练
 *   轮恒 null 不参与命中）；课程选择同步 URL query（courseId）；
 * - 旧 URL 参数兼容：includeResolved=true 映射为 tab=conquered（旧「显示已
 *   攻克」开关的书签/深链不丢语义）；旧 knowledge 筛选被「按考点」分组取代，
 *   忽略不报错；
 * - 条目默认紧凑行（题型徽章 + 题干单行真渲染 + 错 N · 对 M + 最近一轮 ✓/✗
 *   + 绝对时间），点击行展开完整卡片。题干走 InlineMarkdown（与展开卡同一
 *   解析管线的单行收敛形态：公式 KaTeX、[[答案]] 空框、图片/表格占位、
 *   块级元素收成行内，由行容器 truncate 截断）——2026-10 修复 #6972 第 1 条
 *   「题目缩略未渲染」：此前用正则剥 Markdown 记号，公式只去掉 $ 留下
 *   \frac{1}{2} 原文、图片残留 ![…](…)、表格残留竖线；
 * - 展开卡：题干（快照 RichMarkdown 渲染，[[答案]] 标记渲染为空框）、本人
 *   最近答案、正确答案、详解折叠（共用结果视图的 SolutionFold）、首次是否
 *   做对标记、轮次史区块（已做错 N 次 · 做对 M 次 + 每轮一行可点回看该轮
 *   作答 + 待批轮差额提示）、最近来源。时间一律绝对时间（formatCnTime，
 *   Asia/Shanghai）。
 */

/** 错题本页 tab（成员由本地攻克标准从 rounds 计算） */
export type WrongTab = "pending" | "conquered";

/** 分组维度 */
export type WrongGroupMode = "unit" | "time" | "knowledge";

/** 时间筛选项（最近 N 个自然日，含今天；按 lastAt，Asia/Shanghai 自然日） */
export type WrongDaysFilter = 7 | 30 | 90;

/** 错次筛选项（wrongCount ≥ N） */
export type WrongMinFilter = 2 | 3;

/** 错题本页 URL 状态（单一事实来源是 URL query） */
export interface WrongQuestionsUrlState {
  tab: WrongTab;
  group: WrongGroupMode;
  /** 课程筛选（2026-10）：null = 全部课程；选中时保留 rounds 任一轮 courseId 命中的题 */
  courseId: string | null;
  /** 考点筛选（2026-10 综合）：null = 全部考点；题面任一考点命中即保留 */
  knowledge: string | null;
  /** 时间筛选（2026-10 综合）：null = 全部时间；最近 N 天内有判定 */
  days: WrongDaysFilter | null;
  /** 错次筛选（2026-10 综合）：null = 全部；wrongCount ≥ N */
  wrongMin: WrongMinFilter | null;
}

/** 默认状态（待复习 + 按练习分组 + 全部课程 + 无综合筛选） */
export const DEFAULT_WRONG_QUESTIONS_URL_STATE: WrongQuestionsUrlState = {
  tab: "pending",
  group: "unit",
  courseId: null,
  knowledge: null,
  days: null,
  wrongMin: null,
};

/**
 * URLSearchParams → 页面状态。
 * 兼容（2026-10 改版前的旧参数，见模块头注释）：includeResolved=true →
 * tab=conquered；旧 knowledge 忽略（被「按考点」分组取代）；非法值回默认。
 */
export function parseWrongQuestionsUrl(
  search: URLSearchParams,
): WrongQuestionsUrlState {
  const group = search.get("group");
  const courseId = search.get("courseId");
  const knowledge = search.get("knowledge");
  const days = search.get("days");
  const wrongMin = search.get("wrongMin");
  return {
    tab:
      search.get("tab") === "conquered" ||
      search.get("includeResolved") === "true"
        ? "conquered"
        : "pending",
    group: group === "time" || group === "knowledge" ? group : "unit",
    courseId: courseId !== null && courseId !== "" ? courseId : null,
    knowledge: knowledge !== null && knowledge !== "" ? knowledge : null,
    days:
      days === "7" || days === "30" || days === "90"
        ? (Number(days) as WrongDaysFilter)
        : null,
    wrongMin:
      wrongMin === "2" || wrongMin === "3"
        ? (Number(wrongMin) as WrongMinFilter)
        : null,
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
  if (state.courseId !== null) {
    params.set("courseId", state.courseId);
  }
  if (state.knowledge !== null) {
    params.set("knowledge", state.knowledge);
  }
  if (state.days !== null) {
    params.set("days", String(state.days));
  }
  if (state.wrongMin !== null) {
    params.set("wrongMin", String(state.wrongMin));
  }
  return params;
}

/** 时间筛选标签（下拉选项与活跃 chip 共用同一词表） */
export const WRONG_DAYS_LABELS: Record<WrongDaysFilter, string> = {
  7: "最近 7 天",
  30: "最近 30 天",
  90: "最近 90 天",
};

/** 错次筛选标签（下拉选项与活跃 chip 共用同一词表） */
export const WRONG_MIN_LABELS: Record<WrongMinFilter, string> = {
  2: "错 2 次及以上",
  3: "错 3 次及以上",
};

// ---------- 筛选（2026-10 综合：课程 × 考点 × 时间 × 错次组合） ----------

/**
 * 课程筛选（2026-10）：选中课程 C 时保留「任一轮发生在 C」的题（rounds 任一
 * 元素 courseId === C，跨课程的题任一轮命中即保留）；错题重练轮 courseId
 * 恒 null、不参与命中——只有重练轮的题在任意课程筛选下都不出现。
 * null（全部课程）原样返回。
 */
export function filterWrongQuestionsByCourse(
  questions: WrongQuestionCard[],
  courseId: string | null,
): WrongQuestionCard[] {
  if (courseId === null) return questions;
  return questions.filter((question) =>
    question.rounds.some((round) => round.courseId === courseId),
  );
}

/**
 * 综合筛选（2026-10）：课程 × 考点 × 时间 × 错次组合，逐条件收窄——
 * - 课程：rounds 任一轮 courseId 命中（filterWrongQuestionsByCourse 同口径）；
 * - 考点：knowledge 数组任一命中（与展示同源）；
 * - 时间：lastAt 落在最近 days 个自然日内（含今天，Asia/Shanghai 自然日；
 *   字符串 ISO 比较即可——双方都是 toISOString 的 UTC 形态）；
 * - 错次：wrongCount ≥ wrongMin。
 * 任一条件为 null 即跳过该条件。
 */
export function filterWrongQuestions(
  questions: WrongQuestionCard[],
  state: Pick<
    WrongQuestionsUrlState,
    "courseId" | "knowledge" | "days" | "wrongMin"
  >,
  now: Date = new Date(),
): WrongQuestionCard[] {
  let result = filterWrongQuestionsByCourse(questions, state.courseId);
  if (state.knowledge !== null) {
    result = result.filter((question) =>
      question.knowledge.includes(state.knowledge as string),
    );
  }
  if (state.days !== null) {
    // 今天（展示时区）往前推 days-1 天的零点：最近 days 个自然日（含今天）
    const cutoff = dayjs(now)
      .tz(DISPLAY_TZ)
      .startOf("day")
      .subtract(state.days - 1, "day")
      .utc()
      .toISOString();
    result = result.filter((question) => question.lastAt >= cutoff);
  }
  if (state.wrongMin !== null) {
    result = result.filter(
      (question) => question.wrongCount >= (state.wrongMin as number),
    );
  }
  return result;
}

/**
 * 考点下拉选项（来自当前题目集合）：按出现题数降序、同数按中文名稳定排序，
 * 返回 { name, count }（多考点题在每个考点各计一次——下拉是「任一命中」语义）。
 */
export function wrongKnowledgeOptions(
  questions: WrongQuestionCard[],
): Array<{ name: string; count: number }> {
  const countByName = new Map<string, number>();
  for (const question of questions) {
    for (const name of question.knowledge) {
      countByName.set(name, (countByName.get(name) ?? 0) + 1);
    }
  }
  return [...countByName.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort(
      (a, b) =>
        b.count - a.count || a.name.localeCompare(b.name, "zh-Hans-CN"),
    );
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
 * 单条错题紧凑行（默认形态；点击展开完整卡片）。触控 ≥44px。
 * 题干用 InlineMarkdown 单行真渲染（与展开卡同一 displayStemMd 投影），
 * 行容器 truncate 截断；按钮内只允许短语内容，InlineMarkdown 保证不产出
 * 块级或交互元素。
 * 选题模式（2026-10）：传 selection 后整行变为 checkbox（role="checkbox"，
 * aria-checked 表勾态；点击切换勾选，不再展开卡片）——勾选圈 20px 视觉 +
 * 行级 44px 触控目标，选中行主色描边。
 */
export function WrongQuestionRow({
  question,
  expanded,
  onToggle,
  selection,
}: {
  question: WrongQuestionCard;
  expanded: boolean;
  onToggle: () => void;
  /** 选题模式状态：checked=是否已选；onToggle=切换勾选 */
  selection?: { checked: boolean; onToggle: () => void };
}) {
  const lastRound = question.rounds[question.rounds.length - 1];
  const selecting = selection !== undefined;
  return (
    <button
      type="button"
      {...(selecting
        ? {
            role: "checkbox",
            "aria-checked": selection.checked,
            "aria-label": `选择题目 ${question.questionId}`,
          }
        : { "aria-expanded": expanded })}
      onClick={selecting ? selection.onToggle : onToggle}
      className={cn(
        "flex min-h-12 w-full items-center gap-x-3 gap-y-1 rounded-2xl border bg-card px-4 py-2.5 text-left text-card-foreground shadow-xs outline-none transition-colors hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50",
        selecting && selection.checked
          ? "border-primary/60 bg-primary/5"
          : expanded
            ? "border-primary/50 bg-accent/40"
            : "border-border",
      )}
    >
      {selecting && (
        <span
          aria-hidden
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
            selection.checked
              ? "border-primary bg-primary text-primary-foreground"
              : "border-muted-foreground/40 text-transparent",
          )}
        >
          <Check className="size-3.5" />
        </span>
      )}
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${QUESTION_TYPE_BADGE_CLASS[question.type]}`}
      >
        {QUESTION_TYPE_LABELS[question.type]}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">
        <InlineMarkdown source={displayStemMd(question)} />
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        错 {question.wrongCount} · 对 {question.correctCount}
      </span>
      {lastRound !== undefined &&
        (lastRound.correct ? (
          <CheckCircle2
            aria-label="最近一轮做对"
            className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
          />
        ) : lastRound.answered ? (
          <XCircle
            aria-label="最近一轮做错"
            className="size-4 shrink-0 text-red-600 dark:text-red-400"
          />
        ) : (
          <XCircle
            aria-label="最近一轮未做"
            className="size-4 shrink-0 text-muted-foreground"
          />
        ))}
      <span className="shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground">
        {formatCnTime(question.lastAt)}
      </span>
      {!selecting && (
        <ChevronDown
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      )}
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
 * （第 k 轮 ✓/✗ · 绝对时间 · 来源标题）+ 待批轮差额提示（pendingCount>0
 * 时「另有 N 轮待老师批改」——待批轮不进 rounds，在此补足差额口径）。
 * 每轮一行整体为链接 → /s/attempts/:attemptId 回看该轮作答（rounds 只含
 * 已判定轮，目标必为已交卷卷的结果视图）；弱化样式（muted 文字，hover 才
 * 浮出背景与前景色，尾部小箭头暗示可点），触控目标 ≥44px。
 * 攻克判定由端上按学生自选标准从本区块的原料（rounds）计算，服务端不下发
 * 规则。
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
      <ol className="flex flex-col gap-1">
        {question.rounds.map((round, index) => (
          <li key={round.attemptId}>
            <Link
              to={`/s/attempts/${round.attemptId}`}
              aria-label={`查看第 ${index + 1} 轮作答：${round.sourceTitle}`}
              title="查看这一次的作答"
              className="-mx-2 flex min-h-11 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg px-2 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="font-medium text-foreground">
                第 {index + 1} 轮
              </span>
              {round.correct ? (
                <span className="flex shrink-0 items-center gap-1 font-medium text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 aria-hidden className="size-3.5" />
                  做对
                </span>
              ) : round.answered ? (
                <span className="flex shrink-0 items-center gap-1 font-medium text-red-700 dark:text-red-300">
                  <XCircle aria-hidden className="size-3.5" />
                  做错
                </span>
              ) : (
                <span className="flex shrink-0 items-center gap-1 font-medium text-muted-foreground">
                  <XCircle aria-hidden className="size-3.5" />
                  未做
                </span>
              )}
              {round.studentFlag === "unsure" && (
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  标过不会
                </span>
              )}
              <span className="shrink-0 whitespace-nowrap tabular-nums">
                {formatCnTime(round.submittedAt)}
              </span>
              <span className="min-w-0 truncate">
                {round.sourceTitle}
                {round.courseName !== null && `（${round.courseName}）`}
              </span>
              <ChevronRight
                aria-hidden
                className="ml-auto size-3.5 shrink-0 text-muted-foreground/50"
              />
            </Link>
          </li>
        ))}
      </ol>
      {question.pendingCount > 0 && (
        <p className="text-xs text-muted-foreground">
          另有 {question.pendingCount} 轮待老师批改
        </p>
      )}
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
      {question.rounds.at(-1)?.reviewSource === "self" && (
        <p className="text-xs text-muted-foreground">最近判定来自学生自评</p>
      )}
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

      {/* 题干快照（服务端已 studentStemMd 投影，答案在下方面板单独展示） */}
      <RichMarkdown source={displayStemMd(question)} className="text-base" />
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
        <SourceBadge sourceType={question.sourceType} />
        <span className="min-w-0 truncate">
          最近来源：{recordTitleOf(question)}
          {question.courseName !== null && `（${question.courseName}）`}
        </span>
        <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums">
          {formatCnTime(question.lastAt)}
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

/**
 * 综合筛选条（2026-10）：考点 / 时间 / 错次三个下拉（与课程下拉同一形态），
 * 组合生效（综合筛选）；有活跃条件时展示可单清的 chips 与「清除全部筛选」。
 * 选项与标签单源：时间/错次词表 WRONG_DAYS_LABELS / WRONG_MIN_LABELS，
 * 考点选项由页面从当前题目集合算好传入（带计数）。触控 ≥44px。
 */
export function WrongFilterBar({
  knowledge,
  days,
  wrongMin,
  knowledgeOptions,
  unknownKnowledge = false,
  onChange,
  onClearAll,
}: {
  /** 当前考点筛选（null = 全部考点） */
  knowledge: string | null;
  /** 当前时间筛选（null = 全部时间） */
  days: WrongDaysFilter | null;
  /** 当前错次筛选（null = 全部） */
  wrongMin: WrongMinFilter | null;
  /** 考点下拉选项（当前题目集合的考点分布，带计数） */
  knowledgeOptions: Array<{ name: string; count: number }>;
  /** 深链考点不在当前选项里（占位选项兜底，select 不显示空白） */
  unknownKnowledge?: boolean;
  /** 修改单个筛选条件（传 null 清除该条件） */
  onChange: (patch: {
    knowledge?: string | null;
    days?: WrongDaysFilter | null;
    wrongMin?: WrongMinFilter | null;
  }) => void;
  /** 清除全部综合筛选（课程筛选由课程下拉自管，不在此清） */
  onClearAll: () => void;
}) {
  const hasActive = knowledge !== null || days !== null || wrongMin !== null;
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor="wrong-knowledge-filter"
          className="shrink-0 text-sm text-muted-foreground"
        >
          考点
        </label>
        <select
          id="wrong-knowledge-filter"
          className="min-h-11 min-w-0 max-w-56 rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          value={knowledge ?? ""}
          onChange={(e) =>
            onChange({ knowledge: e.target.value === "" ? null : e.target.value })
          }
        >
          <option value="">全部考点</option>
          {knowledgeOptions.map((option) => (
            <option key={option.name} value={option.name}>
              {option.name}（{option.count}）
            </option>
          ))}
          {unknownKnowledge && knowledge !== null && (
            <option value={knowledge}>{knowledge}（已不在当前列表）</option>
          )}
        </select>
        <label
          htmlFor="wrong-days-filter"
          className="shrink-0 text-sm text-muted-foreground"
        >
          时间
        </label>
        <select
          id="wrong-days-filter"
          className="min-h-11 min-w-0 rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          value={days === null ? "" : String(days)}
          onChange={(e) => {
            const value = e.target.value;
            onChange({
              days:
                value === "7" || value === "30" || value === "90"
                  ? (Number(value) as WrongDaysFilter)
                  : null,
            });
          }}
        >
          <option value="">全部时间</option>
          {([7, 30, 90] as WrongDaysFilter[]).map((d) => (
            <option key={d} value={String(d)}>
              {WRONG_DAYS_LABELS[d]}
            </option>
          ))}
        </select>
        <label
          htmlFor="wrong-wrong-min-filter"
          className="shrink-0 text-sm text-muted-foreground"
        >
          错次
        </label>
        <select
          id="wrong-wrong-min-filter"
          className="min-h-11 min-w-0 rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          value={wrongMin === null ? "" : String(wrongMin)}
          onChange={(e) => {
            const value = e.target.value;
            onChange({
              wrongMin:
                value === "2" || value === "3"
                  ? (Number(value) as WrongMinFilter)
                  : null,
            });
          }}
        >
          <option value="">全部错次</option>
          {([2, 3] as WrongMinFilter[]).map((m) => (
            <option key={m} value={String(m)}>
              {WRONG_MIN_LABELS[m]}
            </option>
          ))}
        </select>
      </div>
      {hasActive && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">已筛选：</span>
          {knowledge !== null && (
            <Chip label={knowledge} onClearLabel="清除考点筛选" onClear={() => onChange({ knowledge: null })} />
          )}
          {days !== null && (
            <Chip
              label={WRONG_DAYS_LABELS[days]}
              onClearLabel="清除时间筛选"
              onClear={() => onChange({ days: null })}
            />
          )}
          {wrongMin !== null && (
            <Chip
              label={WRONG_MIN_LABELS[wrongMin]}
              onClearLabel="清除错次筛选"
              onClear={() => onChange({ wrongMin: null })}
            />
          )}
          <Button
            variant="ghost"
            className="min-h-9 px-2 text-xs text-muted-foreground"
            onClick={onClearAll}
          >
            清除全部筛选
          </Button>
        </div>
      )}
    </div>
  );
}

/** 活跃筛选 chip：标签 + 单清 ×（触控高度放宽到 36px——次级操作，主筛选控件 ≥44px） */
function Chip({
  label,
  onClearLabel,
  onClear,
}: {
  label: string;
  onClearLabel: string;
  onClear: () => void;
}) {
  return (
    <span className="flex items-center gap-1 rounded-full bg-muted py-0.5 pl-2.5 pr-1 text-xs text-muted-foreground">
      {label}
      <button
        type="button"
        aria-label={onClearLabel}
        className="flex size-7 items-center justify-center rounded-full outline-none transition-colors hover:bg-muted-foreground/15 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={onClear}
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </span>
  );
}

/** 组头全选按钮（选题模式）：全选本组 / 取消全选（aria-pressed 表当前；触控 ≥44px） */
export function WrongGroupSelectAll({
  count,
  allSelected,
  onToggle,
}: {
  /** 组内在当前 tab 的题数 */
  count: number;
  /** 组内题目是否已全部选中 */
  allSelected: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant="outline"
      className="min-h-11 px-3"
      aria-pressed={allSelected}
      onClick={onToggle}
    >
      {allSelected ? (
        <CheckCircle2 aria-hidden className="size-4" />
      ) : (
        <Circle aria-hidden className="size-4" />
      )}
      {allSelected ? `取消全选（${count} 题）` : `全选本组（${count} 题）`}
    </Button>
  );
}

/**
 * 选题模式底部操作条（sticky bottom）：已选计数（跨分区合计）+ 全选当前列表
 * + 取消选题 + 重练已选（0 题禁用、提交中 loading 防重复建卷）。
 */
export function WrongSelectionBar({
  selectedCount,
  otherTabCount,
  allVisibleSelected,
  visibleCount,
  loading = false,
  onToggleSelectAllVisible,
  onPractice,
  onCancel,
}: {
  /** 已选题目总数（两个 tab 合计） */
  selectedCount: number;
  /** 已选中但不在当前分区可见列表里的题数（跨分区选题提示） */
  otherTabCount: number;
  /** 当前列表（tab + 筛选后）是否已全部选中 */
  allVisibleSelected: boolean;
  /** 当前列表题数（全选按钮示数） */
  visibleCount: number;
  /** 提交中（组卷请求进行时） */
  loading?: boolean;
  onToggleSelectAllVisible: () => void;
  onPractice: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="选题重练操作栏"
      className="sticky bottom-4 z-20 mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-primary/30 bg-card/95 p-3 shadow-lg backdrop-blur"
    >
      <p className="min-w-0 text-sm font-medium" role="status">
        已选 {selectedCount} 题
        {otherTabCount > 0 && (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            （另有 {otherTabCount} 题不在当前列表）
          </span>
        )}
      </p>
      <Button
        variant="ghost"
        className="min-h-11 px-3 text-muted-foreground"
        aria-pressed={allVisibleSelected}
        disabled={visibleCount === 0}
        onClick={onToggleSelectAllVisible}
      >
        {allVisibleSelected ? "取消全选" : `全选当前列表（${visibleCount} 题）`}
      </Button>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          className="min-h-11 px-4"
          disabled={loading}
          onClick={onCancel}
        >
          取消选题
        </Button>
        <Button
          className="min-h-11 px-5"
          disabled={selectedCount === 0 || loading}
          onClick={onPractice}
        >
          <RotateCcw
            aria-hidden
            className={loading ? "size-4 animate-spin" : "size-4"}
          />
          {loading
            ? "正在组卷…"
            : selectedCount === 0
              ? "重练已选（0 题）"
              : `重练已选（${selectedCount} 题）`}
        </Button>
      </div>
    </div>
  );
}

/**
 * 课程筛选下拉（2026-10，与我的记录页同一数据源与近似样式）：选项 = 全部
 * 课程 + 我的课程（useStudentCourses；加载失败由页面传空数组，不阻塞列表）。
 * 深链/回退到已不在课程列表的 courseId（课程归档或移出成员）时补一个占位
 * 选项，select 不显示空白、筛选语义不丢；课程还在加载时占位为「课程加载中…」。
 * 触控 ≥44px。
 */
export function WrongCourseSelect({
  courseId,
  courses,
  coursesPending,
  onChange,
}: {
  /** 当前筛选课程（null = 全部课程） */
  courseId: string | null;
  /** 课程下拉选项（我的课程；加载失败为空数组） */
  courses: { id: string; name: string }[];
  /** 课程选项仍在加载（占位选项文案用） */
  coursesPending: boolean;
  onChange: (courseId: string | null) => void;
}) {
  // 选中课程不在选项里：占位选项兜底（加载中 → 选项就绪后消失）
  const unknownSelected =
    courseId !== null && !courses.some((course) => course.id === courseId);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <label
        htmlFor="wrong-course-filter"
        className="shrink-0 text-sm text-muted-foreground"
      >
        课程
      </label>
      <select
        id="wrong-course-filter"
        className="min-h-11 min-w-0 max-w-56 rounded-lg border border-input bg-transparent px-3 text-base outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        value={courseId ?? ""}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : e.target.value)
        }
      >
        <option value="">全部课程</option>
        {courses.map((course) => (
          <option key={course.id} value={course.id}>
            {course.name}
          </option>
        ))}
        {unknownSelected && (
          <option value={courseId}>
            {coursesPending ? "课程加载中…" : "已不在我的课程"}
          </option>
        )}
      </select>
    </div>
  );
}

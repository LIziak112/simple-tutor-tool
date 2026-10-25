import type { StudentUnitLandingData } from "@tutor/contract";
import {
  ArrowLeft,
  ClipboardList,
  Dumbbell,
  ListChecks,
  Play,
  RotateCcw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import {
  useStartCourseAttempt,
  useStudentUnitLanding,
  workflowStartOptions,
} from "@/features/attempt/attempt-queries";
import { setAttemptStartLayoutIntent } from "@/features/attempt/attempt-start-intent";
import {
  getPracticePreference,
  usePracticePreference,
} from "@/features/attempt/practice-preference-store";
import {
  practiceLayoutLabel,
  practiceLayoutOptions,
  practiceRhythmLabel,
} from "@/features/attempt/practice-protocol";
import { formatResultCounts } from "@/features/attempt/result-counts";
import {
  StudentErrorPanel,
  StudentListSkeleton,
} from "@/features/student/student-ui";
import { ApiError } from "@/lib/api";
import { formatRelativeTime } from "@/lib/time";

/**
 * /s/courses/:id/units/:unitId 单元落地页（T2A.6，D10）：
 * - 单元信息：标题/主题/题数/题型分布 + 首次/最近/最佳题数汇总；
 * - 入口三态：开始练习（从未做）/ 继续作答（存在未交卷作答 → 直接进答题页）/
 *   再做一次（已交卷后，确认「将开始第 n+1 次，从空白开始」）；
 * - 历次记录列表：点击进入该次结果视图（只读，/s/attempts/:attemptId）。
 * 越权（D22）：非成员/课程归档 → 403 COURSE_ACCESS_DENIED（中文引导）；
 * 课程或条目不可见 → 404（不暴露存在性）。
 */

/** 题型中文标签（与 answer-format 的 QUESTION_TYPE_LABELS 同口径的精简版） */
const TYPE_LABELS: Record<string, string> = {
  judge: "判断",
  choice: "单选",
  multi: "多选",
  fill: "填空",
  solve: "手写解答",
  apply: "应用题",
  findError: "找错题",
};

/** 历次状态徽章文案 */
function statusLabel(status: string): string {
  if (status === "draft") return "进行中";
  if (status === "graded") return "已批改";
  return "已交卷";
}

/**
 * 选择器初值链（裁决⑨）：已保存偏好 → 单元推荐 → 缺省（列表/逐题）。
 * 两处消费（单一出处）：挂载 useState 初值 + 未绑定→已绑定对齐 effect（闸门 B1）。
 */
function initialSelectionOf(
  recommendation: StudentUnitLandingData["practiceRecommendation"],
): { layout: "list" | "single"; feedback: "per_question" | "after_attempt" } {
  const saved = getPracticePreference();
  return {
    layout: saved.layout ?? recommendation?.layout ?? "list",
    feedback: saved.feedback ?? recommendation?.feedback ?? "per_question",
  };
}

/** 再做一次的确认弹层（D10：新一次从空白开始） */
function RedoConfirmDialog({
  open,
  nextAttemptNo,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  nextAttemptNo: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="再做一次确认"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
    >
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-lg">
        <h2 className="text-base font-semibold">再做一次</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          将开始第 {nextAttemptNo}{" "}
          次，从空白开始。之前的记录会保留，可随时回看。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={onCancel}
          >
            先不做
          </Button>
          <Button className="min-h-11" disabled={busy} onClick={onConfirm}>
            {busy ? "正在开始…" : "开始新一次"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function StudentCourseUnitPage() {
  const { id: courseId = "", unitId = "" } = useParams<{
    id: string;
    unitId: string;
  }>();
  const navigate = useNavigate();
  const landingQuery = useStudentUnitLanding(courseId, unitId);

  const accessDenied =
    landingQuery.error instanceof ApiError &&
    landingQuery.error.code === "COURSE_ACCESS_DENIED";
  const notVisible =
    landingQuery.error instanceof ApiError && landingQuery.error.status === 404;

  if (landingQuery.isPending) {
    return <StudentListSkeleton label="正在加载练习" />;
  }
  if (landingQuery.isError) {
    if (accessDenied) {
      return (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
        >
          <p className="text-sm font-medium">暂时看不到这个练习</p>
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
      );
    }
    return (
      <StudentErrorPanel
        title={notVisible ? "练习还没有开放" : "练习加载失败"}
        message={
          notVisible
            ? "这个练习可能还未发布或已被移除，可以先看看课程里的其他内容。"
            : landingQuery.error instanceof Error
              ? landingQuery.error.message
              : "网络异常，请稍后重试"
        }
        onRetry={
          notVisible
            ? () => void navigate("/s/courses")
            : () => void landingQuery.refetch()
        }
      />
    );
  }

  // 数据就绪后挂载子组件：选择器 useState 初值才能读到单元推荐与本机偏好
  return (
    <UnitLandingView
      courseId={courseId}
      unitId={unitId}
      landing={landingQuery.data}
    />
  );
}

/** 做题方式反馈节奏两枚选项（标签复用 practiceRhythmLabel 单一出处） */
const rhythmOptions = ["per_question", "after_attempt"] as const;

/**
 * 单元落地视图（数据就绪后挂载；M5-D3 裁决⑨）：
 * - 呈现单元推荐标注（布局与节奏标签，同源 practiceLayoutLabel/RhythmLabel）；
 * - 两枚选择器初值 = 已保存偏好 → 单元推荐 → 缺省（列表/逐题）；显式点选后
 *   本次访问内恒定（无 effect 拉扯）；
 * - 「开始练习」仅显式触碰节奏选择器才发 feedbackMode（显式选择恒最高），
 *   未触碰维持 M5-D2 建卷裁决链（学生偏好 → 单元推荐 → 教师约束，服务端裁决）；
 * - 布局当前值恒经一次性 transient 传作答页（不经服务端，硬刷新回落本机偏好）。
 */
function UnitLandingView({
  courseId,
  unitId,
  landing,
}: {
  courseId: string;
  unitId: string;
  landing: StudentUnitLandingData;
}) {
  const navigate = useNavigate();
  const startAttempt = useStartCourseAttempt(courseId, unitId);
  const [redoOpen, setRedoOpen] = useState(false);

  const summary = landing.summary;
  const hasDraft = summary?.hasDraft === true;
  const submittedCount = summary?.submittedCount ?? 0;
  const nextAttemptNo = (summary?.count ?? 0) + 1;
  const busy = startAttempt.isPending;

  // 初值链：已保存偏好 → 单元推荐 → 缺省；子组件在落地数据到达后挂载，
  // useState 初值可安全读取推荐；本机偏好若绑定晚到由下方对齐 effect 补
  const [selected, setSelected] = useState(() =>
    initialSelectionOf(landing.practiceRecommendation),
  );
  // 节奏是否被显式触碰：未触碰不携 feedbackMode（M5-D2 链不因本页中断）
  const [rhythmTouched, setRhythmTouched] = useState(false);

  // 闸门 B1（M3-D1.5 同款竞态）：硬刷新时布局层的账号绑定 effect 晚于本组件
  // 首渲染，初值链可能读到未绑定 store——已保存偏好被错过退化为 推荐??缺省，
  // 而点击「开始」时 store 已绑定、workflowStartOptions 照发已保存节奏，
  // 展示预选与实际建卷不一致。store 从未绑定变已绑定的那一刻按初值链对齐
  // 一次；任一选择器被显式触碰后不再拉扯（裁决⑨「显式点选后本次访问内
  // 恒定」；换绑与解绑不对齐）。
  const explicitSelectionRef = useRef(false);
  const { accountId: boundAccountId } = usePracticePreference();
  const prevBoundAccountRef = useRef(boundAccountId);
  useEffect(() => {
    const previous = prevBoundAccountRef.current;
    prevBoundAccountRef.current = boundAccountId;
    if (previous !== null || boundAccountId === null) return;
    if (explicitSelectionRef.current) return;
    setSelected(initialSelectionOf(landing.practiceRecommendation));
  }, [boundAccountId, landing.practiceRecommendation]);

  const enterAttempt = (attemptId: string) => {
    void navigate(`/s/attempts/${attemptId}`);
  };

  const onStart = () => {
    startAttempt.mutate(
      rhythmTouched
        ? { ...workflowStartOptions(), feedbackMode: selected.feedback }
        : undefined,
      {
        onSuccess: (attempt) => {
          // 建卷成功才写一次性 transient（含继续作答/再做一次路径，三入口
          // 统一；闸门 A1）：失败/中断不得残留——模块级值永不过期，会劫持
          // 之后任意无关作答的初始布局（裁决⑨「一次性」变「下一次消费」）
          setAttemptStartLayoutIntent(selected.layout);
          enterAttempt(attempt.id);
        },
      },
    );
  };

  const recommendation = landing.practiceRecommendation;
  const recommendationParts =
    recommendation === null
      ? []
      : [
          recommendation.layout !== undefined
            ? practiceLayoutLabel(recommendation.layout)
            : null,
          recommendation.feedback !== undefined
            ? practiceRhythmLabel(recommendation.feedback)
            : null,
        ].filter((part) => part !== null);
  // 空推荐（practice: {} 契约合法）join 得空串，不得按非 null 过渲染门出
  // 「本单元推荐：」悬空标签（M6 闸门 A3）
  const recommendationText =
    recommendationParts.length > 0 ? recommendationParts.join(" · ") : null;

  const typeBadges = Object.entries(landing.typeDistribution)
    .map(([type, count]) => `${TYPE_LABELS[type] ?? type} ${count}`)
    .join(" · ");

  return (
    <section aria-label="单元练习" className="flex flex-col gap-4">
      <header className="flex items-center gap-2">
        <Link
          to={`/s/courses/${courseId}`}
          aria-label="返回课程目录"
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ArrowLeft aria-hidden className="size-5" />
        </Link>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            课程：{landing.courseName}
          </p>
          <h1 className="flex items-center gap-2 truncate text-xl font-semibold">
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300"
            >
              <Dumbbell className="size-5" />
            </span>
            {landing.title}
          </h1>
        </div>
      </header>

      {/* 单元信息卡：题数/题型分布/作答表现 + 做题方式选择 + 入口按钮 */}
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 shadow-xs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span>
            共 <b className="text-primary">{landing.questionCount}</b> 题
          </span>
          {typeBadges !== "" && (
            <span className="text-xs text-muted-foreground">{typeBadges}</span>
          )}
        </div>
        {summary !== null && submittedCount > 0 && (
          <div aria-hidden className="grid grid-cols-3 gap-2">
            {[
              { label: "首次", value: summary.firstResultCounts },
              { label: "最近", value: summary.latestResultCounts },
              { label: "最佳", value: summary.bestResultCounts },
            ].map((tile) => (
              <div
                key={tile.label}
                className="rounded-xl bg-muted/60 px-3 py-2.5 text-center"
              >
                <p className="text-base font-bold text-foreground">
                  {formatResultCounts(tile.value)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {tile.label}表现
                </p>
              </div>
            ))}
          </div>
        )}
        {summary !== null && submittedCount > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>已做 {summary.count} 次</span>
            <span>
              首次 {formatResultCounts(summary.firstResultCounts)} · 最近{" "}
              {formatResultCounts(summary.latestResultCounts)} · 最佳{" "}
              {formatResultCounts(summary.bestResultCounts)}
            </span>
            {summary.pendingCount > 0 && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                有 {summary.pendingCount} 题待批
              </span>
            )}
          </div>
        )}

        {/* 开始前做题方式选择（M5-D3）：推荐只做标注，授权结论仍由服务端
            建卷 resolver 裁决；触控目标 ≥44px */}
        <div className="flex min-w-0 flex-col gap-2 rounded-xl bg-muted/40 p-3">
          <p className="text-xs text-muted-foreground">
            做题方式
            {recommendationText !== null && (
              <span> · 本单元推荐：{recommendationText}</span>
            )}
          </p>
          <fieldset className="grid min-w-0 gap-2 sm:grid-cols-2">
            <legend className="sr-only">选择做题布局</legend>
            {practiceLayoutOptions.map(({ value, title }) => (
              <label
                key={value}
                className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 outline-none has-focus-visible:ring-3 has-focus-visible:ring-ring/50 ${
                  selected.layout === value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted/40"
                }`}
              >
                <input
                  className="size-4 shrink-0 accent-primary"
                  type="radio"
                  name="practice-start-layout"
                  value={value}
                  checked={selected.layout === value}
                  onChange={() => {
                    explicitSelectionRef.current = true;
                    setSelected((prev) => ({ ...prev, layout: value }));
                  }}
                />
                <span className="text-sm font-medium">{title}</span>
              </label>
            ))}
          </fieldset>
          <fieldset className="grid min-w-0 gap-2 sm:grid-cols-2">
            <legend className="sr-only">选择反馈节奏</legend>
            {rhythmOptions.map((value) => (
              <label
                key={value}
                className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 outline-none has-focus-visible:ring-3 has-focus-visible:ring-ring/50 ${
                  selected.feedback === value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted/40"
                }`}
              >
                <input
                  className="size-4 shrink-0 accent-primary"
                  type="radio"
                  name="practice-start-rhythm"
                  value={value}
                  checked={selected.feedback === value}
                  onChange={() => {
                    explicitSelectionRef.current = true;
                    setRhythmTouched(true);
                    setSelected((prev) => ({ ...prev, feedback: value }));
                  }}
                />
                <span className="text-sm font-medium">
                  {practiceRhythmLabel(value)}
                </span>
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-muted-foreground">
            反馈节奏与布局可在此预选；进入练习后可在做题方式里查看，老师允许时也可调整。
          </p>
        </div>

        {/* 入口：开始练习（从未做）/ 继续作答（有未交卷）/ 再做一次（确认后新建） */}
        <div className="flex flex-wrap items-center gap-3">
          {summary === null ? (
            <Button
              className="min-h-12 px-8 text-base"
              disabled={busy}
              onClick={onStart}
              aria-label={`开始练习 ${landing.title}`}
            >
              <Play aria-hidden className="size-4" />
              {busy ? "正在开始…" : "开始练习"}
            </Button>
          ) : hasDraft ? (
            <Button
              className="min-h-12 px-8 text-base"
              disabled={busy}
              onClick={onStart}
              aria-label="继续作答"
            >
              <Play aria-hidden className="size-4" />
              {busy ? "正在打开…" : "继续作答"}
            </Button>
          ) : (
            <Button
              className="min-h-12 px-8 text-base"
              onClick={() => setRedoOpen(true)}
              aria-label="再做一次"
            >
              <RotateCcw aria-hidden className="size-4" />
              再做一次
            </Button>
          )}
          {startAttempt.isError && (
            <p role="alert" className="text-xs text-destructive">
              {startAttempt.error instanceof Error
                ? startAttempt.error.message
                : "开始失败，请稍后重试"}
            </p>
          )}
        </div>
      </div>

      {/* 历次记录 */}
      <div className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 pt-2 text-sm font-semibold text-muted-foreground">
          <ListChecks aria-hidden className="size-4" />
          历次记录（{landing.attempts.length}）
        </h2>
        {landing.attempts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-8 text-center text-sm text-muted-foreground">
            <ClipboardList aria-hidden className="mx-auto mb-2 size-6" />
            还没有做过——从上面的按钮开始第一次练习。
          </div>
        ) : (
          <ol className="flex flex-col gap-2">
            {landing.attempts.map((attempt) => (
              <li key={attempt.attemptId}>
                <button
                  type="button"
                  aria-label={`查看第 ${attempt.attemptNo} 次记录`}
                  onClick={() => enterAttempt(attempt.attemptId)}
                  className="flex min-h-14 w-full items-center gap-3 rounded-2xl border border-border bg-card px-4 py-2 text-left shadow-xs outline-none transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="w-14 shrink-0 text-sm font-medium">
                    第 {attempt.attemptNo} 次
                  </span>
                  <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                    {statusLabel(attempt.status)}
                  </span>
                  {attempt.status !== "draft" && (
                    <span className="shrink-0 text-sm">
                      {formatResultCounts(attempt.resultCounts)}
                    </span>
                  )}
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {attempt.submittedAt !== null
                      ? formatRelativeTime(attempt.submittedAt)
                      : "未交卷"}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>

      <RedoConfirmDialog
        open={redoOpen}
        nextAttemptNo={nextAttemptNo}
        busy={busy}
        onConfirm={() => {
          setRedoOpen(false);
          onStart();
        }}
        onCancel={() => setRedoOpen(false)}
      />
    </section>
  );
}

import { useMutation } from "@tanstack/react-query";
import type { WrongQuestionCard } from "@tutor/contract";
import {
  BookX,
  Filter,
  PartyPopper,
  TriangleAlert,
  Trophy,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { useStudentCourses } from "@/features/student/student-queries";
import { useStudentWrongQuestions } from "@/features/student/student-records-queries";
import {
  StudentEmptyState,
  StudentPageHeader,
} from "@/features/student/student-ui";
import {
  loadWrongMasteryStandard,
  saveWrongMasteryStandard,
  splitByMastery,
  type WrongMasteryStandard,
} from "@/features/student/wrong-mastery";
import {
  filterWrongQuestionsByCourse,
  groupCountLabel,
  groupWrongQuestions,
  parseWrongQuestionsUrl,
  WrongCourseSelect,
  WrongGroupSwitch,
  WrongPracticeButton,
  WrongQuestionItem,
  WrongQuestionRow,
  type WrongQuestionsUrlState,
  WrongTabSwitch,
  wrongQuestionsUrlQuery,
} from "@/features/student/wrong-questions-ui";
import { startWrongPracticeApi } from "@/lib/api";

/**
 * /s/wrong 错题本（T3.5，D11；2026-10 IA 调整升为一级路由；2026-10 轮次史
 * 改版；2026-10 补重练）：按 (学生, 题目) 跨作业 + 课程练习聚合。
 * - 数据策略：页面统一拉**全量形态**（includeResolved=true）一次，tab 归属、
 *   分组、攻克标准全部本地计算（服务端 knowledge/includeResolved 参数保留
 *   兼容，本页不再使用）；
 * - 顶部两 tab：「待复习」（默认）/「已攻克」——做对的题永远不删，进已攻克
 *   分区随时可翻看；成员由本地攻克标准从轮次史（rounds）计算；
 * - 攻克标准学生自选（宽松=做对 1 次即攻克；严格=连续 2 次做对，默认），
 *   存本设备 localStorage（features/student/wrong-mastery.ts，与首页概览卡
 *   同一函数同一数据源，两处口径一致）；
 * - 分组维度：按练习（默认，按题目归属单元）/ 按时间（本周/上周/本月/更早）/
 *   按考点；组内按最近判定时间倒序；
 * - 课程筛选（2026-10）：页头「课程」下拉（默认全部课程，选项 = 我的课程
 *   接口，与我的记录页同源；加载失败不阻塞列表）。筛选口径 = rounds 任一轮
 *   courseId 命中（错题重练轮恒 null 不参与；跨课程的题任一轮命中即保留），
 *   作用于两个 tab 的成员与计数、页头「重练全部」的范围（组头「重练本组」
 *   随列表天然跟随）；不自动切换分组维度（用户自己点「按练习」等）；
 * - 条目默认紧凑行，点击展开完整卡片（含轮次史区块）；时间一律绝对时间
 *   （formatCnTime，Asia/Shanghai）；紧凑行示「错 N · 对 M」；轮次史尾部在
 *   pendingCount>0 时提示「另有 N 轮待老师批改」；
 * - **重练（2026-10）**：范围沿用当前 tab + 分组口径——页头「重练全部
 *   （N 题）」= 当前 tab 全部题；每个组头「重练本组（x 题）」= 该组在当前
 *   tab 的题；点击 POST /wrong-practice（题目顺序 = 圈定顺序）→ 跳
 *   /s/attempts/:attemptId 走既有答题会话；交卷后回本页自然看到轮次史新增
 *   一轮与攻克状态更新（聚合自动纳入）；
 * - tab、分组维度与课程筛选同步 URL query（刷新/返回不丢；旧参数兼容映射见
 *   wrong-questions-ui.parseWrongQuestionsUrl）；三态齐全，触控目标 ≥44px。
 */

/** 组头 id（aria-labelledby 用；组键可能含中文/DSL 字符，编码后剥离非 URL 安全字符） */
function groupIdOf(key: string): string {
  const encoded = encodeURIComponent(key).replace(/[^a-zA-Z0-9]/g, "");
  return `wrong-group-${encoded === "" ? "unknown" : encoded}`;
}

/** 加载骨架（不白屏） */
function WrongSkeleton() {
  return (
    <div
      role="status"
      aria-label="正在加载错题本"
      className="flex flex-col gap-3"
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-14 animate-pulse rounded-2xl border border-border bg-muted/60"
        />
      ))}
      <p className="text-sm text-muted-foreground">正在加载错题本…</p>
    </div>
  );
}

/** 空态（区分「还没有错题」/「当前分区为空」/「课程筛选后为空」并给出解释） */
function WrongEmpty({
  tab,
  standard,
  hasAnyQuestion,
  courseFilterActive,
}: {
  tab: "pending" | "conquered";
  standard: WrongMasteryStandard;
  hasAnyQuestion: boolean;
  /** 课程筛选生效中（空列表优先归因筛选，给下一步动作） */
  courseFilterActive: boolean;
}) {
  const standardText = standard === "lenient" ? "做对 1 次" : "连续做对 2 次";
  if (!hasAnyQuestion) {
    return (
      <StudentEmptyState
        icon={<PartyPopper />}
        title="还没有错题"
        description="做错的题会自动收进这里（等待老师批改的题先不算）；做对的题永远不删，攻克后随时可以回来翻看。"
      />
    );
  }
  if (courseFilterActive) {
    return (
      <StudentEmptyState
        icon={<Filter />}
        title={
          tab === "pending"
            ? "这门课暂无待复习的错题"
            : "这门课暂无已攻克的错题"
        }
        description="可以换一门课程试试，或改选「全部课程」。"
      />
    );
  }
  return (
    <StudentEmptyState
      icon={tab === "pending" ? <PartyPopper /> : <Trophy />}
      title={
        tab === "pending" ? "当前没有需要复习的错题" : "还没有攻克过的错题"
      }
      description={
        tab === "pending"
          ? `按当前攻克标准（${standardText}），做错的题达标后就移进「已攻克」。`
          : `按当前攻克标准（${standardText}）还没有攻克的错题；可以把标准调成「做对 1 次」试试，或再去练习里做对一次。`
      }
    />
  );
}

/** 攻克标准一行小型单选（本设备 localStorage，不进 URL） */
function MasteryStandardPicker({
  standard,
  onChange,
}: {
  standard: WrongMasteryStandard;
  onChange: (standard: WrongMasteryStandard) => void;
}) {
  return (
    <fieldset
      aria-label="攻克标准"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-3"
    >
      <span className="text-sm text-muted-foreground">算作攻克：</span>
      <Button
        variant={standard === "strict" ? "secondary" : "ghost"}
        className={
          standard === "strict"
            ? "min-h-11 px-3 text-primary"
            : "min-h-11 px-3 text-muted-foreground"
        }
        aria-pressed={standard === "strict"}
        onClick={() => onChange("strict")}
      >
        连续做对 2 次（默认）
      </Button>
      <Button
        variant={standard === "lenient" ? "secondary" : "ghost"}
        className={
          standard === "lenient"
            ? "min-h-11 px-3 text-primary"
            : "min-h-11 px-3 text-muted-foreground"
        }
        aria-pressed={standard === "lenient"}
        onClick={() => onChange("lenient")}
      >
        做对 1 次
      </Button>
      <span className="text-xs text-muted-foreground">
        只在这台设备上生效。
      </span>
    </fieldset>
  );
}

export default function StudentWrongQuestionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  // URL query 是 tab 与分组维度的单一事实来源（刷新与返回不丢）
  const state = useMemo(
    () => parseWrongQuestionsUrl(searchParams),
    [searchParams],
  );
  // 攻克标准：本设备 localStorage（挂载时读一次；页内切换即写回）
  const [standard, setStandard] = useState<WrongMasteryStandard>(() =>
    loadWrongMasteryStandard(),
  );
  // 展开的紧凑行（同屏单开；切 tab/分组后目标不在列表则自然收起）
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // 全量形态一次拉取：tab/分组/课程筛选/攻克标准全在本地算（D11 口径：单学生
  // 错题规模有限；含已攻克条目——做对的题永远不删）
  const listQuery = useStudentWrongQuestions({ includeResolved: true });

  // 课程下拉选项（我的课程；与我的记录页同一接口同一数据源，失败不阻塞
  // 列表——只显示「全部课程」）
  const coursesQuery = useStudentCourses();
  const courses = useMemo(
    () =>
      (coursesQuery.data?.courses ?? []).map(({ id, name }) => ({ id, name })),
    [coursesQuery.data],
  );

  const questions = listQuery.data?.questions ?? [];
  // 课程筛选在 tab 分流前生效：两个 tab 的成员与计数、「重练全部」范围都跟随
  const courseFiltered = useMemo(
    () => filterWrongQuestionsByCourse(questions, state.courseId),
    [questions, state.courseId],
  );
  const { pending, conquered } = useMemo(
    () => splitByMastery(courseFiltered, standard),
    [courseFiltered, standard],
  );
  const tabQuestions = state.tab === "pending" ? pending : conquered;
  const groups = useMemo(
    () => groupWrongQuestions(tabQuestions, state.group),
    [tabQuestions, state.group],
  );

  // 重练（2026-10）：范围 = 当前 tab 的题（组头按钮传该组子集）；题目顺序 =
  // 圈定顺序（列表序）即组卷题序。成功后跳答题页；失败留错误横幅可重试
  // （重试按最近一次请求的题目集合重发）。scopeKey 标记正在提交的按钮。
  const [practiceScope, setPracticeScope] = useState<string | null>(null);
  const lastPracticeRef = useRef<{
    scope: string;
    ids: string[];
  } | null>(null);
  const practice = useMutation({
    mutationFn: (input: { scope: string; ids: string[] }) => {
      lastPracticeRef.current = input;
      return startWrongPracticeApi(input.ids);
    },
    onMutate: (input) => {
      setPracticeScope(input.scope);
    },
    onSuccess: (attempt) => {
      void navigate(`/s/attempts/${attempt.id}`);
    },
    onSettled: () => {
      setPracticeScope(null);
    },
  });
  const practiceQuestions = (scope: string, list: WrongQuestionCard[]) => {
    if (list.length === 0) return; // 空范围按钮本就禁用（防御）
    practice.mutate({
      scope,
      ids: list.map((question) => question.questionId),
    });
  };

  /** tab/分组变化：合并补丁写回 URL */
  function applyPatch(patch: Partial<WrongQuestionsUrlState>): void {
    void setSearchParams(wrongQuestionsUrlQuery({ ...state, ...patch }));
  }

  function changeStandard(next: WrongMasteryStandard): void {
    setStandard(next);
    saveWrongMasteryStandard(next);
  }

  return (
    <section aria-labelledby="wrong-title" className="flex flex-col gap-4">
      <StudentPageHeader
        icon={<BookX />}
        title="错题本"
        titleId="wrong-title"
        description="做错的题会自动收进来；做对了也不会删，攻克后随时可以回来翻看。"
        actions={
          // 重练全部：范围 = 当前 tab 且课程筛选后的全部题（数据未到时 0 题禁用）
          <WrongPracticeButton
            label="重练全部"
            count={tabQuestions.length}
            loading={practiceScope === "all"}
            onPractice={() => practiceQuestions("all", tabQuestions)}
          />
        }
      />

      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-3 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <WrongTabSwitch
            tab={state.tab}
            pendingCount={pending.length}
            conqueredCount={conquered.length}
            onSelect={(tab) => applyPatch({ tab })}
          />
          <div className="flex flex-wrap items-center gap-2">
            <WrongGroupSwitch
              group={state.group}
              onSelect={(group) => applyPatch({ group })}
            />
            <WrongCourseSelect
              courseId={state.courseId}
              courses={courses}
              coursesPending={coursesQuery.isPending}
              onChange={(courseId) => applyPatch({ courseId })}
            />
          </div>
        </div>
        <MasteryStandardPicker standard={standard} onChange={changeStandard} />
        {state.group === "knowledge" && (
          <p className="text-xs text-muted-foreground">
            多考点的题按第一个考点归组（完整考点清单在展开卡内）。
          </p>
        )}
      </div>

      {listQuery.isPending && <WrongSkeleton />}

      {listQuery.isError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-2xl border border-red-200 bg-card p-5 dark:border-red-500/30"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            错题本加载失败
          </p>
          <p className="text-sm text-muted-foreground">
            {listQuery.error instanceof Error
              ? listQuery.error.message
              : "网络异常，请稍后重试"}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => void listQuery.refetch()}
          >
            重试
          </Button>
        </div>
      )}

      {/* 重练失败（组卷请求被拒/网络异常）：错误横幅 + 按最近一次圈题重试 */}
      {practice.isError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-2xl border border-red-200 bg-card p-5 dark:border-red-500/30"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            重练组卷失败
          </p>
          <p className="text-sm text-muted-foreground">
            {practice.error instanceof Error
              ? practice.error.message
              : "网络异常，请稍后重试"}
            ；题目状态可能有变化，重试前也可以刷新错题本。
          </p>
          <div className="flex flex-wrap gap-2">
            {lastPracticeRef.current !== null && (
              <Button
                variant="default"
                className="min-h-11"
                onClick={() => {
                  const last = lastPracticeRef.current;
                  if (last !== null) practice.mutate(last);
                }}
              >
                重试
              </Button>
            )}
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => void listQuery.refetch()}
            >
              刷新错题本
            </Button>
          </div>
        </div>
      )}

      {listQuery.data &&
        (tabQuestions.length === 0 ? (
          <WrongEmpty
            tab={state.tab}
            standard={standard}
            hasAnyQuestion={questions.length > 0}
            courseFilterActive={state.courseId !== null}
          />
        ) : (
          groups.map((group) => (
            <section
              key={group.key}
              aria-labelledby={groupIdOf(group.key)}
              className="flex flex-col gap-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2
                  id={groupIdOf(group.key)}
                  aria-label={`${group.title} · ${groupCountLabel(state.tab, group.questions.length)}`}
                  className="flex flex-wrap items-center gap-2 text-sm font-semibold before:h-4 before:w-1 before:rounded-full before:bg-primary"
                >
                  <span className="min-w-0 truncate">{group.title}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {groupCountLabel(state.tab, group.questions.length)}
                  </span>
                </h2>
                {/* 重练本组：范围 = 该组在当前 tab 的题（空组不渲染——上方已分流） */}
                <WrongPracticeButton
                  compact
                  label="重练本组"
                  count={group.questions.length}
                  loading={practiceScope === `group:${group.key}`}
                  onPractice={() =>
                    practiceQuestions(`group:${group.key}`, group.questions)
                  }
                />
              </div>
              <ul className="flex flex-col gap-2">
                {group.questions.map((question) => {
                  const expanded = expandedId === question.questionId;
                  return (
                    <li
                      key={question.questionId}
                      className="flex flex-col gap-2"
                    >
                      <WrongQuestionRow
                        question={question}
                        expanded={expanded}
                        onToggle={() =>
                          setExpandedId(expanded ? null : question.questionId)
                        }
                      />
                      {expanded && <WrongQuestionItem question={question} />}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        ))}
    </section>
  );
}

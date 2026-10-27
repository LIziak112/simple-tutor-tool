import { useMutation } from "@tanstack/react-query";
import type { WrongPracticeScope, WrongQuestionCard } from "@tutor/contract";
import {
  BookX,
  Filter,
  ListChecks,
  PartyPopper,
  TriangleAlert,
  Trophy,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { workflowStartOptions } from "@/features/attempt/attempt-queries";
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
  filterWrongQuestions,
  filterWrongQuestionsByCourse,
  groupCountLabel,
  groupWrongQuestions,
  parseWrongQuestionsUrl,
  WrongCourseSelect,
  WrongFilterBar,
  WrongGroupSelectAll,
  WrongGroupSwitch,
  WrongPracticeButton,
  WrongQuestionItem,
  WrongQuestionRow,
  type WrongQuestionsUrlState,
  WrongSelectionBar,
  WrongTabSwitch,
  wrongKnowledgeOptions,
  wrongQuestionsUrlQuery,
} from "@/features/student/wrong-questions-ui";
import { startWrongPracticeApi } from "@/lib/api";

/**
 * /s/wrong 错题本（T3.5，D11；2026-10 IA 调整升为一级路由；2026-10 轮次史
 * 改版；2026-10 补重练；2026-10 补综合筛选与选题重练）：按 (学生, 题目) 跨
 * 作业 + 课程练习聚合。
 * - 数据策略：页面统一拉**全量形态**（includeResolved=true）一次，tab 归属、
 *   分组、攻克标准、综合筛选全部本地计算（服务端 knowledge/includeResolved
 *   参数保留兼容，本页不再使用）；
 * - 顶部两 tab：「待复习」（默认）/「已攻克」——做对的题永远不删，进已攻克
 *   分区随时可翻看；成员由本地攻克标准从轮次史（rounds）计算；
 * - 攻克标准学生自选（宽松=做对 1 次即攻克；严格=连续 2 次做对，默认），
 *   存本设备 localStorage（features/student/wrong-mastery.ts，与首页概览卡
 *   同一函数同一数据源，两处口径一致）；
 * - 分组维度：按练习（默认，按题目归属单元）/ 按时间（本周/上周/本月/更早）/
 *   按考点；组内按最近判定时间倒序；
 * - 课程筛选（2026-10）：页头「课程」下拉（默认全部课程，选项 = 我的课程
 *   接口，与我的记录页同源；加载失败不阻塞列表）。筛选口径 = rounds 任一轮
 *   courseId 命中（错题重练轮恒 null 不参与；跨课程的题任一轮命中即保留）；
 * - 综合筛选（2026-10）：考点（当前集合的考点分布）/ 时间（最近 7/30/90 个
 *   自然日，按最近判定时间）/ 错次（wrongCount ≥2/≥3）三个下拉与课程筛选
 *   **组合收窄**（综合筛选），作用于两个 tab 的成员与计数、全部重练入口的
 *   范围；活跃条件显示 chips，可单清或一键清除；考点/时间/错次同步 URL
 *   query（knowledge/days/wrongMin，刷新/返回不丢）；
 * - 条目默认紧凑行，点击展开完整卡片（含轮次史区块）；时间一律绝对时间
 *   （formatCnTime，Asia/Shanghai）；紧凑行示「错 N · 对 M」；轮次史尾部在
 *   pendingCount>0 时提示「另有 N 轮待老师批改」；
 * - **重练（2026-10）**：范围沿用当前 tab + 分组口径——页头「重练全部
 *   （N 题）」= 当前 tab 全部题；每个组头「重练本组（x 题）」= 该组在当前
 *   tab 的题；点击 POST /wrong-practice（题目顺序 = 圈定顺序）→ 跳
 *   /s/attempts/:attemptId 走既有答题会话；交卷后回本页自然看到轮次史新增
 *   一轮与攻克状态更新（聚合自动纳入）；
 * - **选题重练（2026-10）**：页头「选题重练」进入选择模式——行变复选、组头
 *   「全选本组」、底部 sticky 操作条「重练已选（N 题）」；选择跨分区、跨
 *   筛选保留（操作条提示不在当前列表的题数），取消选题/Esc 退出并清空；
 *   组卷范围快照 kind=selection（手选 N 题）；题序 = 列表序；
 * - tab、分组维度与全部筛选同步 URL query（刷新/返回不丢；旧参数兼容映射见
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

/** 空态（区分「还没有错题」/「筛选后为空」/「当前分区为空」并给出下一步动作） */
function WrongEmpty({
  tab,
  standard,
  hasAnyQuestion,
  courseFilterActive,
  compositeFilterActive,
  onClearAllFilters,
}: {
  tab: "pending" | "conquered";
  standard: WrongMasteryStandard;
  hasAnyQuestion: boolean;
  /** 课程筛选生效中 */
  courseFilterActive: boolean;
  /** 综合筛选（考点/时间/错次）生效中 */
  compositeFilterActive: boolean;
  /** 清除全部筛选（课程 + 综合） */
  onClearAllFilters: () => void;
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
  // 仅课程筛选时空态归因课程（既有口径与文案）；叠加综合筛选后按组合筛选归因
  if (courseFilterActive || compositeFilterActive) {
    if (!compositeFilterActive) {
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
        icon={<Filter />}
        title="当前筛选下没有错题"
        description="换一组筛选条件试试，或清除全部筛选看完整错题本。"
        action={
          <Button
            variant="outline"
            className="min-h-11"
            onClick={onClearAllFilters}
          >
            清除全部筛选
          </Button>
        }
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
  // 选题模式（2026-10）：selecting=模式开关；selected=已选题目 id 集合
  // （跨分区、跨筛选保留——筛选只影响可见性，不清选择）
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  // 全量形态一次拉取：tab/分组/全部筛选/攻克标准全在本地算（D11 口径：单学生
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
  // 综合筛选（课程 × 考点 × 时间 × 错次）在 tab 分流前生效：两个 tab 的成员
  // 与计数、全部重练入口的范围都跟随（state 是 URL 态快照，identity 随 query
  // 变化——切 tab/分组会重算一次过滤，D11 规模下可忽略）
  const filtered = useMemo(
    () => filterWrongQuestions(questions, state),
    [questions, state],
  );
  // 考点下拉选项只随课程筛选收窄（不被已选考点自身缩死，方便换考点）；深链的
  // 考点不在选项里时由筛选条内自算占位选项兜底
  const knowledgeOptions = useMemo(
    () =>
      wrongKnowledgeOptions(
        filterWrongQuestionsByCourse(questions, state.courseId),
      ),
    [questions, state.courseId],
  );
  const { pending, conquered } = useMemo(
    () => splitByMastery(filtered, standard),
    [filtered, standard],
  );
  const tabQuestions = state.tab === "pending" ? pending : conquered;
  const groups = useMemo(
    () => groupWrongQuestions(tabQuestions, state.group),
    [tabQuestions, state.group],
  );

  /** 选题勾选（单题与整组共用）：整组已全选则全部移除，否则全部补上 */
  function toggleSelectedIds(ids: readonly string[]): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allSelected) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
  }
  const selectedCount = selectedIds.size;
  const visibleSelectedCount = tabQuestions.filter((question) =>
    selectedIds.has(question.questionId),
  ).length;
  const allVisibleSelected =
    tabQuestions.length > 0 && visibleSelectedCount === tabQuestions.length;

  function enterSelecting(): void {
    setExpandedId(null); // 收起展开卡，聚焦选择
    setSelecting(true);
  }
  /** 退出选题模式并清空选择（「取消选题」与 Esc 共用；useCallback 稳定供 effect 依赖） */
  const exitSelecting = useCallback(() => {
    setSelecting(false);
    setSelectedIds(new Set());
  }, []);

  // Esc 退出选题模式（与「取消选题」同一动作）
  useEffect(() => {
    if (!selecting) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") exitSelecting();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selecting, exitSelecting]);

  // 重练（2026-10）：范围 = 当前 tab 的题（组头按钮传该组子集）；题目顺序 =
  // 圈定顺序（列表序）即组卷题序。成功后跳答题页；失败留错误横幅可重试
  // （重试按最近一次请求的题目集合重发）。scopeKey 标记正在提交的按钮。
  const [practiceScope, setPracticeScope] = useState<string | null>(null);
  const lastPracticeRef = useRef<{
    scope: string;
    ids: string[];
  } | null>(null);
  const practice = useMutation({
    mutationFn: (input: {
      scope: string;
      ids: string[];
      scopePayload?: WrongPracticeScope | undefined;
    }) => {
      lastPracticeRef.current = input;
      // M3-D1.5：执行时读本机偏好，显式进入新协议（教师约束服务端裁决）
      return startWrongPracticeApi(
        input.ids,
        workflowStartOptions(),
        input.scopePayload,
      );
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
  // #6980-2：三个重练入口随请求携带范围快照（all/group + 课程名），服务端
  // 落 attempts.practice_scope_json，记录/轮次史标题据此说明「练的是什么」
  const courseNameForScope =
    state.courseId !== null
      ? (courses.find((course) => course.id === state.courseId)?.name ??
        undefined)
      : undefined;
  const scopePayloadFor = (
    scopeKey: string,
    groupTitle: string | null,
    /** selection 口径的实际提交题数（缺省回落勾选计数） */
    count?: number,
  ): WrongPracticeScope | undefined => {
    if (scopeKey === "all") {
      return {
        kind: "all",
        ...(courseNameForScope !== undefined
          ? { courseName: courseNameForScope }
          : {}),
      };
    }
    if (scopeKey === "selection") {
      return {
        kind: "selection",
        // 实际提交的题数（由 practiceQuestions 按列表长度传入——refetch 后
        // 已选题可能失效，不能拿勾选计数当题数）
        ...(count !== undefined
          ? { questionCount: count }
          : { questionCount: selectedCount }),
        ...(courseNameForScope !== undefined
          ? { courseName: courseNameForScope }
          : {}),
      };
    }
    if (groupTitle !== null) {
      return {
        kind: "group",
        dimension: state.group,
        groupTitle,
        ...(courseNameForScope !== undefined
          ? { courseName: courseNameForScope }
          : {}),
      };
    }
    return undefined;
  };
  const practiceQuestions = (
    scope: string,
    list: WrongQuestionCard[],
    groupTitle: string | null = null,
  ) => {
    if (list.length === 0) return; // 空范围按钮本就禁用（防御）
    practice.mutate({
      scope,
      ids: list.map((question) => question.questionId),
      scopePayload: scopePayloadFor(scope, groupTitle, list.length),
    });
  };
  // 选题重练：题序 = 当前列表序在前，不在当前列表的已选题按全量列表序垫后；
  // 复用 practiceQuestions（同一 mutate 入口与范围快照组装）
  const practiceSelected = () => {
    const inListIds = new Set(
      filtered
        .filter((question) => selectedIds.has(question.questionId))
        .map((question) => question.questionId),
    );
    const inList = filtered.filter((question) =>
      inListIds.has(question.questionId),
    );
    const outOfList = questions.filter(
      (question) =>
        selectedIds.has(question.questionId) &&
        !inListIds.has(question.questionId),
    );
    practiceQuestions("selection", [...inList, ...outOfList], null);
  };

  /** tab/分组/筛选变化：合并补丁写回 URL */
  function applyPatch(patch: Partial<WrongQuestionsUrlState>): void {
    void setSearchParams(wrongQuestionsUrlQuery({ ...state, ...patch }));
  }

  /** 清除全部筛选（课程 + 考点 + 时间 + 错次） */
  function clearAllFilters(): void {
    applyPatch({
      courseId: null,
      knowledge: null,
      days: null,
      wrongMin: null,
    });
  }

  const compositeFilterActive =
    state.knowledge !== null || state.days !== null || state.wrongMin !== null;

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
          // 选题模式下常规入口让位给底部操作条
          !selecting && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                className="min-h-11 px-4"
                onClick={enterSelecting}
              >
                <ListChecks aria-hidden className="size-4" />
                选题重练
              </Button>
              {/* 重练全部：范围 = 当前 tab 且全部筛选后的题（数据未到时 0 题禁用） */}
              <WrongPracticeButton
                label="重练全部"
                count={tabQuestions.length}
                loading={practiceScope === "all"}
                onPractice={() => practiceQuestions("all", tabQuestions, null)}
              />
            </div>
          )
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
        {/* 综合筛选（2026-10）：考点 × 时间 × 错次组合收窄，与课程筛选叠加 */}
        <WrongFilterBar
          knowledge={state.knowledge}
          days={state.days}
          wrongMin={state.wrongMin}
          knowledgeOptions={knowledgeOptions}
          onChange={(patch) => applyPatch(patch)}
          onClearAll={() =>
            applyPatch({ knowledge: null, days: null, wrongMin: null })
          }
        />
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
            compositeFilterActive={compositeFilterActive}
            onClearAllFilters={clearAllFilters}
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
                {/* 组头动作：选题模式 = 全选本组；常规 = 重练本组（空组不渲染——上方已分流） */}
                {selecting ? (
                  <WrongGroupSelectAll
                    count={group.questions.length}
                    allSelected={group.questions.every((question) =>
                      selectedIds.has(question.questionId),
                    )}
                    onToggle={() =>
                      toggleSelectedIds(
                        group.questions.map((question) => question.questionId),
                      )
                    }
                  />
                ) : (
                  <WrongPracticeButton
                    compact
                    label="重练本组"
                    count={group.questions.length}
                    loading={practiceScope === `group:${group.key}`}
                    onPractice={() =>
                      practiceQuestions(
                        `group:${group.key}`,
                        group.questions,
                        group.title,
                      )
                    }
                  />
                )}
              </div>
              <ul className="flex flex-col gap-2">
                {group.questions.map((question) => {
                  const checked = selectedIds.has(question.questionId);
                  const expanded =
                    !selecting && expandedId === question.questionId;
                  return (
                    <li
                      key={question.questionId}
                      className="flex flex-col gap-2"
                    >
                      <WrongQuestionRow
                        question={question}
                        expanded={expanded}
                        onToggle={
                          selecting
                            ? () => toggleSelectedIds([question.questionId])
                            : () =>
                                setExpandedId(
                                  expanded ? null : question.questionId,
                                )
                        }
                        selection={selecting ? { checked } : undefined}
                      />
                      {expanded && <WrongQuestionItem question={question} />}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        ))}

      {/* 选题模式底部操作条（sticky bottom）：计数 + 全选当前列表 + 取消 + 重练已选 */}
      {selecting && (
        <WrongSelectionBar
          selectedCount={selectedCount}
          otherTabCount={selectedCount - visibleSelectedCount}
          allVisibleSelected={allVisibleSelected}
          visibleCount={tabQuestions.length}
          loading={practiceScope === "selection"}
          onToggleSelectAllVisible={() =>
            toggleSelectedIds(
              tabQuestions.map((question) => question.questionId),
            )
          }
          onPractice={practiceSelected}
          onCancel={exitSelecting}
        />
      )}
    </section>
  );
}

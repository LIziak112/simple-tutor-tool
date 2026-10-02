import { BookX, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { useStudentWrongQuestions } from "@/features/student/student-records-queries";
import {
  DEFAULT_WRONG_QUESTIONS_URL_STATE,
  IncludeResolvedSwitch,
  KnowledgeChips,
  parseWrongQuestionsUrl,
  WrongQuestionItem,
  type WrongQuestionsUrlState,
  wrongQuestionsUrlQuery,
} from "@/features/student/wrong-questions-ui";

/**
 * /s/wrong 错题本（T3.5，D11；2026-10 IA 调整升为一级路由，入口 = 顶栏导航
 * 与首页概览卡）：按 (学生, 题目) 跨作业 + 课程练习聚合的错题列表，按最近判定
 * 时间倒序。考点筛选 chips（选项从全量形态聚合，服务端 knowledge 精确匹配）
 * 与「显示已攻克」开关（includeResolved）都同步 URL query。默认只列「最近
 * 一次判定仍为错」的题；开关打开额外列出「曾错、最近一次已做对」（已攻克
 * 徽章）。三态齐全，触控目标 ≥44px。
 */

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
          className="h-36 animate-pulse rounded-xl border border-border bg-muted/50"
        />
      ))}
      <p className="text-sm text-muted-foreground">正在加载错题本…</p>
    </div>
  );
}

/** 空态（区分「还没有错题」/「当前考点无错题」/「已攻克列表为空」） */
function WrongEmpty({
  knowledge,
  includeResolved,
}: {
  knowledge: string | null;
  includeResolved: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
      {knowledge !== null ? (
        <>
          <p className="text-sm font-medium">当前考点下没有错题</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            换一个考点（或点「全部考点」）再看看。
          </p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium">
            {includeResolved ? "还没有攻克过的错题" : "还没有需要复习的错题"}
          </p>
          <p className="max-w-sm text-sm text-muted-foreground">
            做错的题会自动收进这里（等待老师批改的题先不算）；
            同一道题最近一次做对后就标记为「已攻克」。
          </p>
        </>
      )}
    </div>
  );
}

export default function StudentWrongQuestionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // URL query 是考点筛选与开关的单一事实来源（刷新与返回不丢）
  const state = useMemo(
    () => parseWrongQuestionsUrl(searchParams),
    [searchParams],
  );

  // 主列表：按当前 URL 状态查询（默认只列最近仍错）
  const listQuery = useStudentWrongQuestions({
    ...(state.knowledge !== null ? { knowledge: state.knowledge } : {}),
    includeResolved: state.includeResolved,
  });
  // 考点 chips 选项数据源：全量形态（含已攻克）聚合——与主列表参数不同、
  // 缓存互不影响；加载失败不阻塞（chips 只剩「全部考点」）
  const allQuery = useStudentWrongQuestions({
    includeResolved: true,
  });

  const knowledgeOptions = useMemo(() => {
    const names = new Set<string>();
    for (const question of allQuery.data?.questions ?? []) {
      for (const name of question.knowledge) {
        names.add(name);
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b, "zh"));
  }, [allQuery.data]);

  /** 筛选变化：合并补丁写回 URL */
  function applyPatch(patch: Partial<WrongQuestionsUrlState>): void {
    void setSearchParams(wrongQuestionsUrlQuery({ ...state, ...patch }));
  }

  function resetFilters(): void {
    void setSearchParams(
      wrongQuestionsUrlQuery(DEFAULT_WRONG_QUESTIONS_URL_STATE),
    );
  }

  return (
    <section aria-labelledby="wrong-title" className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1
            id="wrong-title"
            className="flex items-center gap-2 text-xl font-semibold"
          >
            <BookX aria-hidden className="size-5 text-primary" />
            错题本
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            作业和课程练习里做错的题都会收进来；同一道题最近一次做对后
            标记为「已攻克」。
          </p>
        </div>
      </header>

      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">考点</p>
          <div className="flex flex-wrap items-center gap-2">
            <IncludeResolvedSwitch
              checked={state.includeResolved}
              onToggle={(checked) => applyPatch({ includeResolved: checked })}
            />
            {(state.knowledge !== null || state.includeResolved) && (
              <Button
                variant="outline"
                className="min-h-11"
                onClick={resetFilters}
              >
                清除筛选
              </Button>
            )}
          </div>
        </div>
        {allQuery.isPending && (
          <p className="text-sm text-muted-foreground">正在加载考点选项…</p>
        )}
        <KnowledgeChips
          knowledge={state.knowledge}
          options={knowledgeOptions}
          onSelect={(knowledge) => applyPatch({ knowledge })}
        />
      </div>

      {listQuery.isPending && <WrongSkeleton />}

      {listQuery.isError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
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

      {listQuery.data &&
        (listQuery.data.questions.length === 0 ? (
          <WrongEmpty
            knowledge={state.knowledge}
            includeResolved={state.includeResolved}
          />
        ) : (
          <ol className="flex flex-col gap-3">
            {listQuery.data.questions.map((question) => (
              <li key={question.questionId}>
                <WrongQuestionItem question={question} />
              </li>
            ))}
          </ol>
        ))}
    </section>
  );
}

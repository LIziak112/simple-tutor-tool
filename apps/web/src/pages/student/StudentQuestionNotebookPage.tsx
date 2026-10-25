import { useQuery } from "@tanstack/react-query";
import type { NotebookRound, NotebookRoundContext } from "@tutor/contract";
import { displayStemMd } from "@tutor/md-dsl";
import {
  ArrowLeft,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  History,
  Layers,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { SolutionFold } from "@/features/attempt/AttemptResultView";
import {
  formatReferenceAnswers,
  letterOf,
} from "@/features/attempt/answer-format";
import {
  MaterialPanel,
  materialVersionKey,
  materialVersionNotesOf,
} from "@/features/attempt/MaterialPanel";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import {
  ReflectionColumns,
  sealedCorrectionsOf,
} from "@/features/notes/correction-display";
import { NoteOriginalView } from "@/features/notes/NoteOriginalView";
import { NoteVersionView } from "@/features/notes/NoteVersionView";
import {
  StudentEmptyState,
  StudentErrorPanel,
  StudentPageHeader,
} from "@/features/student/student-ui";
import { ApiError, fetchStudentNotebookApi } from "@/lib/api";
import { formatCnTime } from "@/lib/time";

/**
 * /s/notebook/:questionId 题目笔记本页（T6R.15 E，D7 聚合查询）：本人该题
 * 跨来源（作业 + 课程练习 + 错题重练）的**已交卷**轮次——每轮原稿区
 * （NoteOriginalView 按证据行定位）+ 订正列表（封存反思分栏 + 未封存
 * 「编辑中」）+ 补充稿列表（徽标 + 「交卷后找回的材料，不能证明交卷前已
 * 固定」说明）。轮次导航：上一轮/下一轮 + 轮次列表徽标直跳；默认展示
 * 最新一轮。契约零答案零解析零题干正文（AGENTS 第 3 条，服务端
 * studentNotebookDataSchema 口径）。三态齐全（加载/空/错误）。
 */

/** 笔记本查询键 */
export const studentNotebookKey = (questionId: string) =>
  ["student", "notebook", questionId] as const;

/**
 * 防御性时间格式化（闸门修复 F11）：契约 nullable 路径（补充稿/未封存行的
 * serverSavedAt、封存行的 sealedAt）真出现 null/空串时渲染空串而非
 * 「Invalid Date」垃圾串——服务端正常流程保证不可达，纯防御。
 */
function safeCnTime(utcIso: string | null | undefined): string {
  return utcIso == null || utcIso === "" ? "" : formatCnTime(utcIso);
}

export default function StudentQuestionNotebookPage() {
  const { questionId = "" } = useParams();
  const [params] = useSearchParams();
  const source = params.get("returnTo");
  // 只接受结果页路径，拒绝外站、路径穿越和其他角色页面。
  const returnTo =
    source &&
    /^\/s\/(?:attempts|assignments)\/[a-zA-Z0-9_-]+(?:[?#].*)?$/.test(source) &&
    !source.includes("\\")
      ? source
      : null;
  const back = (
    <Link
      to={returnTo ?? "/s/records"}
      className="flex min-h-11 w-fit items-center gap-2 rounded-lg border border-border px-3 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ArrowLeft aria-hidden className="size-4" />
      {returnTo ? "返回作答结果" : "返回我的记录"}
    </Link>
  );
  const notebookQuery = useQuery({
    queryKey: studentNotebookKey(questionId),
    queryFn: () => fetchStudentNotebookApi(questionId),
    enabled: questionId !== "",
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: (count, err) => !(err instanceof ApiError) && count < 2,
  });

  if (notebookQuery.isPending) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <div
          role="status"
          aria-label="正在加载题目笔记本"
          className="flex flex-col gap-3"
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-2xl border border-border bg-muted/60"
            />
          ))}
          <p className="text-sm text-muted-foreground">正在加载题目笔记本…</p>
        </div>
      </div>
    );
  }
  if (notebookQuery.isError || notebookQuery.data === undefined) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <StudentErrorPanel
          title="笔记本加载失败"
          message={
            notebookQuery.error instanceof Error
              ? notebookQuery.error.message
              : "网络异常，请稍后重试"
          }
          onRetry={() => void notebookQuery.refetch()}
        />
      </div>
    );
  }

  const { rounds } = notebookQuery.data;

  return (
    <div className="flex flex-col gap-4">
      {back}
      <StudentPageHeader
        icon={<History aria-hidden className="size-5" />}
        title="题目笔记本"
        description="这道题历次作答的原稿、订正与补充材料。"
      />
      {rounds.length === 0 ? (
        <StudentEmptyState
          icon={<BookOpen />}
          title="这道题还没有历史记录"
          description="交卷后的轮次会自动收进这里（作业、课程练习与错题重练都算）。"
          action={
            <Link
              to="/s/home"
              className="flex min-h-11 items-center rounded-lg border border-border px-4 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              返回首页
            </Link>
          }
        />
      ) : (
        <NotebookRounds rounds={rounds} questionId={questionId} />
      )}
    </div>
  );
}

/** 轮次导航 + 当前轮卡片（默认最新一轮；轮次序即服务端升序 roundOrdinal） */
function NotebookRounds({
  rounds,
  questionId,
}: {
  rounds: NotebookRound[];
  questionId: string;
}) {
  // null = 未选择（数据到达后默认最新一轮）；显式 0..n-1 为用户选择
  const [index, setIndex] = useState<number | null>(null);
  // 数据变化（重试/刷新产生新数组）时回到最新一轮——渲染期调整派生态
  // （React 官方「reset state when props change」形态，免 effect 双渲染）
  const [seenRounds, setSeenRounds] = useState(rounds);
  if (seenRounds !== rounds) {
    setSeenRounds(rounds);
    setIndex(null);
  }
  const current = index ?? rounds.length - 1;
  const round = rounds[current];
  if (round === undefined) {
    return <p className="text-sm text-muted-foreground">没有可显示的轮次。</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="轮次导航" className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={current === 0}
          aria-label="上一轮"
          onClick={() => setIndex(Math.max(0, current - 1))}
        >
          <ChevronLeft aria-hidden className="size-4" />
          上一轮
        </Button>
        <div className="flex flex-wrap items-center gap-1.5">
          {rounds.map((r, i) => (
            <Button
              key={r.attemptId}
              type="button"
              variant={i === current ? "secondary" : "ghost"}
              aria-pressed={i === current}
              className="h-11"
              onClick={() => setIndex(i)}
            >
              第 {r.roundOrdinal} 次
            </Button>
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={current === rounds.length - 1}
          aria-label="下一轮"
          onClick={() => setIndex(Math.min(rounds.length - 1, current + 1))}
        >
          下一轮
          <ChevronRight aria-hidden className="size-4" />
        </Button>
      </nav>

      {/* key 按轮隔离实例：SolutionFold 展开态等轮内 UI 状态不跨轮残留 */}
      <RoundCard key={round.attemptId} round={round} questionId={questionId} />
    </div>
  );
}

/**
 * 该轮来源材料/题组（QM-15 细项 1/4）：开卷时冻结的依赖闭包投影——材料
 * 子题从历史再次打开可独立理解的数据源。内容恒来自该轮冻结快照（服务端
 * 纯读 attempt_context_snapshots，零 live 回退），老师之后改稿/删除不影响
 * 这里展示；同材料多版本并存时逐版标注（materialVersionNotesOf）。
 * 组头说明在前、材料面板随后（单列只读阅读，与讲练组块同理由不挂跳转）。
 */
function RoundContextSection({ context }: { context: NotebookRoundContext }) {
  const versionNotes = useMemo(
    () => materialVersionNotesOf(context.materials),
    // 组多版本徽标同构（TT-11 P3-③顺手修）：materialVersionNotesOf 按
    // {id, sourceVersion} 泛化工作，组的双版本题头同样可分辨——不另写一套
    [context.materials],
  );
  const groupVersionNotes = useMemo(
    () => materialVersionNotesOf(context.groups),
    [context],
  );
  return (
    <section aria-label="来源材料与题组" className="flex flex-col gap-2">
      <p className="text-sm font-medium">来源材料与题组</p>
      <p className="text-xs text-muted-foreground">
        这一轮作答时看到的材料与题组（开卷时冻结），老师后来的改动不影响这里的展示。
      </p>
      <div className="flex flex-col gap-3">
        {context.groups.map((group) => {
          const title = group.title?.trim();
          const label = group.label?.trim();
          const intro = group.introMd.trim();
          const groupVersionNote = groupVersionNotes.get(
            materialVersionKey(group),
          );
          return (
            <header
              key={`${group.id}|${group.sourceVersion}`}
              className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-muted/30 px-4 py-3"
            >
              <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-semibold">
                <Layers aria-hidden className="size-4 shrink-0" />
                {title && title.length > 0 ? title : "题组"}
                {label && label.length > 0 && (
                  <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                    {label}
                  </span>
                )}
                {groupVersionNote !== undefined && (
                  <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                    {groupVersionNote}
                  </span>
                )}
              </p>
              {intro.length > 0 && (
                <div className="rich-markdown min-w-0 text-sm leading-7">
                  <RichMarkdown source={intro} />
                </div>
              )}
            </header>
          );
        })}
        {context.materials.map((material) => (
          <MaterialPanel
            key={materialVersionKey(material)}
            material={material}
            versionNote={versionNotes.get(materialVersionKey(material))}
          />
        ))}
      </div>
    </section>
  );
}

/** 单轮卡片：徽标/来源/时间/题目版本 + 原稿区 + 订正列表 + 补充稿列表 */
function RoundCard({
  round,
  questionId,
}: {
  round: NotebookRound;
  questionId: string;
}) {
  // 已封存段经共享谓词收窄（sealedAt: string，闸门修复 F12）；未封存行殿后
  const sealed = sealedCorrectionsOf(round.corrections);
  const openRows = round.corrections.filter((row) => row.sealedAt == null);
  return (
    <article
      className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-xs sm:p-5"
      aria-label={`第 ${round.roundOrdinal} 次作答`}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
          第 {round.roundOrdinal} 次
        </span>
        <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
          {round.sourceLabel}
        </span>
        <span className="text-xs text-muted-foreground">
          交卷时间：{formatCnTime(round.submittedAt)}
        </span>
        {round.questionVersion !== null && (
          <span
            className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
            title="这道题在题库中的版本号（改版对照用）"
          >
            题目 v{round.questionVersion}
          </span>
        )}
        <Link
          to={`/s/attempts/${round.attemptId}`}
          className="ml-auto flex min-h-11 items-center rounded-lg px-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          查看这一轮
        </Link>
      </header>

      {/* 来源材料/题组（该轮冻结闭包投影；无冻结依赖不渲染整区） */}
      {round.context !== null && (
        <RoundContextSection context={round.context} />
      )}

      {/* 题目区（冻结快照脱敏投影；快照缺失占位引导回完整结果页） */}
      <section aria-label="题目" className="flex flex-col gap-2">
        <p className="text-sm font-medium">题目</p>
        {round.question === null ? (
          <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
            这一轮的历史题目快照缺失，可点击右上角「查看这一轮」进入完整结果页查看。
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3 sm:p-4">
            {/* 题干（服务端已脱敏，displayStemMd 兜底剥内嵌选项列表） */}
            <RichMarkdown
              source={displayStemMd(round.question)}
              className="text-base"
            />
            {/* 选项纯文本列表：不依据答案做任何高亮（公布状态由解析区承载） */}
            {round.question.options && round.question.options.length > 0 && (
              <ol className="flex flex-col gap-1.5" aria-label="选项">
                {round.question.options.map((option, idx) => (
                  <li
                    key={option}
                    className="flex min-h-11 items-start gap-2 rounded-lg border border-transparent px-3 py-1.5 text-sm"
                  >
                    <span className="mt-0.5 w-5 shrink-0 font-semibold text-muted-foreground">
                      {letterOf(idx)}.
                    </span>
                    <RichMarkdown
                      source={option}
                      className="min-w-0 flex-1 text-sm [&_p]:my-0"
                    />
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </section>

      {/* 解析区（按来源公布 gate 受控下发；未公布 fail-closed 占位。快照缺失
          轮的解析永远无从下发，整区不渲染，避免「还未公布」的误导） */}
      {round.question !== null && (
        <section aria-label="解析" className="flex flex-col gap-2">
          <p className="text-sm font-medium">参考答案与解析</p>
          {round.release === null ? (
            <div className="rounded-lg border border-border bg-muted/30 px-3.5 py-2.5 text-xs text-muted-foreground">
              这一轮的答案还未公布，公布后可在此直接查看参考答案与详解。
            </div>
          ) : (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3 sm:p-4">
              <div className="flex min-w-0 flex-wrap items-baseline gap-2 text-sm">
                <span className="shrink-0 font-medium text-muted-foreground">
                  正确答案：
                </span>
                {round.release.answers === null ? (
                  <span className="text-muted-foreground">
                    本题无标准参考答案（主观题由老师批改）
                  </span>
                ) : (
                  <RichMarkdown
                    source={formatReferenceAnswers(round.release.answers)}
                    className="min-w-0 font-medium [&_p]:my-0"
                  />
                )}
              </div>
              <SolutionFold solutionMd={round.release.solutionMd} />
            </div>
          )}
        </section>
      )}

      {/* 原稿区（按证据行定位该轮原稿；软删题历史可读） */}
      <section aria-label="原稿" className="flex flex-col gap-2">
        <p className="text-sm font-medium">原稿</p>
        <NoteOriginalView
          viewer="student"
          attemptId={round.attemptId}
          questionId={questionId}
          roundLabel={`第 ${round.roundOrdinal} 次`}
          ariaPrefix={`第 ${round.roundOrdinal} 轮`}
        />
      </section>

      {/* 订正列表（封存反思分栏 + 未封存「编辑中」；编辑入口在结果页） */}
      <section aria-label="订正" className="flex flex-col gap-2">
        <p className="text-sm font-medium">
          订正（{round.corrections.length} 份）
        </p>
        {round.corrections.length === 0 ? (
          <p className="text-xs text-muted-foreground">这一轮没有订正。</p>
        ) : (
          <div className="flex flex-col gap-2">
            {sealed.map((row) => (
              <div
                key={row.noteId}
                className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5"
              >
                <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>封存于 {safeCnTime(row.sealedAt)}</span>
                </p>
                <ReflectionColumns row={row} />
                <NoteVersionView
                  viewer="student"
                  versionId={row.currentVersionId}
                  title="订正"
                  openLabel="查看订正"
                  savedAtLabel="封存于"
                  savedAt={row.sealedAt}
                  revision={row.revision}
                  ariaPrefix={`第 ${round.roundOrdinal} 轮`}
                />
              </div>
            ))}
            {openRows.map((row) => (
              <div
                key={row.noteId}
                className="flex flex-col gap-2 rounded-lg border border-dashed border-border px-3 py-2.5"
              >
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 font-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
                    编辑中
                  </span>
                  <span>还没保存定格的订正，去这份卷子的结果页继续编辑。</span>
                </p>
                <NoteVersionView
                  viewer="student"
                  versionId={row.currentVersionId}
                  title="订正"
                  openLabel="查看订正"
                  savedAtLabel="保存于"
                  savedAt={row.serverSavedAt ?? ""}
                  revision={row.revision}
                  ariaPrefix={`第 ${round.roundOrdinal} 轮`}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 补充稿列表（交卷后找回；不进原稿位） */}
      <section aria-label="补充稿" className="flex flex-col gap-2">
        <p className="text-sm font-medium">
          补充稿（{round.supplements.length} 份）
        </p>
        {round.supplements.length === 0 ? (
          <p className="text-xs text-muted-foreground">这一轮没有补充稿。</p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              交卷后找回的材料，不能证明交卷前已固定。
            </p>
            {round.supplements.map((row) => (
              <div
                key={row.noteId}
                className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5"
              >
                <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-foreground">
                    补充稿
                  </span>
                  <span>保存于 {safeCnTime(row.serverSavedAt)}</span>
                </p>
                <NoteVersionView
                  viewer="student"
                  versionId={row.currentVersionId}
                  title="补充稿"
                  openLabel="查看补充稿"
                  savedAtLabel="保存于"
                  savedAt={row.serverSavedAt ?? ""}
                  revision={row.revision}
                  ariaPrefix={`第 ${round.roundOrdinal} 轮`}
                />
              </div>
            ))}
          </div>
        )}
      </section>
    </article>
  );
}

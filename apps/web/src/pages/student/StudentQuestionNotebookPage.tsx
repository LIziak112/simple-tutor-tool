import { useQuery } from "@tanstack/react-query";
import type { NotebookRound } from "@tutor/contract";
import { BookOpen, ChevronLeft, ChevronRight, History } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { Button } from "@/components/ui/button";
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
    );
  }
  if (notebookQuery.isError || notebookQuery.data === undefined) {
    return (
      <StudentErrorPanel
        title="笔记本加载失败"
        message={
          notebookQuery.error instanceof Error
            ? notebookQuery.error.message
            : "网络异常，请稍后重试"
        }
        onRetry={() => void notebookQuery.refetch()}
      />
    );
  }

  const { rounds } = notebookQuery.data;

  return (
    <div className="flex flex-col gap-4">
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

      <RoundCard round={round} questionId={questionId} />
    </div>
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

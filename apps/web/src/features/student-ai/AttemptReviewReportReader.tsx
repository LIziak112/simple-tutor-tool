import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiAttemptReviewDetailData } from "@tutor/contract";
import { type ReactNode, useEffect, useRef } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  fetchStudentAiAttemptReviewDetailApi,
  postStudentAiAttemptReviewActionApi,
} from "@/lib/api";
import { formatCnTime } from "@/lib/time";
import { studentAiQueueSummaryKey } from "./ai-queue-queries";
import {
  ATTEMPT_REVIEW_STATUS_LABEL,
  attemptReviewDetailKey,
  attemptReviewHref,
  attemptReviewListKey,
  attemptReviewQueueKey,
} from "./attempt-review-entry";
import { errorMessageOf } from "./error-text";

/**
 * 整卷复盘报告阅读器：手机上全屏、桌面居中宽版；头部写明是哪份卷的哪一次，
 * 正文分节，底部固定「关闭，回到作答结果」。
 *
 * 已读口径（只有这里写）：详情接口本轮成功（服务端已过当前交卷 / 公布 /
 * 教学授权门）、报告正文存在、且报告属于当前这次作答——三者都满足并渲染出
 * 正文后才调用一次 open。浏览记录、看进度、取详情失败都不写已读。
 * 详情不留缓存（gcTime 0）且只认本轮 isSuccess：权限被收回后不拿旧正文继续展示。
 */

type Report = NonNullable<AiAttemptReviewDetailData["result"]>;
type Finding = Report["knowledgeFindings"][number];

const CONFIDENCE_LABEL = { high: "高", medium: "中", low: "低" } as const;
const PRIORITY_LABEL = {
  high: "优先",
  medium: "其次",
  low: "有空再做",
} as const;

/** 题号按钮组：点题号关闭报告并回到那道题 */
function QuestionNoChips({
  label,
  questionNos,
  onJump,
}: {
  label: string;
  questionNos: readonly number[];
  onJump: (questionNo: number) => void;
}) {
  if (questionNos.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {questionNos.map((questionNo) => (
        <Button
          key={questionNo}
          type="button"
          variant="outline"
          className="h-9 min-w-11 px-2 text-xs"
          onClick={() => onJump(questionNo)}
        >
          第 {questionNo} 题
        </Button>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-base font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function FindingSection({
  title,
  findings,
  onJump,
}: {
  title: string;
  findings: readonly Finding[];
  onJump: (questionNo: number) => void;
}) {
  if (findings.length === 0) return null;
  return (
    <Section title={title}>
      <ul className="flex flex-col gap-2.5">
        {findings.map((finding, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: 报告是只读静态列表、不重排；正文是不可信输入，条目文字可能重复，不能当键
            key={index}
            className="flex flex-col gap-2 rounded-xl border border-border bg-background p-3"
          >
            <p className="text-[15px] leading-7 break-words">
              {finding.statement}
            </p>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span
                className={`rounded px-1.5 py-0.5 font-medium ${
                  finding.basis === "platform_fact"
                    ? "bg-muted text-foreground/80"
                    : "border border-dashed border-border"
                }`}
              >
                {finding.basis === "platform_fact" ? "平台事实" : "AI 推测"}
              </span>
              <span>把握：{CONFIDENCE_LABEL[finding.confidence]}</span>
            </div>
            <QuestionNoChips
              label="依据"
              questionNos={finding.evidenceQuestionNos}
              onJump={onJump}
            />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ReportBody({
  report,
  onJump,
}: {
  report: Report;
  onJump: (questionNo: number) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Section title="总览">
        <p className="text-[15px] leading-7 break-words whitespace-pre-wrap">
          {report.overview}
        </p>
      </Section>
      {report.trainingPlan.length > 0 && (
        <Section title="接下来怎么练">
          <ol className="flex flex-col gap-2.5">
            {report.trainingPlan.map((item, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: 报告是只读静态列表、不重排；正文是不可信输入，条目文字可能重复，不能当键
                key={index}
                className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 font-medium text-primary">
                    {PRIORITY_LABEL[item.priority]}
                  </span>
                  {item.knowledgePoint !== null && (
                    <span className="text-muted-foreground">
                      {item.knowledgePoint}
                    </span>
                  )}
                </div>
                <p className="text-[15px] leading-7 break-words">
                  {item.action}
                </p>
                {item.caveat !== null && (
                  <p className="text-sm text-muted-foreground">
                    注意：{item.caveat}
                  </p>
                )}
                <QuestionNoChips
                  label="相关"
                  questionNos={item.relatedQuestionNos}
                  onJump={onJump}
                />
              </li>
            ))}
          </ol>
        </Section>
      )}
      <FindingSection
        title="知识点"
        findings={report.knowledgeFindings}
        onJump={onJump}
      />
      <FindingSection
        title="错误模式"
        findings={report.errorPatterns}
        onJump={onJump}
      />
      <FindingSection
        title="作答表现"
        findings={report.performanceNotes}
        onJump={onJump}
      />
      {report.limitations.length > 0 && (
        <Section title="这份报告的局限">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
            {report.limitations.map((item, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 报告是只读静态列表、不重排；正文是不可信输入，条目文字可能重复，不能当键
              <li key={index}>{item}</li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

export function AttemptReviewReportReader({
  attemptId,
  taskId,
  attemptLabel,
  onClose,
  onJumpToQuestion,
  onOpenPanel,
}: {
  /** 当前结果页的作答 id：报告必须属于它才显示正文 */
  readonly attemptId: string;
  readonly taskId: string;
  /** 卷名 · 第几次 · 交卷时间（由结果页给出，让学生确认看的是哪一次） */
  readonly attemptLabel: string;
  readonly onClose: () => void;
  /** 点证据题号：调用方负责关闭报告并定位到该题 */
  readonly onJumpToQuestion: (questionNo: number) => void;
  /** 转去发起 / 进度面板（报告未生成、想重新发起或归档时） */
  readonly onOpenPanel: () => void;
}) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: attemptReviewDetailKey(taskId),
    queryFn: () => fetchStudentAiAttemptReviewDetailApi(taskId),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  // 只认本轮成功：重取被拒绝时 TanStack 仍保留上次 data，不能继续展示
  const detail = detailQuery.isSuccess ? detailQuery.data : null;
  const belongsHere = detail !== null && detail.task.attemptId === attemptId;
  const report = belongsHere ? (detail?.result ?? null) : null;
  const unread = report !== null && detail?.task.openedAt === null;

  // 同一份报告只记一次：open 每调用一次服务端都会追加一条「已打开」事实
  const markedTaskId = useRef<string | null>(null);
  useEffect(() => {
    if (!unread || markedTaskId.current === taskId) return;
    markedTaskId.current = taskId;
    void postStudentAiAttemptReviewActionApi(taskId, "open")
      .then(() => {
        for (const queryKey of [
          attemptReviewListKey(attemptId),
          attemptReviewQueueKey,
          studentAiQueueSummaryKey,
        ]) {
          void queryClient.invalidateQueries({ queryKey });
        }
      })
      .catch(() => {
        // 记已读失败不打断阅读：入口保持「未读」，下次打开再记
        markedTaskId.current = null;
      });
  }, [unread, taskId, attemptId, queryClient]);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="top-0 left-0 flex h-dvh max-h-dvh max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[88vh] sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border"
        aria-describedby="attempt-review-report-identity"
      >
        <header className="flex flex-col gap-1 border-b border-border py-3 pr-14 pl-4 sm:pl-6">
          <DialogTitle className="text-lg leading-snug">
            整卷复盘报告
          </DialogTitle>
          <DialogDescription
            id="attempt-review-report-identity"
            className="break-words"
          >
            {attemptLabel}
            {report !== null && detail !== null && (
              <>
                {" · "}覆盖 {detail.task.questionCount} 题 · 报告于{" "}
                {formatCnTime(detail.task.updatedAt)}
              </>
            )}
          </DialogDescription>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
          {detailQuery.isPending ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              正在核对权限并打开报告…
            </p>
          ) : detail === null ? (
            <p role="alert" className="py-6 text-sm text-destructive">
              {errorMessageOf(detailQuery.error, "报告暂时打不开，请稍后重试")}
            </p>
          ) : !belongsHere ? (
            <div className="flex flex-col items-start gap-3 py-6">
              <p className="text-sm">
                这份报告属于另一次作答，不在当前这份作答结果里显示。
              </p>
              <Button asChild className="min-h-11">
                <Link to={attemptReviewHref(detail.task.attemptId, taskId)}>
                  前往对应的作答结果
                </Link>
              </Button>
            </div>
          ) : report === null ? (
            <div className="flex flex-col items-start gap-3 py-6">
              <p className="text-sm">
                报告还没生成：
                {ATTEMPT_REVIEW_STATUS_LABEL[detail.task.status]}。
              </p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={onOpenPanel}
              >
                查看进度
              </Button>
            </div>
          ) : (
            <ReportBody report={report} onJump={onJumpToQuestion} />
          )}
        </div>
        <footer className="flex flex-col-reverse gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:flex-row sm:items-center sm:justify-between sm:px-6">
          {report !== null ? (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 text-sm text-muted-foreground"
              onClick={onOpenPanel}
            >
              重新发起或归档
            </Button>
          ) : (
            <span />
          )}
          <Button type="button" className="min-h-11 px-5" onClick={onClose}>
            关闭，回到作答结果
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

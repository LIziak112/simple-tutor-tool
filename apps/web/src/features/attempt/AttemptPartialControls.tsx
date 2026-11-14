import { useQueryClient } from "@tanstack/react-query";
import type {
  AttemptDraftData,
  AttemptPartialRequest,
  AttemptSettlementResult,
  PracticeQuestionProgress,
  StudentAnswer,
} from "@tutor/contract";
import {
  lazy,
  type RefObject,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { randomUuid } from "@/lib/uuid";
import { isAnswered } from "./answer-format";
import {
  pauseAttemptDetailPolling,
  resumeAttemptDetailPolling,
  studentAttemptKey,
} from "./attempt-queries";
import { inkStrokeCountOf } from "./draft-merge";
import { draftStore } from "./draft-store";
import { prepareQuestionSubmission } from "./prepare-question-submission";
import { readSettlement, settleAttempt } from "./settlement-api";
import type { InkUploadController } from "./use-ink-upload";

const ResultCard = lazy(async () => ({
  default: (await import("./ResultQuestionCard")).ResultQuestionCard,
}));

type SaveInput = Omit<
  Parameters<typeof prepareQuestionSubmission>[0],
  "attemptId" | "questionIds" | "allowMissing"
>;
export function AttemptPartialControls({
  data,
  answers,
  progress,
  disabled,
  groups = [],
  beforeSubmit,
  ...saving
}: SaveInput & {
  data: AttemptDraftData;
  answers: Readonly<Record<string, StudentAnswer>> | null;
  progress: readonly PracticeQuestionProgress[];
  groups?: readonly {
    id: string;
    title?: string | undefined;
    questionIds: readonly string[];
  }[];
  disabled: boolean;
  beforeSubmit: () => Promise<boolean>;
  inkControllers: RefObject<Map<string, InkUploadController>>;
}) {
  const attemptId = data.attempt.id;
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewingSeq, setViewingSeq] = useState<number | null>(null);
  const [result, setResult] = useState<AttemptSettlementResult | null>(null);
  const pending = useRef<AttemptPartialRequest | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      resumeAttemptDetailPolling(attemptId);
    };
  }, [attemptId]);
  const questions = data.units.flatMap((unit) => unit.questions);
  const submitted = new Set(
    progress
      .filter((row) => row.submittedAt !== null)
      .map((row) => row.questionId),
  );
  const eligible = questions.filter(
    (q) =>
      !submitted.has(q.id) &&
      (isAnswered(answers?.[q.id]) ||
        (() => {
          const doc = draftStore.peekInk(attemptId, q.id);
          return doc !== null && inkStrokeCountOf(doc) > 0;
        })()),
  );
  const unassigned = [...submitted].filter(
    (id) => data.settlementProgress?.membership[id] === undefined,
  ).length;
  const canSubmit = data.practiceWorkflow?.canSettlePartially === true;
  const close = () => {
    if (busy) return;
    setOpen(false);
    pending.current = null;
    resumeAttemptDetailPolling(attemptId);
    void client.invalidateQueries({ queryKey: studentAttemptKey(attemptId) });
  };
  const begin = async () => {
    if (!(await beforeSubmit()) || !active.current) return;
    setViewingSeq(null);
    setSelected(eligible.map((q) => q.id));
    setError(null);
    setResult(null);
    pending.current = null;
    pauseAttemptDetailPolling(attemptId);
    setOpen(true);
  };
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!pending.current) {
        const prep = await prepareQuestionSubmission({
          ...saving,
          attemptId,
          questionIds: selected,
        });
        if (!active.current) return;
        if (!prep.declarations)
          throw new Error(
            prep.problems[0]?.reason ?? "草稿尚未保存完整，请同步后重试",
          );
        const record = await draftStore.loadDraft(attemptId);
        pending.current = {
          workflowVersion: 1,
          workflowRevision: data.practiceWorkflow?.revision ?? 0,
          mutationId: randomUuid(),
          questions: selected.map((id) => {
            const question = questions.find((q) => q.id === id);
            const evidence = prep.declarations?.find(
              (e) => e.questionId === id,
            );
            if (!question || !evidence)
              throw new Error("题目或草稿版本缺失，请刷新后重试");
            return {
              questionId: id,
              questionRevisionId: question.questionRevisionId,
              expectedAnswerRevision:
                record?.answerRevisions?.[id] ?? data.draftRevisions?.[id] ?? 0,
              evidence,
            };
          }),
        };
      }
      await client.cancelQueries({
        queryKey: studentAttemptKey(attemptId),
        exact: true,
      });
      if (!active.current) return;
      const received = await settleAttempt(attemptId, pending.current);
      if (active.current) setResult(received);
    } catch (err) {
      if (active.current)
        setError(err instanceof Error ? err.message : "提交失败，请重试原请求");
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const view = async (seq: number) => {
    setViewingSeq(seq);
    setOpen(true);
    setResult(null);
    setError(null);
    setBusy(true);
    try {
      const received = await readSettlement(attemptId, seq);
      if (active.current) setResult(received);
    } catch (err) {
      if (active.current)
        setError(err instanceof Error ? err.message : "读取本批结果失败");
    } finally {
      if (active.current) setBusy(false);
    }
  };
  return (
    <section
      aria-label="分批提交"
      className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
    >
      {canSubmit && (
        <Button
          variant="outline"
          disabled={disabled || eligible.length + unassigned === 0}
          onClick={() => void begin()}
        >
          提交已做的 {eligible.length + unassigned} 题
        </Button>
      )}
      {data.settlementProgress?.settlements.map((settlement) => (
        <Button
          key={settlement.seq}
          variant="ghost"
          onClick={() => void view(settlement.seq)}
        >
          第 {settlement.seq} 批 · {settlement.questionCount} 题
        </Button>
      ))}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <DialogContent
          className="max-h-[85dvh] max-w-3xl overflow-y-auto"
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {result || viewingSeq !== null
                ? `第 ${result?.settlement.seq ?? viewingSeq} 批结果`
                : "确认分批提交"}
            </DialogTitle>
            <DialogDescription>
              {result
                ? "仅显示本批已提交的题目，关闭后可继续剩余题目。"
                : "所选题目提交后将锁定；未选题目留到下次。上次结算后已逐题提交的题目会并入本批。"}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {result ? (
            <Suspense fallback={<p>正在加载本批结果…</p>}>
              <p className="text-sm">
                本批用时：
                {result.settlement.activeSec === null
                  ? "暂无可靠记录"
                  : `${result.settlement.activeSec} 秒`}
              </p>
              {result.questions.map((question, index) => (
                <ResultCard
                  key={question.questionId}
                  index={
                    (result.questionNos?.[question.questionId] ?? index + 1) - 1
                  }
                  question={question}
                  attemptId={attemptId}
                  released={result.answersReleased}
                  completedTools={false}
                  roundLabel={`第 ${result.settlement.seq} 批`}
                  activity={null}
                />
              ))}
            </Suspense>
          ) : viewingSeq !== null ? (
            <Button disabled={busy} onClick={() => void view(viewingSeq)}>
              重试读取本批结果
            </Button>
          ) : (
            <>
              {groups
                .filter(
                  (group) =>
                    group.questionIds.some((id) => selected.includes(id)) &&
                    group.questionIds.some(
                      (id) => !selected.includes(id) && !submitted.has(id),
                    ),
                )
                .map((group) => (
                  <p key={group.id} className="text-sm text-muted-foreground">
                    {group.title ?? "这组"}还有{" "}
                    {
                      group.questionIds.filter(
                        (id) => !selected.includes(id) && !submitted.has(id),
                      ).length
                    }{" "}
                    题没提交。
                  </p>
                ))}
              <div className="space-y-1">
                {eligible.map((q) => (
                  <label
                    key={q.id}
                    className="flex min-h-11 items-center gap-2"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(q.id)}
                      disabled={busy || pending.current !== null}
                      onChange={(event) =>
                        setSelected((ids) =>
                          event.target.checked
                            ? [...ids, q.id]
                            : ids.filter((id) => id !== q.id),
                        )
                      }
                    />
                    第 {questions.indexOf(q) + 1} 题
                  </label>
                ))}
              </div>
              <p className="text-sm text-muted-foreground">
                共提交 {selected.length + unassigned}{" "}
                题；覆盖全部剩余题时将完成整卷。
              </p>
              <Button
                disabled={
                  busy || disabled || selected.length + unassigned === 0
                }
                onClick={() => void submit()}
              >
                {busy
                  ? "正在保存并提交…"
                  : pending.current
                    ? "重试原请求"
                    : "确认提交"}
              </Button>
            </>
          )}
          <Button variant="outline" disabled={busy} onClick={close}>
            继续作答
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  );
}

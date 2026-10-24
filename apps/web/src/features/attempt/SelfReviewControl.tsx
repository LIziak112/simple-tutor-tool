import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AttemptResultQuestion,
  SelfReviewData,
  SelfReviewRequest,
} from "@tutor/contract";
import { hasReferenceAnswer } from "@tutor/contract";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { saveSelfReviewApi } from "@/lib/api";
import { getDraftSessionEpoch } from "./draft-store";

/** 对照声明与自动/教师判断明确分开；失败保留现场并复用请求标识。 */
export function SelfReviewControl({
  attemptId,
  question,
  preserveAttemptView = false,
}: {
  attemptId: string;
  question: AttemptResultQuestion;
  preserveAttemptView?: boolean;
}) {
  const client = useQueryClient();
  const incoming = question.selfReview;
  const queryKey = [
    "student",
    "self-review",
    attemptId,
    question.questionId,
  ] as const;
  const { data: saved } = useQuery<SelfReviewData | null>({
    queryKey,
    queryFn: async () => null,
    initialData: null,
    enabled: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<SelfReviewRequest | null>(null);
  const scope = `${attemptId}:${question.questionId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    scopeRef.current = scope;
    requestRef.current = null;
    setError(null);
    setBusy(false);
  }, [scope]);
  const state =
    saved && (!incoming || saved.review.revision >= incoming.revision)
      ? saved.review
      : incoming;
  const correct =
    saved && state === saved.review
      ? saved.finalCorrect
      : (question.finalCorrect ?? question.autoCorrect);
  if (!state) return null;

  const save = async (mark: boolean | null) => {
    if (busy) return;
    const epoch = getDraftSessionEpoch();
    const revision = state.revision;
    const pending = requestRef.current;
    const request =
      pending && pending.mark === mark && pending.baseRevision === revision
        ? pending
        : { mark, baseRevision: revision, mutationId: crypto.randomUUID() };
    requestRef.current = request;
    setBusy(true);
    setError(null);
    try {
      const result = await saveSelfReviewApi(
        attemptId,
        question.questionId,
        request,
      );
      if (
        !mounted.current ||
        scopeRef.current !== scope ||
        getDraftSessionEpoch() !== epoch
      )
        return;
      client.setQueryData(queryKey, result);
      requestRef.current = null;
      // 结果、错题和教师待处理均由服务端事实刷新；不把自评当作题目提交。
      await client.invalidateQueries({
        queryKey: ["student"],
        predicate: (query) =>
          !preserveAttemptView ||
          !(query.queryKey[1] === "attempt" && query.queryKey[2] === attemptId),
      });
      void client.invalidateQueries({ queryKey: ["teacher"] });
    } catch (cause) {
      if (
        mounted.current &&
        scopeRef.current === scope &&
        getDraftSessionEpoch() === epoch
      ) {
        setError(
          cause instanceof Error ? cause.message : "自评保存失败，请重试",
        );
        if (!preserveAttemptView)
          void client.invalidateQueries({
            queryKey: ["student", "attempt", attemptId],
          });
      }
    } finally {
      if (
        mounted.current &&
        scopeRef.current === scope &&
        getDraftSessionEpoch() === epoch
      )
        setBusy(false);
    }
  };
  const label =
    state.source === "self"
      ? `自评${correct ? "正确" : "错误"}`
      : state.source === "teacher"
        ? correct === null
          ? "老师已批改"
          : `教师判定：${correct ? "正确" : "错误"}`
        : state.source === "automatic"
          ? correct
            ? "回答正确"
            : "回答有误"
          : state.awaitingSelfReview
            ? "已完成，待自评"
            : "尚未判断";
  return (
    <section aria-label="本题评判" className="flex flex-col gap-2 text-sm">
      <p role="status" className="font-medium">
        {label}
      </p>
      {state.canReview ? (
        <>
          <p className="text-xs text-muted-foreground">
            对照参考答案和解析判断，无需老师再次确认。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={state.mark === true ? "default" : "outline"}
              disabled={busy}
              onClick={() => void save(true)}
            >
              对了
            </Button>
            <Button
              size="sm"
              variant={state.mark === false ? "default" : "outline"}
              disabled={busy}
              onClick={() => void save(false)}
            >
              错了
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void save(null)}
            >
              暂不判断
            </Button>
          </div>
        </>
      ) : !hasReferenceAnswer(
          question.answers === null ? {} : { answers: question.answers },
        ) ? (
        <p className="text-xs text-muted-foreground">
          暂无参考答案，不提供自评，可由老师批改。
        </p>
      ) : null}
      {busy && <p className="text-xs text-muted-foreground">正在保存自评…</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

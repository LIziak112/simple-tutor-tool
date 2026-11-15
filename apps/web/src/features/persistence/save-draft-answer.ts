import {
  type AttemptAnswerSaveData,
  attemptAnswerConflictCurrentSchema,
  type StudentAnswer,
} from "@tutor/contract";
import type { ApiServices } from "@/features/runtime/ports/api-services";
import { ApiError } from "@/lib/api-response";
import { randomUuid } from "@/lib/uuid";
import { digestOf } from "./draft-merge";
import { draftStore, getDraftSessionEpoch } from "./draft-store";

const answerSaveTails = new Map<string, Promise<void>>();
export function saveDraftAnswer(
  clients: ApiServices,
  attemptId: string,
  questionId: string,
  answer: StudentAnswer,
): Promise<AttemptAnswerSaveData> {
  const { saveAttemptAnswerApi } = clients;

  const epoch = getDraftSessionEpoch();
  const mutationId =
    draftStore.answerMutationId(attemptId, questionId) ?? randomUuid();
  const key = JSON.stringify([epoch, attemptId, questionId]);
  const prior = answerSaveTails.get(key) ?? Promise.resolve();
  const task = prior.then(async () => {
    if (epoch !== getDraftSessionEpoch())
      throw new Error("作答会话已切换，旧答案未上传");
    await draftStore.flush(attemptId);
    const record = await draftStore.loadDraft(attemptId, { strictRead: true });
    if (epoch !== getDraftSessionEpoch())
      throw new Error("作答会话已切换，旧答案未上传");
    if (
      record?.answerConflicts?.[questionId] ||
      record?.localConflicts?.some(
        (entry) => entry.kind === "answer" && entry.key === questionId,
      )
    )
      throw new Error("本题答案有同步冲突，请先选择保留哪一份");
    const latest = record?.answers[questionId];
    if (
      (latest !== undefined ||
        record?.answerMutationIds?.[questionId] !== undefined) &&
      digestOf(latest) !== digestOf(answer)
    )
      throw new Error("本题已有较新的本机答案，旧答案未上传");
    const baseRevision = record?.answerRevisions?.[questionId];
    try {
      const receipt = await (baseRevision === undefined
        ? saveAttemptAnswerApi(attemptId, questionId, answer)
        : saveAttemptAnswerApi(attemptId, questionId, answer, {
            baseRevision,
            mutationId,
          }));
      if (epoch !== getDraftSessionEpoch()) return receipt;
      await draftStore.markAnswerSynced(
        attemptId,
        questionId,
        answer,
        receipt.revision,
      );
      return receipt;
    } catch (cause) {
      if (
        epoch === getDraftSessionEpoch() &&
        cause instanceof ApiError &&
        cause.code === "ANSWER_REVISION_CONFLICT"
      ) {
        const current = attemptAnswerConflictCurrentSchema.safeParse(
          cause.extra?._current,
        );
        if (current.success)
          draftStore.setAnswerConflict(attemptId, questionId, current.data);
      }
      throw cause;
    }
  });
  const tail = task.then(
    () => undefined,
    () => undefined,
  );
  answerSaveTails.set(key, tail);
  void tail.then(() => {
    if (answerSaveTails.get(key) === tail) answerSaveTails.delete(key);
  });
  return task;
}

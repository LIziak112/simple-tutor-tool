import {
  ATTEMPT_SUBMIT_MAX_QUESTIONS,
  type AttemptDetailData,
  type AttemptSubmitRequest,
  attemptBatchSubmissionBatchSchema,
  attemptBatchSubmissionReceiptSchema,
  attemptBatchSubmissionSessionSchema,
  attemptResultDataSchema,
} from "@tutor/contract";
import { getDraftSessionEpoch } from "@/features/attempt/draft-store";
import { api, callApi } from "./api";
import { ApiError } from "./api-response";
import { withRequestDeadline } from "./request-deadline";

/** 服务端用冻结题快照判分，并在同一事务固定原稿。 */
export function submitAttemptApi(
  attemptId: string,
  input: AttemptSubmitRequest,
): Promise<AttemptDetailData> {
  const routes = api.api.student.attempts[":id"];
  const param = { id: attemptId };
  if (input.revisions.length <= ATTEMPT_SUBMIT_MAX_QUESTIONS) {
    const args = { param, json: input };
    return withRequestDeadline(
      (signal) =>
        callApi(() => routes.submit.$post(args, { init: { signal } })),
      "交卷",
    );
  }
  return submitBatches(attemptId, input);
}

async function submitBatches(
  attemptId: string,
  input: AttemptSubmitRequest,
): Promise<AttemptDetailData> {
  const epoch = getDraftSessionEpoch();
  const ensureSession = () => {
    if (epoch !== getDraftSessionEpoch()) {
      throw new Error("作答会话已切换，请重新打开练习");
    }
  };
  const routes = api.api.student.attempts[":id"]["submit-batches"];
  const options = () => ({ init: { signal: AbortSignal.timeout(30_000) } });
  const batchCount = Math.ceil(
    input.revisions.length / ATTEMPT_SUBMIT_MAX_QUESTIONS,
  );
  const startArgs = { param: { id: attemptId }, json: { batchCount } };
  const session = attemptBatchSubmissionSessionSchema.parse(
    await callApi(() => routes.$post(startArgs, options())),
  );
  const param = { id: attemptId, submissionId: session.submissionId };
  const byQuestion = new Map(
    input.evidence?.map((item) => [item.questionId, item]),
  );
  try {
    for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
      ensureSession();
      const start = batchIndex * ATTEMPT_SUBMIT_MAX_QUESTIONS;
      const revisions = input.revisions.slice(
        start,
        start + ATTEMPT_SUBMIT_MAX_QUESTIONS,
      );
      const evidence = revisions.flatMap(({ questionId }) => {
        const item = byQuestion.get(questionId);
        return item === undefined ? [] : [item];
      });
      const json = attemptBatchSubmissionBatchSchema.parse({
        batchIndex,
        revisions,
        evidence,
      });
      const args = { param, json };
      const stage = () =>
        callApi(() => routes[":submissionId"].$put(args, options()));
      const data = await stage().catch((error: unknown) => {
        if (error instanceof ApiError && error.status < 500) throw error;
        ensureSession();
        return stage();
      });
      if (
        attemptBatchSubmissionReceiptSchema.parse(data).batchIndex !==
        batchIndex
      ) {
        throw new Error("服务器返回的交卷批次不一致，请重试");
      }
    }
    ensureSession();
    const finishArgs = {
      param,
      json: { confirmedSavedAnswers: input.confirmedSavedAnswers },
    };
    const result = await callApi<AttemptDetailData>(() =>
      routes[":submissionId"].finish.$post(finishArgs, options()),
    );
    ensureSession();
    return attemptResultDataSchema.parse(result);
  } catch (error) {
    // 出错后撤掉这次暂存；切换账号或断网时由服务端到期清理。
    if (epoch === getDraftSessionEpoch()) {
      void callApi(() =>
        routes[":submissionId"].$delete({ param }, options()),
      ).catch(() => undefined);
    }
    throw error;
  }
}

import { randomUUID } from "node:crypto";
import { type MarkRequest, markResponseDataSchema } from "@tutor/contract";
import { and, eq, isNull } from "drizzle-orm";
import type { VerdictCommand } from "learning-kernel";
import type { Db } from "../db/client.ts";
import { type Attempt, type ResponseRow, responses } from "../db/schema.ts";
import { kernelResponseMarks } from "../db/schema-kernel-question-delivery.ts";
import { HttpError } from "../lib/http-error.ts";
import { kernelAttemptUnavailable } from "./kernel-assignment-runtime.ts";
import {
  type MarkIntent,
  projectWholeDeliveryVerdicts,
  responseMarkKey,
  responseMarkResult,
} from "./kernel-delivery-verdicts.ts";
import { readQuestionDeliveryFacts } from "./kernel-question-delivery-recovery.ts";
import { deliveryTickets } from "./kernel-question-delivery-ticket.ts";

function loadIntent(db: Db, key: Parameters<typeof responseMarkKey>[0]) {
  return db
    .select()
    .from(kernelResponseMarks)
    .where(responseMarkKey(key))
    .get();
}

/** 调用方已经验证教师域、题目归属和交卷状态，并持有主库写锁。 */
export function stageKernelResponseMark(
  db: Db,
  dataDir: string,
  attempt: Attempt,
  response: ResponseRow,
  teacherId: string,
  request: MarkRequest,
) {
  if (deliveryTickets(db, attempt.id).length === 0) return undefined;
  const facts = readQuestionDeliveryFacts(db, dataDir, attempt);
  const review = facts?.review;
  if (!facts || !review) return undefined;
  const row = facts.rows.find((item) => item.id === response.id);
  const verdict = review.questions.find(
    (item) => item.questionId === response.questionId,
  );
  if (!row || !verdict) kernelAttemptUnavailable();

  const key = {
    attemptId: attempt.id,
    teacherId,
    operationId: request.mutationId ?? randomUUID(),
  };
  const sameRequest = (intent: MarkIntent) =>
    intent.teacherId === teacherId &&
    intent.responseId === row.id &&
    intent.mark === request.mark &&
    intent.comment === request.comment &&
    (request.baseRevision === undefined ||
      intent.baseRevision === request.baseRevision);
  const existing =
    request.mutationId === undefined ? undefined : loadIntent(db, key);
  if (existing) {
    if (!sameRequest(existing))
      throw new HttpError(
        409,
        "OPERATION_CONFLICT",
        "批改操作标识已经用于不同内容",
      );
    return existing.result
      ? { data: markResponseDataSchema.parse(existing.result) }
      : { pending: existing };
  }
  if (
    request.baseRevision !== undefined &&
    request.baseRevision !== verdict.revision
  )
    throw new HttpError(
      409,
      "VERDICT_CONFLICT",
      "批改状态已更新，请刷新后重试",
      {
        _current: { revision: verdict.revision },
      },
    );

  const pending = db
    .select()
    .from(kernelResponseMarks)
    .where(
      and(
        eq(kernelResponseMarks.responseId, row.id),
        isNull(kernelResponseMarks.result),
      ),
    )
    .get();
  if (pending) {
    if (request.mutationId === undefined && sameRequest(pending))
      return { pending };
    throw new HttpError(
      409,
      "KERNEL_MARK_PENDING",
      "这道题还有一项未确认的批改，请重试原操作",
    );
  }

  const subject =
    verdict.status === "judged" && verdict.effective.source === "teacherReview"
      ? verdict.effective
      : undefined;
  if (
    request.mutationId === undefined &&
    request.mark === row.teacherMark &&
    request.comment === row.teacherComment
  )
    return {
      data: responseMarkResult(facts, row, verdict.revision, subject?.id),
    };

  const value = {
    ...key,
    responseId: row.id,
    baseRevision: verdict.revision,
    mark: request.mark,
    comment: request.comment,
  };
  const core = {
    protocolVersion: 1 as const,
    operationId: key.operationId,
    submissionId: review.receipt.id,
    targetId: review.targetId,
    questionId: row.questionId,
    expectedRevision: verdict.revision,
  };
  const command: VerdictCommand | undefined =
    request.mark !== null
      ? {
          ...core,
          action: "override",
          correct: request.mark === "correct",
          reason: "教师改判",
        }
      : subject && {
          ...core,
          action: "withdraw",
          withdrawId: subject.id,
          reason: "教师清除判定",
        };
  if (command) {
    const pending = db
      .insert(kernelResponseMarks)
      .values({ ...value, command })
      .returning()
      .get();
    return { pending };
  }

  // 已经没有教师判定时，清除只更新评语。版本化请求仍保留幂等回执。
  db.update(responses)
    .set({ teacherComment: request.comment })
    .where(eq(responses.id, row.id))
    .run();
  const data = responseMarkResult(
    facts,
    { ...row, teacherComment: request.comment },
    verdict.revision,
  );
  if (request.mutationId !== undefined)
    db.insert(kernelResponseMarks)
      .values({ ...value, result: data })
      .run();
  return { data };
}

/** 预留已跨事务落地，再执行唯一内核事件及宿主回执投影。 */
export function finishKernelResponseMark(
  db: Db,
  dataDir: string,
  attempt: Attempt,
  staged: MarkIntent,
) {
  const facts = readQuestionDeliveryFacts(db, dataDir, attempt);
  if (!facts?.review) kernelAttemptUnavailable();
  const current = loadIntent(db, staged);
  if (!current) kernelAttemptUnavailable();
  if (current.result) return markResponseDataSchema.parse(current.result);
  projectWholeDeliveryVerdicts(db, dataDir, facts, current);
  const result = loadIntent(db, staged)?.result;
  if (!result) kernelAttemptUnavailable();
  return markResponseDataSchema.parse(result);
}

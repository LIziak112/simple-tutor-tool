import { LearningError, type SelfAssessmentReceipt } from "learning-kernel";
import type { Db } from "../db/client.ts";
import type { ResponseRow } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  kernelAttemptUnavailable,
  withKernelRuntime,
} from "./kernel-assignment-runtime.ts";
import type { DeliveryFacts } from "./kernel-question-delivery-recovery.ts";
import { deliveryTickets } from "./kernel-question-delivery-ticket.ts";

type SelfAssessmentWrite = {
  /** 宿主操作标识（自评 mutationId / 细则保存）；与内核修订拼成内核操作号 */
  operation: string;
  verdict: "correct" | "wrong" | null;
  rubric?: Record<string, number>;
};

/** 内核拒绝修订竞争：调用方按宿主 CAS 冲突回给客户端。 */
export class KernelSelfAssessmentConflict extends Error {}

/** 练法在内核声明了本题自评时返回内核当前自评；否则 undefined（宿主自管）。 */
export function kernelSelfAssessmentOf(
  facts: Pick<DeliveryFacts, "reviews"> | undefined,
  questionId: string,
) {
  const verdict = facts?.reviews?.get(questionId)?.verdict;
  return verdict && "selfAssessment" in verdict
    ? verdict.selfAssessment
    : undefined;
}

/**
 * G47：内核练法声明了自评的题，学生自评与细则自评先落内核（来源 self），
 * 宿主行只是投影与客户端 CAS。调用方持有主库写事务并已读出本次交付事实。
 * 内核操作号带上读到的内核修订：宿主写入前进程中断时，同一 mutationId
 * 重试会在新修订上重放同值，而不是撞上旧操作号。
 */
export function writeKernelSelfAssessment(
  db: Db,
  dataDir: string,
  facts: DeliveryFacts,
  row: ResponseRow,
  write: SelfAssessmentWrite,
): SelfAssessmentReceipt | undefined {
  const current = kernelSelfAssessmentOf(facts, row.questionId);
  const reviewed = facts.reviews?.get(row.questionId);
  if (!current || !reviewed) return undefined;
  const ticket = deliveryTickets(db, facts.attempt.id).find(
    ({ receiptId }) => receiptId === reviewed.submissionId,
  );
  if (!ticket) kernelAttemptUnavailable();
  return withKernelRuntime(db, dataDir, false, (runtime) => {
    try {
      return runtime.selfAssess(
        { role: "student", id: facts.attempt.studentId },
        facts.attempt.id,
        {
          protocolVersion: 1,
          stepAttemptId: ticket.stepAttemptId,
          operationId: ticket.operationId,
        },
        {
          protocolVersion: 1,
          operationId: `${write.operation}@${current.revision}`,
          questionId: row.questionId,
          expectedRevision: current.revision,
          verdict: write.verdict,
          ...(write.rubric && { rubric: write.rubric }),
        },
      );
    } catch (error) {
      if (!(error instanceof LearningError)) throw error;
      if (error.code === "SELF_ASSESSMENT_TEACHER_JUDGED")
        throw new HttpError(
          409,
          "SELF_REVIEW_TEACHER_MARKED",
          "老师已判定这道题，无需自评",
        );
      if (error.code === "SELF_ASSESSMENT_CONFLICT")
        throw new KernelSelfAssessmentConflict();
      kernelAttemptUnavailable();
    }
  });
}

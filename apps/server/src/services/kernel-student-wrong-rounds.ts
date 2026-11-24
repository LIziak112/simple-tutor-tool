import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { assignments, attempts, responses } from "../db/schema.ts";
import {
  kernelAssignments,
  kernelAttemptBindings,
  kernelAttemptConfirmations,
} from "../db/schema-kernel-assignments.ts";
import {
  kernelQuestionDeliveries,
  kernelWrongOpenings,
} from "../db/schema-kernel-question-delivery.ts";
import { releaseGateSql } from "./answer-publication-sql.ts";
import {
  type RecoverKernelConfirmation,
  withKernelConfirmationReader,
} from "./kernel-assignment-confirmation-recovery.ts";
import { readBoundKernelActivity } from "./kernel-assignment-runtime.ts";
import { readQuestionDeliveryFacts } from "./kernel-question-delivery.ts";
import { deliverySlotId } from "./kernel-question-delivery-publication.ts";

export interface WrongRoundScope {
  readonly dataDir?: string;
  readonly courseId?: string;
  readonly knowledge?: string;
  readonly questionIds?: readonly string[];
}

function matchingQuestionIds(
  db: Db,
  studentId: string,
  nowIso: string,
  predicate: SQL,
) {
  return db
    .selectDistinct({ questionId: responses.questionId })
    .from(responses)
    .innerJoin(attempts, eq(attempts.id, responses.attemptId))
    .leftJoin(assignments, eq(assignments.id, attempts.assignmentId))
    .leftJoin(
      kernelAttemptConfirmations,
      eq(kernelAttemptConfirmations.attemptId, attempts.id),
    )
    .where(
      and(
        eq(attempts.studentId, studentId),
        isNull(attempts.abandonedAt),
        predicate,
        releaseGateSql(nowIso),
        or(
          ne(attempts.status, "draft"),
          isNotNull(responses.submittedAt),
          isNotNull(kernelAttemptConfirmations.attemptId),
        ),
      ),
    );
}

/** 仅恢复该生本次可公布的确认。隐藏卷与筛选无关的卷不读取内核。 */
export function readPublishedKernelWrongRounds(
  db: Db,
  studentId: string,
  nowIso: string,
  { dataDir, courseId, knowledge, questionIds }: WrongRoundScope,
): ReturnType<RecoverKernelConfirmation>[] {
  if (dataDir === undefined) return [];

  // 先定位可能命中的题。命中后仍纳入同题的历史轮，由最终冻结快照裁决考点。
  if (questionIds?.length === 0) return [];
  const inheritedCourseQuestions =
    courseId === undefined
      ? undefined
      : matchingQuestionIds(
          db,
          studentId,
          nowIso,
          eq(
            sql<string>`coalesce(${attempts.courseId}, ${assignments.courseId})`,
            courseId,
          ),
        );
  const matchingKnowledgeQuestions =
    knowledge === undefined
      ? undefined
      : matchingQuestionIds(
          db,
          studentId,
          nowIso,
          sql`exists (
      select 1 from json_each(
        case when json_valid(${responses.questionSnapshotJson}) then ${responses.questionSnapshotJson} end,
        '$.knowledge'
      ) where value = ${knowledge}
    )`,
        );
  const matchingQuestions =
    questionIds === undefined &&
    inheritedCourseQuestions === undefined &&
    matchingKnowledgeQuestions === undefined
      ? undefined
      : exists(
          db
            .select({ id: responses.id })
            .from(responses)
            .where(
              and(
                eq(responses.attemptId, attempts.id),
                questionIds === undefined
                  ? undefined
                  : inArray(responses.questionId, questionIds),
                inheritedCourseQuestions === undefined
                  ? undefined
                  : inArray(responses.questionId, inheritedCourseQuestions),
                matchingKnowledgeQuestions === undefined
                  ? undefined
                  : inArray(responses.questionId, matchingKnowledgeQuestions),
              ),
            ),
        );
  const scopes = db
    .select({
      attempt: attempts,
      binding: kernelAttemptBindings,
      ticket: kernelAttemptConfirmations,
      delivery: kernelQuestionDeliveries.attemptId,
    })
    .from(attempts)
    .innerJoin(
      kernelAssignments,
      eq(kernelAssignments.assignmentId, attempts.assignmentId),
    )
    .innerJoin(
      kernelAttemptBindings,
      eq(kernelAttemptBindings.attemptId, attempts.id),
    )
    .leftJoin(
      kernelAttemptConfirmations,
      eq(kernelAttemptConfirmations.attemptId, attempts.id),
    )
    .leftJoin(
      kernelQuestionDeliveries,
      and(
        eq(kernelQuestionDeliveries.attemptId, attempts.id),
        eq(
          kernelQuestionDeliveries.stepAttemptId,
          kernelAttemptBindings.stepAttemptId,
        ),
        eq(kernelQuestionDeliveries.slotId, deliverySlotId),
        isNotNull(kernelQuestionDeliveries.receiptId),
        ne(attempts.status, "draft"),
      ),
    )
    .leftJoin(assignments, eq(assignments.id, attempts.assignmentId))
    .where(
      and(
        eq(attempts.studentId, studentId),
        eq(attempts.sourceType, "assignment"),
        isNull(attempts.abandonedAt),
        or(
          isNotNull(kernelAttemptConfirmations.attemptId),
          isNotNull(kernelQuestionDeliveries.attemptId),
        ),
        releaseGateSql(nowIso),
        matchingQuestions,
      ),
    )
    .all();
  const delivered: ReturnType<RecoverKernelConfirmation>[] = [];
  const wrongDeliveries = db
    .select({ attempt: attempts })
    .from(attempts)
    .innerJoin(
      kernelWrongOpenings,
      eq(kernelWrongOpenings.attemptId, attempts.id),
    )
    .innerJoin(
      kernelQuestionDeliveries,
      and(
        eq(kernelQuestionDeliveries.attemptId, attempts.id),
        eq(
          kernelQuestionDeliveries.stepAttemptId,
          kernelWrongOpenings.stepAttemptId,
        ),
        eq(kernelQuestionDeliveries.slotId, deliverySlotId),
      ),
    )
    .where(
      and(
        eq(attempts.studentId, studentId),
        eq(attempts.sourceType, "wrong"),
        isNull(attempts.abandonedAt),
        matchingQuestions,
      ),
    )
    .all();
  for (const { attempt } of wrongDeliveries) {
    const facts = readQuestionDeliveryFacts(db, dataDir, attempt);
    if (facts && facts.attempt.status !== "draft") delivered.push(facts);
  }
  const legacy: Parameters<RecoverKernelConfirmation>[] = [];
  for (const { attempt, binding, ticket, delivery } of scopes) {
    if (delivery !== null) {
      const facts = readQuestionDeliveryFacts(db, dataDir, attempt);
      if (facts && facts.attempt.status !== "draft") delivered.push(facts);
    } else if (ticket !== null) {
      legacy.push([attempt, binding, ticket]);
    }
  }
  if (legacy.length === 0) return delivered;

  return withKernelConfirmationReader(db, dataDir, (runtime, recover) =>
    delivered.concat(
      legacy.flatMap(([attempt, binding, ticket]) =>
        readBoundKernelActivity(runtime, attempt, binding).status ===
        "completed"
          ? [recover(attempt, binding, ticket)]
          : [],
      ),
    ),
  );
}

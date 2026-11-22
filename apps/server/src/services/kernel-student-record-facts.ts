import type { AttemptResultCounts, StudentRecordsQuery } from "@tutor/contract";
import { isUnanswered } from "@tutor/grading";
import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Attempt, attempts } from "../db/schema.ts";
import {
  kernelAssignments,
  kernelAttemptBindings,
  kernelAttemptConfirmations,
  kernelAttemptRefreezes,
} from "../db/schema-kernel-assignments.ts";
import { needsTeacherMark } from "./attempt-final-outcome.ts";
import { projectKernelDraftActivity } from "./kernel-assignment-activity.ts";
import {
  type RecoverKernelConfirmation,
  withKernelConfirmationReader,
} from "./kernel-assignment-confirmation-recovery.ts";
import { resolveKernelRefreezeForRead } from "./kernel-assignment-refreeze.ts";
import {
  type KernelRuntime,
  kernelAttemptUnavailable,
  kernelDraftEntriesOf,
  readBoundKernelActivity,
} from "./kernel-assignment-runtime.ts";

import {
  reachableAssignmentDrafts,
  studentRecordSourceWhere,
} from "./student-record-scope.ts";

const joinedScope = {
  attempt: attempts,
  binding: kernelAttemptBindings,
  ticket: kernelAttemptConfirmations,
};

export type KernelRecordDraftChoices = ReadonlyMap<string, ReadonlySet<string>>;

export interface KernelRecordFacts {
  draftChoices: KernelRecordDraftChoices;
  readPublishedResults: (
    attempts: readonly Attempt[],
  ) => Map<string, PublishedResult>;
}

interface PublishedResult {
  score: number | null;
  resultCounts: AttemptResultCounts;
}

function draftCandidates(
  db: Db,
  studentId: string,
  query: StudentRecordsQuery,
) {
  const reachable = exists(
    reachableAssignmentDrafts(db, studentId, attempts.assignmentId),
  );
  const hasTicket = isNotNull(kernelAttemptConfirmations.attemptId);
  // 还未投影的正式确认可能仍标作 draft。静态筛选可先做，状态和时间只能在恢复后筛。
  const canAffectPage =
    query.status === "draft"
      ? reachable
      : query.status === undefined
        ? or(reachable, hasTicket)
        : hasTicket;
  return db
    .select({
      ...joinedScope,
      pendingRefreeze: kernelAttemptRefreezes.attemptId,
    })
    .from(attempts)
    .innerJoin(
      kernelAssignments,
      eq(kernelAssignments.assignmentId, attempts.assignmentId),
    )
    .leftJoin(
      kernelAttemptBindings,
      eq(kernelAttemptBindings.attemptId, attempts.id),
    )
    .leftJoin(
      kernelAttemptConfirmations,
      eq(kernelAttemptConfirmations.attemptId, attempts.id),
    )
    .leftJoin(
      kernelAttemptRefreezes,
      eq(kernelAttemptRefreezes.attemptId, attempts.id),
    )
    .where(
      and(
        eq(attempts.studentId, studentId),
        eq(attempts.sourceType, "assignment"),
        eq(attempts.status, "draft"),
        isNull(attempts.abandonedAt),
        studentRecordSourceWhere(query),
        query.to === undefined ? undefined : lte(attempts.startedAt, query.to),
        canAffectPage,
      ),
    )
    .all();
}

function publishedResultOf({
  attempt,
  rows,
}: ReturnType<RecoverKernelConfirmation>): PublishedResult {
  return {
    score: attempt.scoreFinal ?? attempt.scoreAuto,
    resultCounts: {
      correctCount: rows.filter((row) => row.finalCorrect === true).length,
      totalCount: rows.length,
      pendingCount: rows.filter(needsTeacherMark).length,
      pendingSelfReviewCount: 0,
    },
  };
}

/** 先恢复影响排序和入账的本人草稿，再在分页内读取已公布结果。 */
export function withKernelStudentRecordFacts<T>(
  db: Db,
  dataDir: string,
  studentId: string,
  query: StudentRecordsQuery,
  list: (facts: KernelRecordFacts) => T,
): T {
  return db.$client
    .transaction(() => {
      let candidates = draftCandidates(db, studentId, query);
      const refreezes = candidates.filter(
        (row) => row.pendingRefreeze !== null,
      );
      for (const { attempt } of refreezes)
        resolveKernelRefreezeForRead(db, dataDir, attempt);
      if (refreezes.length !== 0)
        candidates = draftCandidates(db, studentId, query);

      const draftChoices = new Map<string, ReadonlySet<string>>();
      const confirmed = new Map<string, PublishedResult>();
      function loadPublished(
        runtime: KernelRuntime,
        recover: RecoverKernelConfirmation,
        page: readonly Attempt[],
      ) {
        const missing = page.filter((attempt) => !confirmed.has(attempt.id));
        if (missing.length === 0) return confirmed;
        const scopes = db
          .select(joinedScope)
          .from(attempts)
          .innerJoin(
            kernelAttemptBindings,
            eq(kernelAttemptBindings.attemptId, attempts.id),
          )
          .innerJoin(
            kernelAttemptConfirmations,
            eq(kernelAttemptConfirmations.attemptId, attempts.id),
          )
          .where(
            and(
              eq(attempts.studentId, studentId),
              inArray(
                attempts.id,
                missing.map((attempt) => attempt.id),
              ),
            ),
          )
          .all();
        if (scopes.length !== missing.length) kernelAttemptUnavailable();
        for (const { attempt, binding, ticket } of scopes) {
          if (
            readBoundKernelActivity(runtime, attempt, binding).status !==
            "completed"
          )
            kernelAttemptUnavailable();
          confirmed.set(
            attempt.id,
            publishedResultOf(recover(attempt, binding, ticket)),
          );
        }
        return confirmed;
      }

      if (candidates.length === 0) {
        return list({
          draftChoices,
          readPublishedResults: (page) =>
            page.length === 0
              ? confirmed
              : withKernelConfirmationReader(db, dataDir, (runtime, recover) =>
                  loadPublished(runtime, recover, page),
                ),
        });
      }

      return withKernelConfirmationReader(db, dataDir, (runtime, recover) => {
        for (const { attempt, binding, ticket } of candidates) {
          if (binding === null) kernelAttemptUnavailable();
          const activity = readBoundKernelActivity(runtime, attempt, binding);
          if (activity.status === "completed") {
            if (ticket === null) kernelAttemptUnavailable();
            const result = recover(attempt, binding, ticket);
            confirmed.set(attempt.id, publishedResultOf(result));
          } else {
            if (activity.status !== "active") kernelAttemptUnavailable();
            const heads = kernelDraftEntriesOf(activity).filter(({ answer }) => !isUnanswered(answer));
            draftChoices.set(
              attempt.id,
              new Set(heads.map(({ questionId }) => questionId)),
            );
            projectKernelDraftActivity(db, attempt, runtime);
          }
        }
        return list({
          draftChoices,
          readPublishedResults: (page) => loadPublished(runtime, recover, page),
        });
      });
    })
    .immediate();
}

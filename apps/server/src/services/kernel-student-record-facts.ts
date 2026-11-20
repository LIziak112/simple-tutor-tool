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
import {
  kernelLessonOpenings,
  kernelQuestionDeliveries,
} from "../db/schema-kernel-question-delivery.ts";
import { HttpError } from "../lib/http-error.ts";
import { needsTeacherMark } from "./attempt-final-outcome.ts";
import { projectKernelDraftActivity } from "./kernel-assignment-activity.ts";
import {
  type RecoverKernelConfirmation,
  withKernelConfirmationReader,
} from "./kernel-assignment-confirmation-recovery.ts";
import { resolveKernelRefreezeForRead } from "./kernel-assignment-refreeze.ts";
import {
  judgeAnswerOf,
  type KernelRuntime,
  kernelAttemptUnavailable,
  readBoundKernelActivity,
} from "./kernel-assignment-runtime.ts";
import { readQuestionDeliveryFacts } from "./kernel-question-delivery.ts";
import { answerOf } from "./snapshot.ts";
import { requireVisibleStudentLecture } from "./student-course-service.ts";
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

function hiddenBoundLessonAttempts(db: Db, studentId: string) {
  return new Set(
    db
      .select({
        attemptId: kernelLessonOpenings.attemptId,
        lectureId: kernelLessonOpenings.lectureId,
        courseId: kernelLessonOpenings.courseId,
        teacherId: kernelLessonOpenings.teacherId,
      })
      .from(kernelLessonOpenings)
      .where(
        and(
          eq(kernelLessonOpenings.studentId, studentId),
          isNotNull(kernelLessonOpenings.attemptId),
        ),
      )
      .all()
      .flatMap(({ attemptId, lectureId, courseId, teacherId }) => {
        if (!attemptId) return [];
        try {
          const { course, lecture } = requireVisibleStudentLecture(
            db,
            studentId,
            lectureId,
            courseId,
          );
          return course.teacherId === teacherId && lecture.kind === "lesson"
            ? []
            : [attemptId];
        } catch (error) {
          if (
            error instanceof HttpError &&
            (error.status === 403 || error.status === 404)
          )
            return [attemptId];
          throw error;
        }
      }),
  );
}

export interface KernelRecordFacts {
  draftChoices: KernelRecordDraftChoices;
  hiddenLessons: ReadonlySet<string>;
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
  const hasTicket = or(
    isNotNull(kernelAttemptConfirmations.attemptId),
    exists(
      db
        .select({ id: kernelQuestionDeliveries.attemptId })
        .from(kernelQuestionDeliveries)
        .where(eq(kernelQuestionDeliveries.attemptId, attempts.id)),
    ),
  );
  const lesson = isNotNull(kernelLessonOpenings.attemptId);
  // 还未投影的正式确认可能仍标作 draft。静态筛选可先做，状态和时间只能在恢复后筛。
  const canAffectPage =
    query.status === "draft"
      ? or(reachable, lesson)
      : query.status === undefined
        ? or(reachable, hasTicket, lesson)
        : hasTicket;
  return db
    .select({
      ...joinedScope,
      pendingRefreeze: kernelAttemptRefreezes.attemptId,
    })
    .from(attempts)
    .leftJoin(
      kernelAssignments,
      eq(kernelAssignments.assignmentId, attempts.assignmentId),
    )
    .leftJoin(
      kernelLessonOpenings,
      eq(kernelLessonOpenings.attemptId, attempts.id),
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
        or(isNotNull(kernelAssignments.assignmentId), lesson),
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
      const hiddenLessons = hiddenBoundLessonAttempts(db, studentId);
      const includedDrafts = () =>
        draftCandidates(db, studentId, query).filter(
          ({ attempt }) => !hiddenLessons.has(attempt.id),
        );
      let candidates = includedDrafts();
      const refreezes = candidates.filter(
        (row) => row.pendingRefreeze !== null,
      );
      for (const { attempt } of refreezes)
        resolveKernelRefreezeForRead(db, dataDir, attempt);
      if (refreezes.length !== 0) candidates = includedDrafts();

      const draftChoices = new Map<string, ReadonlySet<string>>();
      const confirmed = new Map<string, PublishedResult>();
      function loadPublished(
        runtime: KernelRuntime,
        recover: RecoverKernelConfirmation,
        page: readonly Attempt[],
      ) {
        for (const attempt of page) {
          if (confirmed.has(attempt.id)) continue;
          const facts = readQuestionDeliveryFacts(db, dataDir, attempt);
          if (facts) confirmed.set(attempt.id, publishedResultOf(facts));
        }
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
          hiddenLessons,
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
          const facts = readQuestionDeliveryFacts(db, dataDir, attempt);
          if (facts) {
            if (facts.attempt.status === "draft") {
              draftChoices.set(
                attempt.id,
                new Set(
                  facts.rows
                    .filter(
                      (row) =>
                        row.answered || !isUnanswered(answerOf(row.answerJson)),
                    )
                    .map((row) => row.questionId),
                ),
              );
            } else confirmed.set(attempt.id, publishedResultOf(facts));
            continue;
          }
          if (binding === null) kernelAttemptUnavailable();
          const activity = readBoundKernelActivity(runtime, attempt, binding);
          if (activity.status === "completed") {
            if (ticket === null) kernelAttemptUnavailable();
            const result = recover(attempt, binding, ticket);
            confirmed.set(attempt.id, publishedResultOf(result));
          } else {
            if (activity.status !== "active") kernelAttemptUnavailable();
            const heads =
              "responseDrafts" in activity
                ? activity.responseDrafts.filter(
                    ({ value }) => !isUnanswered(judgeAnswerOf(value)),
                  )
                : (("choiceDrafts" in activity
                    ? activity.choiceDrafts
                    : undefined) ?? []);
            draftChoices.set(
              attempt.id,
              new Set(heads.map(({ questionId }) => questionId)),
            );
            projectKernelDraftActivity(db, attempt, runtime);
          }
        }
        return list({
          draftChoices,
          hiddenLessons,
          readPublishedResults: (page) => loadPublished(runtime, recover, page),
        });
      });
    })
    .immediate();
}

import { randomUUID } from "node:crypto";
import { questionDeliveryScoringSourcesSchema } from "@tutor/contract";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Attempt, attempts } from "../db/schema.ts";
import { kernelLessonOpenings } from "../db/schema-kernel-question-delivery.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  contextEntriesOf,
  liveAttemptContextClosure,
} from "./attempt-context.ts";
import { freezeInputsOfNewAttempt, questionOfRow } from "./attempt-freeze.ts";
import { recordAttemptStartEvent } from "./event-service.ts";
import {
  canInitializeKernelStorage,
  insertKernelFrozenResponses,
} from "./kernel-assignment-freeze.ts";
import { kernelOpeningDraftSchema } from "./kernel-assignment-input.ts";
import {
  kernelMaterialPublication,
  matchesKernelMaterialInputs,
} from "./kernel-assignment-publication.ts";
import {
  ensureKernelRuntimeStorage,
  type KernelRuntime,
  kernelAttemptUnavailable,
  withKernelRuntime,
} from "./kernel-assignment-runtime.ts";
import {
  lessonRestartChain,
  lessonRestartSource,
  restartKernelLesson,
  withStudentRestart,
} from "./kernel-lesson-restart.ts";
import { deliveryPolicy } from "./kernel-question-delivery-binding.ts";
import { questionDeliveryPublication } from "./kernel-question-delivery-publication.ts";
import { freezeAttemptContextSnapshotsWithin } from "./material-repository.ts";
import { newDraftAttempt } from "./new-draft-attempt.ts";
import { requireVisibleStudentLecture } from "./student-course-service.ts";

type Opening = typeof kernelLessonOpenings.$inferSelect;
type Scope = Pick<
  Opening,
  "studentId" | "lectureId" | "courseId" | "unitId" | "teacherId"
>;

function openingScope(scope: Pick<Scope, "studentId" | "lectureId">) {
  return and(
    eq(kernelLessonOpenings.studentId, scope.studentId),
    eq(kernelLessonOpenings.lectureId, scope.lectureId),
  );
}

export function pendingKernelLesson(
  db: Db,
  scope: Pick<Scope, "studentId" | "lectureId">,
) {
  return db
    .select()
    .from(kernelLessonOpenings)
    .where(and(openingScope(scope), isNull(kernelLessonOpenings.attemptId)))
    .orderBy(desc(kernelLessonOpenings.attemptNo))
    .get();
}

export function kernelLessonForRestart(
  db: Db,
  scope: Scope,
  operationId: string,
) {
  return db
    .select()
    .from(kernelLessonOpenings)
    .where(
      and(
        openingScope(scope),
        eq(kernelLessonOpenings.operationId, operationId),
      ),
    )
    .get();
}

function verifyScope(db: Db, scope: Scope) {
  const { lecture, course } = requireVisibleStudentLecture(
    db,
    scope.studentId,
    scope.lectureId,
    scope.courseId,
  );
  if (lecture.kind !== "lesson" || course.teacherId !== scope.teacherId)
    kernelAttemptUnavailable();
}

export function replayKernelLessonOpening(
  runtime: KernelRuntime,
  opening: Opening,
  restartSource: string | undefined,
) {
  const { practice } = opening.publication;
  if (
    practice.id !== opening.practiceId ||
    practice.version !== opening.practiceVersion
  )
    kernelAttemptUnavailable();
  const draft = kernelOpeningDraftSchema.parse(opening.draft);
  if (draft.courseId !== opening.courseId) kernelAttemptUnavailable();
  const actor = { role: "student", id: opening.studentId } as const;
  runtime.publish(opening.publication);
  const receipt =
    restartSource === undefined
      ? runtime.prepare(actor, {
          protocolVersion: 1,
          operationId: opening.operationId,
          practiceId: opening.practiceId,
          practiceVersion: opening.practiceVersion,
        })
      : restartKernelLesson(runtime, actor, restartSource, opening);
  const view = runtime.read(actor, receipt.activityId);
  if (
    !("questionDeliveries" in view) ||
    view.status !== "active" ||
    deliveryPolicy(view).mode !== "perQuestion" ||
    view.questionDeliveries.length ||
    view.questionDeliveryDrafts.length ||
    !matchesKernelMaterialInputs(
      view,
      opening.teacherId,
      draft.context ?? [],
      draft.responses.map(({ question }) => question),
    )
  )
    kernelAttemptUnavailable();
  return { receipt, draft };
}

function finishOpening(
  db: Db,
  dataDir: string,
  opening: Opening,
  abandoned?: Attempt,
) {
  return db.transaction(
    (tx) => {
      verifyScope(db, opening);
      const current = db
        .select()
        .from(kernelLessonOpenings)
        .where(eq(kernelLessonOpenings.operationId, opening.operationId))
        .get();
      if (!current || current.courseId !== opening.courseId)
        kernelAttemptUnavailable();
      if (current.attemptId) {
        const existing = db
          .select()
          .from(attempts)
          .where(eq(attempts.id, current.attemptId))
          .get();
        if (!existing) kernelAttemptUnavailable();
        return existing;
      }
      const { receipt, draft } = withKernelRuntime(
        db,
        dataDir,
        false,
        (runtime) =>
          replayKernelLessonOpening(
            runtime,
            current,
            lessonRestartSource(db, current),
          ),
      );
      const attempt = newDraftAttempt({
        sourceType: "lesson",
        assignmentId: null,
        studentId: current.studentId,
        courseId: current.courseId,
        lectureId: current.lectureId,
        unitId: current.unitId,
        attemptNo: current.attemptNo,
        id: receipt.activityId,
        startedAt: receipt.startedAt,
      });
      if (abandoned)
        tx.update(attempts)
          .set({ abandonedAt: attempt.startedAt })
          .where(
            and(eq(attempts.id, abandoned.id), eq(attempts.status, "draft")),
          )
          .run();
      tx.insert(attempts).values(attempt).run();
      insertKernelFrozenResponses(tx, attempt.id, draft.responses);
      freezeAttemptContextSnapshotsWithin(
        tx,
        attempt.id,
        draft.context ?? [],
        attempt.startedAt,
      );
      tx.update(kernelLessonOpenings)
        .set({ attemptId: attempt.id, stepAttemptId: receipt.stepAttemptId })
        .where(eq(kernelLessonOpenings.operationId, opening.operationId))
        .run();
      recordAttemptStartEvent(db, attempt.studentId, attempt.id);
      return attempt;
    },
    { behavior: "immediate" },
  );
}

export function resumeKernelLessonOpening(
  db: Db,
  dataDir: string,
  opening: Opening,
) {
  const previous =
    opening.attemptNo === 1
      ? undefined
      : db
          .select()
          .from(attempts)
          .where(
            and(
              eq(attempts.studentId, opening.studentId),
              eq(attempts.lectureId, opening.lectureId),
              eq(attempts.sourceType, "lesson"),
              eq(attempts.attemptNo, opening.attemptNo - 1),
            ),
          )
          .get();
  return finishOpening(db, dataDir, opening, previous);
}

export function openKernelLesson(
  db: Db,
  dataDir: string,
  scope: Scope & { title: string },
  attemptNo: number,
  operationId: string,
  prior?: Attempt,
) {
  const opening = db.transaction(
    (tx) => {
      verifyScope(db, scope);
      const latest = db
        .select({ id: attempts.id, attemptNo: attempts.attemptNo })
        .from(attempts)
        .where(
          and(
            eq(attempts.studentId, scope.studentId),
            eq(attempts.lectureId, scope.lectureId),
            eq(attempts.sourceType, "lesson"),
            isNull(attempts.abandonedAt),
          ),
        )
        .orderBy(desc(attempts.attemptNo))
        .get();
      const existing = db
        .select()
        .from(kernelLessonOpenings)
        .where(
          and(
            openingScope(scope),
            eq(
              kernelLessonOpenings.attemptNo,
              !prior && latest ? latest.attemptNo : attemptNo,
            ),
          ),
        )
        .get();
      if (existing) {
        if (
          existing.courseId !== scope.courseId ||
          (prior && existing.operationId !== operationId)
        )
          throw new HttpError(
            409,
            "LESSON_RESTART_STALE",
            "讲练已在其他页面打开，请刷新",
          );
        return existing;
      }
      if (!prior && latest) return undefined;
      if (
        prior &&
        (latest?.id !== prior.id || attemptNo !== latest.attemptNo + 1)
      )
        throw new HttpError(
          409,
          "LESSON_RESTART_STALE",
          "讲练已在其他页面打开，请刷新",
        );
      const chain = prior && lessonRestartChain(tx, prior.id);
      const practiceId =
        chain?.practiceId ?? `lesson:${scope.lectureId}:${randomUUID()}`;
      const practiceVersion = chain?.practiceVersion ?? 1;
      const { liveRows, teacherId, knowledgeByQuestion } =
        freezeInputsOfNewAttempt(
          db,
          newDraftAttempt({
            ...scope,
            id: randomUUID(),
            startedAt: new Date().toISOString(),
            sourceType: "lesson",
            assignmentId: null,
            attemptNo,
          }),
        );
      if (teacherId !== scope.teacherId || liveRows.length === 0)
        return undefined;
      const context = liveAttemptContextClosure(
        db,
        teacherId,
        liveRows.map((row) => row.id),
      );
      if (
        (context.materials.length === 0 && context.groups.length > 0) ||
        context.materials.some(({ contentMd }) => contentMd.trim() === "")
      )
        return undefined;
      const responses = liveRows.map((row) => ({
        question: questionOfRow(row, knowledgeByQuestion.get(row.id) ?? []),
        questionVersion: row.version,
        unitId: row.unitId,
        gradingPolicy: "auto" as const,
      }));
      if (
        responses.some(({ question }) => question.hints?.length) ||
        !questionDeliveryScoringSourcesSchema.safeParse(
          responses.map(({ question }) => question),
        ).success
      )
        return undefined;
      const draft = kernelOpeningDraftSchema.parse({
        courseId: scope.courseId,
        responses,
        context: contextEntriesOf(context),
      });
      const { materialInputs, materialDefinitions } = kernelMaterialPublication(
        teacherId,
        draft.context ?? [],
        draft.responses.map(({ question }) => question),
      );
      ensureKernelRuntimeStorage(db, dataDir, canInitializeKernelStorage(tx));
      return tx
        .insert(kernelLessonOpenings)
        .values({
          ...scope,
          attemptNo,
          practiceId,
          practiceVersion,
          operationId,
          publication: withStudentRestart({
            ...materialDefinitions,
            ...questionDeliveryPublication(
              { id: practiceId, title: scope.title },
              practiceVersion,
              draft.responses,
              "perQuestion",
              materialInputs,
            ),
          }),
          draft,
        })
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
  return opening && finishOpening(db, dataDir, opening, prior);
}

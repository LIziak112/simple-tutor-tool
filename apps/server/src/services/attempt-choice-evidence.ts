import { randomUUID } from "node:crypto";
import type { AttemptSubmitRequest } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  notes,
  noteVersions,
  type ResponseRow,
  submissionEvidence,
} from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { requireUsableAttempt } from "./attempt-access.ts";
import { attemptResponseRows } from "./attempt-freeze.ts";
import {
  readSubmissionOriginalReservations,
  reserveSubmissionOriginals,
  settleSubmissionOriginalReservation,
} from "./attempt-original-reservation.ts";
import { buildSubmissionEvidence } from "./attempt-submit-evidence.ts";
import {
  assertExactQuestionSet,
  validateSubmitRevisions,
} from "./attempt-submit-revisions.ts";

type Scope = {
  attemptId: string;
  studentId: string;
  operationId: string;
  stepAttemptId: string;
  practiceVersion: number;
};

export const kernelOriginalSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("frozen"),
    documentId: z.uuid(),
    versionId: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  z.strictObject({ state: z.literal("none") }),
  z.strictObject({ state: z.literal("missing") }),
  z.strictObject({ state: z.literal("uncollected") }),
]);
type Original = z.infer<typeof kernelOriginalSchema>;

const recoveredEvidenceSchema = z.object({
  receipt: z.object({
    id: z.uuid(),
    stepAttemptId: z.uuid(),
    slotId: z.literal("answers"),
    confirmedAt: z.iso.datetime(),
  }),
  practice: z.object({ id: z.string(), version: z.int().positive() }),
  confirmation: z.object({
    kind: z.enum(["choiceConfirmation", "responseConfirmation"]),
    questions: z.array(
      z.object({
        questionId: z.string(),
        questionVersion: z.int().positive(),
        original: kernelOriginalSchema,
      }),
    ),
  }),
});

function mismatch() {
  return new HttpError(
    409,
    "NOTE_EVIDENCE_MISMATCH",
    "交卷回执与作答原稿不一致",
  );
}

function assignmentAttempt(db: Db, { studentId, attemptId }: Scope) {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  if (attempt.sourceType !== "assignment" || attempt.assignmentId === null)
    throw mismatch();
  return { attempt, assignmentId: attempt.assignmentId };
}

function linkedOriginal(
  db: Pick<Db, "select">,
  row: Pick<ResponseRow, "attemptId" | "questionId" | "id">,
  versionId: string,
) {
  return db
    .select({
      documentId: notes.id,
      versionId: noteVersions.id,
      hash: noteVersions.hash,
      revision: noteVersions.revision,
    })
    .from(noteVersions)
    .innerJoin(notes, eq(notes.id, noteVersions.noteId))
    .where(
      and(
        eq(noteVersions.id, versionId),
        eq(notes.attemptId, row.attemptId),
        eq(notes.questionId, row.questionId),
        eq(notes.questionRevisionId, row.id),
        eq(notes.phase, "scratch"),
      ),
    )
    .get();
}

/** 开放的产品整卷声明沿用现有冻结题行，答案版本交给权威确认核对。 */
export function prepareChoiceOriginals(
  db: Db,
  dataDir: string,
  scope: Scope,
  request: AttemptSubmitRequest,
) {
  return db.transaction(
    () => {
      const { attempt } = assignmentAttempt(db, scope);
      if (attempt.status !== "draft") throw mismatch();
      const frozen = attemptResponseRows(db, scope.attemptId);
      if (
        frozen.length === 0 ||
        frozen.some(
          ({ questionSnapshotJson, submittedAt }) =>
            questionSnapshotJson === null || submittedAt !== null,
        )
      )
        throw mismatch();

      validateSubmitRevisions(
        frozen.map((response) => ({ response })),
        [],
        request.revisions,
      );
      return prepareKernelOriginals(db, dataDir, scope, request, frozen);
    },
    { behavior: "immediate" },
  );
}

export function prepareKernelOriginals(
  db: Db,
  dataDir: string,
  scope: Scope,
  request: AttemptSubmitRequest,
  frozen: readonly ResponseRow[],
) {
  const rows = frozen.map((response) => ({ response }));
  const answerRevisions = new Map(
    request.revisions.map(({ questionId, expectedAnswerRevision }) => [
      questionId,
      expectedAnswerRevision ?? 0,
    ]),
  );
  const declared = new Map(
    request.evidence?.map((item) => [item.questionId, item]),
  );
  buildSubmissionEvidence(db, scope.attemptId, rows, request.evidence);
  const selected = [];
  for (const declaration of declared.values()) {
    if (declaration.state === "frozen") {
      const { questionId, versionId, revision } = declaration;
      if (versionId === undefined || revision === undefined || revision < 1)
        throw mismatch();
      selected.push({ questionId, versionId, revision });
    }
  }
  const byQuestion = new Map(
    reserveSubmissionOriginals(db, dataDir, {
      ...scope,
      originals: selected,
    }).map((reserved) => [reserved.questionId, reserved]),
  );

  return frozen.map((row) => {
    const { questionId, questionVersion } = row;
    const revision = answerRevisions.get(questionId);
    if (revision === undefined) throw mismatch();
    const held = byQuestion.get(questionId);
    let original: Original;
    if (held) {
      const linked = linkedOriginal(db, row, held.versionId);
      if (
        !linked ||
        linked.hash !== held.hash ||
        linked.revision !== held.revision
      )
        throw mismatch();
      original = {
        state: "frozen",
        documentId: linked.documentId,
        versionId: linked.versionId,
        sha256: linked.hash,
      };
    } else {
      const state = declared.get(questionId)?.state ?? "uncollected";
      if (state === "frozen") throw mismatch();
      original = { state };
    }
    return { questionId, questionVersion, revision, original };
  });
}

/** 仅接受可信恢复回调，从已持久的权威确认重建产品原稿索引。 */
export function projectConfirmedChoiceEvidence(
  db: Db,
  scope: Scope,
  recover: (scope: Scope) => unknown,
) {
  const { assignmentId } = assignmentAttempt(db, scope);
  const parsed = recoveredEvidenceSchema.safeParse(recover(scope));
  if (!parsed.success) throw mismatch();
  const { receipt, practice, confirmation } = parsed.data;
  if (
    receipt.stepAttemptId !== scope.stepAttemptId ||
    practice.id !== assignmentId ||
    practice.version !== scope.practiceVersion
  )
    throw mismatch();

  return projectKernelEvidence(
    db,
    scope,
    receipt,
    confirmation.questions,
    attemptResponseRows(db, scope.attemptId),
  );
}

type EvidenceQuestion = z.infer<
  typeof recoveredEvidenceSchema
>["confirmation"]["questions"][number];

export function projectKernelEvidence(
  db: Db,
  scope: Scope,
  receipt: { confirmedAt: string },
  questions: readonly EvidenceQuestion[],
  frozen: readonly ResponseRow[],
  requireExisting = false,
) {
  return db.transaction(
    (tx) => {
      if (frozen.length === 0) throw mismatch();
      assertExactQuestionSet(
        frozen.map((response) => ({ response })),
        questions,
        mismatch,
      );
      const byQuestion = new Map(frozen.map((row) => [row.questionId, row]));
      const reservations = readSubmissionOriginalReservations(tx, scope);
      const reserved = new Map(
        reservations.map((row) => [row.questionId, row]),
      );
      const confirmedFrozen = questions.filter(
        ({ original }) => original.state === "frozen",
      );
      if (reserved.size !== confirmedFrozen.length) throw mismatch();
      const uncollected = questions.filter(
        ({ original }) => original.state === "uncollected",
      );
      if (uncollected.length > 0 && uncollected.length !== frozen.length)
        throw mismatch();

      const wanted = [];
      for (const { questionId, questionVersion, original } of questions) {
        const row = byQuestion.get(questionId);
        if (
          row?.questionVersion !== questionVersion ||
          row.questionSnapshotJson === null
        )
          throw mismatch();
        if (original.state === "uncollected") continue;

        let versionId: string | null = null;
        if (original.state === "frozen") {
          versionId = original.versionId;
          const hold = reserved.get(questionId);
          const linked = linkedOriginal(tx, row, versionId);
          if (
            !hold ||
            hold.state === "aborted" ||
            hold.versionId !== versionId ||
            hold.hash !== original.sha256 ||
            !linked ||
            linked.documentId !== original.documentId ||
            linked.hash !== original.sha256 ||
            linked.revision !== hold.revision
          )
            throw mismatch();
        }
        wanted.push({ questionId, state: original.state, versionId });
      }

      const current = tx
        .select()
        .from(submissionEvidence)
        .where(eq(submissionEvidence.attemptId, scope.attemptId))
        .all();
      const inScope = current.filter((row) => byQuestion.has(row.questionId));
      if (!requireExisting && inScope.length === 0) {
        if (wanted.length > 0) {
          tx.insert(submissionEvidence)
            .values(
              wanted.map((original) => ({
                ...original,
                id: randomUUID(),
                attemptId: scope.attemptId,
                recordedAt: receipt.confirmedAt,
              })),
            )
            .run();
        }
      } else {
        const byId = new Map(inScope.map((row) => [row.questionId, row]));
        if (
          inScope.length !== wanted.length ||
          wanted.some(({ questionId, state, versionId }) => {
            const seen = byId.get(questionId);
            return (
              seen?.state !== state ||
              seen.versionId !== versionId ||
              seen.recordedAt !== receipt.confirmedAt
            );
          })
        )
          throw mismatch();
      }

      settleSubmissionOriginalReservation(tx, scope, "projected");
      return receipt;
    },
    { behavior: "immediate" },
  );
}

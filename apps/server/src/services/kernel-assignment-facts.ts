import {
  judgeScoringSourceSchema,
  singleChoiceScoringSourceSchema,
} from "@tutor/contract";
import type { StudentActivity } from "learning-kernel";
import type { Db } from "../db/client.ts";
import type { Attempt, ResponseRow } from "../db/schema.ts";
import { attemptResponseRows } from "./attempt-freeze.ts";
import { readKernelConfirmationFacts } from "./kernel-assignment-confirmation.ts";
import {
  judgeAnswerOf,
  kernelAttemptUnavailable,
  ownClassChoiceAnswerOf,
  withBoundKernelActivity,
} from "./kernel-assignment-runtime.ts";
import { snapshotOfRow } from "./snapshot.ts";

/** 调用方已经核验读取权限。按持久绑定取得当前草稿或正式确认的冻结行。 */
export function readKernelAttemptFacts(
  db: Db,
  dataDir: string,
  attempt: Attempt,
) {
  const confirmed = readKernelConfirmationFacts(db, dataDir, attempt);
  if (confirmed !== undefined) return confirmed;
  if (attempt.status !== "draft") kernelAttemptUnavailable();
  return withBoundKernelActivity(
    db,
    dataDir,
    attempt,
    (_runtime, activity) => ({
      attempt,
      rows: kernelDraftRowsOf(db, attempt, activity),
    }),
  );
}

export function kernelDraftRowsOf(
  db: Db,
  attempt: Attempt,
  activity: StudentActivity,
): ResponseRow[] {
  if (activity.status !== "active") kernelAttemptUnavailable();
  const rows = new Map<string, ResponseRow>(
    attemptResponseRows(db, attempt.id).map(
      (row) =>
        [
          row.questionId,
          {
            ...row,
            answerJson: null,
            answerRevision: 0,
            answered: false,
            changeCount: 0,
            submittedAt: null,
          },
        ] as const,
    ),
  );
  for (const revision of ("choiceSnapshotRevisions" in activity
    ? activity.choiceSnapshotRevisions
    : undefined) ?? []) {
    const row = rows.get(revision.questionId);
    if (
      revision.slotId !== "answers" ||
      row === undefined ||
      row.questionVersion !== revision.questionVersion ||
      row.answerRevision !== 0
    )
      kernelAttemptUnavailable();
    rows.set(row.questionId, { ...row, answerRevision: revision.revision });
  }
  for (const draft of ("choiceDrafts" in activity
    ? activity.choiceDrafts
    : undefined) ?? []) {
    const row = rows.get(draft.questionId);
    const answer = ownClassChoiceAnswerOf(draft.choice);
    const source = singleChoiceScoringSourceSchema.safeParse(
      row && snapshotOfRow(row),
    );
    if (
      draft.slotId !== "answers" ||
      row === undefined ||
      row.questionVersion !== draft.questionVersion ||
      row.answerJson !== null ||
      draft.revision <= row.answerRevision ||
      !source.success ||
      source.data.options[answer.index] === undefined
    )
      kernelAttemptUnavailable();
    rows.set(row.questionId, {
      ...row,
      answerJson: JSON.stringify(answer),
      answerRevision: draft.revision,
      changeCount: draft.changeCount,
    });
  }
  for (const draft of ("responseDrafts" in activity
    ? activity.responseDrafts
    : undefined) ?? []) {
    const row = rows.get(draft.questionId);
    if (
      draft.slotId !== "answers" ||
      row === undefined ||
      row.questionVersion !== draft.questionVersion ||
      row.answerJson !== null ||
      draft.revision <= row.answerRevision ||
      !judgeScoringSourceSchema.safeParse(snapshotOfRow(row)).success
    )
      kernelAttemptUnavailable();
    rows.set(row.questionId, {
      ...row,
      answerJson: JSON.stringify(judgeAnswerOf(draft.value)),
      answerRevision: draft.revision,
      changeCount: draft.changeCount,
    });
  }
  return [...rows.values()];
}

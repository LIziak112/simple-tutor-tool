import type {
  Question,
  StudentAnswer,
  TeacherResponseEdit,
} from "@tutor/contract";
import type { ChoiceAmendmentIntent } from "@tutor/contract/choice-amendment-intent";
import type { Db } from "../db/client.ts";
import type { Attempt, ResponseRow } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  type KernelRuntime,
  kernelAttemptUnavailable,
} from "./kernel-assignment-runtime.ts";
import { questionDeliveryPublication } from "./kernel-question-delivery-publication.ts";
import {
  deliveryAnswerOf,
  deliveryValueOf,
} from "./kernel-question-delivery-values.ts";
import { assertTeacherDraftSnapshot } from "./teacher-response-snapshot.ts";

/**
 * 题组交付槽（G33）的教师修正：任一题型的草稿答案与未作答题面都经内核
 * amendQuestionDeliveryDraft / reviseQuestionDeliverySnapshot 写入；单选整卷槽仍走原单选接口。
 */
type Reviewer = { role: "reviewer"; id: string };
type Capability = {
  protocolVersion: 1;
  stepAttemptId: string;
  slotId: string;
  questionId: string;
  questionVersion: number;
};
type DeliveryIntent = Extract<
  ChoiceAmendmentIntent,
  { kind: "deliveryAnswer" | "deliverySnapshot" }
>;

function invalidSnapshot(): never {
  throw new HttpError(
    400,
    "VALIDATION_ERROR",
    "内核题面勘误须保持题型、无提示且能冻结评分",
  );
}

export function usesQuestionDelivery(runtime: KernelRuntime, attempt: Attempt) {
  const view = runtime.read(
    { role: "student", id: attempt.studentId },
    attempt.id,
  );
  return "questionDeliveries" in view;
}

function frozenBlankCount(
  runtime: KernelRuntime,
  attempt: Attempt,
  questionId: string,
) {
  const view = runtime.read(
    { role: "student", id: attempt.studentId },
    attempt.id,
  );
  const inputs = "inputs" in view ? Object.values(view.inputs) : [];
  for (const input of inputs) {
    if (input.from !== "questions") continue;
    const question = input.questions.find(({ id }) => id === questionId);
    const count = question?.blankCount;
    return typeof count === "number" ? count : undefined;
  }
  return undefined;
}

export function deliverySnapshotContent(
  runtime: KernelRuntime,
  attempt: Attempt,
  snapshot: Question,
  questionVersion: number,
) {
  if (snapshot.hints?.length) invalidSnapshot();
  const blankCount = frozenBlankCount(runtime, attempt, snapshot.id);
  let publication: ReturnType<typeof questionDeliveryPublication>;
  try {
    publication = questionDeliveryPublication(
      { id: "teacher-snapshot", title: "题面勘误" },
      1,
      [{ question: snapshot, questionVersion }],
      "whole",
      undefined,
      blankCount === undefined
        ? undefined
        : new Map([[snapshot.id, blankCount]]),
    );
  } catch {
    invalidSnapshot();
  }
  const [frozen] = publication.practice.questions;
  if (!frozen) invalidSnapshot();
  const {
    id: _id,
    version: _version,
    response: _response,
    ...question
  } = frozen;
  const entry =
    "scoringKey" in publication
      ? publication.scoringKey.acceptedByQuestion[snapshot.id]
      : undefined;
  if (!entry) return { question };
  const { response: _key, ...key } = entry;
  return { question, key };
}

export function stageDeliveryFields(
  db: Db,
  runtime: KernelRuntime,
  attempt: Attempt,
  row: ResponseRow,
  original: Question,
  edit: TeacherResponseEdit,
  current: { value: Parameters<typeof deliveryAnswerOf>[1] },
) {
  if ("snapshot" in edit) {
    assertTeacherDraftSnapshot(row, original, edit.snapshot);
    deliverySnapshotContent(
      runtime,
      attempt,
      edit.snapshot,
      row.questionVersion,
    );
    return {
      kind: "deliverySnapshot" as const,
      snapshot: edit.snapshot,
      prior: row.questionSnapshotJson,
    };
  }
  deliveryValueOf(db, row, edit.answer);
  return {
    kind: "deliveryAnswer" as const,
    answer: edit.answer,
    prior: deliveryAnswerOf(row, current.value),
  };
}

export function applyDeliveryIntent(
  db: Db,
  runtime: KernelRuntime,
  attempt: Attempt,
  reviewer: Reviewer,
  row: ResponseRow,
  intent: DeliveryIntent,
  command: Capability & {
    operationId: string;
    baseRevision: number;
    reason: string;
  },
) {
  const revision = intent.baseRevision + 1;
  if (intent.kind === "deliverySnapshot") {
    const receipt = runtime.reviseQuestionDeliverySnapshot(
      reviewer,
      attempt.id,
      {
        ...command,
        ...deliverySnapshotContent(
          runtime,
          attempt,
          intent.snapshot,
          intent.questionVersion,
        ),
      },
    );
    if (
      receipt.revision !== revision ||
      receipt.questionVersion !== intent.questionVersion + 1
    )
      kernelAttemptUnavailable();
    return { questionVersion: receipt.questionVersion };
  }
  const value = deliveryValueOf(db, row, intent.answer as StudentAnswer);
  const receipt = runtime.amendQuestionDeliveryDraft(reviewer, attempt.id, {
    ...command,
    value,
  });
  if (receipt.revision !== revision) kernelAttemptUnavailable();
  return undefined;
}

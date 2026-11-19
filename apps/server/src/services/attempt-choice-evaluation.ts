import { gradeResponseRow } from "@tutor/grading";
import type {
  ChoiceEvaluationInput,
  ChoiceEvaluatorRegistration,
} from "learning-kernel";
import type { Db } from "../db/client.ts";
import { responses } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  buildAttemptQuestionWhere,
  requireOwnAttempt,
} from "./attempt-access.ts";
import { snapshotOfRow } from "./snapshot.ts";

export const ownClassChoiceEvaluatorRef = {
  id: "ownclass-choice",
  version: 1,
} as const;

export type OwnClassChoiceEvaluationScope = Readonly<{
  attemptId: string;
  studentId: string;
  assignmentId: string;
  stepAttemptId: string;
  slotId: string;
  practiceVersion: number;
  questionRevisions: ReadonlyMap<string, string>;
}>;

function mismatch(): never {
  throw new HttpError(
    409,
    "CHOICE_EVALUATION_SCOPE_MISMATCH",
    "冻结的作答评分来源已变化",
  );
}

/** 仅供可信回执恢复调用。以宿主冻结行校验评分来源，将实际答案交给统一判分入口。 */
export function createOwnClassChoiceEvaluator(
  db: Db,
  currentScope: () => OwnClassChoiceEvaluationScope | undefined,
): ChoiceEvaluatorRegistration {
  return {
    ...ownClassChoiceEvaluatorRef,
    evaluate(input: ChoiceEvaluationInput): boolean {
      const scope = currentScope();
      if (
        scope === undefined ||
        input.activityId !== scope.attemptId ||
        input.stepAttemptId !== scope.stepAttemptId ||
        input.slotId !== scope.slotId ||
        input.practice.id !== scope.assignmentId ||
        input.practice.version !== scope.practiceVersion
      )
        mismatch();
      const attempt = requireOwnAttempt(db, scope.studentId, scope.attemptId);
      if (
        attempt.sourceType !== "assignment" ||
        attempt.assignmentId !== scope.assignmentId ||
        attempt.abandonedAt !== null ||
        attempt.frozenAt === null
      )
        mismatch();
      const row = db
        .select()
        .from(responses)
        .where(buildAttemptQuestionWhere(attempt.id, input.questionId))
        .get();
      if (
        row === undefined ||
        row.id !== scope.questionRevisions.get(input.questionId) ||
        row.questionVersion !== input.questionVersion ||
        row.gradingPolicy !== "auto"
      )
        mismatch();
      const question = snapshotOfRow(row);
      if (
        question?.id !== input.questionId ||
        question.type !== "choice" ||
        question.answers?.kind !== "choice" ||
        !question.options?.[question.answers.index] ||
        String(question.answers.index) !== input.acceptedChoice
      )
        mismatch();
      const index = input.choice === null ? undefined : Number(input.choice);
      if (
        index !== undefined &&
        (String(index) !== input.choice || !question.options[index])
      )
        mismatch();
      const verdict = gradeResponseRow(
        row.gradingPolicy,
        question,
        index === undefined ? undefined : { kind: "choice", index },
      );
      if (verdict === null) mismatch();
      return verdict;
    },
  };
}

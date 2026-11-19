import {
  attemptTimeLimitMinutesSchema,
  frozenGradingPolicySchema,
  questionSchema,
  singleChoiceScoringSourceSchema,
} from "@tutor/contract";
import { studentStemMd } from "@tutor/md-dsl";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import type { Assignment, Attempt } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  frozenGradingPolicyOf,
  liveAttemptContextClosure,
} from "./attempt-context.ts";
import { freezeInputsOfNewAttempt, questionOfRow } from "./attempt-freeze.ts";
import { newDraftAttempt } from "./new-draft-attempt.ts";
import { studentSelfReviewEnabledOf } from "./practice-feedback-settings-service.ts";

export const kernelOpeningDraftSchema = z.strictObject({
  courseId: z.string().nullable(),
  timeLimitMinutes: attemptTimeLimitMinutesSchema.optional(),
  workflowVersion: z.literal(1).optional(),
  prepared: z.literal(true).optional(),
  responses: z
    .array(
      z.strictObject({
        question: questionSchema,
        questionVersion: z.int().positive(),
        unitId: z.string(),
        gradingPolicy: frozenGradingPolicySchema,
      }),
    )
    .min(1),
});

export type KernelOpeningDraft = z.infer<typeof kernelOpeningDraftSchema>;

export function kernelDraftForAssignment(
  assignment: Pick<Assignment, "id" | "courseId">,
  studentId: string,
  id: string,
  startedAt: string,
  options: Pick<
    Parameters<typeof newDraftAttempt>[0],
    | "timeLimitMinutes"
    | "practiceWorkflowVersion"
    | "feedbackMode"
    | "workflowRevision"
  > = {},
): Attempt {
  return newDraftAttempt({
    id,
    studentId,
    sourceType: "assignment",
    assignmentId: assignment.id,
    courseId: assignment.courseId,
    unitId: null,
    lectureId: null,
    attemptNo: 1,
    startedAt,
    ...options,
  });
}

function ineligible(): never {
  throw new HttpError(
    422,
    "M04_PRACTICE_INELIGIBLE",
    "内核作业仅支持无材料和提示的整卷单选练习",
  );
}

export function assertKernelAssignmentPolicy(assignment: Assignment): void {
  if (assignment.allowPerQuestionFeedback || assignment.allowRedo) ineligible();
}

export function loadKernelAssignmentChoices(
  db: Db,
  assignment: Assignment,
  studentId: string,
) {
  const candidate = kernelDraftForAssignment(
    assignment,
    studentId,
    assignment.id,
    assignment.createdAt,
  );
  const freeze = freezeInputsOfNewAttempt(db, candidate);
  const { liveRows, teacherId, knowledgeByQuestion } = freeze;
  if (
    teacherId === null ||
    teacherId !== assignment.teacherId ||
    liveRows.length === 0
  )
    ineligible();
  const context = liveAttemptContextClosure(
    db,
    teacherId,
    liveRows.map(({ id }) => id),
  );
  if (context.materials.length || context.groups.length) ineligible();

  const selfReview = studentSelfReviewEnabledOf(db, teacherId);
  const rows = liveRows.map((row) => {
    const snapshot = questionOfRow(row, knowledgeByQuestion.get(row.id) ?? []);
    const scoring = singleChoiceScoringSourceSchema.safeParse(snapshot);
    if (!scoring.success || snapshot.hints?.length) ineligible();
    const { options, answers } = scoring.data;
    const frozen = {
      question: snapshot,
      questionVersion: row.version,
      unitId: row.unitId,
      gradingPolicy: frozenGradingPolicyOf(snapshot, selfReview),
    };
    const question = {
      id: snapshot.id,
      version: row.version,
      prompt: studentStemMd(snapshot),
      options: Object.fromEntries(
        options.map(({ text }, index) => [String(index), text]),
      ),
      acceptedChoice: String(answers.index),
    };
    return { frozen, question };
  });
  return {
    responses: rows.map(({ frozen }) => frozen),
    questions: rows.map(({ question }) => question),
  };
}

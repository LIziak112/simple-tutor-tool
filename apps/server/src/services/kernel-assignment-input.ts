import {
  attemptContextSnapshotEntrySchema,
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
import { multiScoringSourceOf } from "./attempt-choice-evaluation.ts";
import {
  contextEntriesOf,
  frozenGradingPolicyOf,
  liveAttemptContextClosure,
} from "./attempt-context.ts";
import { freezeInputsOfNewAttempt, questionOfRow } from "./attempt-freeze.ts";
import { newDraftAttempt } from "./new-draft-attempt.ts";
import { studentSelfReviewEnabledOf } from "./practice-feedback-settings-service.ts";

const kernelFrozenAssignmentSchema = z.strictObject({
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
  context: z.array(attemptContextSnapshotEntrySchema).optional(),
});

export const kernelOpeningDraftSchema = kernelFrozenAssignmentSchema.extend({
  courseId: z.string().nullable(),
  timeLimitMinutes: attemptTimeLimitMinutesSchema.optional(),
  workflowVersion: z.literal(1).optional(),
  prepared: z.literal(true).optional(),
});

export const kernelRefreezeDraftSchema = z.union([
  kernelFrozenAssignmentSchema,
  kernelFrozenAssignmentSchema.shape.responses.transform((responses) => ({
    responses,
    context: undefined,
  })),
]);

export type KernelOpeningDraft = z.infer<typeof kernelOpeningDraftSchema>;
export type KernelRefreezeDraft = z.input<typeof kernelRefreezeDraftSchema>;

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
    "内核作业仅支持无提示且题型一致的整卷单选、判断或多选，判断和多选须有参考答案且不带材料和题组",
  );
}

export function assertKernelAssignmentPolicy(assignment: Assignment): void {
  if (assignment.allowPerQuestionFeedback || assignment.allowRedo) ineligible();
}

export function loadKernelAssignmentQuestions(
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
  if (context.materials.length === 0 && context.groups.length > 0) ineligible();

  const selfReview = studentSelfReviewEnabledOf(db, teacherId);
  const responses = liveRows.map((row) => {
    const question = questionOfRow(row, knowledgeByQuestion.get(row.id) ?? []);
    if (question.hints?.length) ineligible();
    return {
      question,
      questionVersion: row.version,
      unitId: row.unitId,
      gradingPolicy: frozenGradingPolicyOf(question, selfReview),
    };
  });
  const common = ({
    question,
    questionVersion,
  }: (typeof responses)[number]) => ({
    id: question.id,
    version: questionVersion,
    prompt: studentStemMd(question),
  });
  if (responses[0]?.question.type === "judge") {
    if (context.materials.length) ineligible();
    const questions = responses.map((row) => {
      const { question } = row;
      if (question.type !== "judge" || question.answers?.kind !== "judge")
        ineligible();
      return {
        ...common(row),
        options: { true: "正确", false: "错误" },
        acceptedResponse: question.answers.value,
      };
    });
    return { kind: "judge" as const, responses, questions, context: [] };
  }
  if (responses[0]?.question.type === "multi") {
    if (context.materials.length || context.groups.length) ineligible();
    const questions = responses.map((row) => {
      const source = multiScoringSourceOf(row.question);
      if (!source) ineligible();
      return {
        ...common(row),
        options: indexedOptions(source.options),
        acceptedIndexes: source.indexes,
      };
    });
    return { kind: "multi" as const, responses, questions, context: [] };
  }
  const questions = responses.map((row) => {
    const parsed = singleChoiceScoringSourceSchema.safeParse(row.question);
    if (!parsed.success) ineligible();
    const { options, answers } = parsed.data;
    return {
      ...common(row),
      options: indexedOptions(options),
      acceptedChoice: String(answers.index),
    };
  });
  const entries = z
    .array(attemptContextSnapshotEntrySchema)
    .parse(contextEntriesOf(context));
  if (context.materials.some(({ contentMd }) => contentMd.trim() === ""))
    ineligible();
  return { kind: "choice" as const, responses, questions, context: entries };
}

function indexedOptions(options: readonly { text: string }[]) {
  return Object.fromEntries(options.map(({ text }, index) => [String(index), text]));
}

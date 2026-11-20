import {
  assignmentScoringSourcesSchema,
  attemptContextSnapshotEntrySchema,
  attemptTimeLimitMinutesSchema,
  frozenGradingPolicySchema,
  questionSchema,
  wholeQuestionDeliveryScoringSourcesSchema,
} from "@tutor/contract";
import { studentStemMd } from "@tutor/md-dsl";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import type { Assignment, Attempt } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
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
    "内核作业须使用已支持的题型与参考答案，混合整卷暂不支持提示、材料和题组",
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
  const parsed = assignmentScoringSourcesSchema.safeParse(
    responses.map(({ question }) => question),
  );
  if (!parsed.success) {
    if (
      context.materials.length ||
      context.groups.length ||
      !wholeQuestionDeliveryScoringSourcesSchema.safeParse(
        responses.map(({ question }) => question),
      ).success
    )
      ineligible();
    return { slotType: "questionDelivery" as const, responses, context: [] };
  }
  const { slotType, questions: sources } = parsed.data;
  const common = (index: number) => {
    const row = responses[index];
    if (!row) ineligible();
    return {
      id: row.question.id,
      version: row.questionVersion,
      prompt: studentStemMd(row.question),
    };
  };
  if (slotType === "oneResponsePerQuestion") {
    if (context.materials.length) ineligible();
    const questions = sources.map(({ answers }, index) => ({
      ...common(index),
      options: { true: "正确", false: "错误" },
      acceptedResponse: answers.value,
    }));
    return { slotType, responses, questions, context: [] };
  }
  const questions = sources.map(({ options, answers }, index) => ({
    ...common(index),
    options: Object.fromEntries(
      options.map(({ text }, optionIndex) => [String(optionIndex), text]),
    ),
    acceptedChoice: String(answers.index),
  }));
  const entries = z
    .array(attemptContextSnapshotEntrySchema)
    .parse(contextEntriesOf(context));
  if (context.materials.some(({ contentMd }) => contentMd.trim() === ""))
    ineligible();
  return { slotType, responses, questions, context: entries };
}

import {
  type AttemptContextSnapshotEntry,
  answerDirective,
  assignmentScoringSourcesSchema,
  attemptContextSnapshotEntrySchema,
  attemptTimeLimitMinutesSchema,
  frozenGradingPolicySchema,
  getDirective,
  isTeacherReviewDeliveryScoringSource,
  judgeScoringSourceSchema,
  multiChoiceScoringSourceSchema,
  type Question,
  questionSchema,
  refDirective,
  singleChoiceScoringSourceSchema,
  wholeQuestionDeliveryScoringSourcesSchema,
} from "@tutor/contract";
import {
  detectNewContent,
  expandSelectionIds,
  processor,
  studentStemMd,
} from "@tutor/md-dsl";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import type { Assignment, Attempt } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  closureRefIds,
  contextEntriesOf,
  frozenGradingPolicyOf,
  liveAttemptContextClosure,
} from "./attempt-context.ts";
import { freezeInputsOfNewAttempt, questionOfRow } from "./attempt-freeze.ts";
import { newDraftAttempt } from "./new-draft-attempt.ts";
import { studentSelfReviewEnabledOf } from "./practice-feedback-settings-service.ts";
import { jsonOf } from "./snapshot.ts";

const kernelCourseScoringSourceSchema = z.union([
  singleChoiceScoringSourceSchema,
  judgeScoringSourceSchema,
  multiChoiceScoringSourceSchema,
]);

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
  restartAttemptId: z.uuid().optional(),
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

export function kernelCourseDraftFor(
  db: Db,
  attempt: Attempt,
  expectedTeacherId: string,
  selfReview: boolean,
  restartAttemptId?: string,
) {
  const { liveRows, teacherId, knowledgeByQuestion } = freezeInputsOfNewAttempt(
    db,
    attempt,
  );
  if (teacherId !== expectedTeacherId || !liveRows.length) return undefined;
  const responses = liveRows.map((row) => {
    const question = questionOfRow(row, knowledgeByQuestion.get(row.id) ?? []);
    return {
      question,
      questionVersion: row.version,
      unitId: row.unitId,
      gradingPolicy: frozenGradingPolicyOf(question, selfReview),
    };
  });
  if (
    responses.some(
      ({ question, gradingPolicy }) =>
        gradingPolicy !== "auto" ||
        question.hints?.length ||
        !kernelCourseScoringSourceSchema.safeParse(question).success,
    )
  )
    return undefined;
  const context = liveAttemptContextClosure(
    db,
    teacherId,
    liveRows.map(({ id }) => id),
  );
  if (
    (context.materials.length === 0 && context.groups.length > 0) ||
    context.materials.some(({ contentMd }) => contentMd.trim() === "")
  )
    return undefined;

  return kernelOpeningDraftSchema.parse({
    courseId: attempt.courseId,
    workflowVersion: 1,
    restartAttemptId,
    timeLimitMinutes:
      attempt.timeLimitSec === null ? undefined : attempt.timeLimitSec / 60,
    responses,
    context: contextEntriesOf(context),
  });
}

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
    "内核作业须使用受支持的题型、参考答案和材料",
  );
}

export function assertKernelAssignmentPolicy(assignment: Assignment): void {
  if (assignment.allowPerQuestionFeedback || assignment.allowRedo) ineligible();
}

function assertNoStoredReference(
  sourceMd: string,
  storedAnswers: string | null,
): void {
  // 旧投影可能把坏参考字段丢成缺省，原文里的空答案块也不能视为无参考。
  const [source] = processor.parse(sourceMd).children;
  if (
    storedAnswers !== null ||
    source?.type !== "containerDirective" ||
    source.children.some(
      (child) =>
        child.type === "containerDirective" &&
        getDirective(child.name)?.name === answerDirective.name,
    )
  )
    ineligible();
}

function matchingReviewWidth(
  question: Question,
  entries: readonly AttemptContextSnapshotEntry[],
): number {
  const selected = new Set<string>();
  for (const ref of question.materialRefs ?? []) {
    if (ref.slots === undefined) continue;
    const material = entries.find(
      (entry) => entry.kind === "material" && entry.sourceId === ref.material,
    );
    if (material?.kind !== "material") ineligible();
    const slots = material.snapshot.slots;
    const order = slots.map(({ id }) => id);
    const matchingSlots = new Set(
      slots.filter(({ slotKind }) => slotKind === "match").map(({ id }) => id),
    );
    for (const selection of ref.slots.split(",")) {
      if (selection.trim() === "") continue;
      const expanded = expandSelectionIds(selection, order);
      if (!expanded.length || expanded.some((id) => !matchingSlots.has(id)))
        ineligible();
      for (const id of expanded) selected.add(id);
    }
  }
  if (!selected.size) ineligible();
  // 内核原值的每对两个位置分别保留槽位 id 和选项 id。
  return selected.size * 2;
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
    return {
      question,
      questionVersion: row.version,
      unitId: row.unitId,
      gradingPolicy: frozenGradingPolicyOf(question, selfReview),
    };
  });
  if (context.materials.some(({ contentMd }) => contentMd.trim() === ""))
    ineligible();
  const entries = z
    .array(attemptContextSnapshotEntrySchema)
    .parse(contextEntriesOf(context));
  const frozenQuestions = responses.map(({ question }) => question);
  const parsed = assignmentScoringSourcesSchema.safeParse(frozenQuestions);
  if (!parsed.success) {
    const delivery =
      wholeQuestionDeliveryScoringSourcesSchema.safeParse(frozenQuestions);
    if (!delivery.success) ineligible();
    const teacherReviewWidths = new Map<string, number>();
    for (const [index, source] of delivery.data.entries()) {
      if (!isTeacherReviewDeliveryScoringSource(source)) continue;
      const row = liveRows[index];
      const frozen = responses[index];
      if (!row || !frozen || frozen.gradingPolicy !== "manual_only")
        ineligible();
      assertNoStoredReference(frozen.question.sourceMd, row.answersJson);
      if (!("matchingOptions" in source)) continue;
      if (source.materialRefs?.length) {
        teacherReviewWidths.set(
          row.id,
          matchingReviewWidth(frozen.question, entries),
        );
        continue;
      }
      // 零槽位须来自真实缺省。冻结投影可能剥去破损的引用列。
      const refs =
        row.materialRefsJson === null ? [] : jsonOf(row.materialRefsJson);
      if (
        !Array.isArray(refs) ||
        refs.length > 0 ||
        detectNewContent(row.sourceMd).some(
          ({ kind, name }) =>
            kind === "directive" && name === refDirective.name,
        ) ||
        (context.materials.length > 0 &&
          closureRefIds(db, teacherId, [row.id]).materialIds.size > 0)
      )
        ineligible();
      teacherReviewWidths.set(row.id, 0);
    }
    return {
      slotType: "questionDelivery" as const,
      responses,
      context: entries,
      teacherReviewWidths,
    };
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
  return { slotType, responses, questions, context: entries };
}

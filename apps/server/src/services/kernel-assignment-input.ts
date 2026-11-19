import { singleChoiceScoringSourceSchema } from "@tutor/contract";
import { studentStemMd } from "@tutor/md-dsl";
import type { Db } from "../db/client.ts";
import type { Assignment, Attempt } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { liveAttemptContextClosure } from "./attempt-context.ts";
import { freezeInputsOfNewAttempt, questionOfRow } from "./attempt-freeze.ts";
import { newDraftAttempt } from "./new-draft-attempt.ts";

export function kernelDraftForAssignment(
  assignment: Assignment,
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

  const questions = liveRows.map((row) => {
    const snapshot = questionOfRow(row, knowledgeByQuestion.get(row.id) ?? []);
    const scoring = singleChoiceScoringSourceSchema.safeParse(snapshot);
    if (!scoring.success || snapshot.hints?.length) ineligible();
    const { options, answers } = scoring.data;
    return {
      id: snapshot.id,
      version: row.version,
      prompt: studentStemMd(snapshot),
      options: Object.fromEntries(
        options.map(({ text }, index) => [String(index), text]),
      ),
      acceptedChoice: String(answers.index),
    };
  });
  return { freeze, questions };
}

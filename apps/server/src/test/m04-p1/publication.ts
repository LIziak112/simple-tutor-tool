import { studentStemMd } from "@tutor/md-dsl";
import type { PublicationInput } from "learning-kernel";
import type { Db } from "../../db/client.ts";
import type { Assignment } from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";
import { liveAttemptContextClosure } from "../../services/attempt-context.ts";
import {
  freezeInputsOfNewAttempt,
  questionOfRow,
} from "../../services/attempt-freeze.ts";
import { newDraftAttempt } from "../../services/new-draft-attempt.ts";

export function draftForAssignment(
  assignment: Assignment,
  studentId: string,
  id: string,
  startedAt: string,
) {
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
  });
}

function ineligible(): never {
  throw new HttpError(
    422,
    "M04_PRACTICE_INELIGIBLE",
    "仅支持无材料的普通单选作业",
  );
}

export function publicationForAssignment(
  db: Db,
  assignment: Assignment,
  studentId: string,
) {
  // 复用真实开卷的冻结输入与校验。此处的草稿描述只用于读取有序题集。
  const draft = draftForAssignment(
    assignment,
    studentId,
    assignment.id,
    new Date().toISOString(),
  );
  const { liveRows, teacherId, knowledgeByQuestion } = freezeInputsOfNewAttempt(
    db,
    draft,
  );
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
    const { id, type, options, answers, hints } = snapshot;
    if (
      type !== "choice" ||
      answers?.kind !== "choice" ||
      !options?.[answers.index] ||
      hints?.length
    ) {
      ineligible();
    }
    return {
      id,
      version: row.version,
      prompt: studentStemMd(snapshot),
      options: Object.fromEntries(
        options.map(({ text }, index) => [String(index), text]),
      ),
      acceptedChoice: String(answers.index),
    };
  });
  const scoringKey = {
    id: `${assignment.id}-key`,
    version: 1,
    acceptedChoices: Object.fromEntries(
      questions.map(({ id, acceptedChoice }) => [id, acceptedChoice]),
    ),
  };
  const instructions = "选择每题的一个选项。";
  return {
    revisions: questions.map(({ id, version }) => ({ id, version })),
    input: {
      practice: {
        id: assignment.id,
        version: 1,
        formatVersion: 1,
        title: assignment.title,
        goals: { answer: instructions },
        questions: questions.map(({ id, prompt, options }) => ({
          id,
          prompt,
          options,
        })),
        steps: [
          {
            id: "answer",
            instructions,
            tool: { id: "single-choice-group", version: 1 },
            inputs: { questions: { from: "questions" } },
            submit: {
              purpose: "finalAnswer",
              slots: {
                answers: {
                  type: "oneChoicePerQuestion",
                  source: "questions",
                  targetId: "answer",
                },
              },
            },
            afterConfirmation: "finish",
          },
        ],
        grading: {
          assessment: {
            from: { stepId: "answer", slotId: "answers" },
            evaluator: { id: "choice-key", version: 1 },
            keyRef: { id: scoringKey.id, version: scoringKey.version },
            unit: "question",
            effectiveVerdictOrder: ["teacherReview", "automatic"],
          },
        },
        policy: {
          offline: "onlineOnly",
          redo: "newInstanceOnAuthorization",
          student: {
            ownSubmission: {
              scope: "ownConfirmedSubmissions",
              fields: ["receipt", "ownChoices"],
              onFinal: [],
            },
          },
          reviewer: { scope: "assignedReviewer", fields: [], actions: [] },
          manager: { scope: "assigningTeacher", actions: [] },
          externalAi: "disabled",
        },
      },
      scoringKey,
    } satisfies PublicationInput,
  };
}

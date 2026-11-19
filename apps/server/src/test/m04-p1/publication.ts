import type { PublicationInput } from "learning-kernel";
import type { Db } from "../../db/client.ts";
import { type Assignment, type Attempt, attempts } from "../../db/schema.ts";
import {
  freezeInputsOfNewAttempt,
  insertFrozenResponses,
} from "../../services/attempt-freeze.ts";
import {
  kernelDraftForAssignment,
  loadKernelAssignmentChoices,
} from "../../services/kernel-assignment-input.ts";
import { studentSelfReviewEnabledOf } from "../../services/practice-feedback-settings-service.ts";

export const draftForAssignment = kernelDraftForAssignment;

export function projectTrialDraft(db: Db, draft: Attempt) {
  const { liveRows, teacherId, knowledgeByQuestion } = freezeInputsOfNewAttempt(
    db,
    draft,
  );
  db.transaction((tx) => {
    tx.insert(attempts).values(draft).run();
    insertFrozenResponses(
      tx,
      draft.id,
      liveRows,
      knowledgeByQuestion,
      studentSelfReviewEnabledOf(db, teacherId),
    );
  });
}

export function publicationForAssignment(
  db: Db,
  assignment: Assignment,
  studentId: string,
) {
  const { questions } = loadKernelAssignmentChoices(db, assignment, studentId);
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

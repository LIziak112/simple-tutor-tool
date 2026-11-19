import type { PublicationInput } from "learning-kernel";
import type { Assignment } from "../db/schema.ts";
import { ownClassChoiceEvaluatorRef } from "./attempt-choice-evaluation.ts";
import type { loadKernelAssignmentChoices } from "./kernel-assignment-input.ts";

export function kernelAssignmentPublication(
  assignment: Assignment,
  version: number,
  questions: ReturnType<typeof loadKernelAssignmentChoices>["questions"],
) {
  const scoringKey = {
    id: `${assignment.id}-key`,
    version,
    acceptedChoices: Object.fromEntries(
      questions.map(({ id, acceptedChoice }) => [id, acceptedChoice]),
    ),
  };
  const instructions = "选择每题的一个选项。";
  return {
    practice: {
      id: assignment.id,
      version,
      formatVersion: 1,
      title: assignment.title,
      goals: { answer: instructions },
      questions: questions.map(({ id, version, prompt, options }) => ({
        id,
        version,
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
                confirmFromDrafts: { allowUnanswered: true },
              },
            },
          },
          afterConfirmation: "finish",
        },
      ],
      grading: {
        assessment: {
          from: { stepId: "answer", slotId: "answers" },
          evaluator: ownClassChoiceEvaluatorRef,
          keyRef: { id: scoringKey.id, version },
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
  } satisfies PublicationInput;
}

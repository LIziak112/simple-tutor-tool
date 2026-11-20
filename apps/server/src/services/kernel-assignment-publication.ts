import type { PublicationInput } from "learning-kernel";
import type { Assignment } from "../db/schema.ts";
import {
  ownClassChoiceEvaluatorRef,
  ownClassJudgeEvaluatorRef,
} from "./attempt-choice-evaluation.ts";
import type { loadKernelAssignmentQuestions } from "./kernel-assignment-input.ts";

export function kernelAssignmentPublication(
  assignment: Assignment,
  version: number,
  definition: ReturnType<typeof loadKernelAssignmentQuestions>,
) {
  const key = { id: `${assignment.id}-key`, version };
  const scoringKey =
    definition.kind === "judge"
      ? {
          ...key,
          acceptedResponses: Object.fromEntries(
            definition.questions.map(({ id, acceptedResponse }) => [
              id,
              acceptedResponse,
            ]),
          ),
        }
      : {
          ...key,
          acceptedChoices: Object.fromEntries(
            definition.questions.map(({ id, acceptedChoice }) => [
              id,
              acceptedChoice,
            ]),
          ),
        };
  const judge = definition.kind === "judge";
  const instructions = judge ? "判断每道题。" : "选择每题的一个选项。";
  const slot = {
    source: "questions",
    targetId: "answer",
    confirmFromDrafts: { allowUnanswered: true },
  };
  return {
    practice: {
      id: assignment.id,
      version,
      formatVersion: 1,
      title: assignment.title,
      goals: { answer: instructions },
      questions: definition.questions.map(
        ({ id, version, prompt, options }) => ({
          id,
          version,
          prompt,
          options,
        }),
      ),
      steps: [
        {
          id: "answer",
          instructions,
          tool: {
            id: judge ? "response-group" : "single-choice-group",
            version: 1,
          },
          inputs: { questions: { from: "questions" } },
          submit: {
            purpose: "finalAnswer",
            slots: {
              answers: judge
                ? {
                    type: "oneResponsePerQuestion",
                    input: "booleanOrString",
                    ...slot,
                  }
                : { type: "oneChoicePerQuestion", ...slot },
            },
          },
          afterConfirmation: "finish",
        },
      ],
      grading: {
        assessment: {
          from: { stepId: "answer", slotId: "answers" },
          evaluator: judge
            ? ownClassJudgeEvaluatorRef
            : ownClassChoiceEvaluatorRef,
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
            fields: ["receipt", judge ? "ownResponses" : "ownChoices"],
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

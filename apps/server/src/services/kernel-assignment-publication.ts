import { createHash } from "node:crypto";
import type {
  AttemptContextSnapshotEntry,
  MaterialRef,
  Question,
} from "@tutor/contract";
import type { PublicationInput, StudentActivity } from "learning-kernel";
import type { Assignment } from "../db/schema.ts";
import { canonicalJsonOf } from "../lib/canonical-json.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  ownClassChoiceEvaluatorRef,
  ownClassJudgeEvaluatorRef,
  ownClassMultiEvaluatorRef,
} from "./attempt-choice-evaluation.ts";
import type { loadKernelAssignmentQuestions } from "./kernel-assignment-input.ts";

function materialIdentifier(
  prefix: string,
  identity: readonly unknown[],
): string {
  return (
    prefix +
    "-" +
    createHash("sha256").update(canonicalJsonOf(identity)).digest("hex")
  );
}

type QuestionReferences = Pick<Question, "id" | "materialRefs">;

function materialPublicationOf(
  teacherId: string | null,
  context: readonly AttemptContextSnapshotEntry[],
  questions: readonly QuestionReferences[],
) {
  const materials = new Map(
    context.flatMap((entry) => {
      if (entry.kind !== "material") return [];
      const definition = {
        id: materialIdentifier("material", [teacherId, entry.sourceId]),
        version: entry.sourceVersion,
        source: entry.sourceId,
        title: entry.snapshot.title?.trim() || entry.sourceId,
        paragraphs: [{ id: "content", text: entry.snapshot.contentMd }],
      };
      return [[entry.sourceId, definition] as const];
    }),
  );
  function uses(
    kind: "group" | "question",
    id: string,
    refs: readonly MaterialRef[],
  ) {
    return refs.map((reference, index) => {
      const material = materials.get(reference.material);
      if (!material)
        throw new HttpError(
          409,
          "ATTEMPT_CONTEXT_BROKEN",
          "作答的材料引用与冻结上下文不一致",
        );
      const positionId = materialIdentifier("position", [
        kind,
        id,
        index,
        reference,
      ]);
      return { from: "material" as const, positionId, material };
    });
  }
  const positions = [
    ...context.flatMap((entry) =>
      entry.kind === "group"
        ? uses("group", entry.sourceId, entry.snapshot.materialRefs)
        : [],
    ),
    ...questions.flatMap(({ id, materialRefs }) =>
      uses("question", id, materialRefs ?? []),
    ),
  ];
  if (
    new Set(positions.map(({ material }) => material.id)).size !==
    materials.size
  )
    throw new HttpError(
      409,
      "ATTEMPT_CONTEXT_BROKEN",
      "作答的冻结材料缺少使用位置",
    );
  return { materials: [...materials.values()], positions };
}

export function matchesKernelMaterialInputs(
  activity: StudentActivity,
  teacherId: string | null,
  context: readonly AttemptContextSnapshotEntry[],
  questions: readonly QuestionReferences[],
): boolean {
  const { positions } = materialPublicationOf(teacherId, context, questions);
  const expected = Object.fromEntries(
    positions.map((position) => [position.positionId, position]),
  );
  const actual =
    "inputs" in activity
      ? Object.fromEntries(
          Object.entries(activity.inputs).filter(
            ([, input]) => input.from === "material",
          ),
        )
      : {};
  return canonicalJsonOf(expected) === canonicalJsonOf(actual);
}

export function kernelAssignmentPublication(
  assignment: Assignment,
  version: number,
  definition: ReturnType<typeof loadKernelAssignmentQuestions>,
) {
  const { materials, positions } = materialPublicationOf(
    assignment.teacherId,
    definition.context,
    definition.responses.map(({ question }) => question),
  );
  const materialInputs = Object.fromEntries(
    positions.map(({ from, positionId, material }) => [
      positionId,
      {
        from,
        positionId,
        material: { id: material.id, version: material.version },
      },
    ]),
  );
  const key = { id: `${assignment.id}-key`, version };
  const scoringKey = assignmentScoringKey(key, definition);
  const kind = definition.kind;
  const instructions = kind === "judge" ? "判断每道题。" :
    kind === "multi" ? "选择每题所有符合条件的选项。" : "选择每题的一个选项。";
  const slot = {
    source: "questions",
    targetId: "answer",
    confirmFromDrafts: { allowUnanswered: true },
  };
  return {
    ...(materials.length > 0 && { materials }),
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
            id: kind === "choice" ? "single-choice-group" : "response-group",
            version: 1,
          },
          inputs: { questions: { from: "questions" }, ...materialInputs },
          submit: {
            purpose: "finalAnswer",
            slots: {
              answers: kind !== "choice"
                ? {
                    type: "oneResponsePerQuestion",
                    input: kind === "multi" ? "optionIndexArray" : "booleanOrString",
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
          evaluator: kind === "choice" ? ownClassChoiceEvaluatorRef :
            kind === "multi" ? ownClassMultiEvaluatorRef : ownClassJudgeEvaluatorRef,
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
            fields: ["receipt", kind === "choice" ? "ownChoices" : "ownResponses"],
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

function assignmentScoringKey(
  key: { id: string; version: number },
  definition: ReturnType<typeof loadKernelAssignmentQuestions>,
) {
  switch (definition.kind) {
    case "judge":
      return { ...key, acceptedResponses: Object.fromEntries(definition.questions.map(({ id, acceptedResponse }) => [id, acceptedResponse])) };
    case "multi":
      return { ...key, acceptedIndexes: Object.fromEntries(definition.questions.map(({ id, acceptedIndexes }) => [id, acceptedIndexes])) };
    case "choice":
      return { ...key, acceptedChoices: Object.fromEntries(definition.questions.map(({ id, acceptedChoice }) => [id, acceptedChoice])) };
  }
}

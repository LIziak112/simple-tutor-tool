import {
  isResponseDeliveryScoringSource,
  type Question,
  questionDeliveryScoringSourcesSchema,
  wholeQuestionDeliveryScoringSourcesSchema,
} from "@tutor/contract";
import { studentStemMd } from "@tutor/md-dsl";
import type { PublicationInput } from "learning-kernel";
import { ownClassDeliveryEvaluatorRef } from "./attempt-choice-evaluation.ts";
import {
  ownClassJudgeAnswerRuleRef,
  ownClassResponseAnswerRuleRef,
} from "./kernel-question-delivery-values.ts";

export const deliverySlotId = "answers";

type Frozen = { question: Question; questionVersion: number };
type DeliveryPublication = Extract<PublicationInput, { materials?: unknown }>;
type MaterialInput = Extract<
  DeliveryPublication["practice"]["steps"][0]["inputs"][string],
  { from: "material" }
>;

export function questionDeliveryPublication(
  { id, title }: { id: string; title: string },
  version: number,
  rows: readonly Frozen[],
  mode: "whole" | "perQuestion",
  materialInputs?: Record<string, MaterialInput>,
) {
  const schema =
    mode === "whole"
      ? wholeQuestionDeliveryScoringSourcesSchema
      : questionDeliveryScoringSourcesSchema;
  const sources = schema.parse(rows.map(({ question }) => question));
  const key = { id: `${id}-key`, version };
  const declared = rows.map(({ question, questionVersion }, index) => {
    const source = sources[index];
    if (!source) throw new Error("冻结题与评分来源不齐");
    const base = {
      id: question.id,
      version: questionVersion,
      prompt: studentStemMd(question),
    };
    if ("acceptedBlanks" in source) {
      const response = "orderedTextBlanks" as const;
      const { acceptedBlanks } = source;
      return {
        question: { ...base, response, blankCount: acceptedBlanks.length },
        key: { response, acceptedBlanks },
      };
    }
    if (isResponseDeliveryScoringSource(source)) {
      const response = "textWithOptionalTitle" as const;
      return { question: { ...base, response }, key: { response } };
    }
    if (!("options" in source)) {
      const response = "booleanOrString" as const;
      return {
        question: {
          ...base,
          response,
          options: { true: "正确", false: "错误" },
        },
        key: { response, acceptedResponse: source.answers.value },
      };
    }
    const options = Object.fromEntries(
      source.options.map(({ text }, i) => [String(i), text]),
    );
    if ("index" in source.answers) {
      const response = "choice" as const;
      return {
        question: { ...base, response, options },
        key: { response, acceptedChoice: String(source.answers.index) },
      };
    }
    const response = "optionIndexArray" as const;
    return {
      question: { ...base, response, options },
      key: { response, acceptedIndexes: source.answers.indexes },
    };
  });
  const answerRules = declared.flatMap(({ question }) => {
    const rule =
      question.response === "textWithOptionalTitle"
        ? ownClassResponseAnswerRuleRef
        : mode === "whole" && question.response === "booleanOrString"
          ? ownClassJudgeAnswerRuleRef
          : undefined;
    return rule ? [[question.id, rule] as const] : [];
  });
  const instructions = "完成练习并提交答案。";
  return {
    practice: {
      id,
      version,
      formatVersion: 1,
      title,
      goals: { answer: instructions },
      questions: declared.map((item) => item.question),
      ...(answerRules.length > 0 && {
        questionAnswerRules: Object.fromEntries(answerRules),
      }),
      steps: [
        {
          id: "answer",
          instructions,
          tool: { id: "question-delivery", version: 1 },
          inputs: { ...materialInputs, questions: { from: "questions" } },
          submit: {
            purpose: "finalAnswer",
            slots: {
              [deliverySlotId]: {
                type: "questionDelivery",
                source: "questions",
                targetId: "answer",
                confirmFromDrafts: { allowUnanswered: true },
                delivery:
                  mode === "whole"
                    ? { mode }
                    : {
                        mode,
                        questionSlots: Object.fromEntries(
                          rows.map(({ question }, index) => [
                            question.id,
                            `question-${index + 1}`,
                          ]),
                        ),
                      },
              },
            },
          },
          afterConfirmation: "finish",
        },
      ],
      grading: {
        assessment: {
          from: { stepId: "answer", slotId: deliverySlotId },
          evaluator: ownClassDeliveryEvaluatorRef,
          keyRef: key,
          unit: "question",
          effectiveVerdictOrder: ["teacherReview", "automatic"],
        },
      },
      policy: {
        offline: "onlineOnly",
        redo: "newInstanceOnAuthorization",
        externalAi: "disabled",
        student: {
          ownSubmission: {
            scope: "ownConfirmedSubmissions",
            fields: ["receipt"],
            onFinal: [],
          },
        },
        reviewer: { scope: "assignedReviewer", fields: [], actions: [] },
        manager: { scope: "assigningTeacher", actions: [] },
      },
    },
    scoringKey: {
      ...key,
      acceptedByQuestion: Object.fromEntries(
        declared.map((item) => [item.question.id, item.key]),
      ),
    },
  } satisfies PublicationInput;
}

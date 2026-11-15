import type {
  AttemptResultData,
  AttemptResultQuestion,
  MaterialRef,
} from "@tutor/contract";
import type { ReactNode } from "react";
import {
  groupSegmentsOfUnit,
  questionMaterialsOf,
} from "./attempt-context-view";
import type { useAttemptContext } from "./attempt-queries";
import type { LazyMountWindow } from "./lazy-mount-window";
import { QuestionGroupAnchor } from "./QuestionGroupAnchor";
import { QuestionMaterialsAnchor } from "./QuestionMaterialsAnchor";
import { placeholderHeight } from "./question-placeholder-height";
import { ResultQuestionRow } from "./ResultQuestionRow";

/** 按原单元和材料顺序保留轻量锚点；题卡内容由共享调度器按需挂载。 */
export function ResultQuestionList({
  data,
  context,
  indexOfQuestion,
  controller,
  lazy,
  renderQuestion,
  showMaterials = true,
}: {
  showMaterials?: boolean;
  data: AttemptResultData;
  context: ReturnType<typeof useAttemptContext>["data"];
  indexOfQuestion: ReadonlyMap<string, number>;
  controller: LazyMountWindow | null;
  lazy: boolean;
  renderQuestion: (question: AttemptResultQuestion, index: number) => ReactNode;
}) {
  const showUnitHeaders = data.units.length > 1;
  return (
    <ol className="flex flex-col gap-4">
      {data.units.map((unit) => {
        const questionById = new Map(
          unit.questions.map(
            (question) => [question.questionId, question] as const,
          ),
        );
        // P1-2：题级引用映射（学生题目投影携带）——组段并集 + solo 锚共用
        const questionRefs = new Map<string, readonly MaterialRef[]>([]);
        for (const question of unit.questions) {
          const refs = question.snapshot.materialRefs;
          if (refs !== undefined && refs.length > 0)
            questionRefs.set(question.questionId, refs);
        }
        const segments = groupSegmentsOfUnit(
          context,
          unit.questions.map((question) => question.questionId),
          questionRefs,
        );
        /** 单题行（组行/独立行共用；组行不挂「查看材料」——回看布局
                  上下排布自然阅读，无需 reveal 跳转） */
        const renderRow = (questionId: string) => {
          const question = questionById.get(questionId);
          if (question === undefined) return null;
          return (
            <ResultQuestionRow
              key={question.questionId}
              questionId={question.questionId}
              index={(indexOfQuestion.get(question.questionId) ?? 1) - 1}
              height={placeholderHeight(question.snapshot) + 160}
              controller={controller}
              lazy={lazy && (indexOfQuestion.get(question.questionId) ?? 1) > 2}
            >
              {renderQuestion(
                question,
                (indexOfQuestion.get(question.questionId) ?? 1) - 1,
              )}
            </ResultQuestionRow>
          );
        };
        return (
          <li key={unit.id} className="flex flex-col gap-4">
            {showUnitHeaders && (
              <h2
                data-review-unit={unit.id}
                className="flex items-center gap-2 pt-2 text-sm font-semibold text-foreground before:h-4 before:w-1 before:rounded-full before:bg-primary"
              >
                {unit.title}
              </h2>
            )}
            <ol data-layout="stack" className="flex flex-col gap-4">
              {segments.flatMap((segment) =>
                segment.kind === "solo"
                  ? segment.questionIds.flatMap((questionId) => {
                      const question = questionById.get(questionId);
                      if (question === undefined) return [];
                      // P1-2：solo 题级材料锚（回看自然阅读，无 reveal
                      // 跳转——与组材料列同理由）
                      const soloMaterials = showMaterials
                        ? questionMaterialsOf(context, question.snapshot)
                        : [];
                      return soloMaterials.length === 0
                        ? [renderRow(questionId)]
                        : [
                            <QuestionMaterialsAnchor
                              key={`qmat:${question.questionId}`}
                              questionId={question.questionId}
                              materials={soloMaterials}
                              readingKey={`${data.attempt.id}|q:${question.questionId}`}
                              className="min-w-0"
                              attemptId={data.attempt.id}
                            />,
                            renderRow(questionId),
                          ];
                    })
                  : [
                      <QuestionGroupAnchor
                        key={`group:${segment.group.id}`}
                        group={segment.group}
                        materials={showMaterials ? segment.materials : []}
                        questionCount={segment.questionIds.length}
                        readingKey={`${data.attempt.id}|${segment.group.id}`}
                        layoutMode="stack"
                        attemptId={data.attempt.id}
                      />,
                      ...segment.questionIds.map((questionId) =>
                        renderRow(questionId),
                      ),
                    ],
              )}
            </ol>
          </li>
        );
      })}
    </ol>
  );
}

import {
  type AttemptResultQuestion,
  dispatchBehavior,
  emptyPublicStructure,
  type QuestionAnswers,
} from "@tutor/contract";
import { answerKindViews, dispatchComparison } from "@/features/answering";
import { prepareQuestion } from "@/features/answering/prepare-question";
import { questionBindings } from "@/features/answering/question-binding";
import type { ReferenceMaterial } from "@/features/answering/types";
import {
  AnswerComparisonShell,
  referenceColumnOf,
} from "@/features/answering/views/comparison";
import { formatReferenceAnswers } from "./answer-format";

/**
 * 本人答案 vs 参考答案的两栏对照（结果视图/逐题反馈/讲练页题卡共用）。
 *
 * UA-03 起为呈现登记表的兼容宿主：fill 逐空对齐、额外历史项、缺参考空态与
 * 锁定提示全部收进各 kind 的 Comparison 呈现（answering/views，宿主不再特判
 * fill）；本组件只做两件事——
 * 1. 模型准备：snapshot → PreparedQuestion（公开内容白名单，prepareQuestion）；
 * 2. 授权组装（§6 宿主职责）：released 才提供参考（unavailable=锁定提示），
 *    answers===null 保持「暂无参考答案」空态；错配 kind 的历史参考由
 *    dispatchComparison 调度边界按 §6.1 调整 7 归一（通用参考文本，不崩溃
 *    不改写）。
 * QM-11 细项 2：matching/ordering 的逐项对照格式留 QM-13（呈现控件随同批
 * 落地），到达本宿主时以通用文本占位（本人 display 行为文本化 + 参考经
 * formatReferenceAnswers 序列化）——不伪造逐项格式、不崩溃，共用两栏壳
 * 与公布三态。
 */
export function ResultAnswerComparison({
  question,
  released,
}: {
  question: Pick<AttemptResultQuestion, "snapshot" | "answer" | "answers">;
  released: boolean;
}) {
  const reference: ReferenceMaterial<QuestionAnswers> = !released
    ? { status: "unavailable" }
    : question.answers === null
      ? { status: "no-reference" }
      : { status: "available", reference: question.answers };
  const answerKind = questionBindings[question.snapshot.type].answerKind;
  // 呈现登记表成员判别（I16 集合口径，§19.2-4 同款：不写字面量分支）——
  // 未接入呈现的 kind（当前 matching/ordering，QM-13 呈现层落地前）走通用
  // 文本占位；QM-13 在 answerKindViews 登记真实视图后占位自动消失
  if (!(answerKind in answerKindViews)) {
    return (
      <AnswerComparisonShell
        ownColumn={
          question.answer === null ? (
            <p className="break-words font-medium [overflow-wrap:anywhere]">
              未作答
            </p>
          ) : (
            <p className="break-words font-medium [overflow-wrap:anywhere]">
              {dispatchBehavior(
                question.answer,
                "display",
                emptyPublicStructure,
              )}
            </p>
          )
        }
        referenceColumn={referenceColumnOf(reference, (ref) => (
          <div className="flex min-w-0 flex-col gap-1">
            <p className="break-words font-medium [overflow-wrap:anywhere]">
              {formatReferenceAnswers(ref)}
            </p>
            <p className="text-xs text-muted-foreground">
              逐项对照将在配对/排序题型上线后提供。
            </p>
          </div>
        ))}
      />
    );
  }
  const model = prepareQuestion(question.snapshot, question.snapshot.id);
  return dispatchComparison(model, question.answer ?? undefined, reference);
}

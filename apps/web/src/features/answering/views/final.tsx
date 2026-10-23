import { dispatchBehavior, emptyPublicStructure } from "@tutor/contract";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { formatReferenceAnswers } from "../../attempt/answer-format";
import { FinalAnswerInput } from "../../attempt/FinalAnswerInput";
import type {
  AnswerKindView,
  PreparedOf,
  ReferenceOfKind,
  StudentAnswerOfKind,
} from "../types";
import { AnswerComparisonShell, referenceColumnOf } from "./comparison";

/**
 * final 呈现（solve/apply/find-error 共用，UA-03 落地）：Input=既有最终答案
 * 输入（FinalAnswerInput，普通输入/数学键盘，mathlive 动态分包不进主包）；
 * 题面（QuestionSurface）的 final 输入区只渲染题干——最终答案输入由纸面
 * 控件区（HandwrittenControls）托管本视图，题面不重复（§10 final 不重复）。
 * 控制器所有权不变：登记表不接管纸面引擎/收笔/落盘（I03，§3 证据层）。
 */

export const finalView: AnswerKindView<
  StudentAnswerOfKind<"final">,
  PreparedOf<"final">,
  ReferenceOfKind<"final">
> = {
  Input: ({ model, answer, update }) => (
    <FinalAnswerInput
      value={answer === undefined ? "" : answer.finalAnswer}
      onChange={(value) => update({ kind: "final", finalAnswer: value }, true)}
      label={model.finalInput.label}
    />
  ),
  ReadOnly: ({ answer }) => (
    <p className="break-words font-medium [overflow-wrap:anywhere]">
      {answer === undefined
        ? "未作答"
        : dispatchBehavior(answer, "display", emptyPublicStructure)}
    </p>
  ),
  Reference: ({ reference }) => (
    <RichMarkdown
      source={formatReferenceAnswers(reference)}
      className="min-w-0 font-medium [&_p]:my-0"
    />
  ),
  Comparison: ({ model, answer, reference }) => (
    <AnswerComparisonShell
      ownColumn={finalView.ReadOnly({ model, answer })}
      referenceColumn={referenceColumnOf(reference, (ref) =>
        finalView.Reference({ model, reference: ref }),
      )}
    />
  ),
  completion: (_model, answer, formalInk) => {
    // I06：有正式笔迹未填最终答案 = partial（本次不改成 filled）
    const filled = answer !== undefined && answer.finalAnswer.trim() !== "";
    if (filled) return { state: "filled", filledSlots: 1, expectedSlots: 1 };
    if (formalInk)
      return { state: "partial", filledSlots: 0, expectedSlots: 1 };
    return { state: "empty", filledSlots: 0, expectedSlots: 1 };
  },
};

/**
 * 最终答案输入的呈现挂点（HandwrittenControls 消费）：按题面标识构造 final
 * 模型并派发 finalView.Input——FinalAnswerInput 的唯一消费出口收归本视图
 * （value/onChange/label 与迁移前逐字一致，defer=true 沿原路径）。锁定由
 * 宿主挂载条件控制（与迁移前一致：已提交只读不挂载手写控件区）。
 */
export function FinalAnswerField({
  questionId,
  stemMd,
  answer,
  onAnswer,
}: {
  questionId: string;
  stemMd: string;
  answer: StudentAnswerOfKind<"final"> | undefined;
  /** 宿主回调（沿用迁移前形态：defer 恒 true 沿原路径透传） */
  onAnswer: (
    answer: { kind: "final"; finalAnswer: string },
    defer: boolean,
  ) => void;
}) {
  const model: PreparedOf<"final"> = {
    kind: "final",
    scopeId: questionId,
    stemMd,
    finalInput: { label: "最终答案" },
  };
  return (
    <>
      {finalView.Input({
        model,
        answer,
        // final 更新沿迁移前路径恒 defer=true（纸面题不即时 flush）
        update: (next, _defer) => onAnswer(next, true),
      })}
    </>
  );
}

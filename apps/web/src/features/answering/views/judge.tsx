import type { AnswerOf } from "@tutor/contract";
import { dispatchBehavior, emptyPublicStructure } from "@tutor/contract";
import { cn } from "cn";
import { Check, X } from "lucide-react";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { formatReferenceAnswers } from "../../attempt/answer-format";
import { judgeDisplayStemOf } from "../prepare-question";
import type {
  AnswerKindView,
  PreparedOf,
  ReferenceOfKind,
  StudentAnswerOfKind,
} from "../types";
import { AnswerComparisonShell, referenceColumnOf } from "./comparison";

/**
 * judge 呈现（UA-03 从 QuestionSurface/ResultAnswerComparison 原代码抽取，
 * DOM/class/文案逐字不变，I11）：Input=题干（尾部空标记替换「（　）」）+
 * 对/错大按钮；ReadOnly/Reference/Comparison=结果视图的两栏文本对照
 * （display 口径经纯行为登记表，I15 单源）。
 */

/** 判断题：对/错两个大按钮（原生 radio 语义，组内互斥；false 是有效输入 I03） */
function JudgeControls({
  model,
  answer,
  update,
  disabled = false,
}: {
  model: PreparedOf<"judge">;
  answer: AnswerOf<"judge"> | undefined;
  update: (answer: AnswerOf<"judge">, defer?: boolean) => void;
  /** 已提交只读（§11-2 原位只读）：隐藏输入同样携带 disabled 语义 */
  disabled?: boolean;
}) {
  const picked =
    answer !== undefined && typeof answer.value === "boolean"
      ? answer.value
      : undefined;
  const groupName = `judge-${model.scopeId}`;
  const labelClass = (selected: boolean) =>
    cn(
      "flex min-h-12 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border-2 text-base font-medium outline-none transition-colors has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
      selected
        ? "border-primary bg-primary/10 text-primary"
        : "border-border bg-card hover:bg-muted/60",
    );
  return (
    <div className="flex gap-3" role="radiogroup" aria-label="判断对错">
      <label className={labelClass(picked === true)}>
        <input
          type="radio"
          name={groupName}
          aria-label="对"
          checked={picked === true}
          disabled={disabled}
          onChange={() => update({ kind: "judge", value: true }, undefined)}
          className="sr-only"
        />
        <span className="flex items-center gap-2">
          <Check
            aria-hidden
            className={`size-5 ${picked === true ? "" : "invisible"}`}
          />
          对
        </span>
      </label>
      <label className={labelClass(picked === false)}>
        <input
          type="radio"
          name={groupName}
          aria-label="错"
          checked={picked === false}
          disabled={disabled}
          onChange={() => update({ kind: "judge", value: false }, undefined)}
          className="sr-only"
        />
        <span className="flex items-center gap-2">
          <X
            aria-hidden
            className={`size-5 ${picked === false ? "" : "invisible"}`}
          />
          错
        </span>
      </label>
    </div>
  );
}

/** judge 的本人答案展示文本（display 口径：布尔→对/错，历史字符串原样，§7.1；
 *  null 仅 teacher-queue 的「未做」口径会产生，display 恒非空——兜底空串） */
function judgeDisplayText(answer: AnswerOf<"judge">): string {
  return dispatchBehavior(answer, "display", emptyPublicStructure) ?? "";
}

export const judgeView: AnswerKindView<
  StudentAnswerOfKind<"judge">,
  PreparedOf<"judge">,
  ReferenceOfKind<"judge">
> = {
  Input: ({ model, answer, update, disabled = false }) => (
    <>
      <RichMarkdown
        source={judgeDisplayStemOf(model.stemMd)}
        className="text-base leading-[1.75]"
        lrNodes
      />
      <JudgeControls
        model={model}
        answer={answer}
        update={update}
        disabled={disabled}
      />
    </>
  ),
  ReadOnly: ({ answer }) => (
    <p className="break-words font-medium [overflow-wrap:anywhere]">
      {answer === undefined ? "未作答" : judgeDisplayText(answer)}
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
      ownColumn={judgeView.ReadOnly({ model, answer })}
      referenceColumn={referenceColumnOf(reference, (ref) =>
        judgeView.Reference({ model, reference: ref }),
      )}
    />
  ),
  completion: (_model, answer) =>
    answer !== undefined
      ? { state: "filled", filledSlots: 1, expectedSlots: 1 }
      : { state: "empty", filledSlots: 0, expectedSlots: 1 },
};

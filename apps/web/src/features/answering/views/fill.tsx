import { dispatchBehavior, emptyPublicStructure } from "@tutor/contract";
import {
  DirectiveSessionProvider,
  type SlotBinding,
  type SlotKind,
} from "@/features/markdown/directives/session-context";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import {
  formatReferenceAnswers,
  mathifyAnswerText,
  withBlankValue,
} from "../../attempt/answer-format";
import { expectedSlotCountOf } from "../prepare-question";
import type {
  AnswerKindView,
  PreparedOf,
  ReferenceOfKind,
  StudentAnswerOfKind,
} from "../types";
import { AnswerComparisonShell, referenceColumnOf } from "./comparison";

/**
 * fill 呈现（UA-03 从 QuestionSurface/ResultAnswerComparison 原代码抽取，
 * DOM/class/文案逐字不变，I11）：输入经槽位命名空间（§8.2，BlankDirective
 * 不变）注入题干原位，defer=true（I05）；对照按空号逐空对齐（行数 =
 * max(预期空位, 本人项数, 参考空数)，额外历史项有独立行，§7.1）；完整度
 * 按有效空位计（额外数组项不能填补空位，I06）。
 */

/** 填空题面：槽位命名空间提供 (scopeId, slotId) 绑定，题干由 RichMarkdown 原位渲染 */
function FillControls({
  model,
  answer,
  update,
  disabled = false,
}: {
  model: PreparedOf<"fill">;
  answer: StudentAnswerOfKind<"fill"> | undefined;
  update: (answer: StudentAnswerOfKind<"fill">, defer?: boolean) => void;
  /** 已提交只读/公开底图：输入禁用（公开底图值恒空 + 更新无副作用，由宿主数据流保证） */
  disabled?: boolean;
}) {
  const values = answer === undefined ? [] : answer.values;
  const get = (slotId: string, slotKind: SlotKind): SlotBinding | null => {
    const slot = model.slots.find(
      (entry) => entry.slotId === slotId && entry.slotKind === slotKind,
    );
    if (slot === undefined) return null;
    return {
      value: values[slot.order] ?? "",
      onChange: (value) =>
        update(
          { kind: "fill", values: withBlankValue(values, slot.order, value) },
          true,
        ),
      disabled,
    };
  };
  return (
    <DirectiveSessionProvider slots={{ scopeId: model.scopeId, disabled, get }}>
      <RichMarkdown
        source={model.stemMd}
        className="text-base leading-[1.75]"
        lrNodes
      />
    </DirectiveSessionProvider>
  );
}

/** 逐空行（第N空 + 值/未填；本人值经 mathify，参考值经 formatReferenceAnswers） */
function slotRows(
  values: string[],
  label: string,
  length: number,
): React.ReactNode {
  return (
    <ol aria-label={label} className="flex flex-col gap-2">
      {Array.from({ length }, (_, index) => index + 1).map((no) => (
        <li
          key={no}
          className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2"
        >
          <span className="text-muted-foreground">第{no}空</span>
          {values[no - 1]?.trim() ? (
            <RichMarkdown
              source={values[no - 1] ?? ""}
              className="min-w-0 font-medium [&_p]:my-0"
            />
          ) : (
            <span className="text-muted-foreground">未填</span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** fill 本人列：给定对齐长度的逐空行；零长度回落 display 文本行（迁移前口径） */
function fillOwnColumn(
  answer: StudentAnswerOfKind<"fill"> | undefined,
  length: number,
): React.ReactNode {
  const values = answer === undefined ? [] : answer.values;
  if (length > 0) {
    return slotRows(values.map(mathifyAnswerText), "你的填空答案", length);
  }
  return (
    <p className="break-words font-medium [overflow-wrap:anywhere]">
      {answer === undefined
        ? "未作答"
        : dispatchBehavior(answer, "display", emptyPublicStructure)}
    </p>
  );
}

/** fill 参考列：逐空经 formatReferenceAnswers（等价答案「或」连接 + mathify） */
function fillReferenceColumn(
  reference: ReferenceOfKind<"fill">,
  length: number,
): React.ReactNode {
  return slotRows(
    reference.blanks.map((blank) =>
      formatReferenceAnswers({ kind: "fill", blanks: [blank] }),
    ),
    "参考填空答案",
    length,
  );
}

export const fillView: AnswerKindView<
  StudentAnswerOfKind<"fill">,
  PreparedOf<"fill">,
  ReferenceOfKind<"fill">
> = {
  Input: ({ model, answer, update, disabled = false }) => (
    <FillControls
      model={model}
      answer={answer}
      update={update}
      disabled={disabled}
    />
  ),
  ReadOnly: ({ model, answer }) => {
    // 未公布/错配参考下的本人列：行数 = max(预期空位, 本人项数)（不读参考，
    // 与迁移前未公布态逐字一致，I09）
    const values = answer === undefined ? [] : answer.values;
    return fillOwnColumn(
      answer,
      Math.max(expectedSlotCountOf(model.slots), values.length),
    );
  },
  Reference: ({ reference }) =>
    // 独立参考入口（无对照上下文时按参考自身空数成行；结果视图右列的
    // 对齐长度由 Comparison 统一计算后传入 fillReferenceColumn）
    fillReferenceColumn(reference, reference.blanks.length),
  Comparison: ({ model, answer, reference }) => {
    // 行数 = max(预期空位, 本人项数, 参考空数)——两列共用同一长度才能逐空
    // 对齐（参考空数在本人列产生「未填」行，额外历史项在参考列同理）；参考
    // 仅在 available 时计入（ReferenceMaterial 由宿主按授权组装，错配参考
    // 经调度边界归一），未公布/无参考时长度不含参考（I09 不读参考空数）
    const own = answer === undefined ? [] : answer.values;
    const referenceLength =
      reference.status === "available" ? reference.reference.blanks.length : 0;
    const length = Math.max(
      expectedSlotCountOf(model.slots),
      own.length,
      referenceLength,
    );
    return (
      <AnswerComparisonShell
        ownColumn={fillOwnColumn(answer, length)}
        referenceColumn={referenceColumnOf(reference, (ref) =>
          fillReferenceColumn(ref, length),
        )}
      />
    );
  },
  completion: (model, answer) => {
    const values = answer === undefined ? [] : answer.values;
    const expectedSlots = expectedSlotCountOf(model.slots);
    let filledSlots = 0;
    for (let index = 0; index < expectedSlots; index++) {
      if ((values[index] ?? "").trim() !== "") filledSlots++;
    }
    return {
      state:
        filledSlots === 0
          ? "empty"
          : filledSlots === expectedSlots
            ? "filled"
            : "partial",
      filledSlots,
      expectedSlots,
    };
  },
};

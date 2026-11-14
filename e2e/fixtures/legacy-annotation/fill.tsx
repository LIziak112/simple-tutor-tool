/** 锁定 b50531b3:apps/web/src/features/answering/views/fill.tsx；仅调整测试夹具的 import，禁止生产代码引用。 */

import {
  formatReferenceAnswers,
  mathifyAnswerText,
  withBlankValue,
} from "@/features/answering/answer-format";
import { expectedSlotCountOf } from "@/features/answering/prepare-question";
import type {
  AnswerKindView,
  PreparedOf,
  ReferenceOfKind,
  StudentAnswerOfKind,
} from "@/features/answering/types";
import {
  AnswerComparisonShell,
  referenceColumnOf,
} from "@/features/answering/views/comparison";
import { BlankDirective } from "@/features/markdown/directives/Inline";
import {
  DirectiveSessionProvider,
  type SlotBinding,
  type SlotKind,
} from "@/features/markdown/directives/session-context";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import {
  type AnnotationFrozenControl,
  dispatchBehavior,
  emptyPublicStructure,
} from "../../../packages/contract/src/index";

/**
 * fill 呈现（UA-03 从 QuestionSurface/ResultAnswerComparison 原代码抽取，
 * DOM/class/文案逐字不变，I11）：输入经槽位命名空间（§8.2，BlankDirective
 * 不变）注入题干原位，defer=true（I05）；对照按空号逐空对齐（行数 =
 * max(预期空位, 本人项数, 参考空数)，额外历史项有独立行，§7.1）；完整度
 * 按有效空位计（额外数组项不能填补空位，I06）。
 */

/** 填空题面：槽位命名空间提供 (scopeId, slotId) 绑定，题干由 RichMarkdown 原位渲染 */
type FillInputProps = {
  model: PreparedOf<"fill">;
  answer: StudentAnswerOfKind<"fill"> | undefined;
  update: (answer: StudentAnswerOfKind<"fill">, defer?: boolean) => void;
  /** 已提交只读/公开底图：输入禁用（公开底图值恒空 + 更新无副作用，由宿主数据流保证） */
  disabled?: boolean;
};

function fillSlotBindings({
  model,
  answer,
  update,
  disabled = false,
}: FillInputProps) {
  const values = answer === undefined ? [] : answer.values;
  const get = (slotId: string, slotKind: SlotKind): SlotBinding | null => {
    const slot = model.slots.find(
      (entry) => entry.slotId === slotId && entry.slotKind === slotKind,
    );
    if (slot === undefined) return null;
    return {
      value: values[slot.order] ?? "",
      onChange: (value) => {
        if (disabled) return;
        update(
          { kind: "fill", values: withBlankValue(values, slot.order, value) },
          true,
        );
      },
      disabled,
    };
  };
  return { scopeId: model.scopeId, disabled, get };
}

function FillControls(props: FillInputProps) {
  return (
    <DirectiveSessionProvider slots={fillSlotBindings(props)}>
      <RichMarkdown
        source={props.model.stemMd}
        className="text-base leading-[1.75]"
        lrNodes
      />
    </DirectiveSessionProvider>
  );
}

/** 冻结原稿仅替换输入节点，值和更新仍用填空原有槽位绑定。 */
export function FrozenFillControls({
  controls,
  ...props
}: FillInputProps & {
  controls: readonly AnnotationFrozenControl[];
}) {
  return (
    <DirectiveSessionProvider slots={fillSlotBindings(props)}>
      {controls.map((control) => {
        const slot = props.model.slots.find(
          (entry) => entry.slotId === control.slotId,
        );
        if (!slot) return null;
        return (
          <div
            key={control.slotId}
            data-slot="frozen-control"
            data-control-id={control.slotId}
            className="absolute z-[1] [&_input]:m-0 [&_input]:h-full [&_input]:w-full [&_input]:max-w-none [&_input]:translate-y-0"
            style={{
              left: control.x,
              top: control.y,
              width: control.width,
              height: control.height,
            }}
          >
            <BlankDirective
              name="blank"
              index={slot.order + 1}
              docIndex={slot.order + 1}
            />
          </div>
        );
      })}
    </DirectiveSessionProvider>
  );
}

/** 与 FrozenFillControls 共用同一 Prepared fill 槽位清单，从公开导出副本取框。 */
export function captureFrozenFillControls(
  model: PreparedOf<"fill">,
  exported: HTMLElement,
): AnnotationFrozenControl[] {
  if (
    model.slots.length === 0 ||
    new Set(model.slots.map((slot) => slot.slotId)).size !== model.slots.length
  )
    throw new Error("公开题面填空槽位身份缺失或重复");
  const root = exported.getBoundingClientRect();
  const rounded = (value: number) => Math.round(value * 64) / 64;
  return model.slots.map((slot) => {
    const matches = [
      ...exported.querySelectorAll<HTMLInputElement>(
        "input[data-answer-slot-id]",
      ),
    ].filter((input) => input.dataset.answerSlotId === slot.slotId);
    if (matches.length !== 1)
      throw new Error("导出题面填空槽位缺失或重复，不能保存错位原稿");
    const rect = matches[0]?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0)
      throw new Error("导出题面填空槽位尚未就绪，不能保存错位原稿");
    return {
      slotId: slot.slotId,
      kind: "text" as const,
      x: rounded(rect.left - root.left),
      y: rounded(rect.top - root.top),
      width: rounded(rect.width),
      height: rounded(rect.height),
    };
  });
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

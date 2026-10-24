import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import type {
  AnswerKindView,
  PreparedOf,
  ReferenceOfKind,
  StudentAnswerOfKind,
} from "../types";
import { AnswerComparisonShell, referenceColumnOf } from "./comparison";

/**
 * matching 配对呈现（QM-13 细项 2/5）：
 * - Input：每个声明槽位一行（第 N 空 + 原生 select 选项池）。原生 select 自带
 *   键盘（Tab/方向键/选择）与移动触摸语义，零自定义下拉依赖；allowRepeat=false
 *   时被其他槽位占用的选项在该槽的下拉中禁用（客户端约束与服务端保存校验
 *   同口径，§6.1 调整 6）；干扰项在池内可选（选错是答案错误而非形状错误，
 *   不加标记不拦截）。部分配对=合法草稿（isAnswered 走契约纯行为）；
 * - 结构不可用（选项池或槽位集合缺失——服务端投影的防御形态）显式报错，
 *   不静默降级（§7.1）；
 * - ReadOnly/Reference/Comparison：按槽位序逐行「第 N 空：选项正文」，
 *   对照两栏共用 AnswerComparisonShell；呈现层只显示不计算判定。
 */

/** 槽位显示序号：slotIds 下标 + 1（服务端按材料阅读序展开） */
function slotLabelOf(index: number): string {
  return `第 ${index + 1} 空`;
}

/** 槽位行文本（选项池缺该 id 回落裸 id——与契约 formatStudent 同口径） */
function slotRowTextOf(
  model: PreparedOf<"matching">,
  optionId: string | undefined,
): string {
  if (optionId === undefined) return "未选择";
  const text = model.options.find((option) => option.key === optionId)?.text;
  return text ?? optionId;
}

/** 参考映射行（未知槽位键防御性保留，排到末尾按 id 稳定序） */
function referenceRowsOf(
  model: PreparedOf<"matching">,
  pairs: Readonly<Record<string, string>>,
): Array<{ slot: string; text: string }> {
  const known = model.slotIds
    .filter((slot) => pairs[slot] !== undefined)
    .map((slot, index) => ({
      slot: slotLabelOf(index),
      text: slotRowTextOf(model, pairs[slot]),
    }));
  const unknown = Object.keys(pairs)
    .filter((slot) => !model.slotIds.includes(slot))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((slot) => ({ slot, text: slotRowTextOf(model, pairs[slot]) }));
  return [...known, ...unknown];
}

export const matchingView: AnswerKindView<
  StudentAnswerOfKind<"matching">,
  PreparedOf<"matching">,
  ReferenceOfKind<"matching">
> = {
  Input: ({ model, answer, update, disabled = false }) => {
    const pairs = answer?.pairs ?? {};
    // 结构不可用防御态：显式报错不静默降级（§7.1）
    if (model.slotIds.length === 0 || model.options.length === 0) {
      return (
        <div className="flex min-w-0 flex-col gap-3">
          <RichMarkdown
            source={model.stemMd}
            className="text-base leading-[1.75]"
          />
          <p role="alert" className="text-sm text-destructive">
            这道配对题的选项池或槽位信息不完整，请联系老师重新检查题目。
          </p>
        </div>
      );
    }
    /** 该选项是否已被其他槽位占用（不可重复约束的客户端面） */
    const usedElsewhere = (optionKey: string, slot: string): boolean =>
      !model.allowRepeat &&
      Object.entries(pairs).some(
        ([otherSlot, otherOption]) =>
          otherSlot !== slot && otherOption === optionKey,
      );
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <RichMarkdown
          source={model.stemMd}
          className="text-base leading-[1.75]"
        />
        <div className="flex min-w-0 flex-col gap-2">
          {model.slotIds.map((slot, index) => {
            const selectId = `matching-${model.scopeId}-${slot}`;
            return (
              <div
                key={slot}
                className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3"
              >
                <label
                  htmlFor={selectId}
                  className="shrink-0 text-sm font-medium sm:w-16"
                >
                  {slotLabelOf(index)}
                </label>
                <select
                  id={selectId}
                  aria-label={`${slotLabelOf(index)}的选项`}
                  value={pairs[slot] ?? ""}
                  disabled={disabled}
                  onChange={(event) => {
                    const next = { ...pairs };
                    if (event.target.value === "") delete next[slot];
                    else next[slot] = event.target.value;
                    update({ kind: "matching", pairs: next }, undefined);
                  }}
                  className="min-h-11 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">未选择</option>
                  {model.options.map((option) => (
                    <option
                      key={option.key}
                      value={option.key}
                      disabled={usedElsewhere(option.key, slot)}
                    >
                      {option.text}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
        {!model.allowRepeat && model.slotIds.length > 1 && (
          <p className="text-sm text-muted-foreground">
            每个选项只能用于一个空位。
          </p>
        )}
      </div>
    );
  },
  ReadOnly: ({ model, answer }) => {
    if (answer === undefined || Object.keys(answer.pairs).length === 0) {
      return (
        <p className="break-words font-medium [overflow-wrap:anywhere]">
          未作答
        </p>
      );
    }
    return (
      <ul className="m-0 flex min-w-0 list-none flex-col gap-1 p-0">
        {model.slotIds.map((slot, index) => (
          <li key={slot} className="min-w-0">
            <span className="text-muted-foreground">
              {slotLabelOf(index)}：
            </span>
            <span className="font-medium">
              {slotRowTextOf(model, answer.pairs[slot])}
            </span>
          </li>
        ))}
      </ul>
    );
  },
  Reference: ({ model, reference }) => (
    <ul className="m-0 flex min-w-0 list-none flex-col gap-1 p-0">
      {referenceRowsOf(model, reference.pairs).map((row) => (
        <li key={row.slot} className="min-w-0">
          <span className="text-muted-foreground">{row.slot}：</span>
          <span className="font-medium">{row.text}</span>
        </li>
      ))}
    </ul>
  ),
  Comparison: ({ model, answer, reference }) => (
    <AnswerComparisonShell
      ownColumn={matchingView.ReadOnly({ model, answer })}
      referenceColumn={referenceColumnOf(reference, (ref) =>
        matchingView.Reference({ model, reference: ref }),
      )}
    />
  ),
  completion: (model, answer) => {
    // 分项未填=合法草稿：完成度按已配对槽数/声明槽数计，不判对错
    const filled = answer ? Object.keys(answer.pairs).length : 0;
    const expected = model.slotIds.length;
    return {
      state:
        filled === 0 || expected === 0
          ? "empty"
          : filled >= expected
            ? "filled"
            : "partial",
      filledSlots: filled,
      expectedSlots: expected,
    };
  },
};

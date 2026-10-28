import type { ReactNode } from "react";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import type {
  AnswerKindView,
  PreparedOf,
  ReferenceOfKind,
  StudentAnswerOfKind,
} from "../types";
import { AnswerComparisonShell, referenceColumnOf } from "./comparison";

/**
 * ordering 排序呈现（QM-13 细项 3/5）。板模型口径（与契约 inspectShape 逐字
 * 对齐，§6.1 调整 3/6）：
 * - 板 = 非干扰项行序列（行数 = sortableCount + 固定项数——2026-10-25 审查
 *   P1 收紧：学生面剥离逐项 distractor 标记，行数与完成度改由 sortableCount
 *   计数派生；固定项恒非干扰，fixedPosition 声明自参考序列）；固定项从开答
 *   即预置在声明位、锁定不可移动/移除（「已固定」徽标，fixedPosition 属公开
 *   结构）；
 * - 待排序项池「加入排序」放入首个空行；已放可动项支持 上移/下移（跳过固定
 *   行：目标空则移入、被占则交换）与「移除」回池——按钮原生键盘可达、触控
 *   ≥44px；干扰项在池内不加标记（学生从保存拒绝信息得知，§6.1 调整 6——
 *   UI 不预拦，学生面也无从标记）；
 * - 保存序列派生：按行序收集已放项；**固定项仅当其上方全部行已满（锚定）时
 *   进入序列**——保证任意合法板态派生的序列过服务端结构校验（固定项若出现
 *   必在其声明位）。恢复：固定项回其声明行，序列中的可动项按序填入剩余空行
 *   （部分草稿保序不保距——完整作答无差异）；
 * - 分项未放=合法草稿；完成度按已放应放项计（期望数 = sortableCount）。
 */

/** 排序板：行 → 项 key（null = 空行） */
type Board = ReadonlyArray<string | null>;

/** 项 key → 项（防御：未知 key 不在板/池呈现） */
function itemOf(
  model: PreparedOf<"ordering">,
  key: string,
): PreparedOf<"ordering">["items"][number] | undefined {
  return model.items.find((item) => item.key === key);
}

/**
 * 板行数 = sortableCount + 固定项数（学生面无逐项干扰标记，从计数派生；
 * 固定项恒非干扰——fixedPosition 声明自参考序列，不会与干扰项重叠）
 */
function boardRowCountOf(model: PreparedOf<"ordering">): number {
  return (
    model.sortableCount +
    model.items.filter((item) => item.fixedPosition !== null).length
  );
}

/** 固定行下标集合（fixedPosition 预置行，永不可移入/移出） */
function fixedRowIndexesOf(model: PreparedOf<"ordering">): ReadonlySet<number> {
  const total = boardRowCountOf(model);
  const indexes = new Set<number>();
  for (const item of model.items) {
    if (item.fixedPosition !== null && item.fixedPosition <= total) {
      indexes.add(item.fixedPosition - 1);
    }
  }
  return indexes;
}

/** 答案 → 板（恢复：固定项回声明行，可动项按序填剩余空行——保序不保距） */
function boardOf(
  model: PreparedOf<"ordering">,
  answer: StudentAnswerOfKind<"ordering"> | undefined,
): (string | null)[] {
  const rows: Array<string | null> = Array.from(
    { length: boardRowCountOf(model) },
    () => null,
  );
  for (const index of fixedRowIndexesOf(model)) {
    const fixed = model.items.find((item) => item.fixedPosition === index + 1);
    if (fixed !== undefined) rows[index] = fixed.key;
  }
  const placedKeys = new Set(rows.filter((key): key is string => key !== null));
  let cursor = 0;
  for (const key of answer?.sequence ?? []) {
    // 固定项已在板上（锚定入序的行在恢复时原位保留）；未知 key 防御跳过
    if (placedKeys.has(key)) continue;
    const item = itemOf(model, key);
    if (item === undefined) continue;
    while (cursor < rows.length && rows[cursor] !== null) cursor += 1;
    if (cursor >= rows.length) break;
    rows[cursor] = key;
    placedKeys.add(key);
  }
  return rows;
}

/** 板 → 保存序列（固定项仅锚定入序；任意合法板态派生的序列过结构校验） */
function sequenceOfBoard(model: PreparedOf<"ordering">, rows: Board): string[] {
  const sequence: string[] = [];
  let anchored = true; // 上方行是否全满（固定项锚定条件）
  rows.forEach((key) => {
    if (key === null) {
      anchored = false;
      return;
    }
    const item = itemOf(model, key);
    if (item !== undefined && item.fixedPosition !== null && !anchored) {
      return; // 未锚定固定项不入序（其上方存在空行）
    }
    sequence.push(key);
  });
  return sequence;
}

/** 上/下移的目标行（跳过固定行的最近可动行）；无可移目标返回 -1 */
function moveTargetOf(
  rows: ReadonlyArray<string | null>,
  from: number,
  direction: -1 | 1,
  fixedRows: ReadonlySet<number>,
): number {
  for (let i = from + direction; i >= 0 && i < rows.length; i += direction) {
    if (!fixedRows.has(i)) return i;
  }
  return -1;
}

/** 可动项上/下移：目标空则移入、被占则交换；无可移目标原样返回 */
function moveItem(
  rows: ReadonlyArray<string | null>,
  from: number,
  direction: -1 | 1,
  fixedRows: ReadonlySet<number>,
): Array<string | null> {
  const target = moveTargetOf(rows, from, direction, fixedRows);
  if (target < 0) return [...rows];
  const next = [...rows];
  const moving = next[from] ?? null;
  next[from] = next[target] ?? null;
  next[target] = moving;
  return next;
}

/** 已放项的操作按钮组（原生按钮键盘可达、触控 ≥44px） */
function OrderRowActions({
  onUp,
  onDown,
  onRemove,
  upDisabled,
  downDisabled,
  label,
}: {
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
  upDisabled: boolean;
  downDisabled: boolean;
  label: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <ButtonishAction
        onClick={onUp}
        disabled={upDisabled}
        label={`${label}上移`}
      >
        ↑
      </ButtonishAction>
      <ButtonishAction
        onClick={onDown}
        disabled={downDisabled}
        label={`${label}下移`}
      >
        ↓
      </ButtonishAction>
      <ButtonishAction
        onClick={onRemove}
        disabled={false}
        label={`${label}移除`}
      >
        移除
      </ButtonishAction>
    </div>
  );
}

/** 操作按钮外壳（保持与主按钮形态一致的轻量原生按钮） */
function ButtonishAction({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-11 min-w-11 items-center justify-center rounded-md border border-input bg-card px-2 text-sm font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export const orderingView: AnswerKindView<
  StudentAnswerOfKind<"ordering">,
  PreparedOf<"ordering">,
  ReferenceOfKind<"ordering">
> = {
  Input: ({ model, answer, update, disabled = false }) => {
    // 结构不可用防御态：显式报错不静默降级（§7.1）
    if (model.items.length === 0) {
      return (
        <div className="flex min-w-0 flex-col gap-3">
          <RichMarkdown
            source={model.stemMd}
            className="text-base leading-[1.75]"
            lrNodes
          />
          <p role="alert" className="text-sm text-destructive">
            这道排序题的排序项信息不完整，请联系老师重新检查题目。
          </p>
        </div>
      );
    }
    const fixedRows = fixedRowIndexesOf(model);
    const rows = boardOf(model, answer);
    const firstEmptyRow = rows.indexOf(null);
    const placedKeys = new Set(
      rows.filter((key): key is string => key !== null),
    );
    const applyBoard = (next: ReadonlyArray<string | null>) => {
      update(
        { kind: "ordering", sequence: sequenceOfBoard(model, next) },
        undefined,
      );
    };
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <RichMarkdown
          source={model.stemMd}
          className="text-base leading-[1.75]"
          lrNodes
        />
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm font-semibold text-muted-foreground">
            排序区（按正确顺序放置）
          </p>
          <ol className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
            {rows.map((key, index) => {
              const item = key === null ? undefined : itemOf(model, key);
              const fixed = fixedRows.has(index);
              const movableHere = item !== undefined && !fixed;
              return (
                <li
                  key={fixed ? `fixed-${index}` : (key ?? `empty-${index}`)}
                  className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-start"
                >
                  <div className="flex min-w-0 flex-1 items-start gap-2">
                    <span className="mt-1 shrink-0 text-sm font-semibold text-muted-foreground">
                      {`第 ${index + 1} 位`}
                    </span>
                    <div className="min-w-0 flex-1">
                      {item === undefined ? (
                        <p className="text-muted-foreground">待放置</p>
                      ) : (
                        <>
                          <RichMarkdown
                            source={item.text}
                            className="min-w-0 text-base leading-[1.75]"
                          />
                          {fixed && (
                            <span className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                              已固定，不可移动
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  {movableHere && key !== null && !disabled && (
                    <OrderRowActions
                      label={`第 ${index + 1} 位`}
                      onUp={() =>
                        applyBoard(moveItem(rows, index, -1, fixedRows))
                      }
                      onDown={() =>
                        applyBoard(moveItem(rows, index, 1, fixedRows))
                      }
                      onRemove={() => {
                        const next = [...rows];
                        next[index] = null;
                        applyBoard(next);
                      }}
                      upDisabled={moveTargetOf(rows, index, -1, fixedRows) < 0}
                      downDisabled={moveTargetOf(rows, index, 1, fixedRows) < 0}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm font-semibold text-muted-foreground">
            待排序项
          </p>
          <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
            {model.items
              .filter((item) => !placedKeys.has(item.key))
              .map((item) => (
                <li
                  key={item.key}
                  className="flex min-w-0 flex-col gap-2 rounded-lg border border-dashed border-border bg-card/50 p-3 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <RichMarkdown
                      source={item.text}
                      className="min-w-0 text-base leading-[1.75]"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={disabled || firstEmptyRow < 0}
                    onClick={() => {
                      if (firstEmptyRow < 0) return;
                      const next = [...rows];
                      next[firstEmptyRow] = item.key;
                      applyBoard(next);
                    }}
                    className="inline-flex h-11 shrink-0 items-center justify-center rounded-md border border-input bg-card px-3 text-sm font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    加入排序
                  </button>
                </li>
              ))}
          </ul>
        </div>
      </div>
    );
  },
  ReadOnly: ({ model, answer }) => {
    if (answer === undefined || answer.sequence.length === 0) {
      return (
        <p className="break-words font-medium [overflow-wrap:anywhere]">
          未作答
        </p>
      );
    }
    return (
      <ol className="m-0 flex min-w-0 list-none flex-col gap-1 p-0">
        {answer.sequence.map((key, index) => {
          const item = itemOf(model, key);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 只读回看的静态序列渲染，防御性数据可能重复 id，序号即位次语义的一部分，渲染期无重排
            <li key={`${key}-${index}`} className="min-w-0">
              <span className="text-muted-foreground">{`第 ${index + 1} 位：`}</span>
              <span className="font-medium">{item?.text ?? key}</span>
            </li>
          );
        })}
      </ol>
    );
  },
  Reference: ({ model, reference }) => (
    <ol className="m-0 flex min-w-0 list-none flex-col gap-1 p-0">
      {reference.sequence.map((key, index) => {
        const item = itemOf(model, key);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 冻结参考序列的静态只读渲染（序号即位次语义），渲染期无重排
          <li key={`${key}-${index}`} className="min-w-0">
            <span className="text-muted-foreground">{`第 ${index + 1} 位：`}</span>
            <span className="font-medium">{item?.text ?? key}</span>
            {item !== undefined && item.fixedPosition !== null && (
              <span className="ml-1 text-xs text-muted-foreground">
                （已固定）
              </span>
            )}
          </li>
        );
      })}
    </ol>
  ),
  Comparison: ({ model, answer, reference }) => (
    <AnswerComparisonShell
      ownColumn={orderingView.ReadOnly({ model, answer })}
      referenceColumn={referenceColumnOf(reference, (ref) =>
        orderingView.Reference({ model, reference: ref }),
      )}
    />
  ),
  completion: (model, answer) => {
    // 分项未放=合法草稿：完成度期望 = sortableCount（应放项数：非干扰且非
    // 固定——固定项开答即预置、不算学生工作）；已放按序列命中计。学生序列
    // 经服务端结构校验不含干扰项（干扰入序 400），本地未保存态短暂多计不
    // 影响保存结果（2026-10-25 审查 P1 后学生面无逐项标记，无从预拦）
    const expected = model.sortableCount;
    const placedKeys = new Set(answer?.sequence ?? []);
    const filled = model.items.filter(
      (item) => item.fixedPosition === null && placedKeys.has(item.key),
    ).length;
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

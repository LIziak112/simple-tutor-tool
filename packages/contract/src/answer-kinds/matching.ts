import type {
  AnswerKindBehavior,
  MatchingPublicStructure,
  ShapeIssue,
} from "./types.ts";

/**
 * matching 纯行为（TT-05a 域②，§5.3.1/§6.1 调整 6）：
 * - isAnswered = pairs 非空对象（部分配对=草稿合法，保存只校验结构/范围、
 *   永不比对参考答案）；
 * - 三口径文本化一致：按槽位键稳定排序，`slot = 选项正文`（选项池缺失该 id
 *   时回落裸 id——三代理 emptyPublicStructure 路径）「；」连接；
 * - inspectShape 只报告不拦截：未知槽位/未知选项/重复占用（allowRepeat=false）。
 *   干扰选项在池内、学生可选——选错是答案错误而非形状错误，不报。
 *   空结构（选项池与槽位集合都为空）= 结构不可用，无从校验（返回空）。
 */
export const matchingBehavior: AnswerKindBehavior<
  { kind: "matching"; pairs: Record<string, string> },
  MatchingPublicStructure
> = {
  isAnswered: (answer) => Object.keys(answer.pairs).length > 0,
  formatStudent: (answer, _profile, structure) => {
    const textOf = new Map(
      structure.options.map((option) => [option.key, option.text]),
    );
    // QM-16：材料槽位序 ordinal 在场 → 槽位标签「第 N 空」（与材料面板（N）
    // 编号同口径）；ordinal 表缺该槽位回落裸 id（不猜位置）
    const labelOf = (slot: string): string => {
      const ordinal = structure.slotOrdinals?.[slot];
      return ordinal === undefined ? slot : `第 ${ordinal} 空`;
    };
    return Object.entries(answer.pairs)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([slot, option]) => `${labelOf(slot)} = ${textOf.get(option) ?? option}`)
      .join("；");
  },
  inspectShape: (answer, structure): readonly ShapeIssue[] => {
    if (structure.options.length === 0 && structure.slotIds.length === 0) {
      return []; // 结构不可用（文本化代理路径），无从校验
    }
    const issues: ShapeIssue[] = [];
    const optionIds = new Set(structure.options.map((option) => option.key));
    const declaredSlots = new Set(structure.slotIds);
    const optionUseCount = new Map<string, number>();
    for (const [slot, option] of Object.entries(answer.pairs)) {
      if (declaredSlots.size > 0 && !declaredSlots.has(slot)) {
        issues.push({
          code: "MATCHING_UNKNOWN_SLOT",
          message: `配对答案引用了未声明的槽位 ${slot}`,
        });
      }
      if (!optionIds.has(option)) {
        issues.push({
          code: "MATCHING_UNKNOWN_OPTION",
          message: `配对答案引用了选项池外的选项 ${option}（槽位 ${slot}）`,
        });
        continue;
      }
      optionUseCount.set(option, (optionUseCount.get(option) ?? 0) + 1);
    }
    if (!structure.allowRepeat) {
      for (const [option, count] of optionUseCount) {
        if (count > 1) {
          issues.push({
            code: "MATCHING_OPTION_REUSED",
            message: `选项 ${option} 被多个槽位重复占用（题目未允许重复）`,
          });
        }
      }
    }
    return issues;
  },
};

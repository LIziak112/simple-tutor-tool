import type {
  AnswerKindBehavior,
  OrderingPublicStructure,
  ShapeIssue,
} from "./types.ts";

/**
 * ordering 纯行为（TT-05a 域②，§5.3.1/§6.1 调整 6）：
 * - isAnswered = sequence 非空数组（部分序列=草稿合法）；
 * - 三口径文本化一致：项正文依序「 → 」连接（结构缺该 id 回落裸 id）；
 * - inspectShape 只报告不拦截：干扰项入序（DISTRACTOR_IN_SEQUENCE——与
 *   matching 的不对称口径）、未知项、重复项、固定项错位（固定项**若出现**
 *   必须在其声明位置；部分草稿中未出现的固定项不报）。空结构=结构不可用。
 */
export const orderingBehavior: AnswerKindBehavior<
  { kind: "ordering"; sequence: string[] },
  OrderingPublicStructure
> = {
  isAnswered: (answer) => answer.sequence.length > 0,
  formatStudent: (answer, _profile, structure) => {
    const textOf = new Map(
      structure.items.map((item) => [item.key, item.text]),
    );
    return answer.sequence.map((item) => textOf.get(item) ?? item).join(" → ");
  },
  inspectShape: (answer, structure): readonly ShapeIssue[] => {
    if (structure.items.length === 0) return []; // 结构不可用，无从校验
    const issues: ShapeIssue[] = [];
    const itemOf = new Map(structure.items.map((item) => [item.key, item]));
    const seen = new Set<string>();
    answer.sequence.forEach((itemId, index) => {
      const item = itemOf.get(itemId);
      if (item === undefined) {
        issues.push({
          code: "ORDERING_UNKNOWN_ITEM",
          message: `排序答案引用了未声明的项 ${itemId}`,
        });
        return;
      }
      if (item.distractor) {
        issues.push({
          code: "DISTRACTOR_IN_SEQUENCE",
          message: `干扰项 ${itemId} 不得进入排序序列`,
        });
      }
      if (seen.has(itemId)) {
        issues.push({
          code: "ORDERING_DUPLICATE_ITEM",
          message: `项 ${itemId} 在序列中重复出现`,
        });
      } else {
        seen.add(itemId);
      }
      if (item.fixedPosition !== null && item.fixedPosition !== index + 1) {
        issues.push({
          code: "FIXED_ITEM_OUT_OF_POSITION",
          message: `固定项 ${itemId} 应在第 ${item.fixedPosition} 位，当前在第 ${index + 1} 位`,
        });
      }
    });
    return issues;
  },
};

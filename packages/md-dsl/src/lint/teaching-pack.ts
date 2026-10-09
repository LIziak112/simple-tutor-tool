import {
  getDirective,
  type LintIssue,
  type ParsedDocument,
  questionCapabilityBindings,
} from "@tutor/contract";
import type { Root } from "mdast";
import { makeIssue } from "../v2/shared.ts";

/**
 * 教学包声明显式引用校验（T7.8 / 方案 §4.6）：
 * frontmatter.teachingPack 存在时，对 directives / validators 两个引用数组逐一
 * 核对存在性——缺失是 error（导入阻断），与普通正文未知指令的 warning + 降级
 * 口径刻意不同：声明是「依赖承诺」，承诺不存在的东西就是缺陷。
 *
 * 边界（方案 §4.6）：只检查显式引用存在，不要求列齐正文实际使用的全部指令，
 * 不做版本范围、依赖图或能力定义复制；能力面从当前系统清单解析。校验只用
 * 契约元数据（注册表 + 题型能力表），不引入 grading 函数。无声明零 issue，
 * 普通 MD 行为与现状完全一致。
 */

/**
 * 内置校验器 id 集合：从题型能力表派生（单一事实来源——桥接表扩项自动纳入）。
 * 当前七种题型的 validatorId 与题型名一致，但本规则不假设这一巧合。
 */
const VALIDATOR_IDS = new Set(
  Object.values(questionCapabilityBindings).map(
    (binding) => binding.validatorId,
  ),
);

export function lintTeachingPack(
  tree: Root,
  parsed: ParsedDocument,
): LintIssue[] {
  const pack = parsed.frontmatter?.teachingPack;
  if (pack === undefined) return [];

  // 行锚：frontmatter 映射首行（围栏行的下一行）；无位置信息时兜底第 1 行
  const yamlNode = tree.children.find((node) => node.type === "yaml");
  const line = (yamlNode?.position?.start.line ?? 0) + 1;

  const issues: LintIssue[] = [];
  for (const ref of pack.directives) {
    // 别名经注册表归一命中主名（getDirective 按主名与别名都可查）
    if (getDirective(ref) === undefined) {
      issues.push(
        makeIssue(
          "error",
          line,
          1,
          "DIRECTIVE_REF_NOT_FOUND",
          `teachingPack.directives 引用了未注册的指令「${ref}」：请改用指令清单内的名称（见规范.md 指令速查表；声明只列依赖，不要求列齐正文使用的全部指令）`,
        ),
      );
    }
  }
  for (const ref of pack.validators) {
    if (!VALIDATOR_IDS.has(ref)) {
      issues.push(
        makeIssue(
          "error",
          line,
          1,
          "VALIDATOR_REF_NOT_FOUND",
          `teachingPack.validators 引用了不存在的校验器「${ref}」：请改用题型能力表的内置 validatorId（${[
            ...VALIDATOR_IDS,
          ].join(" / ")}）`,
        ),
      );
    }
  }
  return issues;
}

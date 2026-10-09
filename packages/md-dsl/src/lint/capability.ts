import {
  type EnabledCapabilityFlags,
  type LintIssue,
  questionCapabilityBindings,
} from "@tutor/contract";
import type { Root } from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
import { visit } from "unist-util-visit";
import { isQuestionContainer } from "../v2/question.ts";
import { canonicalName, lineRange, makeIssue } from "../v2/shared.ts";

/**
 * 能力启用集回退提示（T7.7 / 方案 §4.5）：lint 携带教师启用集上下文时，
 * 对「使用了 steps 逐步揭晓或手写题型，但对应辅助开关已关闭」的位置给
 * warning，说明学生端的实际回退——steps 完整展开、手写入口隐藏（最终答案
 * 仍可提交）。无上下文（CLI、缺省导入预览）经 toEnabledCapabilities 归一为
 * 全启用，自然零 issue；正文仍可正常教学导入，warning 不阻断。
 *
 * 语义边界：启用集不是安全边界（泄露守卫独立保证），本规则只提示渲染回退，
 * 不改变解析产出——题目照常入库，开关读时生效。
 */

/**
 * 手写题型集合：从契约题型能力表按 inputType=ink 派生（单一事实来源——
 * 未来新增 ink 题型自动纳入；choice/fill 是正式作答不触发）。
 */
const HANDWRITTEN_TYPES = new Set<string>(
  Object.entries(questionCapabilityBindings)
    .filter(([, binding]) => binding.inputType === "ink")
    .map(([type]) => type),
);

function report(line: number, message: string): LintIssue {
  return makeIssue("warning", line, 1, "CAPABILITY_DISABLED", message);
}

/** 递归遍历取全部指令节点（steps 可在讲义顶层、题目内、steps 内嵌套出现） */
function directiveNodes(tree: Root): readonly ContainerDirective[] {
  const found: ContainerDirective[] = [];
  visit(tree, (node) => {
    if (node.type === "containerDirective") found.push(node);
  });
  return found;
}

/**
 * 规则入口：steps 关闭 → 每个 steps 容器一条；ink 关闭 → 每道手写题型题一条
 * （题号与 lintQuestions 同口径：被丢弃的题也占序号）。
 */
export function lintCapabilityProfile(
  tree: Root,
  flags: EnabledCapabilityFlags,
): LintIssue[] {
  const issues: LintIssue[] = [];

  if (!flags.steps) {
    for (const node of directiveNodes(tree)) {
      if (canonicalName(node) !== "steps") continue;
      issues.push(
        report(
          lineRange(node)[0],
          "教师已关闭「逐步揭晓」辅助能力：此处 :::steps 在学生端将完整展开全部步骤、不显示「显示下一步」按钮（内容不变，仅回退提示）",
        ),
      );
    }
  }

  if (!flags.ink) {
    let ordinal = 1;
    for (const child of tree.children) {
      if (!isQuestionContainer(child)) continue;
      const rawType = child.attributes?.type;
      if (typeof rawType === "string" && HANDWRITTEN_TYPES.has(rawType)) {
        issues.push(
          report(
            lineRange(child)[0],
            `第 ${ordinal} 题是手写题型（${rawType}），教师已关闭「手写辅助」：学生端将隐藏手写与草稿入口，仍可填写最终答案提交（正式作答不受影响，仅回退提示）`,
          ),
        );
      }
      ordinal += 1; // 与 lintQuestions 同口径：题型缺失/未知的题也占序号
    }
  }
  return issues;
}

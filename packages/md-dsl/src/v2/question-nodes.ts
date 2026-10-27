import {
  QUESTION_NODES_VERSION,
  type QuestionNode,
  type QuestionNodeKind,
} from "@tutor/contract";
import type { Root } from "mdast";
import type { Node } from "unist";
import { visit } from "unist-util-visit";
import { studentStemMd } from "./public-stem.ts";
import { processor } from "./shared.ts";

/**
 * 题面语义节点枚举（LR-4，学习记录模型设计稿 §5.1）：从公开题面投影按 AST
 * 预序枚举块级节点。键 schema / kind 词表 / 版本常量的单一来源在
 * @tutor/contract（question-node.ts），本文件只负责「源文本 → 节点列表」。
 *
 * 规则（设计稿 §5.1 / 附录 A-3）：
 * - 只枚举**块级**节点：root + 题干块（stem/<kind>/<n>）+ 选项
 *   （options/option/<n>）；行级/字级锚定留给后续版本（设计稿 §10-4）。
 *   n 为同类节点在预序中的 0 起序号。
 * - 输入先过学生端唯一投影 studentStemMd（publicStemMd∘displayStemMd，幂等）：
 *   [[…]] 标记脱敏为 [[]] 空框 + 选项任务列表剥除（有 options 才剥，与渲染侧
 *   一致）——nodes[].text 对任何调用方都是公开投影，不会把教师原文里的答案
 *   原文带进学生/AI 载荷（评审 #11400 建议改条目）；标记替换只动行内文本
 *   （渲染侧 remark-blank 产 inline textDirective），两角色键序列不变
 *   （question-nodes.test.ts 锁定）。
 * - 渲染器（RichMarkdown 管线）将用同一枚举规则给块级元素打
 *   data-lr-node="<key>"（LR-PR2）。
 */

export { QUESTION_NODES_VERSION };

/** 节点纯文本摘要上限（questionNodeSchema text ≤200 同口径） */
const QUESTION_NODE_TEXT_MAX = 200;

/** mdast 块级节点类型 → 节点 kind / 键词元（paragraph 在键里缩写为 p） */
const BLOCK_KIND_BY_TYPE: Readonly<
  Record<string, { kind: QuestionNodeKind; token: string }>
> = {
  paragraph: { kind: "paragraph", token: "p" },
  heading: { kind: "heading", token: "heading" },
  listItem: { kind: "list-item", token: "list-item" },
  code: { kind: "code", token: "code" },
  math: { kind: "math-block", token: "math-block" },
  table: { kind: "table", token: "table" },
};

/** 其余块级节点（blockquote/html/directive 等）一律归 other（键词元 other） */
const OTHER: { kind: QuestionNodeKind; token: string } = {
  kind: "other",
  token: "other",
};

/** 节点纯文本摘要：text/code/math 的 value 串联、压平空白、截断 */
function nodeText(node: Node): string | undefined {
  let text = "";
  visit(node, (child) => {
    const value = (child as { value?: unknown }).value;
    if (typeof value === "string") text += value;
    return undefined;
  });
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed === "") return undefined;
  return collapsed.slice(0, QUESTION_NODE_TEXT_MAX);
}

/** 选项字母：0 起 → A、B、…、Z、AA、AB（choice 判分「字母由顺序推导」同口径） */
function optionLabel(index: number): string {
  let label = "";
  let n = index;
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}

/** questionNodesOf 的输入：题干源文本 + 选项纯文本数组（choice/multi 有） */
export interface QuestionNodesInput {
  readonly stemMd: string;
  readonly options?: readonly string[] | undefined;
}

/**
 * 从公开题面投影确定性枚举块级语义节点（两角色同输入同输出）。
 * 纯函数：不碰 DOM、不依赖渲染管线；同输入恒等输出（确定性单测锁定）。
 */
export function questionNodesOf(input: QuestionNodesInput): QuestionNode[] {
  const nodes: QuestionNode[] = [{ key: "root", kind: "root", order: 0 }];
  const counters = new Map<string, number>();
  const nextIndex = (token: string): number => {
    const n = counters.get(token) ?? 0;
    counters.set(token, n + 1);
    return n;
  };

  // 输入先过学生端唯一投影 studentStemMd（幂等；学生投影再入无变化）——
  // nodes[].text 恒为公开投影，两角色键序列不变（见文件头注释）。
  const stem = studentStemMd({
    stemMd: input.stemMd,
    options: input.options,
  });
  const tree = processor.parse(stem) as Root;
  for (const child of tree.children) {
    // list 是包装节点：每个 listItem 自成一个块级节点（键按同类预序编号）
    const blocks =
      child.type === "list"
        ? ((child as { children?: Node[] }).children ?? [])
        : [child];
    for (const block of blocks) {
      const mapped = BLOCK_KIND_BY_TYPE[block.type] ?? OTHER;
      const token = mapped.token;
      nodes.push({
        key: `stem/${token}/${nextIndex(token)}`,
        kind: mapped.kind,
        order: nodes.length,
        ...(mapped.kind === "other" ? {} : { text: nodeText(block) }),
      });
    }
  }

  // 选项节点：数组下标即键序号（跳过空洞不改键）；label 按字母序推导
  const options = input.options ?? [];
  for (let i = 0; i < options.length; i += 1) {
    const option = options[i];
    if (option === undefined) continue;
    nodes.push({
      key: `options/option/${i}`,
      kind: "option",
      order: nodes.length,
      text: option.slice(0, QUESTION_NODE_TEXT_MAX),
      label: optionLabel(i),
    });
  }
  return nodes;
}

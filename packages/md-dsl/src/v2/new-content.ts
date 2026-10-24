import {
  NEW_QUESTION_TYPES,
  getDirective,
} from "@tutor/contract";
import type { Root } from "mdast";
import { SKIP, visit } from "unist-util-visit";
import { canonicalName, processor } from "./shared.ts";

/**
 * TT-06 新内容检测：NEW_CONTENT_DISABLED 的判定面（决策记录 §5.8.4 触发清单
 * + §12.2-8 强制约束）。
 *
 * 导入层（QM-05）在部署发布开关 NEW_CONTENT_ENABLED 关闭时调用——文档命中
 * 任一标记即 403。本函数只做检测、不产 lint issue（NEW_CONTENT_DISABLED 是
 * 导入层码，不进 lint 码表；静态 lint 对新指令照常解析）。
 *
 * 触发清单（§5.8.4 字面 + §12.2-8 补遗）：
 * - 注册表 since 晚于基线 2.0 的指令（material/group/seg/ref/options/option/
 *   item/variant；从注册表派生，后续批次新增指令自动纳入）；
 * - question 的 type 为新题型枚举值（response/matching/ordering——契约
 *   NEW_QUESTION_TYPES 单源；纯旧语法文档写新题型必须触发，TT-05a 审查
 *   发现的绕过角落）；
 * - question 的 word-min/word-max 属性（新属性）；
 * - 材料正文 {{slot}} 槽位标记（新行内语法）。
 *
 * 代码块与公式子树跳过：展示新语法的样例段落不是使用新内容，不误伤导入。
 */

/** 首发指令集的注册表基线版本：since 晚于此值的指令都算新内容 */
const BASE_DIRECTIVE_VERSION = "2.0";

/** 新属性清单：question 容器上 TT-06 新增的属性名 */
const NEW_QUESTION_ATTRS: readonly string[] = ["word-min", "word-max"];

/** 材料槽位标记：{{slot-id}}（与 materials.ts 槽位识别同款形态） */
const SLOT_MARKER_RE = /\{\{[^{}\n]+\}\}/g;

/** 行内式 ::ref{…} 标记：跟在文字后的写法是纯文本节点（question.ts 同款纪律） */
const INLINE_REF_RE = /::ref\{([^{}]*)\}/g;

/** 一次新内容命中：类别 + 名称 + 定位（导入层提示与前端行标红用） */
export interface NewContentUsage {
  /** directive=新指令；question-type=新题型；question-attr=新属性；slot=槽位标记 */
  readonly kind: "directive" | "question-type" | "question-attr" | "slot";
  /** 指令主名 / 题型枚举值 / 属性名 / 标记字面（含花括号） */
  readonly name: string;
  readonly line: number;
  readonly column: number;
}

/** 指令节点的三种 mdast 类型（容器/叶子/行内文字指令统一收集） */
const DIRECTIVE_NODE_TYPES = new Set([
  "containerDirective",
  "leafDirective",
  "textDirective",
]);

/** 跳过代码/公式/行内代码/行内公式的子树判定（展示样例不算使用） */
function isSampleSubtree(node: { type: string }): boolean {
  return (
    node.type === "code" ||
    node.type === "inlineCode" ||
    node.type === "math" ||
    node.type === "inlineMath"
  );
}

/** 新题型集合（契约单源，转 Set 加速逐题判定） */
const NEW_TYPE_SET = new Set<string>(NEW_QUESTION_TYPES);

/**
 * 检测入口：输入 markdown 原文，输出全部新内容命中（按文档出现顺序）。
 * 解析失败返回空数组——导入在 lint 层会被拒，不靠本检测兜底语法错误。
 */
export function detectNewContent(md: string): readonly NewContentUsage[] {
  let tree: Root;
  try {
    tree = processor.parse(md) as Root;
  } catch {
    return [];
  }
  const usages: NewContentUsage[] = [];
  visit(tree, (node) => {
    if (isSampleSubtree(node)) return SKIP;
    const line = node.position?.start.line ?? 1;
    const column = node.position?.start.column ?? 1;
    if (DIRECTIVE_NODE_TYPES.has(node.type)) {
      const directive = node as { name: string } & {
        attributes?: Record<string, string | null | undefined>;
      };
      const name = canonicalName(directive);
      const definition = getDirective(name);
      if (definition !== undefined && definition.since !== BASE_DIRECTIVE_VERSION) {
        usages.push({ kind: "directive", name, line, column });
      }
      // question 容器的新题型与新属性在指令节点上判定（question 自身 since 2.0）
      if (name === "question") {
        const attrs = directive.attributes ?? {};
        const type = attrs.type?.trim();
        if (type !== undefined && NEW_TYPE_SET.has(type)) {
          usages.push({ kind: "question-type", name: type, line, column });
        }
        for (const attr of NEW_QUESTION_ATTRS) {
          if (attrs[attr] !== undefined) {
            usages.push({ kind: "question-attr", name: attr, line, column });
          }
        }
      }
      return undefined;
    }
    if (node.type !== "text") return undefined;
    const baseLine = node.position?.start.line ?? 1;
    const baseColumn = node.position?.start.column ?? 1;
    const value = (node as { value: string }).value;
    /** 文本内标记的行/列定位（相对文本节点起点按换行推进） */
    const locate = (index: number): { line: number; column: number } => {
      const before = value.slice(0, index);
      const newlines = before.split("\n").length - 1;
      const lastNewline = before.lastIndexOf("\n");
      return {
        line: baseLine + newlines,
        column:
          lastNewline === -1 ? baseColumn + index : index - lastNewline,
      };
    };
    for (const match of value.matchAll(SLOT_MARKER_RE)) {
      usages.push({
        kind: "slot",
        name: match[0],
        ...locate(match.index ?? 0),
      });
    }
    for (const match of value.matchAll(INLINE_REF_RE)) {
      usages.push({
        kind: "directive",
        name: "ref",
        ...locate(match.index ?? 0),
      });
    }
    return undefined;
  });
  return usages;
}

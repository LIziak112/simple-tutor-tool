import type { MdNode } from "./mdast-interop";

/**
 * remark 插件：把题干中的填空标记 `[[…]]` 转成名为 blank 的 textDirective 节点，
 * 交给统一的指令映射层渲染（T1.8 设计决策 2）。
 *
 * 规则（与 packages/md-dsl v2 解析器一致，见 T1.3 要点）：
 * - 位于 $…$ / $$…$$ 数学环境内的 `[[…]]` 是公式记号，不识别；
 * - 标记内的参考答案属教师侧内容，教师预览渲染一律丢弃，只留空填空框
 *   （Blank 组件显示为下划线空框），即 `[[4]]` 与 `[[0.5|1/2]]` 渲染结果相同。
 */
const BLANK_PATTERN = /\[\[([^[\]]*)\]\]/g;

/** 把一个 text 节点的 value 按 [[…]] 切分为 文本/blank指令 节点序列；无标记返回 null */
function splitBlankText(value: string): MdNode[] | null {
  if (!value.includes("[[")) return null;
  const parts: MdNode[] = [];
  let cursor = 0;
  BLANK_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(BLANK_PATTERN)) {
    const at = match.index ?? 0;
    if (at > cursor) {
      parts.push({ type: "text", value: value.slice(cursor, at) });
    }
    parts.push({ type: "textDirective", name: "blank", children: [] });
    cursor = at + match[0].length;
  }
  if (parts.length === 0) return null;
  if (cursor < value.length) {
    parts.push({ type: "text", value: value.slice(cursor) });
  }
  return parts;
}

/** 深度优先遍历：替换非数学环境内的 text 节点（数学环境整棵子树跳过） */
function replaceBlanks(node: MdNode): void {
  const children = node.children;
  if (!children) return;
  // remark-math 产出的 math / inlineMath 节点内部是公式原文，不识别 [[…]]
  if (node.type === "math" || node.type === "inlineMath") return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!child) continue;
    if (child.type === "text" && typeof child.value === "string") {
      const replacement = splitBlankText(child.value);
      if (replacement) {
        children.splice(i, 1, ...replacement);
        i += replacement.length - 1;
      }
      continue;
    }
    replaceBlanks(child);
  }
}

/** remark 插件入口：无选项，直接变换语法树 */
export function remarkBlank() {
  return (tree: MdNode) => {
    replaceBlanks(tree);
  };
}

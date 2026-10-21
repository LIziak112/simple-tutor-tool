/** 只改写清洗后语法树的顶级节点；完整文档已解析，引用定义与嵌套块保持原样。 */
interface HtmlNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HtmlNode[];
}
const depthOf = (node: HtmlNode) =>
  /^h[1-6]$/.test(node.tagName ?? "") ? Number(node.tagName?.slice(1)) : null;
export function rehypeReplySections() {
  return (tree: HtmlNode) => {
    const nodes = tree.children ?? [];
    const depths = nodes.flatMap((node) => depthOf(node) ?? []);
    if (depths.length < 2) return;
    let depth = Math.min(...depths);
    // 唯一总标题下有多个同级子标题时，以子标题分节，总标题与引言留在前面。
    if (depths.filter((value) => value === depth).length === 1) {
      const deeper = depths.filter((value) => value > depth);
      if (!deeper.length) return;
      depth = Math.min(...deeper);
    }
    const indexes = nodes.flatMap((node, index) =>
      depthOf(node) === depth ? [index] : [],
    );
    if (indexes.length < 2) return;
    const ids = indexes.map((index) => `section-${index}`);
    const grouped: HtmlNode[] = nodes.slice(0, indexes[0]);
    grouped.push({
      type: "element",
      tagName: "nav",
      properties: { dataSectionIds: ids.join(",") },
      children: [],
    });
    indexes.forEach((start, index) => {
      const heading = nodes[start];
      if (!heading) return;
      grouped.push({
        type: "element",
        tagName: "details",
        properties: { id: ids[index], open: index === 0 },
        children: [
          {
            type: "element",
            tagName: "summary",
            properties: {},
            children: [heading],
          },
          {
            type: "element",
            tagName: "div",
            properties: {},
            children: nodes.slice(
              start + 1,
              indexes[index + 1] ?? nodes.length,
            ),
          },
        ],
      });
    });
    tree.children = grouped;
  };
}

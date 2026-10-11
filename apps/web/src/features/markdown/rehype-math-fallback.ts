import { simplifySizedMathDelimiters } from "@tutor/md-dsl";
import katex from "katex";

/** 渲染器内部最小hast结构，不新增AST依赖或外部内容契约。 */
interface HtmlNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HtmlNode[];
}

function canRender(value: string, displayMode: boolean): boolean {
  try {
    katex.renderToString(value, {
      displayMode,
      throwOnError: true,
      trust: false,
    });
    return true;
  } catch {
    return false;
  }
}

/** 发布仍拒绝坏公式；历史显示的简化不修改源文、冻结快照或导出证据。 */
export function rehypeMathFallback() {
  return (tree: HtmlNode) => {
    function visit(node: HtmlNode): void {
      const classes = node.properties?.className;
      if (
        Array.isArray(classes) &&
        classes.some(
          (name) =>
            name === "math-inline" ||
            name === "math-display" ||
            name === "language-math",
        )
      ) {
        const value =
          node.children?.map((child) => child.value ?? "").join("") ?? "";
        const display = classes.includes("math-display");
        if (canRender(value, display)) return;
        const simplified = simplifySizedMathDelimiters(value);
        const repaired = simplified !== null && canRender(simplified, display);
        node.tagName = "span";
        node.properties = {
          className: [repaired ? "math-fallback" : "math-render-error"],
        };
        node.children = repaired
          ? [
              {
                type: "element",
                tagName: "code",
                properties: {
                  className: [display ? "math-display" : "math-inline"],
                },
                children: [{ type: "text", value: simplified }],
              },
              {
                type: "element",
                tagName: "small",
                properties: {},
                children: [{ type: "text", value: "〔历史公式简化显示〕" }],
              },
            ]
          : [{ type: "text", value: "〔公式无法显示，请反馈老师〕" }];
        return;
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}

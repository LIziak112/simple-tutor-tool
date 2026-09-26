import type { LintIssue } from "@tutor/contract";
import { makeIssue } from "../v2/shared.ts";

/**
 * 未闭合容器扫描（T1.5：UNCLOSED_CONTAINER）。
 *
 * 为什么需要独立扫描：remark-directive 对未闭合的容器不会报错——实测
 * （micromark-extension-directive@4）它会产出一个延伸到文档末尾（或父容器内容末尾）的
 * containerDirective 节点，之后的全部内容都被吞进该容器（比如后面的题目不再被当作顶层
 * 题目提取）。AST 层看不出「作者忘了写结束围栏」，因此按原文逐行做冒号栈扫描。
 *
 * 栈语义（经探针对齐 micromark 真实行为，见 fences.test.ts）：
 * - 开栏行 `^ {0,3}(:{3,})名称([标签])?({属性})?$` 入栈；
 * - 裸围栏 `^ {0,3}(:{3,})[ \t]*$`：从栈底起找第一个开栏冒号数 ≤ N 的条目，
 *   它及其上方（内部嵌套的）容器一起闭合——等价于 micromark 的
 *   「外层容器扫描到冒号数 ≥ 自身开栏数的裸围栏即闭合，嵌套容器在父内容结束处隐式闭合」；
 * - 文档末尾仍在栈上的容器即未闭合，逐条报 error。
 *
 * 为避免误报，扫描跳过：frontmatter 围栏、```/~~~ 代码块、$$ 数学块
 * （这些区域内的 ::: 不参与指令配对，与解析管线行为一致）。
 */

/** 开栏行：冒号 ×3+ 指令名（名称不含冒号/空白/花括号/方括号；micromark 允许非 ASCII 名），后接可选 [标签] 与 {属性} */
const OPEN_FENCE_RE =
  /^ {0,3}(:{3,})([^ \t{:[]+)(?:\[[^\]]*\])?(?:\{.*\})?[ \t]*$/;
/** 裸闭合围栏：冒号 ×3+ 到行尾（只允许尾随空白） */
const CLOSE_FENCE_RE = /^ {0,3}(:{3,})[ \t]*$/;
/** 代码块开栏（与 CommonMark 一致：` 或 ~ ×3+，行首缩进 ≤3） */
const CODE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
/** frontmatter 起始/结束围栏（remark-frontmatter 的 yaml 围栏） */
const FRONTMATTER_FENCE_RE = /^(?:-{3}|\.{3})[ \t]*$/;

/** 一个未闭合的开栏 */
export interface UnclosedContainer {
  readonly name: string;
  readonly colons: number;
  readonly line: number;
}

/** 逐行扫描，返回文档末尾仍未闭合的容器（按开栏行升序） */
export function scanUnclosedContainers(
  lines: readonly string[],
): UnclosedContainer[] {
  const stack: UnclosedContainer[] = [];
  let codeFence:
    | { readonly marker: string; readonly length: number }
    | undefined;
  let inMathBlock = false;

  for (let index = skipFrontmatter(lines); index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (codeFence !== undefined) {
      // 代码块内：等长及以上同字符围栏才结束代码块，其余行一律跳过
      const fence = CODE_FENCE_RE.exec(line);
      if (fence !== null) {
        const fenceText = fence[1] ?? "";
        const trailing = line.slice((fence[0] ?? "").length).trim().length;
        if (
          fenceText.startsWith(codeFence.marker) &&
          fenceText.length >= codeFence.length &&
          trailing === 0
        ) {
          codeFence = undefined;
        }
      }
      continue;
    }
    if (inMathBlock) {
      if (/^\s*\$\$/.test(line)) inMathBlock = false;
      continue;
    }

    const code = CODE_FENCE_RE.exec(line);
    if (code !== null) {
      codeFence = {
        marker: code[1]?.[0] ?? "`",
        length: code[1]?.length ?? 3,
      };
      continue;
    }
    if (/^ {0,3}\$\$/.test(line)) {
      // 单行 $$…$$ 是自闭合数学块；只有「以 $$ 开头但不同行收尾」才进入多行数学块
      const trimmed = line.trim();
      const selfContained =
        trimmed.length >= 4 &&
        trimmed.startsWith("$$") &&
        trimmed.endsWith("$$");
      if (!selfContained) inMathBlock = true;
      continue;
    }

    const close = CLOSE_FENCE_RE.exec(line);
    if (close !== null) {
      const colons = close[1]?.length ?? 3;
      // 自栈底起第一个开栏冒号数 ≤ N 的容器被闭合，其内部嵌套容器随之隐式闭合
      const matched = stack.findIndex(
        (container) => container.colons <= colons,
      );
      if (matched >= 0) stack.length = matched;
      continue;
    }
    const open = OPEN_FENCE_RE.exec(line);
    if (open !== null) {
      stack.push({
        name: open[2] ?? "",
        colons: open[1]?.length ?? 3,
        line: index + 1,
      });
    }
  }
  return stack;
}

/** 把扫描结果转成 LintIssue（error：未闭合会静默吞内容，必须阻断导入） */
export function lintUnclosedContainers(lines: readonly string[]): LintIssue[] {
  return scanUnclosedContainers(lines).map((container) => {
    const fence = ":".repeat(container.colons);
    return {
      ...makeIssue(
        "error",
        container.line,
        1,
        "UNCLOSED_CONTAINER",
        `容器指令 ${fence}${container.name}（第 ${container.line} 行）没有配对的结束围栏：从该行往后的全部内容都会被吞进这个容器（例如后面的题目不再被单独识别）；请在容器内容结束后单独一行补上「${fence}」。嵌套时通常外层比内层多一个冒号（如 ::::question 内放 :::hint）`,
      ),
      fix: `在 ${fence}${container.name} 的内容结束后补一行「${fence}」结束围栏`,
    };
  });
}

/** frontmatter 占用的行数（首行是 --- 围栏时，跳到结束围栏之后；否则 0） */
function skipFrontmatter(lines: readonly string[]): number {
  if ((lines[0] ?? "").trimEnd() !== "---") return 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (FRONTMATTER_FENCE_RE.test(lines[index] ?? "")) return index + 1;
  }
  return 0;
}

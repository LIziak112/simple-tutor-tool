import type { LintIssue } from "@tutor/contract";
import type { Root } from "mdast";
import { visit } from "unist-util-visit";
import { makeIssue } from "../v2/shared.ts";

/**
 * 表格单元格被竖线切开检查（TABLE_CELL_PIPE_SPLIT）。
 *
 * 动机（2026-10-02 实例）：AI 生成的讲义在 GFM 表格单元格里写含绝对值
 * 竖线的公式 `$-|-a|$`。GFM 表格以未转义 `|` 切分单元格且先于数学扩展
 * 生效，公式从中间断开：`$` 定界符落单成纯文本，\\ge / \\le / \\iff 等
 * 以 LaTeX 源码原样显示，整行单元格错位。填空 [[答案|显示]] 在表格里
 * 同理会被 `|` 切开。本规则在导入前把它拦成 warning。
 *
 * 判定（对每个 table 的正文行，两个独立信号各报各的）：
 * 1. 行单元格数 > 表头列数：行里有未转义 `|` 把内容切出了额外单元格
 *    （来自公式绝对值、填空 [[…|…]] 或笔误多写竖线）。
 * 2. 单元格内 text 节点的 `$` 计数为奇数、且含 \\命令 形态的 LaTeX：
 *    公式被切开后落单 `$ 的确凿信号。无 LaTeX 命令的奇数 `$`（如货币
 *    `$5`）不报，避免误伤。
 *
 * 正确写法：公式内竖线用 `\lvert … \rvert`（KaTeX 完整支持，渲染等价），
 * 填空内的 `|` 转义为 `\|`（表格解析先行，转义后还原成字面竖线）。
 */

/** 单元格内「疑似被切开的公式」：落单 $ 且含 \命令 */
function splitMathCell(cell: Root["children"][number]): boolean {
  let dollars = 0;
  let hasCommand = false;
  visit(cell, "text", (node) => {
    dollars += (node.value.match(/\$/g) ?? []).length;
    if (/\\[a-zA-Z]+/.test(node.value)) {
      hasCommand = true;
    }
  });
  return dollars % 2 === 1 && hasCommand;
}

/** 扫描全部表格行，返回 warning 列表（无命中不报） */
export function lintTablePipes(tree: Root): LintIssue[] {
  const issues: LintIssue[] = [];
  visit(tree, "table", (table) => {
    const width = table.children[0]?.children.length ?? 0;
    if (width === 0) return;
    for (const row of table.children.slice(1)) {
      const line = row.position?.start.line ?? 1;
      const column = row.position?.start.column ?? 1;
      if (row.children.length > width) {
        issues.push({
          ...makeIssue(
            "warning",
            line,
            column,
            "TABLE_CELL_PIPE_SPLIT",
            `该表格行有 ${row.children.length} 个单元格，超过表头的 ${width} 列：行内公式 $…|…$（绝对值）或填空 [[答案|显示]] 里的 | 被当成了单元格分隔符，公式断开后以 LaTeX 源码显示、整行错位。公式内竖线改用 \\lvert … \\rvert，填空内的 | 转义为 \\|，或把公式移出表格`,
          ),
          fix: "公式内的 | 改成 \\lvert / \\rvert；[[…|…]] 内的 | 改成 \\|",
        });
      }
      for (const cell of row.children) {
        if (splitMathCell(cell)) {
          issues.push({
            ...makeIssue(
              "warning",
              cell.position?.start.line ?? line,
              cell.position?.start.column ?? column,
              "TABLE_CELL_PIPE_SPLIT",
              "该单元格内有落单的 $ 且含 LaTeX 命令：公式疑似被表格单元格分隔符 | 切开，KaTeX 收不到完整公式、页面显示源码。公式内竖线改用 \\lvert … \\rvert 或转义 \\|",
            ),
            fix: "公式内的 | 改成 \\lvert / \\rvert",
          });
        }
      }
    }
  });
  return issues;
}

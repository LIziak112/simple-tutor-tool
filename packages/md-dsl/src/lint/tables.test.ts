import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintDocument } from "./lint.ts";

/**
 * TABLE_CELL_PIPE_SPLIT 测试（测试先行：先于 tables.ts 实现编写）。
 *
 * 动机（2026-10-02 实例）：AI 生成的讲义在 GFM 表格单元格里写含绝对值
 * 竖线的公式 `$-|-a|$`。表格以未转义 `|` 切分单元格，公式从中间断开：
 * `$` 定界符落单成纯文本，\\ge / \\le / \\iff 等以 LaTeX 源码原样显示，
 * 整行单元格错位。填空 [[答案|显示]] 在表格里同理会被切开。本规则在
 * 导入前把它拦成 warning。
 */

const codes = (issues: readonly { code: string }[]): string[] =>
  issues.map((i) => i.code);

/** 行数组拼 md */
const md = (lines: readonly string[]): string => lines.join("\n");

describe("lintDocument：TABLE_CELL_PIPE_SPLIT", () => {
  it("samples/lint/16 反例：公式内裸 | 切开单元格 → 该行 warning；\\lvert 写法的正确表格 → 0 issue", () => {
    const fixture = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../samples/lint/16-table-pipe-split.md",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const { issues } = lintDocument(fixture);
    const hits = issues.filter((i) => i.code === "TABLE_CELL_PIPE_SPLIT");
    // 错误表格那一行：单元格数超表头 1 条 + 落单 $ 且含 LaTeX 命令的单元格 1 条
    expect(hits.length).toBe(2);
    for (const issue of hits) {
      expect(issue.level).toBe("warning");
      expect(issue.line).toBe(10);
      expect(issue.fix).toBeDefined();
    }
  });

  it("公式内竖线写成 \\lvert … \\rvert 或转义 \\| → 0 issue", () => {
    const { issues } = lintDocument(
      md([
        "---",
        "kind: lecture",
        "unit: 专题",
        "---",
        "",
        "# 第一讲",
        "",
        "| 要点 | 说明 |",
        "| :---: | :---: |",
        "| $\\lvert -a\\rvert \\ge 0$ | 转义写法 \\| 也合法 |",
      ]),
    );
    expect(codes(issues)).toEqual([]);
  });

  it("表格里的货币符号 $（无 LaTeX 命令）不误报", () => {
    const { issues } = lintDocument(
      md([
        "---",
        "kind: lecture",
        "unit: 专题",
        "---",
        "",
        "# 第一讲",
        "",
        "| 商品 | 单价 | 优惠价 |",
        "| :---: | :---: | :---: |",
        "| 笔记本 | $5 | $12 |",
      ]),
    );
    expect(codes(issues)).toEqual([]);
  });

  it("非表格正文里公式内的 | 不报（正文没有单元格切分问题）", () => {
    const { issues } = lintDocument(
      md([
        "---",
        "kind: lecture",
        "unit: 专题",
        "---",
        "",
        "# 第一讲",
        "",
        "化简：$-|-a|$ 与 $|x| = 3$ 均为合法公式。",
      ]),
    );
    expect(codes(issues)).toEqual([]);
  });
});

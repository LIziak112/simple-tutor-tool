import type { LintIssue } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  countLevels,
  exitCodeFor,
  formatIssueLines,
  renderReport,
} from "./report.ts";

/**
 * tutor-lint CLI 输出格式化测试（T1.7，测试先行）。
 * 契约：每条 issue 一行 `文件:行:列  ERROR/WARNING  [CODE] 中文消息`（+ fix 建议行），
 * 末尾统计 `共检查 N 个文件：E error / W warning`；彩色用原生 ANSI 转义码
 * （error 红 / warning 黄 / 摘要绿），color=false 时绝不输出任何转义码（CI 日志干净）。
 */

const issue = (patch: Partial<LintIssue> = {}): LintIssue => ({
  level: "error",
  line: 1,
  column: 1,
  code: "TEST_CODE",
  message: "消息",
  ...patch,
});

describe("formatIssueLines", () => {
  it("主行格式：文件:行:列  ERROR  [CODE] 消息", () => {
    const lines = formatIssueLines(
      "samples/lint/a.md",
      issue({ level: "error", line: 7, column: 3, code: "FILL_NO_BLANK" }),
      false,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("samples/lint/a.md:7:3  ERROR  [FILL_NO_BLANK] 消息");
  });

  it("warning 级别原样显示，有 fix 时追加缩进的建议行", () => {
    const lines = formatIssueLines(
      "b.md",
      issue({
        level: "warning",
        line: 10,
        column: 1,
        code: "UNKNOWN_DIRECTIVE",
        fix: "把 :::tps 改为 :::tip",
      }),
      false,
    );
    expect(lines[0]).toBe("b.md:10:1  WARNING  [UNKNOWN_DIRECTIVE] 消息");
    expect(lines[1]).toBe("  建议：把 :::tps 改为 :::tip");
  });

  it("无 fix 时不输出建议行", () => {
    const lines = formatIssueLines("b.md", issue(), false);
    expect(lines).toHaveLength(1);
  });

  it("color=true：error 红、warning 黄", () => {
    const err = formatIssueLines("a.md", issue({ level: "error" }), true)[0];
    expect(err).toContain("\u001B[31mERROR\u001B[0m");
    const warn = formatIssueLines("a.md", issue({ level: "warning" }), true)[0];
    expect(warn).toContain("\u001B[33mWARNING\u001B[0m");
  });

  it("color=false：不含任何 ANSI 转义码（非 TTY 场景）", () => {
    const lines = [
      ...formatIssueLines("a.md", issue({ level: "warning", fix: "x" }), false),
      ...formatIssueLines("a.md", issue(), true), // 对照组：彩色开启才有码
    ];
    expect(lines[0]).not.toContain("\u001B");
    expect(lines[2]).toContain("\u001B");
  });
});

describe("countLevels / exitCodeFor", () => {
  it("分别统计 error 与 warning", () => {
    const issues = [
      issue({ level: "error" }),
      issue({ level: "warning" }),
      issue({ level: "warning" }),
    ];
    expect(countLevels(issues)).toEqual({ errors: 1, warnings: 2 });
  });

  it("退出码：有 error → 1；仅 warning 或无 issue → 0", () => {
    expect(exitCodeFor([{ displayPath: "a", issues: [issue()] }])).toBe(1);
    expect(
      exitCodeFor([
        { displayPath: "a", issues: [issue({ level: "warning" })] },
      ]),
    ).toBe(0);
    expect(exitCodeFor([{ displayPath: "a", issues: [] }])).toBe(0);
    expect(exitCodeFor([])).toBe(0);
  });
});

describe("renderReport", () => {
  it("多文件多 issue 依次输出，末尾统计汇总（无 error 时绿色）", () => {
    const text = renderReport(
      [
        {
          displayPath: "a.md",
          issues: [
            issue({ line: 2, code: "C1" }),
            issue({ level: "warning", line: 5, code: "C2", fix: "改一下" }),
          ],
        },
        { displayPath: "sub/b.md", issues: [] },
      ],
      false,
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("a.md:2:1  ERROR  [C1] 消息");
    expect(lines[1]).toBe("a.md:5:1  WARNING  [C2] 消息");
    expect(lines[2]).toBe("  建议：改一下");
    expect(lines[3]).toBe("共检查 2 个文件：1 error / 1 warning");
    expect(lines).toHaveLength(4);
  });

  it("全部通过：仅一行绿色摘要", () => {
    const plain = renderReport([{ displayPath: "a.md", issues: [] }], false);
    expect(plain).toBe("共检查 1 个文件：0 error / 0 warning");
    const colored = renderReport([{ displayPath: "a.md", issues: [] }], true);
    expect(colored).toContain("\u001B[32m");
  });

  it("有 error 时摘要为红色", () => {
    const colored = renderReport(
      [{ displayPath: "a.md", issues: [issue()] }],
      true,
    );
    const summary = colored.split("\n").at(-1);
    expect(summary).toContain("\u001B[31m");
  });
});

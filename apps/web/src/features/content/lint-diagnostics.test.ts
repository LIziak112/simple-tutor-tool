import type { LintIssue } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { lintIssuesToDiagnostics } from "./lint-diagnostics.ts";

/**
 * lint 诊断映射纯函数测试（T1.11）：行列换算（1 起 → 0 起偏移）、
 * error/warning 严重级映射、fix 并入 message、越界行列收敛、按位置排序。
 */

const DOC = [
  "---", // 行 1：偏移 0，长 3，换行后行 2 起点 4
  "kind: practice", // 行 2：偏移 4，长 14
  "---", // 行 3：偏移 19
  "", // 行 4：偏移 23（空行）
  "::::question{type=fill difficulty=2}", // 行 5：偏移 24
  "计算：1+1=2。", // 行 6：偏移 59
].join("\n");

function issue(overrides: Partial<LintIssue>): LintIssue {
  return {
    level: "error",
    line: 6,
    column: 1,
    code: "FILL_NO_BLANK",
    message: "填空题题干没有任何 [[…]] 空",
    ...overrides,
  };
}

describe("lintIssuesToDiagnostics", () => {
  it("1 起行列换算为 0 起文档偏移（第 6 行第 1 列 → 行 6 起始偏移）", () => {
    const [diag] = lintIssuesToDiagnostics([issue({})], DOC);
    // 行 1-5 累计（含换行）60 字符 → 行 6 起始偏移 61 的前一行尾……实际 61
    expect(diag?.from).toBe(61);
    expect(diag?.to).toBe(62);
  });

  it("列偏移生效：第 2 行第 6 列 → 偏移 4+5", () => {
    const [diag] = lintIssuesToDiagnostics(
      [issue({ line: 2, column: 6 })],
      DOC,
    );
    expect(diag?.from).toBe(9);
    expect(diag?.to).toBe(10);
  });

  it("severity：error→error、warning→warning；fix 并入 message；code 进 source", () => {
    const [errDiag, warnDiag] = lintIssuesToDiagnostics(
      [
        issue({ fix: "把 1+1=2 改为 [[2]]" }),
        issue({ level: "warning", code: "UNKNOWN_DIRECTIVE" }),
      ],
      DOC,
    );
    expect(errDiag?.severity).toBe("error");
    expect(errDiag?.message).toContain("填空题题干");
    expect(errDiag?.message).toContain("修正建议：把 1+1=2 改为 [[2]]");
    expect(errDiag?.source).toBe("FILL_NO_BLANK");
    expect(warnDiag?.severity).toBe("warning");
    expect(warnDiag?.source).toBe("UNKNOWN_DIRECTIVE");
  });

  it("行越界收敛到最后一行；空文档收敛到 0 偏移", () => {
    const [beyond] = lintIssuesToDiagnostics([issue({ line: 999 })], DOC);
    // 收敛到第 6 行第 1 列
    expect(beyond?.from).toBe(61);

    const [emptyDoc] = lintIssuesToDiagnostics(
      [issue({ line: 3, column: 4 })],
      "",
    );
    expect(emptyDoc?.from).toBe(0);
    expect(emptyDoc?.to).toBe(0);
  });

  it("列越界收敛到行内合法位置（不跨行、from≤to）", () => {
    // 行 6 长 9（"计算：1+1=2。"），第 99 列 → 收敛到行尾最后一个字符
    const [diag] = lintIssuesToDiagnostics(
      [issue({ line: 6, column: 99 })],
      DOC,
    );
    expect(diag?.from).toBe(69);
    expect(diag?.to).toBe(70);
    expect(diag?.from).toBeLessThanOrEqual(diag?.to ?? Number.NaN);
  });

  it("空行上的 issue 退化为零宽标注（from == to == 行起始）", () => {
    const [diag] = lintIssuesToDiagnostics(
      [issue({ line: 4, column: 1 })],
      DOC,
    );
    expect(diag?.from).toBe(23);
    expect(diag?.to).toBe(23);
  });

  it("多条 issue 按文档位置排序输出", () => {
    const diags = lintIssuesToDiagnostics(
      [issue({ line: 6 }), issue({ line: 2, column: 3 })],
      DOC,
    );
    const offsets = diags.map((d) => d.from);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(offsets[0]).toBeLessThan(offsets[1] ?? Number.NaN);
  });
});

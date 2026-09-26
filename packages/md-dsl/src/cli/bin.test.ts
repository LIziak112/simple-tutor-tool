import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * tutor-lint CLI 子进程冒烟测试（T1.7）：只跑两个关键路径（其余逻辑由
 * report/files/fixtures 的进程内测试覆盖，避免拖慢测试套件）：
 * 1. 有 error 的文件 → 退出码 1、输出含 code、管道下（非 TTY）无 ANSI 转义码；
 * 2. 文件不存在 → stderr 报错、退出码 2。
 */

const scriptPath = fileURLToPath(
  new URL("../../scripts/tutor-lint.ts", import.meta.url),
);
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    cwd: packageRoot,
    timeout: 30_000,
  });
}

describe("tutor-lint 子进程（关键路径）", () => {
  it("反例文件：退出码 1，输出含 code，无 ANSI 码（管道即非 TTY 自动去色）", () => {
    const fixture = fileURLToPath(
      new URL("../../../../samples/lint/04-choice-correct.md", import.meta.url),
    );
    const done = runCli(fixture);
    expect(done.status).toBe(1);
    expect(done.stdout).toContain("[CHOICE_NO_CORRECT]");
    expect(done.stdout).toContain("[CHOICE_MULTIPLE_CORRECT]");
    expect(done.stdout).toContain("共检查 1 个文件：3 error / 0 warning");
    expect(done.stdout).not.toContain("\u001B");
  });

  it("文件不存在：stderr 提示、退出码 2", () => {
    const done = runCli("no-such-file.md");
    expect(done.status).toBe(2);
    expect(done.stderr).toContain("路径不存在");
    expect(done.stderr).toContain("no-such-file.md");
  });
});

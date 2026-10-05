import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * dsl-kit/tutor-lint.mjs 独立校验脚本冒烟测试：dsl-kit 分发包的承诺是
 * 「拷走这一个文件夹即拥有与仓库同版本的校验器」，这里防两种退化——
 * 改了 linter/CLI 忘记重新打包（行为落后于 src，另由 CI 的 gen:spec diff
 * 校验兜底），以及打包配置损坏（产物跑不起来）。与 bin.test.ts 同思路，
 * 只走两条关键路径，避免拖慢测试套件。
 */
const bundlePath = fileURLToPath(
  new URL("../../../../dsl-kit/tutor-lint.mjs", import.meta.url),
);
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

function runBundle(...args: string[]) {
  return spawnSync(process.execPath, [bundlePath, ...args], {
    encoding: "utf8",
    cwd: packageRoot,
    timeout: 30_000,
  });
}

describe("dsl-kit/tutor-lint.mjs（独立校验脚本冒烟）", () => {
  it("反例文件：退出码 1，输出含 code 与统计、无 ANSI 码，行为与仓库 CLI 一致", () => {
    const fixture = fileURLToPath(
      new URL("../../../../samples/lint/04-choice-correct.md", import.meta.url),
    );
    const done = runBundle(fixture);
    expect(done.status).toBe(1);
    expect(done.stdout).toContain("[CHOICE_NO_CORRECT]");
    expect(done.stdout).toContain("[CHOICE_MULTIPLE_CORRECT]");
    expect(done.stdout).toContain("共检查 1 个文件：3 error / 0 warning");
    expect(done.stdout).not.toContain("\u001B");
  });

  it("独立口径：用法文案是 node tutor-lint.mjs；路径不存在退出码 2", () => {
    const done = runBundle("no-such-file.md");
    expect(done.status).toBe(2);
    expect(done.stderr).toContain("路径不存在");
    expect(done.stderr).toContain("no-such-file.md");
  });
});

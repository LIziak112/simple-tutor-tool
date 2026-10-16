import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

import { runBackupRestoreDrill } from "../../scripts/b20-verify/backup-restore-drill.ts";
import { runDegradationDrill } from "../../scripts/b20-verify/degradation-drill.ts";
import {
  type DrillReport,
  hasDrillFail,
  renderDrillReport,
} from "../../scripts/b20-verify/drill-common.ts";

/**
 * B20 演练脚本自证（SAI-35 步骤 4/5；对齐 b19-verify-scripts.test.ts 模式）：
 * - 健全合成世界上两个演练（备份恢复 / 降级）全过；
 * - 检出力负控：跳过对应前置动作时断言必须 FAIL（证明断言非恒真）；
 * - CLI 子进程真实退出码与 --out 落盘（演练证据文件由脚本自身写出）。
 * 演练一律在临时 DATA_DIR 上执行真实服务（建连接/任务/材料/派发/备份/恢复），
 * 绝不触碰用户数据目录（脚本目录头注释同款纪律）。
 */

function failSteps(report: DrillReport): string[] {
  return report.steps
    .filter((step) => step.level === "fail")
    .map((step) => step.message);
}

it("备份恢复演练：健全世界全部断言通过（回执不写新库/票据凭证按设计/代际正确）", async () => {
  const report = await runBackupRestoreDrill();
  try {
    expect(failSteps(report)).toEqual([]);
    const log = renderDrillReport(report);
    // 关键断言面都在日志里可定位（防断言集意外缩水）
    expect(log).toContain("旧在途页内回执");
    expect(log).toContain("旧 MCP 租约回执");
    expect(log).toContain("备份内票据恢复后仍可读");
    expect(log).toContain("备份后新票据已失效");
    expect(log).toContain("任务代际");
    expect(log).toContain("恢复前保险快照");
  } finally {
    rmSync(report.dataDir, { recursive: true, force: true });
  }
}, 60_000);

it("备份恢复演练检出力：跳过恢复步骤时必须报 FAIL（断言非恒真）", async () => {
  const report = await runBackupRestoreDrill({ skipRestore: true });
  try {
    const fails = failSteps(report);
    expect(fails.length).toBeGreaterThanOrEqual(3);
    expect(fails.join("\n")).toContain("备份后新建任务仍存在");
    expect(fails.join("\n")).toContain("回执");
  } finally {
    rmSync(report.dataDir, { recursive: true, force: true });
  }
}, 60_000);

it("降级演练：健全世界四场景全过（缺密钥/缺文件/GC/关闭 AI，交卷不受影响）", async () => {
  const report = await runDegradationDrill();
  try {
    expect(failSteps(report)).toEqual([]);
    const log = renderDrillReport(report);
    expect(log).toContain("needs_rekey");
    expect(log).toContain("AI_MATERIAL_BROKEN");
    expect(log).toContain("孤儿回收");
    expect(log).toContain("交卷");
  } finally {
    rmSync(report.dataDir, { recursive: true, force: true });
  }
}, 60_000);

it("降级演练检出力：未换密钥/未删材料文件/未造孤儿/未禁用时各自 FAIL", async () => {
  const cases = [
    { key: "skipSecretRotation" as const, needle: "needs_rekey" },
    { key: "skipFileDeletion" as const, needle: "AI_MATERIAL_BROKEN" },
    { key: "skipOrphanCreation" as const, needle: "孤儿" },
    { key: "skipPolicyDisable" as const, needle: "AI_POLICY_DISABLED" },
  ];
  for (const testCase of cases) {
    const report = await runDegradationDrill({
      [testCase.key]: true,
    });
    try {
      const fails = failSteps(report);
      expect(
        fails.length,
        `${testCase.key} 跳过时应出现 FAIL 断言`,
      ).toBeGreaterThanOrEqual(1);
      expect(fails.join("\n")).toContain(testCase.needle);
    } finally {
      rmSync(report.dataDir, { recursive: true, force: true });
    }
  }
}, 240_000);

it("CLI 子进程：两个演练退出码 0，--out 操作日志落盘且含断言行", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "tutor-b20-cli-"));
  try {
    const serverRoot = fileURLToPath(new URL("../..", import.meta.url));
    const runCli = async (script: string, out: string): Promise<string> => {
      // 子进程必须摘掉 VITEST 环境变量——脚本以它区分「直接运行」与「测试导入」
      const env = { ...process.env };
      delete env.VITEST;
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "node_modules/tsx/dist/cli.mjs",
          `scripts/b20-verify/${script}`,
          "--out",
          out,
        ],
        { cwd: serverRoot, timeout: 240_000, maxBuffer: 16 * 1024 * 1024, env },
      );
      expect(stdout).toContain("演练");
      return readFileSync(out, "utf8");
    };
    const backupLog = await runCli(
      "backup-restore-drill.ts",
      join(outDir, "backup-restore.log.md"),
    );
    expect(backupLog).toContain("备份恢复演练");
    expect(backupLog).toContain("[PASS]");
    expect(hasDrillFail).toBeTypeOf("function");
    const degradationLog = await runCli(
      "degradation-drill.ts",
      join(outDir, "degradation.log.md"),
    );
    expect(degradationLog).toContain("降级演练");
    expect(degradationLog).toContain("[PASS]");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 300_000);

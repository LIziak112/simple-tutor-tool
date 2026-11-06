import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { checkAiReply } from "./check.ts";

it("CLI 的 BOM/中文路径/CRLF、JSON 和退出码与核心一致", () => {
  const directory = mkdtempSync(join(tmpdir(), "ownclass 检查 "));
  const file = join(directory, "回信.md");
  const cli = fileURLToPath(
    new URL("../../scripts/check-ai-reply.ts", import.meta.url),
  );
  try {
    for (const source of ["\uFEFF正确 $x$\r\n", String.raw`$\badcommand$`]) {
      writeFileSync(file, source);
      const expected = checkAiReply(source.replace(/^\uFEFF/, ""));
      const result = spawnSync(process.execPath, [cli, file, "--json"], {
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(expected.valid ? 0 : 1);
      expect(JSON.parse(result.stdout)).toEqual(expected);
    }
    expect(
      spawnSync(process.execPath, [cli, join(directory, "不存在.md")]).status,
    ).toBe(2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAiReply } from "../packages/md-dsl/src/ai-reply/check.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = join(root, "dist/ai-reply-checker");
const manifest = JSON.parse(
  readFileSync(join(artifacts, "manifest.json"), "utf8"),
);
if (process.argv.includes("--exe"))
  assert(
    manifest.files.some((file) => file.name.endsWith(".exe")),
    "未生成 exe",
  );
const directory = mkdtempSync(join(tmpdir(), "ownclass 中文 检查 "));
try {
  const path = join(directory, "回复.md");
  for (const file of manifest.files) {
    const artifact = join(artifacts, file.name);
    assert.equal(
      createHash("sha256").update(readFileSync(artifact)).digest("hex"),
      file.sha256,
    );
    const executable = file.name.endsWith(".exe");
    const command = executable ? artifact : process.execPath;
    const prefix = executable ? [] : [artifact];
    // exe 在空 PATH 下独立运行，不能依靠机器上另装的 Node 或 node_modules。
    const options = {
      cwd: directory,
      encoding: "utf8",
      env: executable
        ? { ...process.env, PATH: "", NODE_PATH: "", NODE_OPTIONS: "" }
        : process.env,
    };
    for (const source of [
      "\uFEFF结果是 $x$。\r\n",
      String.raw`结果是 -\frac{1}{2}$（负数）。`,
      String.raw`$\badcommand$`,
      "```tex\n\\frac{1}{2}$\n```",
      String.raw`\frac{1}{2}`,
    ]) {
      writeFileSync(path, source);
      const expected = checkAiReply(source.replace(/^\uFEFF/, ""));
      const result = spawnSync(command, [...prefix, path, "--json"], options);
      assert.equal(result.status, expected.valid ? 0 : 1, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), expected);
    }
    const missing = spawnSync(
      command,
      [...prefix, join(directory, "不存在.md")],
      options,
    );
    assert.equal(missing.status, 2);
    const version = spawnSync(command, [...prefix, "--version"], options);
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), manifest.version);
    console.log(
      `${file.name}：哈希、版本、5 组正文、无文件退出码通过${executable ? "（空 PATH）" : ""}`,
    );
  }
  const rebuilt = spawnSync(
    process.execPath,
    [
      join(root, "packages/md-dsl/scripts/build-ai-reply-checker.ts"),
      "--copy-server",
    ],
    { cwd: join(root, "apps/server"), encoding: "utf8" },
  );
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  const serverManifest = JSON.parse(
    readFileSync(
      join(root, "apps/server/dist/ai-reply-checker/manifest.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    serverManifest,
    manifest,
    "服务端构建目录不能改变脚本指纹或丢失 exe",
  );
  console.log("服务端目录重打包、复制后清单及 exe 保持一致");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

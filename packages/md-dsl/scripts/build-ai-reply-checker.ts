import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_REPLY_CHECK_VERSION,
  aiReplyCheckerManifestSchema,
} from "@tutor/contract";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const output = join(root, "dist/ai-reply-checker");
mkdirSync(output, { recursive: true });
const script = join(output, "ownclass-ai-check.cjs");
await build({
  absWorkingDir: root,
  entryPoints: [join(root, "packages/md-dsl/scripts/check-ai-reply.ts")],
  outfile: script,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  legalComments: "inline",
});
const digest = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const executable = join(output, "ownclass-ai-check.exe");
const stamp = join(output, "exe-source.sha256");
if (process.argv.includes("--exe")) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("exe 首版仅支持在 Windows x64 构建");
  const node = process.env.OWNCLASS_SEA_NODE ?? process.execPath;
  const config = join(output, "sea-config.json");
  writeFileSync(
    config,
    JSON.stringify({
      main: script,
      output: executable,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
      execArgvExtension: "none",
    }),
  );
  execFileSync(node, ["--build-sea", config], { stdio: "inherit" });
  writeFileSync(stamp, digest(script));
}
const names = ["ownclass-ai-check.cjs"];
// 旧 exe 不能与新版脚本混装；指纹不一致时清单只公布当前脚本。
if (
  existsSync(executable) &&
  existsSync(stamp) &&
  readFileSync(stamp, "utf8") === digest(script)
)
  names.push("ownclass-ai-check.exe");
const manifest = aiReplyCheckerManifestSchema.parse({
  version: AI_REPLY_CHECK_VERSION,
  files: names.map((name) => ({
    name,
    platform: name.endsWith(".exe") ? "win32-x64" : "node",
    bytes: readFileSync(join(output, name)).length,
    sha256: digest(join(output, name)),
  })),
});
writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
if (process.argv.includes("--copy-server")) {
  const destination = join(root, "apps/server/dist/ai-reply-checker");
  mkdirSync(destination, { recursive: true });
  for (const name of [
    "manifest.json",
    ...names,
    "ownclass-ai-check.cjs.LEGAL.txt",
  ]) {
    if (existsSync(join(output, name)))
      copyFileSync(join(output, name), join(destination, name));
  }
}
console.log(`已生成检查器 ${AI_REPLY_CHECK_VERSION}：${names.join("、")}`);

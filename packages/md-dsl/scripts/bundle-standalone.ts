/**
 * 打包 dsl-kit/tutor-lint.mjs——dsl-kit 一站式分发包自带的可执行校验器。
 * 以 scripts/tutor-lint-standalone.ts 为入口全量打包（remark 系、yaml、zod、
 * @tutor/contract 全部内联），产物为平台无关的单文件 ESM。
 *
 * 由根目录 `pnpm gen:spec` 链末尾调用，产物随仓库提交；CI 的 gen:spec diff
 * 校验同样覆盖这里——改了 linter 或 CLI 而忘记重新打包会被拦下（另有
 * src/cli/standalone.test.ts 冒烟测试保证产物可运行且行为一致）。
 *
 * 确定性：同版本 esbuild + 同输入产出逐字节相同（无时间戳/绝对路径注入，
 * legalComments 固定 eof），满足 CI 的 diff 幂等要求；minify 压缩提交体积。
 */
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, "..", "..", "..", "dsl-kit", "tutor-lint.mjs");

await build({
  entryPoints: [join(here, "tutor-lint-standalone.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "eof",
  // ESM 产物没有 require：bundle 内的 CJS 依赖（yaml 等）运行时会
  // require("process") 等内建模块，注入 createRequire 交给真 require——
  // 与 apps/server 构建的 banner 同一解法（esbuild 的 __require shim 会
  // 优先使用环境里已存在的 require）。
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  outfile,
  logLevel: "warning",
});

const size = (await stat(outfile)).size;
console.log(
  `已打包 ${outfile}（${size} 字节，单文件零依赖，Node ≥20 可直接运行）`,
);

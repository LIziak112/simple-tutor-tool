// 构建后处理：把仓库根 docs/dsl 拷贝到 dist/spec（T1.13）。
// 运行时（node dist/index.js）由 src/spec-files.ts 的目录候选解析到 dist/spec，
// Docker / 生产部署只携带产物（不带仓库源码与 docs/），因此构建产物旁必须带上规范文档：
// - docs/dsl/规范.md、完整样例.md、提示词模板.md、schema/content.json 由 pnpm gen:spec
//   生成（完整样例.md 手写维护），是 /api/public/spec/:file 的数据源；
// - Dockerfile 的 runner 阶段整目录 COPY dist（含 dist/spec），无需额外 COPY 行，
//   但 .dockerignore 必须放行 docs/dsl（构建阶段 server build 需要读取源目录）。
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// apps/server/scripts → 仓库根/docs/dsl
const src = join(here, "..", "..", "..", "docs", "dsl");
const dest = join(here, "..", "dist", "spec");

if (
  !existsSync(join(src, "规范.md")) ||
  !existsSync(join(src, "完整样例.md")) ||
  !existsSync(join(src, "提示词模板.md")) ||
  !existsSync(join(src, "schema", "content.json"))
) {
  // 规范文档随仓库提交，正常不会缺失；缺失说明检出不完整或未跑 pnpm gen:spec
  console.error(`spec 源目录不存在或不完整：${src}（请先运行 pnpm gen:spec）`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`已拷贝 DSL 规范文档：${src} -> ${dest}`);

/**
 * gen:spec 脚本入口（T1.7）：从指令注册表 + lint 规则清单生成
 * docs/dsl/规范.md 与 docs/dsl/提示词模板.md。
 * 运行：根目录 `pnpm gen:spec`（本脚本与 contract 的 export-schema 串联，
 * 一次命令全量刷新规范、提示词模板与 JSON Schema）。
 *
 * - Node 24 原生类型剥离直接运行（相对导入带 .ts 扩展名）；
 * - 渲染逻辑在 src/spec/gen.ts（纯函数、有完整测试），本脚本只负责写盘；
 * - 整体生成保证幂等：同一数据源生成字节相同，CI 用「gen:spec 后
 *   git diff --exit-code」防止忘记重新生成（docs/dsl/完整样例.md 手写维护，不经本脚本）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listDirectives } from "@tutor/contract";
import { LINT_RULES } from "../src/lint/rules.ts";
import {
  renderPromptTemplateMarkdown,
  renderSpecMarkdown,
} from "../src/spec/gen.ts";

const directives = listDirectives();
const rules = LINT_RULES;

const outputs: ReadonlyArray<{
  readonly file: string;
  readonly content: string;
}> = [
  {
    file: "规范.md",
    content: renderSpecMarkdown({ directives, rules }),
  },
  { file: "提示词模板.md", content: renderPromptTemplateMarkdown(directives) },
];

// 输出目录按脚本自身位置定位（../../.. 即仓库根），与运行时 cwd 无关
const outDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "dsl",
);
await mkdir(outDir, { recursive: true });
for (const { file, content } of outputs) {
  await writeFile(join(outDir, file), content, "utf8");
  console.log(`已生成 ${join(outDir, file)}（${content.length} 字符）`);
}
console.log(
  `共 ${directives.length} 个指令、${rules.length} 条 lint 规则；完整样例.md 为手写文件，不在此列`,
);

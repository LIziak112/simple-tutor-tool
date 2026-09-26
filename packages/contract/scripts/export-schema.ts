/**
 * 导出内容契约的 JSON Schema 到 docs/dsl/schema/content.json。
 * 运行：根目录 `pnpm schema:export`（等价于 `pnpm --filter @tutor/contract run export-schema`）。
 *
 * 说明：
 * - 借助 Node 24 的原生 TypeScript 类型剥离直接 `node scripts/export-schema.ts`，零额外依赖；
 * - 生成的 json 属于"提交进仓库的构建产物"：T1.13 的 /api/public/spec/schema.json 与给 AI 的提示词附件直接使用它；
 *   修改 src/content.ts 后必须重新导出并提交（T1.7 起由 CI 的 gen:spec diff 检查兜底）；
 * - 单文件而非按类型拆分：所有契约互相引用（Unit→Question→answers、ParsedDocument→全部），
 *   拆开会产生跨文件 $ref，静态校验与"整份复制给 AI"都不方便，且 /spec 只下发一个 schema.json。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  lectureSchema,
  lintIssueSchema,
  parsedDocumentSchema,
  questionPublicSchema,
  questionSchema,
  unitSchema,
} from "../src/content.ts";

/** 根对象：把每个顶层契约收进一个属性，生成一份自包含（$defs 内部 $ref）的 schema */
const contentContractSchema = z.object({
  lintIssue: lintIssueSchema,
  question: questionSchema,
  questionPublic: questionPublicSchema,
  unit: unitSchema,
  lecture: lectureSchema,
  parsedDocument: parsedDocumentSchema,
});

const jsonSchema = {
  title: "simple-tutor-tool 内容契约（DSL v2）",
  description:
    "题目/单元/讲义/解析结果结构化字段的权威 JSON Schema，由 packages/contract/src/content.ts 经 zod v4 z.toJSONSchema 自动导出。注意：questionPublic 是学生端唯一允许下发的题目形态，不含 answers/solutionMd/hints/sourceMd。",
  ...z.toJSONSchema(contentContractSchema),
};

// 输出目录按脚本自身位置定位（../../.. 即仓库根），与运行时 cwd 无关
const scriptDir = dirname(fileURLToPath(import.meta.url));
const outPath = join(
  scriptDir,
  "..",
  "..",
  "..",
  "docs",
  "dsl",
  "schema",
  "content.json",
);
await mkdir(dirname(outPath), { recursive: true });
const content = `${JSON.stringify(jsonSchema, null, 2)}\n`;
await writeFile(outPath, content, "utf8");
const typeCount = Object.keys(jsonSchema.properties ?? {}).length;
console.log(
  `已导出 ${typeCount} 个顶层契约到 ${outPath}（${content.length} 字符）`,
);

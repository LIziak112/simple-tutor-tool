/**
 * 导出内容契约的 JSON Schema 到 docs/dsl/schema/content.json，
 * 并导出学情数据包契约到 docs/dsl/schema/learning-pack.json（T4.3 扩面，D19）。
 * 运行：根目录 `pnpm schema:export`（等价于 `pnpm --filter @tutor/contract run export-schema`）。
 *
 * 说明：
 * - 借助 Node 24 的原生 TypeScript 类型剥离直接 `node scripts/export-schema.ts`，零额外依赖；
 * - 生成的 json 属于"提交进仓库的构建产物"：T1.13 的 /api/public/spec/schema.json 与给 AI 的提示词附件直接使用它；
 *   修改 src/content.ts 后必须重新导出并提交（T1.7 起由 CI 的 gen:spec diff 检查兜底）；
 * - content.json 单文件而非按类型拆分：所有契约互相引用（Unit→Question→answers、ParsedDocument→全部），
 *   拆开会产生跨文件 $ref，静态校验与"整份复制给 AI"都不方便，且 /spec 只下发一个 schema.json；
 * - learning-pack.json（T4.3）：learningPackJsonSchema() 单一来源生成——教师端导出
 *   zip 内的 schema.json 与本文件逐字节一致（export-service 共用同一函数）；
 *   与 content.json 分开成两个文件：二者消费者不同（内容制作 vs 学情导出），
 *   学情数据包自包含一份 schema 才能整包交给 AI。
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
import {
  learningPackJsonSchema,
  learningPackV2JsonSchema,
} from "../src/learning-pack.ts";

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
const outDir = join(scriptDir, "..", "..", "..", "docs", "dsl", "schema");
await mkdir(outDir, { recursive: true });
const content = `${JSON.stringify(jsonSchema, null, 2)}\n`;
await writeFile(join(outDir, "content.json"), content, "utf8");
const typeCount = Object.keys(jsonSchema.properties ?? {}).length;
console.log(
  `已导出 ${typeCount} 个顶层契约到 ${join(outDir, "content.json")}（${content.length} 字符）`,
);

// 学情数据包契约（T4.3，D19）：learningPackJsonSchema() 与 export-service 共用，
// 保证 docs 产物与 zip 内 schema.json 永不漂移
const packSchema = learningPackJsonSchema();
const packContent = `${JSON.stringify(packSchema, null, 2)}\n`;
await writeFile(join(outDir, "learning-pack.json"), packContent, "utf8");
console.log(
  `已导出学情数据包契约到 ${join(outDir, "learning-pack.json")}（${packContent.length} 字符）`,
);

// 学情数据包 v2（T6R.12 证据装配）：learningPackV2JsonSchema() 同一模式——
// v2 zip 内 schema.json 与本文件逐字节一致；v1/v2 两个文件分开导出，
// 既有 v1 消费方（zip、dsl-kit 校验材料）零变化
const packV2Schema = learningPackV2JsonSchema();
const packV2Content = `${JSON.stringify(packV2Schema, null, 2)}\n`;
await writeFile(join(outDir, "learning-pack-v2.json"), packV2Content, "utf8");
console.log(
  `已导出学情数据包 v2 契约到 ${join(outDir, "learning-pack-v2.json")}（${packV2Content.length} 字符）`,
);

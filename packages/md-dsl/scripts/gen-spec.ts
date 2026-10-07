/**
 * gen:spec 脚本入口（T1.7）：从指令注册表 + lint 规则清单生成
 * docs/dsl/规范.md 与 docs/dsl/提示词模板.md；T4.3 起追加第三个输出
 * docs/dsl/学情分析提示词.md（五种任务目标的完整提示词模板，人读版；
 * T6R.16 增第五目标 per-question-review 逐题评析）；
 * dsl-kit 起（一站式分发包）另把规范三件套 + content.json 同步拷贝进
 * 仓库根 dsl-kit/（README.md / SKILL.md 手写维护，不经本脚本）。
 * 运行：根目录 `pnpm gen:spec`（本脚本与 contract 的 export-schema 串联，
 * 一次命令全量刷新规范、两份提示词模板与 JSON Schema）。
 *
 * - Node 24 原生类型剥离直接运行（相对导入带 .ts 扩展名）；
 * - 渲染逻辑在 src/spec/gen.ts（纯函数、有完整测试），本脚本只负责写盘；
 *   学情分析提示词的模板常量在 @tutor/contract 的 learning-pack.ts
 *   （D17 单一来源：教师端导出 zip 内 prompt.md 与本文档共用同一渲染函数）；
 * - 整体生成保证幂等：同一数据源生成字节相同，CI 用「gen:spec 后
 *   git diff --exit-code」防止忘记重新生成（docs/dsl/完整样例.md 手写维护，不经本脚本）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEARNING_PACK_GOAL_LABELS,
  listDirectives,
  renderLearningPackPrompt,
} from "@tutor/contract";
import { LINT_RULES } from "../src/lint/rules.ts";
import {
  renderPromptTemplateMarkdown,
  renderSpecMarkdown,
} from "../src/spec/gen.ts";

const directives = listDirectives();
const rules = LINT_RULES;

/** 学情分析提示词.md（人读版）：按全模块示例渲染五模板 + 拼装规则说明 */
function renderLearningPackPromptDoc(): string {
  const ALL_MODULES = {
    lectures: true,
    questionLevel: "solution" as const,
    responses: true,
    summaries: true,
    ink: true,
    traces: true,
    anonymized: true,
  };
  // T6R.16：per-question-review（逐题评析）单独用含 evidence+evidencePhases
  // 的 v2 示例输入渲染（它是 v2 专属目标，文档示例展示证据阶段的说明行）；
  // 四个旧模板的示例输入保持现状不变（渲染字节级回归锁在 contract 测试）。
  const V2_REVIEW_MODULES = {
    ...ALL_MODULES,
    evidence: true,
    evidencePhases: ["scratch", "correction", "supplement"] as const,
  };
  const goals = Object.keys(LEARNING_PACK_GOAL_LABELS) as Array<
    keyof typeof LEARNING_PACK_GOAL_LABELS
  >;
  const sections: string[] = [
    [
      "# 学情分析提示词模板（AI 学情数据包）",
      "",
      "> 本文件由 `pnpm gen:spec` 自动生成，请勿手改；模板单一来源在",
      "> `packages/contract/src/learning-pack.ts`（renderLearningPackPrompt）——",
      "> 教师端「导出给 AI」数据包（T4.3）zip 内的 prompt.md 由同一函数按实际勾选",
      "> 模块拼装，与本文件永不漂移。前四个模板按**全模块勾选 + 化名**的示例渲染；",
      "> 实际导出时未勾选的模块（如手写 PNG、讲义）对应说明句不会出现。",
      "",
      "## 用法",
      "",
      "1. 教师端「导出中心」按向导生成数据包（zip：pack.json / summary.md /",
      "   prompt.md / schema.json / 映射.txt〔化名模式〕/ ink/*.png〔勾选〕）；",
      "2. 把整包交给任意 AI 对话（或多模态模型读 ink 图片），prompt.md 已按任务",
      "   目标与勾选模块拼装完毕，无需再手动粘模板；",
      "3. 五种任务目标：诊断薄弱点 / 备下节课讲解建议 / 生成变式练习（输出内容",
      "   DSL v2，可直接回到导入流程）/ 阶段总结（家长沟通）/ 逐题评析（v2 专属，",
      "   需显式选择 v2 数据包并勾选证据附件——结合逐题手写原稿/订正/补充稿图片",
      "   分析书写过程，示例渲染见第五个模板）；教师附加要求在向导第③步填写，",
      "   追加在 prompt.md 的「教师附加要求」段。",
      "",
    ].join("\n"),
  ];
  for (const goal of goals) {
    sections.push(
      `## 模板：${LEARNING_PACK_GOAL_LABELS[goal]}（goal=${goal}）\n`,
    );
    sections.push(
      renderLearningPackPrompt({
        ...(goal === "per-question-review" ? V2_REVIEW_MODULES : ALL_MODULES),
        goal,
      }),
    );
  }
  return `${sections.join("\n")}\n`;
}

const outputs: ReadonlyArray<{
  readonly file: string;
  readonly content: string;
}> = [
  {
    file: "规范.md",
    content: renderSpecMarkdown({ directives, rules }),
  },
  { file: "提示词模板.md", content: renderPromptTemplateMarkdown(directives) },
  { file: "学情分析提示词.md", content: renderLearningPackPromptDoc() },
];

// 输出目录按脚本自身位置定位（../../.. 即仓库根），与运行时 cwd 无关
const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const outDir = join(repoRoot, "docs", "dsl");
await mkdir(outDir, { recursive: true });
for (const { file, content } of outputs) {
  await writeFile(join(outDir, file), content, "utf8");
  console.log(`已生成 ${join(outDir, file)}（${content.length} 字符）`);
}

// dsl-kit 一站式分发包同步：规范三件套 + JSON Schema 复制进仓库根 dsl-kit/
// （README.md 与 SKILL.md 手写维护，不经本脚本；拷贝与 docs/dsl 逐字节一致，
// CI 的 gen:spec diff 校验同样覆盖这里，两边不允许漂移）。
// 完整样例.md 与 schema/content.json 是链路上前序步骤（手写 / export-schema）
// 的产物，从 docs/dsl 读取后原样拷贝；单独运行 gen-spec 时读到的即已提交版本。
const kitDir = join(repoRoot, "dsl-kit");
const kitCopies: ReadonlyArray<{ file: string; content: string }> = [
  { file: "规范.md", content: renderSpecMarkdown({ directives, rules }) },
  {
    file: "提示词模板.md",
    content: renderPromptTemplateMarkdown(directives),
  },
  {
    file: "完整样例.md",
    content: await readFile(join(outDir, "完整样例.md"), "utf8"),
  },
  {
    file: "schema/content.json",
    content: await readFile(join(outDir, "schema", "content.json"), "utf8"),
  },
];
await mkdir(join(kitDir, "schema"), { recursive: true });
for (const { file, content } of kitCopies) {
  await writeFile(join(kitDir, file), content, "utf8");
  console.log(`已同步 ${join(kitDir, file)}（${content.length} 字符）`);
}
console.log(
  `共 ${directives.length} 个指令、${rules.length} 条 lint 规则；完整样例.md 为手写文件，不在此列`,
);

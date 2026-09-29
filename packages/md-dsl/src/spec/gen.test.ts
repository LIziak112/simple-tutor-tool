import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineDirective, listDirectives } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LINT_RULES } from "../lint/rules.ts";
import { renderPromptTemplateMarkdown, renderSpecMarkdown } from "./gen.ts";

/**
 * gen:spec 渲染核心测试（T1.7，测试先行）：
 * - 幂等：同一数据源两次生成字节相同（CI 的 git diff 检查依赖这一点）；
 * - 17 个首发指令全部渲染（名称/description/example/属性表）；
 * - 临时指令测试（验收 2）：defineDirective 动态注册 demo-box 后，
 *   规范文本出现该指令的名称/description/example——临时指令不留在代码里；
 * - 内容抽查：question 属性表含 type 七值、兼容规则三条、lint 错误码清单。
 */

const specDirectives = listDirectives();
const spec = renderSpecMarkdown({
  directives: specDirectives,
  rules: LINT_RULES,
});
const promptDirectives = listDirectives();
const prompt = renderPromptTemplateMarkdown(promptDirectives);

describe("renderSpecMarkdown：稳定性与完整性", () => {
  it("幂等：同一数据源两次生成字节相同", () => {
    const again = renderSpecMarkdown({
      directives: listDirectives(),
      rules: LINT_RULES,
    });
    expect(spec).toBe(again);
    expect(spec.length).toBeGreaterThan(5000);
  });

  it("17 个首发指令全部出现：标题、description、example 完整渲染", () => {
    for (const d of specDirectives) {
      expect(spec).toContain(`### ${d.name}\n`);
      expect(spec).toContain(d.description);
      expect(spec).toContain(d.example);
    }
    // 指令小节标题是独立的「### 名称」整行（二节的题型等小节标题含中文，不匹配）
    expect([...spec.matchAll(/^### ([a-z][a-z0-9-]*)$/gm)]).toHaveLength(17);
  });

  it("question 属性表：type 行含七值与必填标记，difficulty 含缺省 2", () => {
    expect(spec).toContain(
      "| type | judge / choice / multi / fill / solve / apply / find-error | 是 | — |",
    );
    expect(spec).toContain("| difficulty | number | 否 | 2 |");
    expect(spec).toContain("judge 判断 / choice 单选");
  });

  it("兼容规则三条在文中：只增不改 / 别名 / 优雅降级", () => {
    expect(spec).toContain("只增不改");
    expect(spec).toContain("别名");
    expect(spec).toContain("优雅降级");
  });

  it("lint 错误码清单：每个 code 与级别都渲染（说明里的竖线按表格规则转义）", () => {
    for (const rule of LINT_RULES) {
      expect(spec).toContain(`| ${rule.code} |`);
      expect(spec).toContain(rule.description.replaceAll("|", "\\|"));
    }
  });

  it("配套资源一节指向完整样例与 tutor-lint CLI", () => {
    expect(spec).toContain("完整样例.md");
    expect(spec).toContain("pnpm tutor-lint");
    expect(spec).toContain("schema/content.json");
  });

  it("讲义行为描述与实现一致：H1 前正文并入第一篇讲义（内容不丢失），不得出现「会被丢弃」", () => {
    // 回归：v2/lecture.ts 的实际行为是并入第一篇 + CONTENT_BEFORE_FIRST_HEADING 警告，
    // 规范文案曾误写为「会被丢弃」——权威文档不允许与实现相悖
    expect(spec).toContain("并入第一篇讲义");
    expect(spec).not.toContain("会被丢弃");
  });

  it("命名与身份规则一节成文：统一身份表、匹配范围表与配套讲义措辞在文中", () => {
    // 内容模型与导入规范化（task/content-model）：title 字段、unit 缺省文件名、
    // lecture 改称「配套讲义」的指针语义，均须在生成规范中成文
    expect(spec).toContain("### 命名与身份规则");
    expect(spec).toContain(
      "| 题目 | 容器 `id` 属性 | `单元名-序号` | 同 id → 更新（version+1） |",
    );
    expect(spec).toContain(
      "| 单元 | frontmatter `unit:` | 文件名去扩展名 | 同名 → 合并题目 |",
    );
    expect(spec).toContain(
      "| 讲义 | frontmatter `title:`（可选） | 第一个 H1 | 同文件夹同名 → 覆盖正文 |",
    );
    expect(spec).toContain("LECTURE_LINK_UNRESOLVED");
    expect(spec).toContain(
      "| title | 否 | 讲义显示名与导入键（仅单讲义文件生效）；缺省取第一个 H1；",
    );
    expect(spec).toContain("缺省取文件名（去扩展名）");
    expect(spec).toContain("配套讲义的名字");
    // 旧措辞不得回潮
    expect(spec).not.toContain("关联的讲义标题");
  });
});

describe("renderSpecMarkdown：临时指令（验收 2）", () => {
  it("动态注册 demo-box 后，规范文本出现其名称/description/example/属性说明", () => {
    defineDirective({
      name: "demo-box",
      kind: "container",
      since: "2.1",
      allowedIn: ["lecture"],
      attrs: z.strictObject({
        tone: z.enum(["calm", "alert"]).default("calm"),
      }),
      attrDocs: { tone: "语气色调，缺省 calm" },
      description: "临时测试指令：验证 gen:spec 从注册表自动渲染新指令。",
      example: ':::demo-box{tone="alert"}\n内容\n:::',
    });
    const withDemo = renderSpecMarkdown({
      directives: listDirectives(),
      rules: LINT_RULES,
    });
    expect(withDemo).toContain("### demo-box\n");
    expect(withDemo).toContain(
      "临时测试指令：验证 gen:spec 从注册表自动渲染新指令。",
    );
    expect(withDemo).toContain(':::demo-box{tone="alert"}');
    expect(withDemo).toContain("语气色调，缺省 calm");
    expect(withDemo).toContain("calm / alert");
  });
});

describe("renderPromptTemplateMarkdown", () => {
  it("幂等且包含角色设定、占位符、指令速查表、few-shot 与自查清单", () => {
    expect(prompt).toBe(renderPromptTemplateMarkdown(promptDirectives));
    expect(prompt).toContain("出题助手");
    expect(prompt).toContain("{{");
    expect(prompt).toContain("{{知识点}}");
    expect(prompt).toContain("| 指令 |");
    expect(prompt).toContain("自查");
    expect(prompt).toContain("只输出");
  });

  it("few-shot 来自注册表 example：question/example/steps/mark/graph 的样例片段在文中", () => {
    const byName = new Map(listDirectives().map((d) => [d.name, d]));
    for (const name of ["question", "example", "steps", "mark", "graph"]) {
      const d = byName.get(name);
      expect(d, name).toBeDefined();
      expect(prompt).toContain(d?.example ?? "");
    }
  });

  it("临时指令也进入速查表（验收 2 的提示词侧）", () => {
    const withDemo = renderPromptTemplateMarkdown(listDirectives());
    expect(withDemo).toContain("demo-box");
  });
});

describe("生成的规范与磁盘上已提交的版本一致（CI diff 检查的进程内预演）", () => {
  it("docs/dsl/规范.md 与提示词模板.md 是最新生成产物", () => {
    // 用模块顶部缓存的渲染结果（demo-box 注册之前）对比磁盘文件
    const docDir = fileURLToPath(
      new URL("../../../../docs/dsl/", import.meta.url),
    );
    expect(readFileSync(`${docDir}规范.md`, "utf8")).toBe(spec);
    expect(readFileSync(`${docDir}提示词模板.md`, "utf8")).toBe(prompt);
  });
});

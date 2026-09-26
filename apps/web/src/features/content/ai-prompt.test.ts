import { describe, expect, it } from "vitest";
import { AI_PROMPT_KIND_OPTIONS, buildAiPrompt } from "./ai-prompt";

/**
 * "复制给 AI"提示词拼装测试（T1.13）：
 * 三种 kind 的开头文案、主题注入（空主题 → 教师自定）、
 * 三段内容（规范/样例/模板）的拼接顺序、结尾输出要求。
 */

const RULES = "# 内容 DSL v2 规范\n\n| 指令 | 用途 |\n| --- | --- |\n";
const EXAMPLE =
  "# 完整样例\n\n```markdown\n::::question{type=judge}\n判断。\n::::\n```\n";
const TEMPLATE = "# 出题提示词模板\n\n{{学科/年级}}\n";

function build(kind: "practice" | "lecture" | "mixed", topic: string): string {
  return buildAiPrompt({
    kind,
    topic,
    rules: RULES,
    example: EXAMPLE,
    promptTemplate: TEMPLATE,
  });
}

describe("buildAiPrompt（T1.13 一键复制给 AI）", () => {
  it("开头包含角色设定与 kind 中文名：练习 / 讲义 / 混合", () => {
    expect(build("practice", "一元一次方程")).toContain(
      "你是一对一辅导老师的内容助手",
    );
    expect(build("practice", "x")).toContain("生成一份练习");
    expect(build("lecture", "x")).toContain("生成一份讲义");
    expect(build("mixed", "x")).toContain("生成一份混合");
  });

  it("主题注入：填写的主题出现在开头；空/空白主题回退为「教师自定」", () => {
    expect(build("practice", "一元一次方程")).toContain("主题：一元一次方程");
    expect(build("practice", "")).toContain("主题：教师自定");
    expect(build("practice", "   ")).toContain("主题：教师自定");
  });

  it("三段内容按「规范 → 完整样例 → 提示词模板」顺序完整拼入", () => {
    const prompt = build("mixed", "分数运算");
    expect(prompt).toContain(RULES.trim());
    expect(prompt).toContain(EXAMPLE.trim());
    expect(prompt).toContain(TEMPLATE.trim());
    const iRules = prompt.indexOf(RULES.trim());
    const iExample = prompt.indexOf(EXAMPLE.trim());
    const iTemplate = prompt.indexOf(TEMPLATE.trim());
    expect(iRules).toBeGreaterThan(-1);
    expect(iExample).toBeGreaterThan(iRules + RULES.length - 1);
    expect(iTemplate).toBeGreaterThan(iExample + EXAMPLE.length - 1);
    // 每段有分隔标题，方便 AI 与老师阅读
    expect(prompt).toContain("## DSL 规范");
    expect(prompt).toContain("## 完整样例");
    expect(prompt).toContain("## 出题提示词模板");
  });

  it("结尾带输出要求：一个 markdown 代码块、可直接导入", () => {
    const prompt = build("practice", "x");
    const tail = prompt.slice(-120);
    expect(tail).toContain("输出一个 markdown 代码块");
    expect(tail).toContain("可直接导入");
  });

  it("kind 选项恰好三个（练习/讲义/混合），值为 DSL kind", () => {
    expect(AI_PROMPT_KIND_OPTIONS).toEqual([
      { value: "practice", label: "练习" },
      { value: "lecture", label: "讲义" },
      { value: "mixed", label: "混合" },
    ]);
  });
});

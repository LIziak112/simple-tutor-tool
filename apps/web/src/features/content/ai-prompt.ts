/**
 * "AI 出题助手"提示词拼装（T1.13，§5.1 规范文档化：教师端一键复制「规范 + 样例 + 模板」）。
 * 纯函数：不触碰剪贴板、不发请求（三份文档经 /api/public/spec 拉取，
 * 由 TanStack Query 缓存，见 spec-queries.ts；复制交互在 AiPromptPanel 组件处理）。
 */

/** 生成内容的 kind（与 DSL frontmatter 的 kind 取值一致） */
export type AiPromptKind = "practice" | "lecture" | "mixed";

/** 面板上的三选一选项（顺序即展示顺序） */
export const AI_PROMPT_KIND_OPTIONS: ReadonlyArray<{
  value: AiPromptKind;
  label: string;
}> = [
  { value: "practice", label: "练习" },
  { value: "lecture", label: "讲义" },
  { value: "mixed", label: "混合" },
];

/** kind → 中文名（拼进开头一句） */
const KIND_LABELS: Record<AiPromptKind, string> = {
  practice: "练习",
  lecture: "讲义",
  mixed: "混合",
};

export interface AiPromptInput {
  /** 生成内容的 kind */
  kind: AiPromptKind;
  /** 主题/考点（可选；空时提示词里写「教师自定」） */
  topic: string;
  /** DSL 规范全文（/api/public/spec/rules.md） */
  rules: string;
  /** 完整样例全文（/api/public/spec/example.md） */
  example: string;
  /** 出题提示词模板全文（/api/public/spec/prompt.md） */
  promptTemplate: string;
}

/**
 * 组装发给大模型的完整提示词：
 * 开头（角色 + kind + 主题）→ 规范全文 → 完整样例全文 → 提示词模板全文 → 结尾输出要求。
 */
export function buildAiPrompt(input: AiPromptInput): string {
  const topic = input.topic.trim() || "教师自定";
  return [
    `你是一对一辅导老师的内容助手。请按下面的 DSL 规范生成一份${KIND_LABELS[input.kind]}，主题：${topic}。`,
    "",
    "## DSL 规范",
    "",
    input.rules.trim(),
    "",
    "## 完整样例",
    "",
    input.example.trim(),
    "",
    "## 出题提示词模板",
    "",
    input.promptTemplate.trim(),
    "",
    "## 输出要求",
    "",
    "请输出一个 markdown 代码块，可直接导入。",
  ].join("\n");
}

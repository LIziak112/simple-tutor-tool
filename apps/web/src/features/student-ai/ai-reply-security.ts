import type rehypeSanitize from "rehype-sanitize";
import { richMarkdownSanitizeSchema } from "@/features/markdown/sanitize";

/**
 * SAI-21 AI 回复受限渲染的安全单源（B11 先测③）：
 * - 入检 inspectAiReplySafety：字节/公式数量与长度/节点规模超限给可解释
 *   失败（不进解析管线，防超大 KaTeX/Markdown 拖死页面）；
 * - aiReplySanitizeSchema：从 RichMarkdown 白名单派生（KaTeX 放行清单
 *   单源复用），再收紧——去指令宿主标签（交互 directive 不执行）、去 img
 *   （自动远程图片零请求）、href 仅 http/https/mailto（危险协议不落地）。
 * 普通题面 Markdown 不走本模块（RichMarkdown 语义不变，完成条件 2）。
 */

/** 回复渲染字节上限（UTF-8；服务端入库另有 AI_REPLY_MAX_CHARS 上限） */
export const AI_REPLY_RENDER_MAX_BYTES = 128 * 1024;
/** 回复渲染节点规模上限（估算值：行 × 3 + 公式 × 40 + 链接 × 4 + 图片 × 3） */
export const AI_REPLY_RENDER_MAX_NODES = 6000;
/** 单条回复公式数量上限 */
export const AI_REPLY_MAX_FORMULAS = 80;
/** 单个公式长度上限（字符；超长公式按失败处理，不交给 KaTeX） */
export const AI_REPLY_MAX_FORMULA_CHARS = 1000;

export type AiReplySafetyReason =
  | "bytes"
  | "nodes"
  | "formula_count"
  | "formula_size";

export type AiReplySafety =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: AiReplySafetyReason;
      readonly message: string;
    };

/** 行内/块级公式的近似提取（$ 与 $$ 定界；remark-math 同口径） */
function extractFormulas(source: string): string[] {
  const formulas: string[] = [];
  const display = source.match(/\$\$[\s\S]+?\$\$/g) ?? [];
  formulas.push(...display);
  const inline = source.match(/\$[^$\n]+\$/g) ?? [];
  formulas.push(...inline);
  return formulas;
}

/** 节点规模估算（解释性上限：GFM 列表/链接/公式展开后的 DOM 量级） */
function estimateNodes(source: string, formulas: readonly string[]): number {
  const lines = source.split("\n").filter((line) => line.trim() !== "").length;
  const links = (source.match(/\]\(/g) ?? []).length;
  const images = (source.match(/!\[/g) ?? []).length;
  return lines * 3 + formulas.length * 40 + links * 4 + images * 3;
}

/** 渲染前安全入检：超限给可解释失败文案（不区分具体数值，学生可理解） */
export function inspectAiReplySafety(source: string): AiReplySafety {
  if (new TextEncoder().encode(source).length > AI_REPLY_RENDER_MAX_BYTES) {
    return {
      ok: false,
      reason: "bytes",
      message: "这条回复内容过长，已停止显示以保证页面流畅",
    };
  }
  const formulas = extractFormulas(source);
  if (formulas.length > AI_REPLY_MAX_FORMULAS) {
    return {
      ok: false,
      reason: "formula_count",
      message: "这条回复公式过多，已停止显示以保证页面流畅",
    };
  }
  if (formulas.some((formula) => formula.length > AI_REPLY_MAX_FORMULA_CHARS)) {
    return {
      ok: false,
      reason: "formula_size",
      message: "这条回复包含过长公式，已停止显示；可让老师查看原文",
    };
  }
  if (estimateNodes(source, formulas) > AI_REPLY_RENDER_MAX_NODES) {
    return {
      ok: false,
      reason: "nodes",
      message: "这条回复内容过多，已停止显示以保证页面流畅",
    };
  }
  return { ok: true };
}

/** 受限模式额外剥离的标签：指令宿主（交互不执行）与 img（远程像素零请求） */
const RESTRICTED_STRIP_TAGS = new Set([
  "img",
  "directive-container",
  "directive-leaf",
  "directive-text",
]);

/** 清洗 schema 类型：与 sanitize.ts 同款推导（rehype-sanitize v6 无导出） */
type SanitizeSchema = NonNullable<Parameters<typeof rehypeSanitize>[0]>;

/**
 * AI 回复专用清洗 schema：RichMarkdown 白名单的收紧派生——KaTeX 输出放行
 * 清单原样复用（单源），指令宿主与图片剥离，链接协议收窄到 http/https/
 * mailto（javascript:/data: 在清洗层即被丢弃）。
 */
export const aiReplySanitizeSchema: SanitizeSchema = {
  ...richMarkdownSanitizeSchema,
  tagNames: (richMarkdownSanitizeSchema.tagNames ?? []).filter(
    (tag) => !RESTRICTED_STRIP_TAGS.has(tag),
  ),
  attributes: Object.fromEntries(
    Object.entries(richMarkdownSanitizeSchema.attributes ?? {}).filter(
      ([tag]) => !RESTRICTED_STRIP_TAGS.has(tag),
    ),
  ),
  protocols: {
    ...richMarkdownSanitizeSchema.protocols,
    href: ["http", "https", "mailto"],
    src: [],
  },
};

/** Markdown 图片的占位文案（源文本预替换，图片 URL 不进解析管线） */
export const AI_REPLY_IMAGE_PLACEHOLDER = "【图片不显示】";

/** 把 Markdown 图片语法替换为占位说明（远程/本地图片一律不加载） */
export function stripReplyImages(source: string): string {
  return source.replace(/!\[[^\]]*\]\([^)]*\)/g, AI_REPLY_IMAGE_PLACEHOLDER);
}

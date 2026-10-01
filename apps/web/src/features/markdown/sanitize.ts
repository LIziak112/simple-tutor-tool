import type rehypeSanitize from "rehype-sanitize";
import { defaultSchema } from "rehype-sanitize";

/** 清洗 schema 类型：直接从 rehype-sanitize 的入参推导（v6 未在入口导出 Schema 名） */
type SanitizeSchema = NonNullable<Parameters<typeof rehypeSanitize>[0]>;

/**
 * RichMarkdown 的 rehype-sanitize 白名单（T1.8 最大坑位，用 XSS 测试锁定）。
 *
 * 管线顺序：remark → rehype-katex → rehype-sanitize。即 KaTeX 输出也要过
 * 白名单，必须在 defaultSchema 之上放行 KaTeX 的实际产出，否则公式排版
 * 会被静默剥坏（strut 靠内联 style 控制行高、MathML 靠标签结构表达语义、
 * \sqrt 用 svg/path 画根号——以上均已用 katex.renderToString 实测确认）。
 *
 * 同时保持危险内容被清除：script/onerror 等事件属性不在白名单、
 * javascript: 协议被 protocols 拦截、原始 HTML 在 remark-rehype 阶段
 * 已被丢弃（未开 allowDangerousHtml）。sanitize 是纵深防御的第二层。
 */

/** 指令宿主标签（remarkDirectiveHost 注入的 hName，见 remark-directive-host.ts） */
const DIRECTIVE_HOST_TAGS = [
  "directive-container",
  "directive-leaf",
  "directive-text",
] as const;

/**
 * KaTeX MathML 输出涉及的标签（htmlAndMathml 模式）。
 * 列表覆盖 KaTeX 文档声明的全部 MathML 标签，未知表达式也不致剥坏结构。
 */
const KATEX_MATHML_TAGS = [
  "math",
  "semantics",
  "annotation",
  "annotation-xml",
  "mrow",
  "mi",
  "mn",
  "mo",
  "ms",
  "mtext",
  "mspace",
  "mfrac",
  "msqrt",
  "mroot",
  "mstyle",
  "merror",
  "mpadded",
  "mphantom",
  "mfenced",
  "menclose",
  "msub",
  "msup",
  "msubsup",
  "munder",
  "mover",
  "munderover",
  "mmultiscripts",
  "mtable",
  "mtr",
  "mlabeledtr",
  "mtd",
  "maction",
  "mgroupalign",
  "mprescripts",
] as const;

/** KaTeX \sqrt / 大括号等用内联 SVG 绘制的标签 */
const KATEX_SVG_TAGS = ["svg", "path", "g", "line", "rect", "use"] as const;

/** MathML 标签上实际出现的属性（实测 katex 0.18 输出） */
const KATEX_MATHML_ATTRS = [
  "encoding",
  "xmlns",
  "display",
  "displaystyle",
  "scriptlevel",
  "lspace",
  "rspace",
  "voffset",
  "mathvariant",
  "stretchy",
  "fence",
  "separator",
  "columnalign",
  "columnspacing",
  "rowspacing",
  "rowalign",
  "notation",
  "open",
  "close",
  "width",
  "height",
  "depth",
] as const;

/** KaTeX 内联 SVG 上出现的属性 */
const KATEX_SVG_ATTRS = [
  "viewBox",
  "preserveAspectRatio",
  "xmlns",
  "width",
  "height",
  "d",
  "fill",
  "stroke",
  "strokeWidth",
  "points",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
] as const;

/** 指令宿主标签上允许的属性（remarkDirectiveHost 注入 + 指令属性透传） */
const DIRECTIVE_HOST_ATTRS = [
  "directive", // 指令名（刻意避开 sanitize 的 clobber 属性 name/id）
  "dclass", // `{.样式类}` 简写
  "index", // 文档顺序编号（第 N 题 / 提示 N / 第 N 步）
  "dindex", // 文档全局指令序号（T4.0b directive_interact 的 index 口径）
  "title",
  "type",
  "difficulty",
  "knowledge",
  "src",
  "width",
  "fn",
  "range",
  "color",
] as const;

function buildMathmlAttributes(): Record<string, string[]> {
  const entries: Record<string, string[]> = {};
  for (const tag of KATEX_MATHML_TAGS) {
    entries[tag] = [...KATEX_MATHML_ATTRS];
  }
  for (const tag of KATEX_SVG_TAGS) {
    entries[tag] = [...KATEX_SVG_ATTRS];
  }
  return entries;
}

/** RichMarkdown 专用清洗 schema */
export const richMarkdownSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    ...DIRECTIVE_HOST_TAGS,
    ...KATEX_MATHML_TAGS,
    ...KATEX_SVG_TAGS,
  ],
  attributes: {
    ...defaultSchema.attributes,
    // 全局放行 class（KaTeX 的 katex/mord/strut 等大量样式类）、内联 style
    // （strut 高度与垂直对齐）与 aria 标注。style 仅由可信管线产出（rehype-katex），
    // 原始 HTML 已在上游被丢弃，不会把用户输入的 style 放进来。
    "*": [
      ...(defaultSchema.attributes?.["*"] ?? []),
      "className",
      "style",
      "aria-hidden",
      "aria-label",
    ],
    ...buildMathmlAttributes(),
    "directive-container": [...DIRECTIVE_HOST_ATTRS],
    "directive-leaf": [...DIRECTIVE_HOST_ATTRS],
    "directive-text": [...DIRECTIVE_HOST_ATTRS],
    // GFM 任务列表复选框（checked/disabled 由 remark-gfm 生成，不可交互属预期）
    input: [
      ...new Set([
        ...(defaultSchema.attributes?.input ?? []),
        "type",
        "checked",
        "disabled",
      ]),
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    // src（::image 的图片路径等）只允许 http/https 与相对路径（blobs/…），
    // javascript: 等危险协议被拦截；protocols 按属性名而非标签名匹配
    src: [
      ...new Set([...(defaultSchema.protocols?.src ?? []), "http", "https"]),
    ],
  },
};

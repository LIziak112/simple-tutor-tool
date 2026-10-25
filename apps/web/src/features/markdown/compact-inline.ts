/**
 * RichMarkdown 单行收敛形态（compact）的源文降级变换。
 *
 * 场景：错题本紧凑行等行内预览——公式照常 KaTeX 渲染，图片与表格无法在
 * 一行内成立，降级为「[图]」「[表格]」文本占位；块级公式收敛为行内；指令
 * 围栏标记剥离（内容保留并入正文流）。容器收敛样式见 index.css 的
 * .rich-markdown-compact。
 */

/** GFM 表格块（连续以 | 开头的行）→「[表格]」 */
const TABLE_BLOCK = /(?:^[^\S\n]*\|.*(?:\n|$))+/gm;

/** 图片语法 ![alt](src "title") →「[图]」 */
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;

/** 块级公式 $$…$$（含跨行）→ 行内 $…$（KaTeX 照常渲染，只去块级身份） */
const DISPLAY_MATH = /\$\$([\s\S]+?)\$\$/g;

/** 指令围栏行（仅 :::xxx 或 :::）→ 移除（内容保留并入正文流） */
const DIRECTIVE_FENCE_LINE = /^[^\S\n]*:::+[a-zA-Z-]*[^\S\n]*\n?/gm;

export function compactInlineSource(md: string): string {
  return md
    .replace(TABLE_BLOCK, "[表格]\n")
    .replace(IMAGE, "[图]")
    .replace(DISPLAY_MATH, (_, body: string) => `$${body.trim()}$`)
    .replace(DIRECTIVE_FENCE_LINE, "");
}

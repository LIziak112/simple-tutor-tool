import type { LintIssue } from "@tutor/contract";
import type { Root } from "mdast";
import { visit } from "unist-util-visit";
import { makeIssue } from "../v2/shared.ts";

/**
 * 原始 HTML 检查（RAW_HTML）。
 *
 * 动机（2026-10-04 实例：408 王道题库）：AI 生成的题干用原始 HTML 画结点结构表
 * （`<table><tr><td>data</td><td>next</td></tr></table>`）。渲染管线
 * （react-markdown + rehype-sanitize，见 apps/web RichMarkdown）刻意不解析
 * 原始 HTML：块级 HTML 是 CommonMark type-6 HTML 块，连同其后直到下一个
 * 空行的文字合并成一个 html 节点，最终被 sanitize 整体丢弃——页面上不止表格
 * 不显示，其后整句文字也一起消失。行内 HTML（如 <u>）则按纯文本原样显示标签。
 * 本规则在导入前把两种情况都拦成 warning，提示改写。
 *
 * 判定：mdast 的 html 节点（块级与行内原始 HTML 同为该类型）；同一行聚合
 * 为一条 issue（一对开闭标签是两个节点），message 列出该行涉及的所有标签名。
 * HTML 注释（<!-- … -->）有意不报：注释本就不该渲染，是作者注记而非渲染
 * 错误（本项目夹具即以注释做规则头注）。
 *
 * 正确写法：表格用 GFM 管道语法（| data | next | 加分隔行，表格前后各留一个
 * 空行，紧贴上一行会被并入段落、紧贴下一行会吞掉下一行）；其他排版用 DSL
 * 指令（:::tip、::image 等）或 Markdown 语法（**加粗** 等）。代码块与行内
 * 代码里的 HTML 是代码内容，remark 解析为 code/inlineCode 节点，不触发本规则。
 */

/** 从 html 节点原文提取涉及的标签名（开/闭标签同名去重） */
function collectTags(value: string, into: Set<string>): void {
  for (const match of value.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)) {
    const name = match[1];
    if (name !== undefined) {
      into.add(name.toLowerCase());
    }
  }
}

/** 同一行聚合的命中：涉及标签集合与该行首个 html 节点的列 */
interface LineHit {
  readonly tags: Set<string>;
  readonly column: number;
}

/** 扫描全部 html 节点，按行聚合返回 warning 列表（无命中不报） */
export function lintRawHtml(tree: Root): LintIssue[] {
  const byLine = new Map<number, LineHit>();
  visit(tree, "html", (node) => {
    // 注释节点整体跳过（注释内出现 <table> 等字样也不算原始 HTML 内容）
    if (node.value.trimStart().startsWith("<!--")) return;
    const line = node.position?.start.line ?? 1;
    const column = node.position?.start.column ?? 1;
    const hit = byLine.get(line) ?? { tags: new Set<string>(), column };
    collectTags(node.value, hit.tags);
    byLine.set(line, hit);
  });

  const issues: LintIssue[] = [];
  for (const [line, hit] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    const list = [...hit.tags].sort().join("、");
    issues.push({
      ...makeIssue(
        "warning",
        line,
        hit.column,
        "RAW_HTML",
        `本行是原始 HTML（涉及标签 ${list}），渲染时不会生效：渲染管线只解析 Markdown 与 DSL，块级 HTML（如 <table>）连同其后直到下一个空行的文字会在页面上整体消失，行内 HTML 会把标签原样显示成文字。表格请改用 GFM 管道语法（如 | data | next |，表格前后各留一个空行），其他排版请改用 DSL 指令或 Markdown 语法`,
      ),
      fix: "表格改写成 GFM 管道表格（前后留空行）；行内样式改用 **加粗** 等 Markdown 语法或 DSL 指令",
    });
  }
  return issues;
}

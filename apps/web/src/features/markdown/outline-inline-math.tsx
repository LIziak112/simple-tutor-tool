import katex from "katex";
import { Fragment } from "react";

/**
 * 讲义目录行内公式渲染组件（T6R.23 P2-4，修复方案路径 A）：目录条目文本
 * 按 $...$ 切分——公式段用 katex.renderToString 渲染（与正文 remark-math +
 * rehype-katex 同一 katex 实例），非公式段按纯文本渲染，替代原先整段
 * 纯文本输出导致标题公式暴露原始 LaTeX 的问题。
 *
 * 只支持行内 $...$（标题场景不存在 $$ 块级公式），配对规则与正文管线
 * remark-math（micromark-extension-math 的 mathText）对齐：
 * - 开 $ 后、闭 $ 前的空白**不阻断**配对（「价格 $5 和 $10」正文也渲染
 *   「5 和 」为公式，目录必须同口径，两边展示才一致）；
 * - 未配对 $、$$ 连排（无闭合序列）按字面量字符；
 * - 公式语法错误由 throwOnError:false 兜底（KaTeX 输出红色原文，不抛错）。
 */

/** 切分片段：math=true 为公式段（value 已剥除两侧 $ 定界符） */
export interface InlineMathPart {
  readonly value: string;
  readonly math: boolean;
}

/** 把标题文本按行内 $...$ 切分为「文本段 + 公式段」序列 */
export function splitInlineMath(text: string): InlineMathPart[] {
  const parts: InlineMathPart[] = [];
  let plain = "";
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch !== "$") {
      plain += ch;
      i += 1;
      continue;
    }
    // $$ 连排：按两个字面量 $ 处理（remark-math 中无闭合序列，同为字面量）
    if (text.charAt(i + 1) === "$") {
      plain += "$$";
      i += 2;
      continue;
    }
    const close = text.indexOf("$", i + 1);
    // 有配对 $ 即成公式段（内层至少一个字符：close === i+1 已被上面的
    // $$ 连排拦截）；未配对按字面量
    if (close !== -1) {
      if (plain.length > 0) {
        parts.push({ value: plain, math: false });
        plain = "";
      }
      parts.push({ value: text.slice(i + 1, close), math: true });
      i = close + 1;
      continue;
    }
    plain += "$";
    i += 1;
  }
  if (plain.length > 0) parts.push({ value: plain, math: false });
  return parts;
}

/**
 * 目录条目行内渲染：公式段 KaTeX 排版标记、文本段纯文本。
 * 供讲义阅读页 LectureOutline 等目录场景使用（外层容器自带 truncate）。
 */
export function OutlineInlineMath({ text }: { readonly text: string }) {
  const parts = splitInlineMath(text);
  // key＝内容＋出现次序（同文本段可重复出现，下标键被 lint 禁用）
  const keySeen = new Map<string, number>();
  const keyOf = (part: InlineMathPart): string => {
    const base = `${part.math ? "m" : "t"}:${part.value}`;
    const nth = (keySeen.get(base) ?? 0) + 1;
    keySeen.set(base, nth);
    return `${base}#${nth}`;
  };
  return (
    <>
      {parts.map((part) =>
        part.math ? (
          <span
            key={keyOf(part)}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: 内容为 katex.renderToString 输出（trust 默认关闭，非法输入渲染为红色原文而非注入标记），与正文 rehype-katex 产物同源
            dangerouslySetInnerHTML={{
              __html: katex.renderToString(part.value, {
                throwOnError: false,
              }),
            }}
          />
        ) : (
          <Fragment key={keyOf(part)}>{part.value}</Fragment>
        ),
      )}
    </>
  );
}

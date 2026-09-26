/**
 * 讲义自动目录（T2.3，§5.3「自动目录（H2/H3）」）：从讲义 markdown 原文
 * 按行扫描出 H2/H3 标题，供阅读页生成可点击目录。
 *
 * 配对机制：目录条目顺序 = 文档顺序 = <RichMarkdown> 渲染出的 h2/h3 顺序，
 * 点击第 N 项即滚动到正文中第 N 个 h2/h3（见阅读页 scrollToHeading）。
 * 因此扫描必须与 remark 解析口径一致地跳过 fenced code block 内的 `#` 行
 * （remark 里代码块内的 # 不是标题）。ATX 标题（# 前缀）是 DSL 讲义的
 * 规范写法（lint 约束），setext 标题（下划线 ===）不采集。
 */

/** 目录条目：层级（2=H2 / 3=H3）、标题原始文本与列表内稳定标识（React key 用） */
export interface OutlineItem {
  depth: 2 | 3;
  text: string;
  /** 稳定 key：标题文本 + 同名去重序号（标题可能重名，顺序位置本身不可作 key） */
  id: string;
}

/** ATX 标题行：2–3 个 # 后跟空白与标题文本 */
const ATX_HEADING_RE = /^(#{2,3})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/** 标题文本 → 目录条目标识（空格转连字符；同名标题追加出现序号去重） */
function outlineId(text: string, occurrence: number): string {
  const base = `h-${text.replace(/\s+/g, "-")}`;
  return occurrence === 1 ? base : `${base}-${occurrence}`;
}

/**
 * 提取讲义目录（H2/H3）。跳过 fenced code block（``` 或 ~~~ 围栏）内的行；
 * 标题行右侧行尾 # 闭合串（## 标题 ##）按 CommonMark 规则剥除。
 */
export function extractOutline(markdown: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  /** 同名标题出现次数（key 去重用） */
  const seen = new Map<string, number>();
  /** 当前围栏字符（` / ~）；代码块内不出标题 */
  let fence: string | null = null;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const fenceMatch = /^(`{3,}|~{3,})/.exec(rawLine.trimStart());
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      if (fence === null) {
        fence = marker[0] ?? "`";
      } else if (marker[0] === fence) {
        // 同字符围栏闭合（长度 ≥ 开栏长度即视为闭合，CommonMark 放宽口径）
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;
    const heading = ATX_HEADING_RE.exec(rawLine);
    if (heading) {
      const hashes = heading[1] ?? "";
      const text = (heading[2] ?? "").trim();
      if (text.length > 0) {
        const occurrence = (seen.get(text) ?? 0) + 1;
        seen.set(text, occurrence);
        items.push({
          depth: hashes.length === 2 ? 2 : 3,
          text,
          id: outlineId(text, occurrence),
        });
      }
    }
  }
  return items;
}

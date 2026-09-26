import { SKIP, visit } from "unist-util-visit";
import { processor } from "./shared.ts";

/**
 * 题干公开化（T2.4，学生端防泄露的关键一环）：
 * 把题干中的填空/判断标记 `[[参考答案|等价答案…]]` 替换为空标记 `[[]]`，
 * 参考答案文本从此不再随 QuestionPublic.stemMd 下发（学生端 <RichMarkdown> 的
 * remark-blank 对空标记与非空标记渲染相同：下划线空框）。
 *
 * 判定语义与 v2 解析器 scanStem / 前端 remark-blank 完全一致（同一事实来源的
 * 三处消费）：只在 text 节点识别标记，math / inlineMath / code / inlineCode
 * 子树整体跳过——数学环境内的 `[[…]]` 是公式记号（如闭区间 $[[1,2]]$、
 * 下标 $a_{[[1]]}$），不是作答空位，必须原样保留。
 *
 * 实现说明（为什么按「原文行偏移」而不是按解码后的节点值替换）：
 * mdast 会把字符转义（`\*`）与字符引用（`&amp;`）解码进 text 节点的 value，
 * 节点值与原文片段可能不等长，按 value 的匹配下标映射回原文会错位。因此这里
 * 只用 AST 定位 text 节点（及跳过 math/code 子树），标记替换一律作用在节点
 * 对应的**原文片段**上：漏判方向安全（转义拆开的标记本就不构成空位，解析器
 * 也不会把它记进答案），多判方向也只是把非空位渲染成空框，不会泄露答案。
 */
const BLANK_MARKER_RE = /\[\[[^[\]]*\]\]/g;

/** 空填空标记：学生端渲染为下划线空框，不携带任何答案文本 */
const EMPTY_MARKER = "[[]]";

/**
 * 生成学生端公开题干：非数学/代码环境内的全部 `[[…]]` 标记替换为 `[[]]`。
 * 纯函数：无标记时原样返回同一字符串；有标记时返回新字符串（不修改入参）。
 */
export function publicStemMd(stemMd: string): string {
  if (!stemMd.includes("[[")) return stemMd;

  const tree = processor.parse(stemMd);
  // 待替换的原文区间 [start, end)，按出现顺序收集
  const segments: Array<[number, number]> = [];
  // 所有路径显式 return（noImplicitReturns，与 require-student 同理）
  visit(tree, (node): "skip" | undefined => {
    if (
      node.type === "math" ||
      node.type === "inlineMath" ||
      node.type === "code" ||
      node.type === "inlineCode"
    ) {
      return SKIP; // 公式/代码子树整体跳过（与解析器 scanStem 同一语义）
    }
    if (node.type !== "text") return undefined;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return undefined;
    if (!stemMd.slice(start, end).includes("[[")) return undefined;
    segments.push([start, end]);
    return undefined;
  });
  if (segments.length === 0) return stemMd;

  // 从后往前逐段替换，避免前面的改动使后面的偏移失效
  segments.sort((a, b) => b[0] - a[0]);
  let result = stemMd;
  for (const [from, to] of segments) {
    result =
      result.slice(0, from) +
      result.slice(from, to).replace(BLANK_MARKER_RE, EMPTY_MARKER) +
      result.slice(to);
  }
  return result;
}

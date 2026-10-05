import type { ListItem } from "mdast";
import { SKIP, visit } from "unist-util-visit";
import type { Node } from "unist";
import { lineRange, processor } from "./shared.ts";

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

// ---------- 学生端题干投影（2026-10 选项内嵌泄露修复） ----------

/**
 * 任务列表项行首快路径预检：任何行都不形如「列表标记 + [」时必然没有任务列表项
 * （GFM 任务标记必须是项内第一个非空白内容），免解析直接返回。
 * 预检只会多不会少：命中后仍以 AST 判定为准（如 `- [备注]` 普通列表项会被排除）。
 */
const TASK_ITEM_HINT_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[/m;

/** 与解析器 scanStem 同一谓词：listItem.checked 为布尔即 GFM 任务列表项（选择题选项） */
function isTaskListItem(node: Node): node is ListItem {
  return (
    node.type === "listItem" && typeof (node as ListItem).checked === "boolean"
  );
}

/**
 * 剥除题干中的选项任务列表（按 AST 定位，非逐行正则）：
 * - 与解析器抽取 options 的口径完全一致（同一 mdast 谓词），解析器认多少项就剥多少项，
 *   含多行选项的续行——按节点行区间整段删除，杜绝逐行正则漏掉续行的孤儿文本；
 * - 每个被删区间上方紧邻的空行（列表与正文的分隔）一并删除，避免残留连续空行；
 * - 代码块内的 `- [x]`、转义写法 `\- \[x\]` 不是任务列表项，不受影响；
 * - 无任务列表项时原样返回同一字符串。
 * 本函数无条件剥除，调用方负责条件（选项另行渲染/下发时才调用）。
 */
export function stripOptionListMd(stemMd: string): string {
  if (!TASK_ITEM_HINT_RE.test(stemMd)) return stemMd;

  const tree = processor.parse(stemMd);
  const lines = stemMd.split("\n");
  const dropped = new Set<number>(); // 1 起行号
  visit(tree, (node) => {
    if (!isTaskListItem(node)) return undefined;
    const [start, end] = lineRange(node);
    for (let line = start; line <= end; line += 1) dropped.add(line);
    let above = start - 1;
    while (
      above >= 1 &&
      (lines[above - 1] ?? "").trim() === "" &&
      !dropped.has(above)
    ) {
      dropped.add(above);
      above -= 1;
    }
    return undefined;
  });
  if (dropped.size === 0) return stemMd;
  return lines
    .filter((_, index) => !dropped.has(index + 1))
    .join("\n")
    .trim();
}

/** studentStemMd / displayStemMd 的最小输入：Question、冻结快照、DB 投影行皆可 */
export interface StudentStemInput {
  readonly stemMd: string;
  /** 选项（仅 choice/multi 有）：存在即「选项将另行渲染/下发」，题干内嵌列表随之剥除 */
  readonly options?: readonly unknown[];
}

/**
 * 显示侧题干（教师端与学生端 UI 共用）：选项另行渲染时剥掉题干内嵌列表，
 * 不做标记脱敏（[[答案]] 由 remark-blank 统一渲染为空框，原文语义留给教师侧）。
 */
export function displayStemMd(question: StudentStemInput): string {
  return question.options === undefined
    ? question.stemMd
    : stripOptionListMd(question.stemMd);
}

/**
 * 学生端题干唯一投影：剥选项（options 另行下发时）+ [[答案]] → [[]] 脱敏。
 * 学生端一切下发路径（取卷/草稿/结果/错题本/学习包「仅题干」层）都必须且只需
 * 经过本函数——投影后题干不得携带任何可判定答案的标记（`[x]` 任务标记、非空
 * [[…]]），该不变量由 student-stem.test.ts 的 samples 属性测试以解析器为
 * oracle 守卫（AGENTS.md 第 3 条）。
 */
export function studentStemMd(question: StudentStemInput): string {
  return publicStemMd(displayStemMd(question));
}

import { isQuestionContainer, withQuestionId } from "./question.ts";
import { lineRange, processor } from "./shared.ts";

/**
 * 讲练页正文题块定位替换（2026-10 讲练文档 SSOT P1a 的地基）：
 * 题库单题编辑后，把新题目 sourceMd 原位替换回讲义正文对应题块——
 * 讲练页 lectures.markdown 是题块原位真相，回写让题库与正文不再各自漂移。
 *
 * 定位纪律：
 * 1. 只认文档顶层 question 容器的**显式 id 属性**（与解析器提取、切段对位同口径）；
 *    无 id 题块不按缺省序号兜底猜测——序号会因插题/删题漂移，猜错会吞掉别的题；
 * 2. 同 id 容器**恰好一个**才替换；0 个（缺块，存储正文被手工改动等数据异常）
 *    或多个（重复 id）都拒绝，原文逐字返回 replaced:false，交调用方定夺；
 * 3. 替换文本先过 withQuestionId 注入显式 id，保证回写后的题块身份自包含；
 * 4. 行尾保持：纯 CRLF 输入输出仍 CRLF（split/rejoin 对称）；\r\n 与 \n 并存
 *    （或孤立 \r）时 split 行号与解析器 position 行号必然错位，splice 会落错行
 *    （旧围栏残留、相邻段被并吞），按「异常形态不改动」纪律整体拒绝。
 */

/** replaceLessonQuestionBlock 的结果：replaced:false 时 markdown 与输入逐字相同 */
export interface ReplacedLessonBlock {
  readonly markdown: string;
  readonly replaced: boolean;
}

/** 见文件头注释；纯函数、不抛异常，结构性问题一律以 replaced:false 表达 */
export function replaceLessonQuestionBlock(
  markdown: string,
  questionId: string,
  newSourceMd: string,
): ReplacedLessonBlock {
  const tree = processor.parse(markdown);
  const hits = tree.children.filter(
    (child) =>
      isQuestionContainer(child) && child.attributes?.id === questionId,
  );
  const hit = hits.length === 1 ? hits[0] : undefined;
  if (hit === undefined) return { markdown, replaced: false };

  const [start, end] = lineRange(hit);
  // 行尾齐一性：解析器把 \r\n / \n / 孤立 \r 一律计作换行，而下面 split 只按单一
  // eol 切行——两种行尾并存时 split 行号与 AST position 行号错位，按纪律整体拒绝
  const lfCount = [...markdown.matchAll(/\n/g)].length;
  const crlfCount = [...markdown.matchAll(/\r\n/g)].length;
  const loneCrCount = [...markdown.matchAll(/\r/g)].length - crlfCount;
  const loneLfCount = lfCount - crlfCount;
  if (loneCrCount > 0 || (crlfCount > 0 && loneLfCount > 0)) {
    return { markdown, replaced: false };
  }
  const eol = crlfCount > 0 ? "\r\n" : "\n";
  const lines = markdown.split(eol);
  // 新题块可能来自不同行尾的编辑器输入，统一按全文 eol 拼回
  const replacement = withQuestionId(newSourceMd, questionId).split(/\r?\n/);
  lines.splice(start - 1, end - start + 1, ...replacement);
  return { markdown: lines.join(eol), replaced: true };
}

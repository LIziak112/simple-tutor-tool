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
  const located = locateLessonQuestionBlock(markdown, questionId);
  if (located === undefined) return { markdown, replaced: false };
  const { start, end, eol } = located;
  const lines = markdown.split(eol);
  // 新题块可能来自不同行尾的编辑器输入，统一按全文 eol 拼回
  const replacement = withQuestionId(newSourceMd, questionId).split(/\r?\n/);
  lines.splice(start - 1, end - start + 1, ...replacement);
  return { markdown: lines.join(eol), replaced: true };
}

/**
 * 读取讲练页正文中指定题块的原文（updateQuestion 双源漂移守卫用，审查修复 2）：
 * 定位口径与 replaceLessonQuestionBlock 同一出处——只认显式 id、恰一命中才
 * 返回；0 个（缺块）、多个（重复 id）或行尾混杂（行号与 split 必然错位）都
 * 返回 undefined，由调用方按各自口径拒绝。
 */
export function lessonQuestionBlockOf(
  markdown: string,
  questionId: string,
): string | undefined {
  const located = locateLessonQuestionBlock(markdown, questionId);
  if (located === undefined) return undefined;
  const lines = markdown.split(located.eol);
  return lines.slice(located.start - 1, located.end).join(located.eol);
}

/** 题块定位结果：起止行（1 起，含端点）与全文行尾（split/join 对称用） */
interface LessonBlockLocation {
  readonly start: number;
  readonly end: number;
  readonly eol: string;
}

/**
 * 定位指定显式 id 的顶层题块（locate 系共用）：结构异常（无/重复 id/行尾
 * 混杂）一律 undefined，不猜测、不改动——见文件头注释的定位纪律。
 */
function locateLessonQuestionBlock(
  markdown: string,
  questionId: string,
): LessonBlockLocation | undefined {
  const tree = processor.parse(markdown);
  const hits = tree.children.filter(
    (child) =>
      isQuestionContainer(child) && child.attributes?.id === questionId,
  );
  const hit = hits.length === 1 ? hits[0] : undefined;
  if (hit === undefined) return undefined;

  const [start, end] = lineRange(hit);
  // 行尾齐一性：解析器把 \r\n / \n / 孤立 \r 一律计作换行，而 split 只按单一
  // eol 切行——两种行尾并存时 split 行号与 AST position 行号错位，按纪律整体拒绝。
  // 短路判定与原 matchAll 计数逐项等价（Vite 基线目标 Safari 16.4+ 支持后行断言）：
  // 孤立 \r = 存在不后随 \n 的 \r；孤立 \n = 存在前非 \r 的 \n
  const hasCrlf = /\r\n/.test(markdown);
  const hasLoneCr = /\r(?!\n)/.test(markdown);
  const hasLoneLf = /(?<!\r)\n/.test(markdown);
  if (hasLoneCr || (hasCrlf && hasLoneLf)) {
    return undefined;
  }
  return { start, end, eol: hasCrlf ? "\r\n" : "\n" };
}

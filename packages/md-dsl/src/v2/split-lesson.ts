import type { LessonBlock, LintIssue } from "@tutor/contract";
import { isQuestionContainer } from "./question.ts";
import {
  FALLBACK_UNIT_ID,
  firstNonEmpty,
  makeIssue,
  processor,
  sliceRangeExcluding,
} from "./shared.ts";

/**
 * 讲练页切段（2026-10 讲练一体，方案决策 1/2）：
 * 输入是服务端存储的讲义正文（无 frontmatter、题块开围栏已在解析时注入最终
 * 题目 id），按顶层 question 容器切成段落序列——md 段是原文的非题区间（可渲染），
 * question 段只携带题目 id（题目内容由开卷接口的冻结题公开投影下发）。学生侧
 * 安全投影的唯一切段入口：题块原文（含 [[答案]]/:::solution/:::hint）绝不进学生载荷。
 *
 * 约定：
 * 1. 纯函数、不抛异常；问题只记 warning（LESSON_QUESTION_WITHOUT_ID，经可选
 *    issues 旁路输出），不阻断切段；
 * 2. 无 id 的题块按「单元id-序号」兜底对位（序号按全部题块计，与解析器缺省
 *    id 的占号规则一致）；正常导入的讲练页不会出现本情形（解析已注入缺省 id）；
 * 3. md 段去掉首尾空白行后为空时直接跳过（契约 lessonBlockSchema md min(1)，
 *    空段是切段 bug 的信号）；行尾 CRLF 归一为 LF（与解析器切原文同款）。
 */

/** 切段选项 */
export interface SplitLessonBlocksOptions {
  /**
   * 兜底单元名：无 id 题块的缺省 id 前缀（「单元id-序号」）。
   * 缺省用解析器兜底值 unit（与 frontmatter 缺 unit 时的缺省单元 id 同源）。
   */
  readonly unitId?: string | undefined;
  /** issue 旁路输出（无 id 题块记 warning）；不传则只切段 */
  readonly issues?: LintIssue[] | undefined;
}

/**
 * 把讲练页讲义正文切成段落序列（md 段 + 题目槽）。
 * LessonBlock 值形态与契约 lessonBlockSchema 对齐（类型直接取自 @tutor/contract，
 * 单一出处；md-dsl 本就依赖契约，不另建本地定义）。
 */
export function splitLessonBlocks(
  markdown: string,
  options: SplitLessonBlocksOptions = {},
): LessonBlock[] {
  const tree = processor.parse(markdown);
  const lines = markdown.split(/\r?\n/);
  const unitId = firstNonEmpty(options.unitId) ?? FALLBACK_UNIT_ID;

  const blocks: LessonBlock[] = [];
  let cursor = 1; // 下一个 md 段的起始行（1 起）
  let ordinal = 0; // 题块序号（按全部题块计，与解析器缺省 id 占号一致）
  for (const child of tree.children) {
    if (!isQuestionContainer(child)) continue;
    const [startLine, endLine] = [
      child.position?.start.line ?? 1,
      child.position?.end.line ?? 1,
    ];
    pushMdBlock(blocks, lines, cursor, startLine - 1);
    ordinal += 1;
    const id = firstNonEmpty(child.attributes?.id ?? undefined);
    if (id !== undefined) {
      blocks.push({ type: "question", questionId: id });
    } else {
      options.issues?.push(
        makeIssue(
          "warning",
          startLine,
          child.position?.start.column ?? 1,
          "LESSON_QUESTION_WITHOUT_ID",
          `讲练页题目容器没有 id 属性（第 ${startLine} 行）：正常导入的讲练页题目 id 已注入开围栏，出现本 warning 多为存储的讲义正文被手工改动；已按「${unitId}-${ordinal}」兜底对位，请核对与冻结题目集合是否对得上`,
        ),
      );
      blocks.push({
        type: "question",
        questionId: `${unitId}-${ordinal}`,
      });
    }
    cursor = endLine + 1;
  }
  pushMdBlock(blocks, lines, cursor, lines.length);
  return blocks;
}

/** 追加一个 md 段（行区间原文，去首尾空白行）；空段跳过（不产出空 md 段） */
function pushMdBlock(
  blocks: LessonBlock[],
  lines: readonly string[],
  startLine: number,
  endLine: number,
): void {
  const md = sliceRangeExcluding(lines, startLine, endLine, []);
  if (md.length > 0) blocks.push({ type: "md", md });
}

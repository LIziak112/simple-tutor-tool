import type { LintIssue } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { parseDocument } from "./parse.ts";
import { splitLessonBlocks } from "./split-lesson.ts";

/**
 * 讲练页切段测试（2026-10 讲练一体，测试先行）：
 * splitLessonBlocks 的输入是服务端存储的讲义正文（无 frontmatter、题块开围栏
 * 已注入最终题目 id），输出学生侧安全投影用的段落序列——md 段可渲染、
 * question 段只携带题目 id（题块原文绝不出现在学生载荷，方案决策 1）。
 * LessonBlock 值形态与契约 lessonBlockSchema 对齐（类型直接取自契约，单一出处）。
 */

const LESSON_BODY_MD = `# 第1讲 有理数

正文一。

::::question{type=judge id="q-judge"}
$0$ 是最小的正整数。[[错误]]
::::

中间一段。

::::question{type=fill id="q-fill"}
$|-5|=$ [[5]]
::::

结尾正文。`;

describe("splitLessonBlocks：切段", () => {
  it("切段正确：md 段与 question 段按原文顺序交替，md 段不含题块内容", () => {
    const blocks = splitLessonBlocks(LESSON_BODY_MD);
    expect(blocks).toEqual([
      { type: "md", md: "# 第1讲 有理数\n\n正文一。" },
      { type: "question", questionId: "q-judge" },
      { type: "md", md: "中间一段。" },
      { type: "question", questionId: "q-fill" },
      { type: "md", md: "结尾正文。" },
    ]);
    // 安全投影口径：md 段不含题块围栏与 [[答案]] 标记
    for (const block of blocks) {
      if (block.type === "md") {
        expect(block.md).not.toContain("::::question");
        expect(block.md).not.toContain("[[");
      }
    }
  });

  it("多题多段：相邻题块之间不出空 md 段；{#id} 简写同样识别", () => {
    const md = `开头。

::::question{#q1 type=judge}
[[正确]]
::::

::::question{type=judge id="q2"}
[[错误]]
::::

结尾。`;
    expect(splitLessonBlocks(md)).toEqual([
      { type: "md", md: "开头。" },
      { type: "question", questionId: "q1" },
      { type: "question", questionId: "q2" },
      { type: "md", md: "结尾。" },
    ]);
  });

  it("纯文本无题输入：单个 md 段；空白与空串输入返回空数组", () => {
    expect(splitLessonBlocks("# 标题\n\n只有正文。")).toEqual([
      { type: "md", md: "# 标题\n\n只有正文。" },
    ]);
    expect(splitLessonBlocks("   \n\n  ")).toEqual([]);
    expect(splitLessonBlocks("")).toEqual([]);
  });

  it("CRLF 行尾照常切段（md 段换行归一为 LF）", () => {
    const md =
      '# 标题\r\n\r\n正文。\r\n\r\n::::question{type=judge id="q"}\r\n[[正确]]\r\n::::\r\n';
    expect(splitLessonBlocks(md)).toEqual([
      { type: "md", md: "# 标题\n\n正文。" },
      { type: "question", questionId: "q" },
    ]);
  });
});

describe("splitLessonBlocks：无 id 题块兜底", () => {
  it("无 id 按「单元-序号」兜底对位并记 warning；序号按全部题块（含有 id 的）计", () => {
    const md = `正文。

::::question{type=judge id="q1"}
[[正确]]
::::

::::question{type=judge}
[[错误]]
::::
`;
    const issues: LintIssue[] = [];
    const blocks = splitLessonBlocks(md, { unitId: "随堂讲练", issues });
    expect(blocks).toEqual([
      { type: "md", md: "正文。" },
      { type: "question", questionId: "q1" },
      { type: "question", questionId: "随堂讲练-2" },
    ]);
    expect(issues.map((i) => i.code)).toEqual(["LESSON_QUESTION_WITHOUT_ID"]);
    expect(issues[0]?.level).toBe("warning");
    expect(issues[0]?.message).toContain("随堂讲练-2");
  });

  it("未提供 unitId 时用解析器兜底值 unit（与缺省单元 id 同源）", () => {
    const blocks = splitLessonBlocks(
      "::::question{type=judge}\n[[正确]]\n::::",
    );
    expect(blocks).toEqual([{ type: "question", questionId: "unit-1" }]);
  });

  it("不传 issues 时无 id 题块同样兜底对位（warning 为可选旁路输出）", () => {
    const blocks = splitLessonBlocks(
      "::::question{type=judge}\n[[正确]]\n::::",
      { unitId: "随堂讲练" },
    );
    expect(blocks).toEqual([{ type: "question", questionId: "随堂讲练-1" }]);
  });
});

describe("splitLessonBlocks：与解析注入闭环（parse → 讲义 markdown → 切段对位）", () => {
  it("parseDocument 注入的缺省 id 在切段后原样对位（服务端安全投影口径）", () => {
    const doc = `---
kind: lesson
unit: 随堂讲练
---

# 第1讲 有理数

正文一。

::::question{type=judge}
$0$ 是最小的正整数。[[错误]]
::::

正文二。

::::question{type=fill}
$|-5|=$ [[5]]
::::
`;
    const parsed = parseDocument(doc);
    expect(parsed.issues).toEqual([]);
    const questions = parsed.units[0]?.questions ?? [];
    const lectureMd = parsed.lectures[0]?.markdown ?? "";
    const blocks = splitLessonBlocks(lectureMd);
    const questionIds = blocks.flatMap((block) =>
      block.type === "question" ? [block.questionId] : [],
    );
    expect(questionIds).toEqual(questions.map((q) => q.id));
    // md 段不含题块与答案标记（防泄露根基的切段侧口径）
    for (const block of blocks) {
      if (block.type === "md") {
        expect(block.md).not.toContain("[[");
        expect(block.md).not.toContain("::::question");
      }
    }
  });
});

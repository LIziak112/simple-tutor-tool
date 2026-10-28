import { describe, expect, it } from "vitest";
import { replaceLessonQuestionBlock } from "./lesson-block.ts";
import { hasExplicitQuestionId, withQuestionId } from "./question.ts";

/**
 * 讲练题块定位替换测试（2026-10 讲练文档 SSOT，测试先行）：
 * replaceLessonQuestionBlock 是题库单题编辑回写讲义正文的地基（P1a）——
 * 只认显式 id 定位、恰一命中才替换；withQuestionId / hasExplicitQuestionId
 * 的围栏 id 注入语义自 library-service 私有 ensureQuestionId 上移收敛（逐字一致）。
 */

const LESSON_MD = [
  "# 第 1 讲 有理数",
  "",
  "引入段。",
  "",
  '::::question{id="q-1" type=fill difficulty=2}',
  "计算 [[3]]。",
  ":::",
  "::::",
  "",
  "收尾段。",
].join("\n");

describe("withQuestionId / hasExplicitQuestionId", () => {
  it("无属性围栏注入 id；有属性追加 id；已有 id 原样；非容器原样", () => {
    expect(withQuestionId("::::question\n题干\n::::", "q-9")).toBe(
      '::::question{id="q-9"}\n题干\n::::',
    );
    expect(
      withQuestionId("::::question{type=judge}\n题\n::::", "q-9"),
    ).toContain('id="q-9"');
    expect(withQuestionId('::::question{id="q-1"}\n题\n::::', "q-9")).toBe(
      '::::question{id="q-1"}\n题\n::::',
    );
    expect(withQuestionId("普通段落", "q-9")).toBe("普通段落");
    expect(hasExplicitQuestionId('::::question{id="q-1"}')).toBe(true);
    expect(hasExplicitQuestionId("::::question{type=judge}")).toBe(false);
  });

  it("属性未闭合（不以 } 结尾）不改动，交给 lint", () => {
    const broken = "::::question{type=judge\n题\n::::";
    expect(withQuestionId(broken, "q-9")).toBe(broken);
  });

  it("id 排首位紧跟 { 的形态判定为已有 id、不重复注入（tt-07b P2-4 回归位）", () => {
    const idFirst = '::::question{id="q-1" type=judge}\n题\n::::';
    expect(withQuestionId(idFirst, "q-9")).toBe(idFirst);
    expect(hasExplicitQuestionId('::::question{id="q-1" type=judge}')).toBe(
      true,
    );
  });
});

describe("withQuestionId / hasExplicitQuestionId：围栏口径对齐解析器（审查修复 1）", () => {
  it("{#id} 简写视为显式 id：原样返回、判定为 true", () => {
    // remark-directive 把 {#q1} 归一到 attributes.id——注入与判定必须同认
    const shorthand = "::::question{#q1}\n题\n::::";
    expect(withQuestionId(shorthand, "q-9")).toBe(shorthand);
    expect(hasExplicitQuestionId("::::question{#q1}")).toBe(true);
    expect(hasExplicitQuestionId("::::question[标签]{id=q1}")).toBe(true);
  });

  it("[标签] 形态：无花括号把 {id=…} 注入标签后；有花括号在属性串尾部追加", () => {
    expect(withQuestionId("::::question[标签]\n题\n::::", "q-9")).toBe(
      '::::question[标签]{id="q-9"}\n题\n::::',
    );
    expect(
      withQuestionId("::::question[标签]{type=judge}\n题\n::::", "q-9"),
    ).toBe('::::question[标签]{type=judge id="q-9"}\n题\n::::');
    expect(hasExplicitQuestionId("::::question[标签]")).toBe(false);
  });

  it("三/五冒号围栏与解析器同口径识别，冒号前缀原样保留", () => {
    expect(withQuestionId(":::question\n题\n:::", "q-9")).toBe(
      ':::question{id="q-9"}\n题\n:::',
    );
    expect(
      withQuestionId(":::::question{type=judge}\n题\n:::::", "q-9"),
    ).toContain(':::::question{type=judge id="q-9"}');
    expect(hasExplicitQuestionId(":::::question")).toBe(false);
  });

  it("CRLF 首行：剥离尾随 \\r 后判定，注入不再被行尾吞掉", () => {
    expect(withQuestionId("::::question\r\n题干\r\n::::", "q-9")).toBe(
      '::::question{id="q-9"}\n题干\r\n::::',
    );
    expect(
      hasExplicitQuestionId('::::question{id="q-1"}\r\n题干\r\n::::'),
    ).toBe(true);
    expect(
      hasExplicitQuestionId("::::question{type=judge}\r\n题干\r\n::::"),
    ).toBe(false);
  });

  it("行首缩进围栏（解析器容忍 ≤3 空格）同口径识别，缩进保留", () => {
    expect(withQuestionId("  ::::question\n题\n::::", "q-9")).toBe(
      '  ::::question{id="q-9"}\n题\n::::',
    );
  });
});

describe("replaceLessonQuestionBlock", () => {
  const NEW_BLOCK =
    "::::question{type=fill difficulty=2}\n新题干 [[7]]\n:::\n::::";
  // 整文期望（LF）：钉住容器 endLine 边界——闭合围栏行整段换掉，不漏出不并吞
  const EXPECTED_LF = `# 第 1 讲 有理数

引入段。

::::question{type=fill difficulty=2 id="q-1"}
新题干 [[7]]
:::
::::

收尾段。`;
  it("命中替换：注入 id、保留相邻段落与 H1", () => {
    const r = replaceLessonQuestionBlock(LESSON_MD, "q-1", NEW_BLOCK);
    expect(r.replaced).toBe(true);
    // withQuestionId 语义与原 ensureQuestionId 逐字一致：id 追加在属性串尾部
    expect(r.markdown).toContain(
      '::::question{type=fill difficulty=2 id="q-1"}',
    );
    expect(r.markdown).toContain("新题干");
    expect(r.markdown).toContain("引入段。");
    expect(r.markdown).toContain("收尾段。");
    expect(r.markdown).not.toContain("计算 [[3]]");
    expect(r.markdown).toBe(EXPECTED_LF);
  });
  it("id 不存在 → replaced:false 且原文逐字返回", () => {
    const r = replaceLessonQuestionBlock(LESSON_MD, "q-404", NEW_BLOCK);
    expect(r).toEqual({ markdown: LESSON_MD, replaced: false });
  });
  it("无 id 题块不按兜底序号匹配（只认显式 id）", () => {
    const noId = LESSON_MD.replace('id="q-1" ', "");
    expect(
      replaceLessonQuestionBlock(noId, "第1讲-1", NEW_BLOCK).replaced,
    ).toBe(false);
  });
  it("同 id 两块 → replaced:false", () => {
    const dup = `${LESSON_MD}\n\n${LESSON_MD}`;
    expect(replaceLessonQuestionBlock(dup, "q-1", NEW_BLOCK).replaced).toBe(
      false,
    );
  });
  it("CRLF 输入保持 CRLF 输出", () => {
    const r = replaceLessonQuestionBlock(
      LESSON_MD.replace(/\n/g, "\r\n"),
      "q-1",
      NEW_BLOCK,
    );
    expect(r.replaced).toBe(true);
    expect(r.markdown.includes("\r\n")).toBe(true);
    expect(r.markdown).toBe(EXPECTED_LF.replace(/\n/g, "\r\n"));
  });
  it("混合行尾（\\r\\n 与 \\n 并存）→ replaced:false 且原文逐字不变", () => {
    // split 只按单一 eol 切行，与解析器的 position 行号错位，splice 会落错行
    // （旧开围栏残留、相邻段被并吞）——按「异常形态不改动」纪律整体拒绝
    const mixed =
      '# 第 1 讲\r\n\n引入段。\n\n::::question{id="q-1"}\n计算 [[3]]。\n::::\n\n收尾段。';
    expect(replaceLessonQuestionBlock(mixed, "q-1", NEW_BLOCK)).toEqual({
      markdown: mixed,
      replaced: false,
    });
  });
  it("孤立 \\r（无配对 \\n）→ replaced:false 且原文逐字不变", () => {
    // 解析器把孤立 \r 也计作换行（行号比 split 多计一行），同样落错行——拒绝
    const loneCr =
      '# 第 1 讲 有理数\r引入段。\n\n::::question{id="q-1"}\n计算 [[3]]。\n::::\n\n收尾段。';
    expect(replaceLessonQuestionBlock(loneCr, "q-1", NEW_BLOCK)).toEqual({
      markdown: loneCr,
      replaced: false,
    });
  });
});

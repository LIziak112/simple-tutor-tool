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
});

describe("replaceLessonQuestionBlock", () => {
  const NEW_BLOCK =
    "::::question{type=fill difficulty=2}\n新题干 [[7]]\n:::\n::::";
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
  });
});

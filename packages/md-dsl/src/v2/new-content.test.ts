import { describe, expect, it } from "vitest";
import { detectNewContent } from "./new-content.ts";

/**
 * TT-06 新内容检测（NEW_CONTENT_DISABLED 判定面，决策记录 §5.8.4/§12.2-8）。
 *
 * §12.2-8 强制约束的核心场景：一份**纯旧语法**文档（只有 :::answer 等旧指令）
 * 仅凭 type=response/matching/ordering 就必须命中——TT-05a 审查发现按新指令
 * 字面清单判定时该组合可绕过开关进入导入。
 */

const OLD_DOC = [
  "---",
  "kind: practice",
  "unit: 单元",
  "---",
  "",
  "# 标题",
  "",
  "::::question{type=judge}",
  "判断。[[]]",
  "",
  ":::solution",
  "详解。",
  ":::",
  "::::",
].join("\n");

describe("detectNewContent：旧文档零命中（负对照）", () => {
  it("纯旧七型 + 旧指令（question/hint/answer/solution/steps/fold/::image）零标记", () => {
    const md = [
      OLD_DOC.replace("::::question{type=judge}", "::::question{type=judge}"),
      "",
      ":::fold",
      "折叠内容。",
      ":::",
      "",
      "::image{src=\"blobs/media/ab.png\"}",
    ].join("\n");
    expect(detectNewContent(md)).toEqual([]);
  });

  it("代码块与公式里的新语法字面不算命中（展示语法样例不触发开关）", () => {
    const md = [
      OLD_DOC,
      "",
      "```md",
      "::::material{id=mat-1}",
      "{{slot-1}}",
      "::::",
      "```",
      "",
      "$$::ref{material=mat-1}$$",
    ].join("\n");
    expect(detectNewContent(md)).toEqual([]);
  });
});

describe("detectNewContent：新题型枚举（§12.2-8）", () => {
  for (const type of ["response", "matching", "ordering"] as const) {
    it(`纯旧语法文档 + type=${type}（旧式 :::answer）必须命中`, () => {
      const markers = detectNewContent(
        OLD_DOC.replace("type=judge", `type=${type}`).replace(
          "判断。[[]]",
          "作答。",
        ),
      );
      expect(markers).toContainEqual(
        expect.objectContaining({ kind: "question-type", name: type }),
      );
    });
  }

  it("judge/choice 等旧七型零标记（题型维度负对照）", () => {
    for (const type of ["judge", "choice", "multi", "fill", "solve", "apply", "find-error"]) {
      expect(
        detectNewContent(OLD_DOC.replace("type=judge", `type=${type}`)).filter(
          (marker) => marker.kind === "question-type",
        ),
      ).toEqual([]);
    }
  });
});

describe("detectNewContent：新指令与属性（§5.8.4 清单）", () => {
  it("注册表 since 2.1 的指令全部命中（material/seg/ref 等按实际出现判定）", () => {
    const md = [
      OLD_DOC,
      "",
      "::::material{id=mat-1}",
      ":::seg{id=seg-1}",
      "片段。",
      ":::",
      "::::",
    ].join("\n");
    const kinds = detectNewContent(md).map((marker) => marker.name);
    expect(kinds).toContain("material");
    expect(kinds).toContain("seg");
  });

  it("行内 ::ref（跟在文字后）命中——与解析器两路径识别同口径", () => {
    const md = `${OLD_DOC}\n\n引用 ::ref{material=mat-1} 处。`;
    expect(detectNewContent(md).map((m) => m.name)).toContain("ref");
  });

  it("word-min/word-max 属性命中（question-attr）", () => {
    const md = OLD_DOC.replace(
      "type=judge",
      "type=fill word-min=50 word-max=200",
    );
    const names = detectNewContent(md)
      .filter((marker) => marker.kind === "question-attr")
      .map((marker) => marker.name);
    expect(names).toEqual(["word-min", "word-max"]);
  });

  it("材料正文 {{slot}} 槽位标记命中（slot 类，行号定位）", () => {
    const md = [
      OLD_DOC,
      "",
      "::::material{id=mat-1}",
      "文{{slot-1}}空。",
      "::::",
    ].join("\n");
    const markers = detectNewContent(md).filter((marker) => marker.kind === "slot");
    expect(markers).toHaveLength(1);
    expect(markers[0]?.line).toBeGreaterThan(0);
  });
});

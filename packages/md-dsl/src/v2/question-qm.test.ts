import type { ParsedDocument } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { parseDocument } from "./parse.ts";

/**
 * TT-06 题级新结构解析（§5.4.1/§5.4.2）：::ref（块式与行内式）、
 * matching 选项池与行式参考、ordering 项与固定/干扰派生、response 参考
 * 与多参考表达、word-min/word-max；新容器一律不进题干（防泄露边界）。
 *
 * 语法定稿评审事实：`::ref` 行首（块式）经 remark-directive 解析为
 * leafDirective；跟在文字后的行内式（valid-03「第 1 空。::ref{…}」）
 * 是纯文本节点——解析层必须两条路径都识别（语料为准，§5.4）。
 */

function parse(md: string): ParsedDocument {
  return parseDocument(md);
}

const FRONT = "---\nkind: practice\nunit: 单元\n---\n\n# 标题\n\n";

function question(md: string) {
  const doc = parse(`${FRONT}${md}\n`);
  const q = doc.units[0]?.questions[0];
  return { doc, q, issues: doc.issues };
}

describe("题级 ::ref 抽取（块式 + 行内式）", () => {
  it("块式 ref 独占行：整行从题干排除，material/segs/slot/slots 原样保留", () => {
    const { q, issues } = question(
      [
        "::::material{id=mat-1}",
        ":::seg{id=seg-1}",
        "一。",
        ":::",
        ":::seg{id=seg-2}",
        "二。",
        ":::",
        "::::",
        "",
        "::::material{id=mat-2}",
        "备用材料。",
        "::::",
        "",
        "::::question{id=q1 type=response}",
        '::ref{material=mat-1 segs="seg-1..seg-2"}',
        "::ref{material=mat-2}",
        "概括资料。",
        ":::answer",
        "参考。",
        ":::",
        "::::",
      ].join("\n"),
    );
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(q?.materialRefs).toEqual([
      { material: "mat-1", segs: "seg-1..seg-2" },
      { material: "mat-2" },
    ]);
    expect(q?.stemMd).toBe("概括资料。");
  });

  it("行内式 ref（文字后 ::ref{…}，valid-03 形态）：文本节点识别、按出现顺序", () => {
    const { q, issues } = question(
      [
        "::::material{id=mat-1}",
        "文{{slot-1}}空。",
        "::::",
        "",
        "::::question{id=q1 type=choice}",
        "第 1 空。::ref{material=mat-1 slot=slot-1}",
        "",
        "- [ ] 甲",
        "- [x] 乙",
        "::::",
      ].join("\n"),
    );
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(q?.materialRefs).toEqual([{ material: "mat-1", slot: "slot-1" }]);
    // 行内标记保留在题干原文（[[…]] 同款纪律：教师侧原文不动，公开投影剥离）
    expect(q?.stemMd).toContain("第 1 空。::ref{material=mat-1 slot=slot-1}");
    expect(q?.options).toEqual([{ text: "甲" }, { text: "乙" }]);
  });

  it('行内式带引号属性（segs="seg-1..seg-3"）正确解析', () => {
    const { q } = question(
      [
        "::::question{id=q1 type=response}",
        '引用：::ref{material=mat-1 segs="seg-1..seg-3"}',
        ":::answer",
        "参考。",
        ":::",
        "::::",
      ].join("\n"),
    );
    expect(q?.materialRefs).toEqual([
      { material: "mat-1", segs: "seg-1..seg-3" },
    ]);
  });

  it("旧七型无 ref：materialRefs 键不注入（旧题目键集不变）", () => {
    const { q } = question(
      ["::::question{type=judge}", "判断。[[]]", "::::"].join("\n"),
    );
    expect(q && "materialRefs" in q).toBe(false);
  });
});

describe("matching：选项池与行式参考（§5.4.2）", () => {
  const MATCHING = [
    "::::material{id=mat-1}",
    "{{slot-1}}认为甲；{{slot-2}}认为乙。",
    "::::",
    "",
    ":::::question{id=q1 type=matching}",
    "配对。",
    "",
    "::ref{material=mat-1 slots=slot-1..slot-2}",
    "",
    "::::options",
    ":::option{id=opt-1}",
    "甲",
    ":::",
    ":::option{id=opt-2}",
    "乙",
    ":::",
    "::::",
    "",
    ":::answer",
    "slot-1 = opt-1",
    "slot-2 = opt-2",
    ":::",
    ":::::",
  ].join("\n");

  it("选项池抽取（缺省 id、干扰标记透传）；答案行式解析为 pairs", () => {
    const { q, issues } = question(MATCHING);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(q?.matchingOptions).toEqual({
      allowRepeat: false,
      options: [
        { id: "opt-1", text: "甲", distractor: false },
        { id: "opt-2", text: "乙", distractor: false },
      ],
    });
    expect(q?.answers).toEqual({
      kind: "matching",
      pairs: { "slot-1": "opt-1", "slot-2": "opt-2" },
    });
    // options 容器与 answer 不进题干
    expect(q?.stemMd).toBe("配对。");
  });

  it("allow-repeat=true 解析；缺省 option id 走 opt-题目id-序号", () => {
    const { q } = question(
      [
        "::::material{id=mat-1}",
        "{{slot-1}}甲 {{slot-2}}乙。",
        "::::",
        "",
        ":::::question{id=q9 type=matching}",
        "::ref{material=mat-1 slots=slot-1..slot-2}",
        "::::options{allow-repeat=true}",
        ":::option",
        "甲",
        ":::",
        ":::option",
        "乙",
        ":::",
        "::::",
        ":::answer",
        "slot-1 = opt-q9-1",
        "slot-2 = opt-q9-1",
        ":::",
        ":::::",
      ].join("\n"),
    );
    expect(q?.matchingOptions?.allowRepeat).toBe(true);
    expect(q?.matchingOptions?.options.map((o) => o.id)).toEqual([
      "opt-q9-1",
      "opt-q9-2",
    ]);
    expect(q?.answers).toEqual({
      kind: "matching",
      pairs: { "slot-1": "opt-q9-1", "slot-2": "opt-q9-1" },
    });
  });

  it("参考引用未声明 optionId：INVALID_OPTION_REF，结构化答案不落字段", () => {
    const { q, issues } = question(
      [
        ":::::question{id=q1 type=matching}",
        "::ref{material=mat-1 slots=slot-1..slot-2}",
        "::::options",
        ":::option{id=opt-1}",
        "甲",
        ":::",
        ":::option{id=opt-2}",
        "乙",
        ":::",
        "::::",
        ":::answer",
        "slot-1 = opt-9",
        "slot-2 = opt-1",
        ":::",
        ":::::",
      ].join("\n"),
    );
    expect(
      issues.some(
        (i) => i.code === "INVALID_OPTION_REF" && i.level === "error",
      ),
    ).toBe(true);
    expect(q?.answers).toBeUndefined();
  });

  it("option id 重复声明：INVALID_OPTION_REF", () => {
    const { issues } = question(
      [
        ":::::question{id=q1 type=matching}",
        "::::options",
        ":::option{id=opt-1}",
        "甲",
        ":::",
        ":::option{id=opt-1}",
        "乙",
        ":::",
        "::::",
        ":::::",
      ].join("\n"),
    );
    expect(issues.some((i) => i.code === "INVALID_OPTION_REF")).toBe(true);
  });

  it("行式格式不符（非 a = b 行）：INVALID_REFERENCE_ANSWER_FORMAT，答案不落字段", () => {
    const { q, issues } = question(
      [
        ":::::question{id=q1 type=matching}",
        "::::options",
        ":::option{id=opt-1}",
        "甲",
        ":::",
        "::::",
        ":::answer",
        "第一空选 opt-1",
        ":::",
        ":::::",
      ].join("\n"),
    );
    expect(
      issues.some(
        (i) =>
          i.code === "INVALID_REFERENCE_ANSWER_FORMAT" && i.level === "error",
      ),
    ).toBe(true);
    expect(q?.answers).toBeUndefined();
  });
});

describe("ordering：项、固定位与干扰项派生（§5.4.2/§6.1-3）", () => {
  it("行序即正确顺序；fixed 项 fixedPosition 来自参考序列声明位；不在序列即干扰项", () => {
    const { q, issues } = question(
      [
        "::::question{id=px type=ordering}",
        "排序。",
        "",
        ":::item{id=it-1}",
        "尾句。",
        ":::",
        ":::item{id=it-2 fixed=true}",
        "设问句。",
        ":::",
        ":::item{id=it-3 distractor=true}",
        "无关段。",
        ":::",
        ":::item{id=it-4}",
        "第二句。",
        ":::",
        "",
        ":::answer",
        "it-2",
        "it-4",
        "it-1",
        ":::",
        "::::",
      ].join("\n"),
    );
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(q?.answers).toEqual({
      kind: "ordering",
      sequence: ["it-2", "it-4", "it-1"],
    });
    expect(q?.orderingItems).toEqual([
      { id: "it-1", text: "尾句。", fixedPosition: null, distractor: false },
      { id: "it-2", text: "设问句。", fixedPosition: 1, distractor: false },
      {
        id: "it-3",
        text: "无关段。",
        fixedPosition: null,
        distractor: true,
      },
      { id: "it-4", text: "第二句。", fixedPosition: null, distractor: false },
    ]);
    expect(q?.stemMd).toBe("排序。");
  });

  it("参考引用未声明 item id：INVALID_REFERENCE_ANSWER_FORMAT；缺省 id 走 item-题目id-序号", () => {
    const { q, issues } = question(
      [
        "::::question{id=px type=ordering}",
        ":::item",
        "甲项。",
        ":::",
        ":::item",
        "乙项。",
        ":::",
        ":::answer",
        "px",
        "it-px-1",
        ":::",
        "::::",
      ].join("\n"),
    );
    expect(
      issues.some((i) => i.code === "INVALID_REFERENCE_ANSWER_FORMAT"),
    ).toBe(true);
    expect(q?.answers).toBeUndefined();
    expect(q?.orderingItems?.map((i) => i.id)).toEqual([
      "item-px-1",
      "item-px-2",
    ]);
  });
});

describe("response：参考 Markdown、多参考表达与字数提示（§5.4.1/§5.4.2）", () => {
  it(":::answer → referenceMd；:::variant 依次收进 variantsMd；word-min/max 落题面", () => {
    const { q, issues } = question(
      [
        "::::question{id=r1 type=response word-min=150 word-max=250}",
        "概括材料特点。",
        "",
        ":::answer",
        "**要点**：化整为零、公开透明。",
        ":::",
        "",
        ":::variant",
        "另一种组织方式。",
        ":::",
        "",
        ":::variant",
        "第三种表达。",
        ":::",
        "::::",
      ].join("\n"),
    );
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(q?.wordMin).toBe(150);
    expect(q?.wordMax).toBe(250);
    expect(q?.answers).toEqual({
      kind: "response",
      referenceMd: "**要点**：化整为零、公开透明。",
      variantsMd: ["另一种组织方式。", "第三种表达。"],
    });
    expect(q?.stemMd).toBe("概括材料特点。");
  });

  it("无 :::answer 的 response：answers 整体缺省（manual_only 演示，valid-07 zm-2 同款）", () => {
    const { q } = question(
      ["::::question{id=r1 type=response}", "自由作答。", "::::"].join("\n"),
    );
    expect(q?.answers).toBeUndefined();
    expect(q && "variantsMd" in (q.answers ?? {})).toBe(false);
  });
});

describe("新容器不进题干（防泄露边界，任意题型）", () => {
  it("旧题型（solve）内出现 variant/options/item：不进题干也不落结构化字段", () => {
    const { q, issues } = question(
      [
        ":::::question{type=solve}",
        "计算过程。",
        "",
        ":::variant",
        "误写进 solve 的备选参考。",
        ":::",
        "",
        "::::options",
        ":::option{id=opt-1}",
        "误写的选项。",
        ":::",
        "::::",
        "",
        ":::answer",
        "42",
        ":::",
        ":::::",
      ].join("\n"),
    );
    expect(q?.stemMd).toBe("计算过程。");
    expect(q?.answers).toEqual({ kind: "final", answer: "42" });
    expect(q && "matchingOptions" in q).toBe(false);
    expect(q && "orderingItems" in q).toBe(false);
    // 类型-指令错配的严格校验属发布层（§5.3.3 规则 1），lint 层只保证不泄露
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });
});

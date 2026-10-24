import { parseDocument } from "./parse.ts";
import { describe, expect, it } from "vitest";

/**
 * TT-06 两遍解析第二遍：引用解析与结构校验（§5.4.3 静态面全码表）。
 * 经 parseDocument 全链验证（材料/组/题级引用的行号与错误码一起过契约）。
 */

const FRONT = "---\nkind: practice\nunit: 单元\n---\n\n# 标题\n\n";

function errorCodes(md: string): string[] {
  const doc = parseDocument(`${FRONT}${md}\n`);
  return doc.issues.filter((i) => i.level === "error").map((i) => i.code);
}

/** 2 题 + 1 材料 + 1 组引用两题的合法基线（零 error） */
const VALID_BASE = [
  "::::material{id=mat-1}",
  "正文 {{slot-1}} 与 {{slot-2}}。",
  "::::",
  "",
  "::::group{id=grp-1 title=\"组题\"}",
  "::ref{material=mat-1}",
  "::ref{question=q-1}",
  "::ref{question=q-2}",
  "::::",
  "",
  "::::question{id=q-1 type=choice}",
  "第 1 空。::ref{material=mat-1 slot=slot-1}",
  "",
  "- [ ] 甲",
  "- [x] 乙",
  "::::",
  "",
  "::::question{id=q-2 type=choice}",
  "第 2 空。::ref{material=mat-1 slot=slot-2}",
  "",
  "- [x] 丙",
  "- [ ] 丁",
  "::::",
].join("\n");

describe("合法基线（向后引用 + 槽位全覆盖）", () => {
  it("组先声明、题块在后（向后引用合法）；槽位被逐题绑定 → 零 error", () => {
    expect(errorCodes(VALID_BASE)).toEqual([]);
  });

  it("材料/组声明在题块之后同样合法（向后引用双向）", () => {
    const doc = parseDocument(
      `${FRONT}::::question{id=q-1 type=judge}\n判断。[[]]\n::::\n\n::::material{id=mat-1}\n正文。\n::::\n\n::::group{id=grp-1}\n::ref{material=mat-1}\n::ref{question=q-1}\n::::\n`,
    );
    expect(doc.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(doc.units[0]?.materials).toHaveLength(1);
    expect(doc.units[0]?.groups?.[0]?.questionIds).toEqual(["q-1"]);
  });
});

describe("组引用健康（§5.4.3）", () => {
  it("子题不存在：GROUP_MEMBER_NOT_FOUND", () => {
    const codes = errorCodes(
      VALID_BASE.replace("::ref{question=q-2}", "::ref{question=q-404}"),
    );
    expect(codes).toContain("GROUP_MEMBER_NOT_FOUND");
  });

  it("组引用组：GROUP_NESTED_OR_CYCLIC（首版仅一层）", () => {
    const codes = errorCodes(
      VALID_BASE.replace("::ref{question=q-2}", "::ref{question=grp-1}"),
    );
    expect(codes).toContain("GROUP_NESTED_OR_CYCLIC");
  });

  it("同一子题被两组引用 / 组内重复引用：GROUP_MEMBER_DUPLICATED", () => {
    const dupAcross = errorCodes(
      [
        "::::group{id=grp-1}",
        "::ref{question=q-1}",
        "::::",
        "",
        "::::group{id=grp-2}",
        "::ref{question=q-1}",
        "::::",
        "",
        "::::question{id=q-1 type=judge}",
        "判断。[[]]",
        "::::",
      ].join("\n"),
    );
    expect(dupAcross).toContain("GROUP_MEMBER_DUPLICATED");
    const dupInside = errorCodes(
      [
        "::::group{id=grp-1}",
        "::ref{question=q-1}",
        "::ref{question=q-1}",
        "::::",
        "",
        "::::question{id=q-1 type=judge}",
        "判断。[[]]",
        "::::",
      ].join("\n"),
    );
    expect(dupInside).toContain("GROUP_MEMBER_DUPLICATED");
  });

  it("组 questionIds 非单元题序子序列：GROUP_ORDER_INVALID", () => {
    // 文档顺序 q-1、q-2；组引用逆序 q-2 → q-1
    const codes = errorCodes(
      VALID_BASE.replace(
        "::ref{question=q-1}\n::ref{question=q-2}",
        "::ref{question=q-2}\n::ref{question=q-1}",
      ),
    );
    expect(codes).toContain("GROUP_ORDER_INVALID");
  });

  it("组引用未声明材料：UNKNOWN_MATERIAL_REF（题级引用同码）", () => {
    expect(errorCodes(VALID_BASE)).toEqual([]);
    expect(
      errorCodes(VALID_BASE.replace("::ref{material=mat-1}", "::ref{material=mat-404}")),
    ).toContain("UNKNOWN_MATERIAL_REF");
    expect(
      errorCodes(
        VALID_BASE.replace(
          "第 1 空。::ref{material=mat-1 slot=slot-1}",
          "第 1 空。::ref{material=mat-404 slot=slot-1}",
        ),
      ),
    ).toContain("UNKNOWN_MATERIAL_REF");
  });
});

describe("片段锚点校验（§5.2.2 区间语义）", () => {
  const SEG_BASE = [
    "::::material{id=mat-1}",
    ":::seg{id=seg-1}",
    "一。",
    ":::",
    ":::seg{id=seg-2}",
    "二。",
    ":::",
    ":::seg{id=seg-3}",
    "三。",
    ":::",
    "::::",
    "",
    "::::question{id=q-1 type=response}",
    "::ref{material=mat-1 segs=seg-2}",
    "概括。",
    "",
    ":::answer",
    "参考。",
    ":::",
    "::::",
  ].join("\n");

  it("单点 seg-2 引用零告警（invalid-05 对照组）", () => {
    expect(errorCodes(SEG_BASE)).toEqual([]);
  });

  it("segs= 区间端点不存在：SEG_RANGE_OUT_OF_BOUNDS（seg-1..seg-9）", () => {
    expect(
      errorCodes(SEG_BASE.replace("segs=seg-2", "segs=seg-1..seg-9")),
    ).toContain("SEG_RANGE_OUT_OF_BOUNDS");
  });

  it("segs= 区间逆序：SEG_RANGE_OUT_OF_BOUNDS", () => {
    expect(
      errorCodes(SEG_BASE.replace("segs=seg-2", "segs=seg-3..seg-1")),
    ).toContain("SEG_RANGE_OUT_OF_BOUNDS");
  });

  it("segs= 引用不存在的锚点 id：SEG_REF_UNKNOWN", () => {
    expect(
      errorCodes(SEG_BASE.replace("segs=seg-2", "segs=seg-x")),
    ).toContain("SEG_REF_UNKNOWN");
  });

  it("segs= 列表形态：区间 + 单点 + 列表混合合法", () => {
    expect(
      errorCodes(SEG_BASE.replace("segs=seg-2", 'segs="seg-1..seg-2,seg-3"')),
    ).toEqual([]);
  });
});

describe("槽位校验与绑定（§5.2.2）", () => {
  it("slot= 引用不存在的槽位：UNKNOWN_SLOT_REF；合法槽位零告警（invalid-04 语义）", () => {
    const codes = errorCodes(
      VALID_BASE.replace("slot=slot-1}", "slot=slot-99}"),
    );
    expect(codes).toContain("UNKNOWN_SLOT_REF");
    expect(codes).not.toContain("UNKNOWN_MATERIAL_REF");
  });

  it("材料槽位未被绑定：SLOT_UNBOUND", () => {
    const codes = errorCodes(
      VALID_BASE.replace("第 2 空。::ref{material=mat-1 slot=slot-2}", "第 2 空。"),
    );
    expect(codes).toContain("SLOT_UNBOUND");
  });

  it("slots= 区间端点不存在：UNKNOWN_SLOT_REF；合法区间零告警（valid-04 语义）", () => {
    const matchValid = [
      "::::material{id=mat-1}",
      "{{slot-1}}甲 {{slot-2}}乙。",
      "::::",
      "",
      ":::::question{id=q-1 type=matching}",
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
      "slot-1 = opt-1",
      "slot-2 = opt-2",
      ":::",
      ":::::",
    ].join("\n");
    expect(errorCodes(matchValid)).toEqual([]);
    const broken = matchValid.replace(
      "{{slot-1}}甲 {{slot-2}}乙。",
      "{{slot-1}}甲。",
    );
    const codes = errorCodes(broken);
    expect(codes).toContain("UNKNOWN_SLOT_REF");
  });

  it("槽位种类派生：choice 绑定 → choice；matching slots= → match；未绑定 → text", () => {
    const doc = parseDocument(`${FRONT}${VALID_BASE}\n`);
    const slots = doc.units[0]?.materials?.[0]?.slots ?? [];
    expect(slots.map((s) => s.slotKind)).toEqual(["choice", "choice"]);
    const docMatch = parseDocument(
      `${FRONT}::::material{id=mat-1}\n{{slot-1}}甲 {{slot-2}}乙。\n::::\n\n:::::question{id=q-1 type=matching}\n::ref{material=mat-1 slots=slot-1..slot-2}\n::::options\n:::option{id=opt-1}\n甲\n:::\n:::option{id=opt-2}\n乙\n:::\n::::\n:::answer\nslot-1 = opt-1\nslot-2 = opt-2\n:::\n:::::\n`,
    );
    expect(
      docMatch.units[0]?.materials?.[0]?.slots.map((s) => s.slotKind),
    ).toEqual(["match", "match"]);
  });

  it("matching 参考答案槽位侧未知：INVALID_REFERENCE_ANSWER_FORMAT（第二遍收口）", () => {
    const codes = errorCodes(
      [
        "::::material{id=mat-1}",
        "{{slot-1}}甲。",
        "::::",
        "",
        ":::::question{id=q-1 type=matching}",
        "::ref{material=mat-1 slots=slot-1..slot-1}",
        "::::options",
        ":::option{id=opt-1}",
        "甲",
        ":::",
        "::::",
        ":::answer",
        "slot-9 = opt-1",
        ":::",
        ":::::",
      ].join("\n"),
    );
    expect(codes).toContain("INVALID_REFERENCE_ANSWER_FORMAT");
  });
});

describe("防泄露与结构（安全重点）", () => {
  it("材料含答案型内容：MATERIAL_CONTAINS_ANSWER（与引用错误并存不吞）", () => {
    const codes = errorCodes(
      VALID_BASE.replace("正文 {{slot-1}} 与 {{slot-2}}。", "答案 [[甲]]。"),
    );
    expect(codes).toContain("MATERIAL_CONTAINS_ANSWER");
    expect(codes).not.toContain("SLOT_UNBOUND"); // 槽位不存在时不再另报未绑定
  });

  it("材料/组 id 重复：MATERIAL_DUPLICATE_ID（引用仍按首个实体解析）", () => {
    const codes = errorCodes(
      [
        "::::material{id=mat-1}",
        "甲。",
        "::::",
        "",
        "::::material{id=mat-1}",
        "乙。",
        "::::",
        "",
        "::::question{id=q-1 type=judge}",
        "判断。[[]]",
        "::::",
      ].join("\n"),
    );
    expect(codes).toContain("MATERIAL_DUPLICATE_ID");
    expect(codes).not.toContain("UNKNOWN_MATERIAL_REF");
  });
});

import { parseDocument } from "./parse.ts";
import { normalizeQmIds } from "./normalize-ids.ts";
import { describe, expect, it } from "vitest";

/**
 * tt-06b / QM-05 导入规范化回写（§5.2.3 回写=是、§5.2.5-4 只在导入时发生）：
 * 缺省 id（material/group/seg/slot/option/item）在导入时生成并写回源文，
 * 此后 id 显式存在——重排、reparse、编辑、导出重导不重新生成。
 * 约束：AST 定位的行内手术（代码块/公式内的样例文本不动）；已有显式 id 的
 * 实体不改；无任何缺省 id 时原文逐字节不变（changed=false）；幂等（二次
 * 规范化零改动）；规范化后的文档解析出与注入一致的 id。
 */

const DOC = [
  "---",
  "kind: practice",
  "unit: 资料分析",
  "---",
  "",
  "# 资料分析练习",
  "",
  "::::material{title=给定资料}",
  "材料正文，第一空 {{}} 与显式 {{slot-2}}，末尾无号 {{}}。",
  "",
  ":::seg",
  "首段。",
  ":::",
  ":::seg",
  "次段。",
  ":::",
  "::::",
  "",
  "::::group{label=1～5}",
  "组说明。",
  "::ref{material=mat-资料分析-1 slot=slot-1}",
  "::ref{question=q1}",
  "::ref{question=q2}",
  "::::",
  "",
  "::::question{id=q1 type=choice difficulty=2}",
  "::ref{material=mat-资料分析-1 slot=slot-3}",
  "第 1 空 {{}}（题干空位标记，暂不回写）。",
  "",
  "- [ ] 甲",
  "- [x] 乙",
  "::::",
  "",
  "::::question{id=q2 type=matching}",
  "::ref{material=mat-资料分析-1 slots=slot-2}",
  "配对。",
  "",
  "::::options",
  ":::option",
  "选项甲",
  ":::",
  ":::option{id=opt-b}",
  "选项乙",
  ":::",
  "::::",
  "",
  ":::answer",
  "slot-2 = opt-q2-1",
  ":::",
  "::::",
  "",
  "::::question{type=ordering}",
  "排序。",
  "",
  ":::item",
  "甲项",
  ":::",
  ":::item",
  "乙项",
  ":::",
  "",
  ":::answer",
  "item-资料分析-3-2",
  "item-资料分析-3-1",
  ":::",
  "::::",
  "",
].join("\n");

describe("normalizeQmIds（导入规范化回写）", () => {
  it("缺省 id 全类注入：material/group/seg/slot/option/item；显式 id 不改", () => {
    const { markdown, changed } = normalizeQmIds(DOC, {});
    expect(changed).toBe(true);
    // 材料：mat-{unitId}-1 注入既有属性块（保留 title）
    expect(markdown).toContain("::::material{id=mat-资料分析-1 title=给定资料}");
    // 组：grp-{unitId}-1
    expect(markdown).toContain("::::group{id=grp-资料分析-1 label=1～5}");
    // 锚点：seg-1/seg-2（材料内顺序；裸围栏补属性块）
    expect(markdown).toContain(":::seg{id=seg-1}");
    expect(markdown).toContain(":::seg{id=seg-2}");
    // 槽位：空标记按材料内出现顺序编号（第 1 个 → slot-1、第 3 个 → slot-3），
    // 显式 {{slot-2}} 原样
    expect(markdown).toContain(
      "材料正文，第一空 {{slot-1}} 与显式 {{slot-2}}，末尾无号 {{slot-3}}。",
    );
    // 配对选项：opt-{qid}-{n}（第 1 个缺省、第 2 个显式不动）
    expect(markdown).toContain(":::option{id=opt-q2-1}");
    expect(markdown).toContain(":::option{id=opt-b}");
    // 排序项：item-{qid}-{n}（q3 缺省题 id = 资料-…走「单元id-序号」）
    expect(markdown).toContain(":::item{id=item-资料分析-3-1}");
    expect(markdown).toContain(":::item{id=item-资料分析-3-2}");
    // 显式 id 的题（q1/q2）与组内 ::ref 原文不动
    expect(markdown).toContain("::::question{id=q1 type=choice difficulty=2}");
    expect(markdown).toContain("::ref{material=mat-资料分析-1 slot=slot-1}");
    // 题干空位标记（{{}}，题内 scope）不在本版回写范围——保持原样
    expect(markdown).toContain("第 1 空 {{}}（题干空位标记，暂不回写）。");
  });

  it("规范化后解析：注入的 id 与解析产物一致（slot/option/item 引用闭合）", () => {
    const { markdown } = normalizeQmIds(DOC, {});
    const parsed = parseDocument(markdown);
    expect(parsed.issues.filter((i) => i.level === "error")).toEqual([]);
    const unit = parsed.units[0];
    expect(unit?.materials.map((m) => m.id)).toEqual(["mat-资料分析-1"]);
    expect(unit?.materials[0]?.slots.map((s) => s.id)).toEqual([
      "slot-1",
      "slot-2",
      "slot-3",
    ]);
    expect(unit?.materials[0]?.anchors.map((a) => a.id)).toEqual([
      "seg-1",
      "seg-2",
    ]);
    expect(unit?.groups.map((g) => g.id)).toEqual(["grp-资料分析-1"]);
    const q2 = unit?.questions.find((q) => q.id === "q2");
    expect(q2?.matchingOptions?.options.map((o) => o.id)).toEqual([
      "opt-q2-1",
      "opt-b",
    ]);
    const q3 = unit?.questions.find((q) => q.id === "资料分析-3");
    expect(q3?.orderingItems?.map((i) => i.id)).toEqual([
      "item-资料分析-3-1",
      "item-资料分析-3-2",
    ]);
    expect(q3?.answers).toEqual({
      kind: "ordering",
      sequence: ["item-资料分析-3-2", "item-资料分析-3-1"],
    });
  });

  it("幂等：二次规范化零改动（changed=false 且原文相等）", () => {
    const first = normalizeQmIds(DOC, {});
    const second = normalizeQmIds(first.markdown, {});
    expect(second.changed).toBe(false);
    expect(second.markdown).toBe(first.markdown);
  });

  it("全部显式 id 的文档：原文逐字节不变（changed=false）", () => {
    const explicit = DOC.replace(
      "::::material{title=给定资料}",
      "::::material{id=mat-x title=给定资料}",
    ).replace("{{}} 与显式", "{{slot-1}} 与显式")
      .replace("末尾无号 {{}}。", "末尾无号 {{slot-3}}。")
      .replace(":::seg\n首段。", ":::seg{id=seg-1}\n首段。")
      .replace(":::seg\n次段。", ":::seg{id=seg-2}\n次段。")
      .replace("::::group{label=1～5}", "::::group{id=grp-x label=1～5}")
      .replace("::::options\n:::option\n选项甲", "::::options\n:::option{id=opt-a}\n选项甲")
      .replace(":::item\n甲项", ":::item{id=it-1}\n甲项")
      .replace(":::item\n乙项", ":::item{id=it-2}\n乙项");
    const { markdown, changed } = normalizeQmIds(explicit, {});
    expect(changed).toBe(false);
    expect(markdown).toBe(explicit);
  });

  it("代码块与公式内的样例文本不注入（AST 定位，不做文本盲扫）", () => {
    const doc = [
      "---",
      "kind: practice",
      "unit: u1",
      "---",
      "",
      "# 标题",
      "",
      "```md",
      "::::material",
      "样例 {{}} 与 :::seg",
      "```",
      "",
      "公式 $x + {{not-slot}}$。",
      "",
      "::::material",
      "真材料 {{}}。",
      "::::",
      "",
    ].join("\n");
    const { markdown } = normalizeQmIds(doc, {});
    // 代码块三行原样
    expect(markdown).toContain("::::material\n样例 {{}} 与 :::seg");
    // 真材料注入
    expect(markdown).toContain("::::material{id=mat-u1-1}");
    expect(markdown).toContain("真材料 {{slot-1}}。");
  });

  it("frontmatter 缺 unit 时用 fallbackUnitId（与解析同链）", () => {
    const doc = [
      "---",
      "kind: practice",
      "---",
      "",
      "# 标题",
      "",
      "::::material",
      "正文 {{}}。",
      "::::",
      "",
    ].join("\n");
    const { markdown } = normalizeQmIds(doc, { fallbackUnitId: "文件名单元" });
    expect(markdown).toContain("::::material{id=mat-文件名单元-1}");
    expect(markdown).toContain("正文 {{slot-1}}。");
  });
});

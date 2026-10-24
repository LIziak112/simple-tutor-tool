import type { LintIssue } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { extractMaterialsAndGroups } from "./materials.ts";
import { processor } from "./shared.ts";

/**
 * TT-06 材料/组实体抽取（两遍解析第一遍，§5.2.1/§5.2.2/§5.2.3）：
 * - 材料容器 → materialSchema 形态（id 缺省走 contract material.ts 单源、
 *   sourceMd 原文切分、contentMd 容器内部、seg 锚点、{{slot}} 槽位、
 *   ::image 媒体引用收集）；
 * - 组容器 → questionGroupSchema 形态（introMd 排除 ::ref 行、材料引用与
 *   子题引用按书写顺序）；
 * - 重复 id / 首个 H1 之前声明 → MATERIAL_DUPLICATE_ID /
 *   MATERIAL_BEFORE_FIRST_HEADING；
 * - 引用合法性（缺失/跨域/循环/槽位/锚点）在第二遍 references.ts（另测）。
 */

function parse(md: string): {
  materials: ReturnType<typeof extractMaterialsAndGroups>["materials"];
  groups: ReturnType<typeof extractMaterialsAndGroups>["groups"];
  issues: LintIssue[];
} {
  const tree = processor.parse(md);
  const lines = md.split(/\r?\n/);
  const issues: LintIssue[] = [];
  const { materials, groups } = extractMaterialsAndGroups(tree.children, {
    lines,
    unitId: "单元",
    issues,
  });
  return { materials, groups, issues };
}

const HEADING = "# 单元标题";

describe("材料实体抽取（第一遍）", () => {
  it("材料：id/title/contentMd/sourceMd 原文切分，seg 锚点按文档顺序 0 起", () => {
    const { materials, issues } = parse(
      [
        HEADING,
        "",
        '::::material{id=mat-1 title="给定资料"}',
        "第一段正文。",
        "",
        ":::seg{id=seg-a}",
        "锚点甲。",
        ":::",
        "",
        ":::seg{id=seg-b}",
        "锚点乙。",
        ":::",
        "::::",
        "",
      ].join("\n"),
    );
    expect(issues).toEqual([]);
    expect(materials).toHaveLength(1);
    const mat = materials[0];
    expect(mat?.id).toBe("mat-1");
    expect(mat?.title).toBe("给定资料");
    // sourceMd 原样（含围栏与属性），contentMd 为容器内部
    expect(mat?.sourceMd).toContain('::::material{id=mat-1 title="给定资料"}');
    expect(mat?.sourceMd.endsWith("::::")).toBe(true);
    expect(mat?.contentMd).toContain("第一段正文。");
    expect(mat?.contentMd).not.toContain("::::material");
    expect(mat?.anchors).toEqual([
      { id: "seg-a", order: 0 },
      { id: "seg-b", order: 1 },
    ]);
  });

  it("缺省 id：material 走 defaultMaterialIdOf（mat-单元-序号），seg 走 seg-{n}", () => {
    const { materials } = parse(
      [
        HEADING,
        "",
        "::::material{title=无号材料}",
        ":::seg",
        "首锚点。",
        ":::",
        ":::seg",
        "次锚点。",
        ":::",
        "::::",
        "",
      ].join("\n"),
    );
    expect(materials[0]?.id).toBe("mat-单元-1");
    expect(materials[0]?.anchors.map((a) => a.id)).toEqual(["seg-1", "seg-2"]);
  });

  it("槽位标记 {{slot-id}}：文本节点识别、math/code 跳过、缺省 slot-{n}", () => {
    const { materials } = parse(
      [
        HEADING,
        "",
        "::::material{id=mat-1}",
        "文中有{{slot-1}}与 {{slot-2}} 两个空，公式 $x{{not-a-slot}}$ 与代码 `{{no}}` 不识别，无号 {{}} 取缺省。",
        "::::",
        "",
      ].join("\n"),
    );
    const slots = materials[0]?.slots ?? [];
    // slot-1、slot-2 显式；{{}} 缺省编号按出现顺序为 3（前两个显式占 1、2 号位）
    expect(slots.map((s) => s.id)).toEqual(["slot-1", "slot-2", "slot-3"]);
    expect(slots.every((s, i) => s.order === i)).toBe(true);
  });

  it("媒体引用：材料内 ::image src 收集进 mediaPaths（去重、保序）", () => {
    const { materials } = parse(
      [
        HEADING,
        "",
        "::::material{id=mat-1}",
        '::image{src="blobs/media/9af3.png" alt="图一"}',
        "",
        '::image{src="blobs/media/77c2.png"}',
        "",
        '::image{src="blobs/media/9af3.png"}',
        "::::",
        "",
      ].join("\n"),
    );
    expect(materials[0]?.mediaPaths).toEqual([
      "blobs/media/9af3.png",
      "blobs/media/77c2.png",
    ]);
  });

  it("材料正文含答案型内容：MATERIAL_CONTAINS_ANSWER（[[…]]/:::answer/:::solution/:::hint 各报一次）", () => {
    const { materials, issues } = parse(
      [
        HEADING,
        "",
        "::::material{id=mat-1}",
        "答案写这里 [[公有制|全民所有制]]。",
        "",
        ":::solution",
        "解析文字。",
        ":::",
        "",
        ":::hint",
        "提示文字。",
        ":::",
        "",
        ":::answer",
        "最终答案。",
        ":::",
        "::::",
        "",
      ].join("\n"),
    );
    // 实体照常产出（宽松解析），错误阻断交给导入层
    expect(materials).toHaveLength(1);
    const codes = issues.filter((i) => i.code === "MATERIAL_CONTAINS_ANSWER");
    // 四类各一处：标记 1 + solution + hint + answer
    expect(codes).toHaveLength(4);
    expect(issues.every((i) => i.level === "error")).toBe(true);
    expect(codes.some((i) => i.line === 4)).toBe(true); // [[…]] 在第 4 行
  });

  it("材料 id 重复与材料内锚点 id 重复：MATERIAL_DUPLICATE_ID", () => {
    const { issues } = parse(
      [
        HEADING,
        "",
        "::::material{id=mat-1}",
        "甲。",
        "::::",
        "",
        "::::material{id=mat-1}",
        "乙。",
        "::::",
        "",
        "::::material{id=mat-2}",
        ":::seg{id=s}",
        "一。",
        ":::",
        ":::seg{id=s}",
        "二。",
        ":::",
        "::::",
        "",
      ].join("\n"),
    );
    const codes = issues.filter((i) => i.code === "MATERIAL_DUPLICATE_ID");
    expect(codes).toHaveLength(2); // 材料级 1 + 锚点级 1
    expect(codes.every((i) => i.level === "error")).toBe(true);
  });

  it("材料在首个 H1 之前：MATERIAL_BEFORE_FIRST_HEADING（组同规则；H1 后合法）", () => {
    const before = parse(
      [
        "::::material{id=mat-0}",
        "太早了。",
        "::::",
        "",
        HEADING,
        "",
        "::::material{id=mat-1}",
        "合法。",
        "::::",
        "",
        "::::group{id=grp-0}",
        "::ref{question=q-1}",
        "::::",
        "",
        HEADING,
        "第二个标题",
        "",
      ].join("\n"),
    );
    const codes = before.issues.filter(
      (i) => i.code === "MATERIAL_BEFORE_FIRST_HEADING",
    );
    expect(codes).toHaveLength(1); // 仅 mat-0；grp-0 在首个 H1 之后
    expect(codes[0]?.line).toBe(1);
  });
});

describe("组实体抽取（第一遍）", () => {
  it("组：introMd 排除 ::ref 行，材料引用与子题引用按书写顺序收集", () => {
    const { groups, issues } = parse(
      [
        HEADING,
        "",
        '::::group{id=grp-1 title="同一段材料" label="1～2"}',
        "请阅读材料后作答。",
        "",
        "::ref{material=mat-1}",
        "::ref{question=q-1}",
        '::ref{material=mat-2 segs="seg-1..seg-2"}',
        "::ref{question=q-2}",
        "::::",
        "",
      ].join("\n"),
    );
    expect(issues).toEqual([]);
    const grp = groups[0];
    expect(grp?.id).toBe("grp-1");
    expect(grp?.title).toBe("同一段材料");
    expect(grp?.label).toBe("1～2");
    expect(grp?.introMd).toBe("请阅读材料后作答。");
    expect(grp?.materialRefs).toEqual([
      { material: "mat-1" },
      { material: "mat-2", segs: "seg-1..seg-2" },
    ]);
    expect(grp?.questionIds).toEqual(["q-1", "q-2"]);
    expect(grp?.sourceMd).toContain("::ref{question=q-1}");
  });

  it("缺省组 id：grp-单元-序号；组 id 重复报 MATERIAL_DUPLICATE_ID", () => {
    const { groups, issues } = parse(
      [
        HEADING,
        "",
        "::::group",
        "::ref{question=q-1}",
        "::::",
        "",
        "::::group",
        "::ref{question=q-2}",
        "::::",
        "",
      ].join("\n"),
    );
    expect(groups.map((g) => g.id)).toEqual(["grp-单元-1", "grp-单元-2"]);
    expect(issues.filter((i) => i.code === "MATERIAL_DUPLICATE_ID")).toEqual(
      [],
    );
    const dup = parse(
      [
        HEADING,
        "",
        "::::group{id=g}",
        "::ref{question=q-1}",
        "::::",
        "",
        "::::group{id=g}",
        "::ref{question=q-2}",
        "::::",
        "",
      ].join("\n"),
    );
    expect(
      dup.issues.filter((i) => i.code === "MATERIAL_DUPLICATE_ID"),
    ).toHaveLength(1);
  });

  it("旧文档零影响：无材料/组容器时产出空数组、零 issue", () => {
    const { materials, groups, issues } = parse(
      [HEADING, "", "::::question{type=judge}", "判断。[[]]", "::::", ""].join(
        "\n",
      ),
    );
    expect(materials).toEqual([]);
    expect(groups).toEqual([]);
    expect(issues).toEqual([]);
  });
});

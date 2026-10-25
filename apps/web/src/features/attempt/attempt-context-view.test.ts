import type {
  AttemptContextData,
  AttemptContextGroup,
  AttemptContextMaterial,
} from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { groupSegmentsOfUnit, questionMaterialsOf } from "./attempt-context-view";
import { materialVersionKey } from "./MaterialPanel";

/**
 * TT-08a / QM-08 共用数据解释模型测试：/attempts/:id/context 冻结投影 →
 * 单元组段（solo / group）——作答视图与结果回看共用同一解释（教师预览走
 * markdown 管线，语义同源于契约投影）。
 */

function material(
  id: string,
  overrides: Partial<AttemptContextMaterial> = {},
): AttemptContextMaterial {
  return {
    id,
    contentMd: `材料 ${id} 正文。`,
    anchors: [],
    slots: [],
    mediaPaths: [],
    sourceVersion: 1,
    ...overrides,
  };
}

function group(
  id: string,
  overrides: Partial<AttemptContextGroup> = {},
): AttemptContextGroup {
  return {
    id,
    introMd: "",
    materialRefs: [],
    questionIds: [],
    sourceVersion: 1,
    ...overrides,
  };
}

function context(
  materials: readonly AttemptContextMaterial[],
  groups: readonly AttemptContextGroup[],
): AttemptContextData {
  return {
    attemptId: "attempt-1",
    materials: [...materials],
    groups: [...groups],
  };
}

describe("groupSegmentsOfUnit（共用数据解释）", () => {
  it("无上下文（legacy 卷）→ 全部 solo 段，零结构变化", () => {
    expect(groupSegmentsOfUnit(undefined, ["q1", "q2"])).toEqual([
      { kind: "solo", questionIds: ["q1", "q2"] },
    ]);
  });

  it("无组快照 → 全部 solo 段", () => {
    expect(groupSegmentsOfUnit(context([material("m1")], []), ["q1"])).toEqual([
      { kind: "solo", questionIds: ["q1"] },
    ]);
  });

  it("空题目列表 → 零段", () => {
    expect(groupSegmentsOfUnit(context([], []), [])).toEqual([]);
    expect(
      groupSegmentsOfUnit(
        context([], [group("g1", { questionIds: ["q1"] })]),
        [],
      ),
    ).toEqual([]);
  });

  it("组内子题成一段：组块含材料解析与卷内成员序", () => {
    const ctx = context(
      [material("m1"), material("m2")],
      [
        group("g1", {
          title: "资料分析",
          materialRefs: [{ material: "m1" }, { material: "m2" }],
          questionIds: ["q2", "q3"],
        }),
      ],
    );
    const segments = groupSegmentsOfUnit(ctx, ["q1", "q2", "q3"]);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ kind: "solo", questionIds: ["q1"] });
    const groupSegment = segments[1];
    expect(groupSegment?.kind).toBe("group");
    if (groupSegment?.kind !== "group") return;
    expect(groupSegment.group.id).toBe("g1");
    expect(groupSegment.questionIds).toEqual(["q2", "q3"]);
    expect(groupSegment.materials.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("组块插在首位成员处一次，后置独立题保持 solo（组不重复出现）", () => {
    const ctx = context(
      [material("m1")],
      [
        group("g1", {
          materialRefs: [{ material: "m1" }],
          questionIds: ["q1"],
        }),
      ],
    );
    const segments = groupSegmentsOfUnit(ctx, ["q1", "q2", "q3"]);
    expect(segments).toEqual([
      {
        kind: "group",
        group: ctx.groups[0],
        materials: [ctx.materials[0]],
        questionIds: ["q1"],
      },
      { kind: "solo", questionIds: ["q2", "q3"] },
    ]);
  });

  it("成员不在本卷（wrong 剔除/跨单元）→ 只按卷内成员成段，空成员组不渲染", () => {
    const ctx = context(
      [material("m1")],
      [
        group("g1", {
          materialRefs: [{ material: "m1" }],
          questionIds: ["q9"],
        }),
        group("g2", { questionIds: ["q1"] }),
      ],
    );
    // g1 无卷内成员不渲染；g2 成员 q1 在卷内但零材料 → 仍渲染组块（materials 空）
    const segments = groupSegmentsOfUnit(ctx, ["q1", "q2"]);
    expect(segments).toEqual([
      {
        kind: "group",
        group: ctx.groups[1],
        materials: [],
        questionIds: ["q1"],
      },
      { kind: "solo", questionIds: ["q2"] },
    ]);
  });

  it("同 id 多版本条目（wrong 双版本边界）→ 组每 id 一段取最高冻结版；材料全版本分别保留不按 materialId 覆盖（QM-15 细项 4）", () => {
    const ctx = context(
      [
        material("m1", { sourceVersion: 1 }),
        material("m1", { sourceVersion: 2, contentMd: "v2 正文" }),
      ],
      [
        group("g1", { sourceVersion: 1, questionIds: ["q1"] }),
        group("g1", {
          sourceVersion: 3,
          materialRefs: [{ material: "m1" }],
          questionIds: ["q1"],
        }),
      ],
    );
    const segments = groupSegmentsOfUnit(ctx, ["q1"]);
    expect(segments).toHaveLength(1);
    const groupSegment = segments[0];
    expect(groupSegment?.kind).toBe("group");
    if (groupSegment?.kind !== "group") return;
    expect(groupSegment.group.sourceVersion).toBe(3);
    // 材料双版本全量保留（引用序内版本升序），不取最高覆盖旧版
    expect(
      groupSegment.materials.map(
        (m) => `${materialVersionKey(m)}:${m.contentMd}`,
      ),
    ).toEqual(["m1|1:材料 m1 正文。", "m1|2:v2 正文"]);
  });

  it("组材料引用缺快照条目（防御：闭包保证外的坏数据）→ 跳过该材料不崩溃", () => {
    const ctx = context(
      [material("m1")],
      [
        group("g1", {
          materialRefs: [{ material: "m1" }, { material: "m-missing" }],
          questionIds: ["q1"],
        }),
      ],
    );
    const segments = groupSegmentsOfUnit(ctx, ["q1"]);
    const groupSegment = segments[0];
    expect(groupSegment?.kind).toBe("group");
    if (groupSegment?.kind !== "group") return;
    expect(groupSegment.materials.map((m) => m.id)).toEqual(["m1"]);
  });

  it("组间穿插：两个组各成一段，中间独立题归 solo（成员区间内非成员题随段渲染）", () => {
    const ctx = context(
      [material("m1"), material("m2")],
      [
        group("g1", {
          materialRefs: [{ material: "m1" }],
          questionIds: ["q1"],
        }),
        group("g2", {
          materialRefs: [{ material: "m2" }],
          questionIds: ["q3"],
        }),
      ],
    );
    const segments = groupSegmentsOfUnit(ctx, ["q1", "q2", "q3"]);
    expect(segments.map((s) => s.kind)).toEqual(["group", "solo", "group"]);
    expect(segments[1]).toEqual({ kind: "solo", questionIds: ["q2"] });
  });

  it("一题属多组（数据异常防御）→ 按稳定序（id）首个组收编，判定确定", () => {
    const ctx = context(
      [material("m1")],
      [
        group("g1", {
          materialRefs: [{ material: "m1" }],
          questionIds: ["q1"],
        }),
        group("g2", { questionIds: ["q1"] }),
      ],
    );
    const segments = groupSegmentsOfUnit(ctx, ["q1", "q2"]);
    const groupSegment = segments[0];
    expect(groupSegment?.kind).toBe("group");
    if (groupSegment?.kind !== "group") return;
    expect(groupSegment.group.id).toBe("g1");
    expect(groupSegment.questionIds).toEqual(["q1"]);
  });

  it("成员区间内夹非成员题（子序列允许的空洞）→ 随组段渲染不拆组块", () => {
    const ctx = context(
      [material("m1")],
      [
        group("g1", {
          materialRefs: [{ material: "m1" }],
          questionIds: ["q1", "q3"],
        }),
      ],
    );
    const segments = groupSegmentsOfUnit(ctx, ["q1", "q2", "q3"]);
    expect(segments).toHaveLength(1);
    const groupSegment = segments[0];
    expect(groupSegment?.kind).toBe("group");
    if (groupSegment?.kind !== "group") return;
    // 区间内题全部归组段（q2 虽非成员但夹在首尾成员之间；真实语料成员连续，
    // 此规则保证一组一块不重开）
    expect(groupSegment.questionIds).toEqual(["q1", "q2", "q3"]);
  });
});

describe("questionMaterialsOf（题级材料单源，P1-2）", () => {
  it("题级引用 → 冻结材料全版本（引用序、版本升序）；无引用/无上下文 → 空", () => {
    const ctx = context(
      [
        material("m-solo", { sourceVersion: 1 }),
        material("m-solo", { sourceVersion: 2, contentMd: "二版正文" }),
        material("m-other"),
      ],
      [],
    );
    const refs = [{ material: "m-solo" }, { material: "m-missing" }];
    expect(
      questionMaterialsOf(ctx, { materialRefs: refs }).map(
        (m) => `${materialVersionKey(m)}:${m.contentMd}`,
      ),
    ).toEqual(["m-solo|1:材料 m-solo 正文。", "m-solo|2:二版正文"]);
    expect(questionMaterialsOf(ctx, {})).toEqual([]);
    expect(
      questionMaterialsOf(undefined, { materialRefs: refs }),
    ).toEqual([]);
  });

  it("同 id 重复引用去重（不翻倍）；引用缺快照条目跳过不崩溃", () => {
    const ctx = context([material("m1")], []);
    const refs = [{ material: "m1" }, { material: "m1" }];
    expect(questionMaterialsOf(ctx, { materialRefs: refs })).toHaveLength(1);
    expect(
      questionMaterialsOf(ctx, { materialRefs: [{ material: "m-none" }] }),
    ).toEqual([]);
  });
});

describe("groupSegmentsOfUnit 组∪题级闭包（P1-2：与 frozenMaterialsForQuestion 同源口径）", () => {
  it("组段材料并入成员题级引用：组引用先、题级后去重；缺 refs 映射零变化", () => {
    const ctx = context(
      [material("m-grp"), material("m-q", { contentMd: "题级材料正文" })],
      [
        group("g1", {
          materialRefs: [{ material: "m-grp" }],
          questionIds: ["q1", "q2"],
        }),
      ],
    );
    const questionRefs = new Map([
      ["q1", [{ material: "m-q" }]],
      ["q2", [{ material: "m-grp" }]], // 与组重复 → 去重
    ]);
    const segments = groupSegmentsOfUnit(ctx, ["q1", "q2"], questionRefs);
    const groupSegment = segments[0];
    expect(groupSegment?.kind).toBe("group");
    if (groupSegment?.kind !== "group") return;
    expect(groupSegment.materials.map((m) => m.id)).toEqual(["m-grp", "m-q"]);
    // 不传第三参：既有两参调用零变化（旧视图/旧测试口径）
    expect(
      groupSegmentsOfUnit(ctx, ["q1", "q2"]).map((s) =>
        s.kind === "group" ? s.materials.map((m) => m.id) : null,
      ),
    ).toEqual([["m-grp"]]);
  });

  it("题级引用映射里的非本组/缺席题不进本组材料（只收编本段成员）", () => {
    const ctx = context(
      [material("m1"), material("m-solo")],
      [group("g1", { questionIds: ["q1"] })],
    );
    const questionRefs = new Map([
      ["q1", [{ material: "m1" }]],
      ["q2", [{ material: "m-solo" }]], // solo 题：不进 g1 组段
    ]);
    const segments = groupSegmentsOfUnit(ctx, ["q1", "q2"], questionRefs);
    const groupSegment = segments[0];
    expect(groupSegment?.kind).toBe("group");
    if (groupSegment?.kind !== "group") return;
    expect(groupSegment.materials.map((m) => m.id)).toEqual(["m1"]);
    expect(segments[1]).toEqual({ kind: "solo", questionIds: ["q2"] });
  });
});

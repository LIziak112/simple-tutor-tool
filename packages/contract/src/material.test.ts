import { describe, expect, it } from "vitest";
import { unitSchema } from "./content.ts";
import {
  materialPublicSchema,
  materialRefSchema,
  materialSchema,
  questionGroupPublicSchema,
  questionGroupSchema,
  unitGroupSchema,
} from "./material.ts";

/**
 * 材料/题组契约测试（TT-05a 域①，QM-01 §5.2 定稿）：
 * - 教师侧完整形态（sourceMd 原文是真相，锚点/槽位/引用是抽取副本）；
 * - 学生公开投影白名单 fail closed（sourceMd/答案型键不可能出现）；
 * - unitSchema 旧形态键集不变（materials/groups 缺省不注入，practice 先例）；
 * - 稳定 ID 缺省生成规则单源（§5.2.3 表）。
 */

const materialFixture = {
  id: "mat-1",
  title: "给定资料一",
  sourceMd: '::::material{id=mat-1 title="给定资料一"}\n正文……\n::::',
  contentMd: "正文……",
  anchors: [{ id: "seg-1", order: 0 }],
  slots: [{ id: "slot-1", slotKind: "choice", order: 0 }],
  mediaPaths: ["blobs/media/9af3.png"],
};

const groupFixture = {
  id: "grp-1",
  title: "根据以下资料回答第 1～5 题",
  label: "1～5",
  sourceMd:
    "::::group{id=grp-1}\n::ref{material=mat-1}\n::ref{question=q-1}\n::::",
  introMd: "根据以下资料回答第 1～5 题",
  materialRefs: [{ material: "mat-1" }],
  questionIds: ["q-1"],
};

describe("materialSchema（教师侧完整形态）", () => {
  it("解析完整材料（原文 + 抽取副本）", () => {
    const parsed = materialSchema.parse(materialFixture);
    expect(parsed.id).toBe("mat-1");
    expect(parsed.title).toBe("给定资料一");
    expect(parsed.sourceMd).toContain("::::material");
    expect(parsed.contentMd).toBe("正文……");
    expect(parsed.anchors).toEqual([{ id: "seg-1", order: 0 }]);
    expect(parsed.slots).toEqual([
      { id: "slot-1", slotKind: "choice", order: 0 },
    ]);
    expect(parsed.mediaPaths).toEqual(["blobs/media/9af3.png"]);
  });

  it("title 可缺省；anchors/slots/mediaPaths 缺省为空数组（抽取副本可选）", () => {
    const parsed = materialSchema.parse({
      id: "mat-2",
      sourceMd: "::::material{id=mat-2}\n……\n::::",
      contentMd: "……",
    });
    expect(parsed.title).toBeUndefined();
    expect(parsed.anchors).toEqual([]);
    expect(parsed.slots).toEqual([]);
    expect(parsed.mediaPaths).toEqual([]);
  });

  it("缺 sourceMd/contentMd 拒绝（原文是真相，两份载体都必填）", () => {
    expect(materialSchema.safeParse({ id: "mat-1" }).success).toBe(false);
    expect(
      materialSchema.safeParse({ id: "mat-1", sourceMd: "x" }).success,
    ).toBe(false);
  });

  it("槽位种类词表 text/choice/match（§5.2.2/§5.7.3）", () => {
    expect(
      materialSchema.safeParse({
        ...materialFixture,
        slots: [{ id: "slot-1", slotKind: "match", order: 0 }],
      }).success,
    ).toBe(true);
    expect(
      materialSchema.safeParse({
        ...materialFixture,
        slots: [{ id: "slot-1", slotKind: "排序", order: 0 }],
      }).success,
    ).toBe(false);
  });
});

describe("materialPublicSchema（学生公开投影，白名单 fail closed）", () => {
  it("白名单字段保留：id/title/contentMd/anchors/slots/mediaPaths", () => {
    const parsed = materialPublicSchema.parse(materialFixture);
    expect(Object.keys(parsed).sort()).toEqual(
      ["anchors", "contentMd", "id", "mediaPaths", "slots", "title"].sort(),
    );
  });

  it("sourceMd（教师侧容器原文）被剥离，不在公开投影", () => {
    const parsed = materialPublicSchema.parse(materialFixture);
    expect(parsed).not.toHaveProperty("sourceMd");
  });

  it("混入的答案型/私有键（answers/solutionMd/teacherComment）被 strip，结构上不可能携带", () => {
    const parsed = materialPublicSchema.parse({
      ...materialFixture,
      answers: { kind: "choice", index: 1 },
      solutionMd: "详解",
      teacherComment: "私注",
    });
    expect(parsed).not.toHaveProperty("answers");
    expect(parsed).not.toHaveProperty("solutionMd");
    expect(parsed).not.toHaveProperty("teacherComment");
  });
});

describe("materialRefSchema（::ref 引用解析产物）", () => {
  it("material 必填；segs/slot/slots 可选（原始选择串形态）", () => {
    expect(materialRefSchema.parse({ material: "mat-1" })).toEqual({
      material: "mat-1",
    });
    expect(
      materialRefSchema.parse({
        material: "mat-1",
        segs: "seg-1..seg-3",
        slot: "slot-2",
      }),
    ).toEqual({ material: "mat-1", segs: "seg-1..seg-3", slot: "slot-2" });
    expect(materialRefSchema.safeParse({ segs: "seg-1" }).success).toBe(false);
  });
});

describe("questionGroupSchema / unitGroupSchema / 公开投影", () => {
  it("题组完整形态：sourceMd + introMd + 引用索引", () => {
    const parsed = questionGroupSchema.parse(groupFixture);
    expect(parsed.sourceMd).toContain("::ref");
    expect(parsed.introMd).toContain("根据以下资料");
    expect(parsed.materialRefs).toEqual([{ material: "mat-1" }]);
    expect(parsed.questionIds).toEqual(["q-1"]);
    expect(parsed.label).toBe("1～5");
  });

  it("title/label 可缺省；materialRefs/questionIds 缺省空数组", () => {
    const parsed = questionGroupSchema.parse({
      id: "grp-2",
      sourceMd: "::::group{id=grp-2}\n说明\n::::",
      introMd: "说明",
    });
    expect(parsed.title).toBeUndefined();
    expect(parsed.label).toBeUndefined();
    expect(parsed.materialRefs).toEqual([]);
    expect(parsed.questionIds).toEqual([]);
  });

  it("unit.groups 叠加元数据形态（§5.2.4 定稿：id/title/label?/materialRefs/questionIds）", () => {
    const parsed = unitGroupSchema.parse({
      id: "grp-1",
      materialRefs: [{ material: "mat-1", slot: "slot-1" }],
      questionIds: ["q-1", "q-2"],
    });
    expect(parsed.questionIds).toHaveLength(2);
    expect(unitGroupSchema.safeParse({ questionIds: ["q-1"] }).success).toBe(
      false,
    );
  });

  it("题组公开投影剥 sourceMd（教师侧原文不下发）", () => {
    const parsed = questionGroupPublicSchema.parse(groupFixture);
    expect(parsed).not.toHaveProperty("sourceMd");
    expect(parsed.id).toBe("grp-1");
    expect(parsed.introMd).toContain("根据以下资料");
    expect(parsed.questionIds).toEqual(["q-1"]);
  });
});

describe("unitSchema 兼容（§5.8.1 缺省策略）", () => {
  it("旧文档解析结果键集不变：materials/groups 缺省不注入键", () => {
    const parsed = unitSchema.parse({
      id: "u1",
      title: "旧单元",
      questions: [],
    });
    expect(Object.keys(parsed).sort()).toEqual(
      ["id", "questions", "title"].sort(),
    );
  });

  it("新材料/组解析产物挂载（旧快照读取：新代码读旧形态 = 无组无材料独立题）", () => {
    const parsed = unitSchema.parse({
      id: "u1",
      title: "新单元",
      questions: [],
      materials: [materialFixture],
      groups: [groupFixture],
    });
    expect(parsed.materials).toHaveLength(1);
    expect(parsed.groups).toHaveLength(1);
  });
});

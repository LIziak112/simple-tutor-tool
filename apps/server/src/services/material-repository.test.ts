import { randomUUID } from "node:crypto";
import type { Material, QuestionGroup } from "@tutor/contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import {
  materialRefs as materialRefsTable,
  questionGroupMembers as memberTable,
  questions,
  students,
  teachers,
  units,
} from "../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import {
  findDanglingGroupMembers,
  findDanglingMaterialRefs,
  findGroupsReferencingQuestion,
  findMaterialRefOwners,
  freezeAttemptContextSnapshots,
  getAttemptContextSnapshot,
  getMaterial,
  getQuestionGroup,
  listAttemptContextSnapshots,
  listMaterialsByUnit,
  listQuestionGroupsByUnit,
  replaceQuestionMaterialRefs,
  saveMaterial,
  saveQuestionGroup,
  softDeleteMaterial,
  softDeleteQuestionGroup,
} from "./material-repository.ts";

/**
 * QM-03（tt-05b）仓储测试：材料/组/引用索引/冻结快照的服务端内部读写。
 * 教师域过滤在仓储层强制（同 ID 不同教师隔离）；原文与抽取字段职责分明
 * （sourceMd 是真相，anchors/slots/引用索引是可重建副本）；软删除延续。
 */

const NOW = "2026-10-24T08:00:00.000Z";
const NOW2 = "2026-10-24T09:00:00.000Z";

/** 第二位教师（隔离测试用）；createTestDb 已种 TEST_TEACHER_ID */
const TEACHER_B_ID = "teacher-b-qm03";

function seedTeacherB(db: Db): string {
  db.insert(teachers)
    .values({
      id: TEACHER_B_ID,
      loginName: "teacher-b-qm03",
      isAdmin: false,
      disabledAt: null,
      passwordHash: null,
      apiToken: null,
      createdAt: NOW,
    })
    .run();
  return TEACHER_B_ID;
}

/** 造一个单元（材料/组的容器）；返回 unitId */
function seedUnit(db: Db, teacherId: string, unitId: string): string {
  db.insert(units)
    .values({
      id: unitId,
      teacherId,
      courseId: null,
      folderId: null,
      lectureId: null,
      title: "资料分析",
      topic: null,
      order: 0,
      updatedAt: NOW,
      deletedAt: null,
    })
    .run();
  return unitId;
}

/** 造一道题（成员索引/悬垂检测的目标）；返回 questionId */
function seedQuestion(
  db: Db,
  teacherId: string,
  unitId: string,
  questionId: string,
): string {
  db.insert(questions)
    .values({
      id: questionId,
      teacherId,
      unitId,
      order: 0,
      type: "judge",
      difficulty: 1,
      stemMd: "题干 [[正确]]",
      optionsJson: null,
      answersJson: '{"kind":"judge","value":true}',
      hintsJson: "[]",
      solutionMd: null,
      sourceMd: "::::question{type=judge}\n题干 [[正确]]\n::::",
      updatedAt: NOW,
      deletedAt: null,
    })
    .run();
  return questionId;
}

/** 造学生 + wrong 来源 attempt（冻结快照的外键链）；返回 attemptId */
function seedAttempt(db: Db): string {
  const studentId = randomUUID();
  db.insert(students)
    .values({
      id: studentId,
      teacherId: null,
      displayName: "张三",
      loginName: `张三-${randomUUID().slice(0, 8)}`,
      passwordHash: null,
      linkToken: `link-${randomUUID()}`,
      linkEnabled: true,
      passwordEnabled: false,
      note: null,
      archivedAt: null,
      createdAt: NOW,
    })
    .run();
  const attemptId = randomUUID();
  db.$client
    .prepare(
      `INSERT INTO attempts (id, student_id, source_type, attempt_no, status, started_at)
       VALUES (?, ?, 'wrong', 1, 'draft', ?)`,
    )
    .run(attemptId, studentId, NOW);
  return attemptId;
}

/** 契约 Material 夹具（material.ts 形态；sourceMd 为原文是真相） */
function materialFixture(overrides: Partial<Material> = {}): Material {
  return {
    id: "mat-u1-1",
    title: "2023 年税收构成",
    sourceMd:
      "::::material{id=mat-u1-1 title=2023 年税收构成}\n正文段落 {{slot-1}}\n:::seg{id=seg-1}\n片段\n:::\n::::",
    contentMd: "正文段落 {{slot-1}}\n:::seg{id=seg-1}\n片段\n:::",
    anchors: [{ id: "seg-1", order: 0 }],
    slots: [{ id: "slot-1", slotKind: "choice", order: 0 }],
    mediaPaths: ["blobs/media/abc123.png"],
    ...overrides,
  };
}

/** 契约 QuestionGroup 夹具（引用式：materialRefs/questionIds 为 ::ref 抽取） */
function groupFixture(overrides: Partial<QuestionGroup> = {}): QuestionGroup {
  return {
    id: "grp-u1-1",
    title: "根据以下材料回答",
    label: "1～5",
    sourceMd:
      "::::group{id=grp-u1-1 title=根据以下材料回答}\n::ref{material=mat-u1-1}\n::ref{question=u1-1}\n::ref{question=u1-2}\n::::",
    introMd: "阅读材料，回答下面的问题。",
    materialRefs: [{ material: "mat-u1-1" }],
    questionIds: ["u1-1", "u1-2"],
    ...overrides,
  };
}

describe("材料仓储：saveMaterial / getMaterial / 软删与复活", () => {
  it("新材料落库：抽取字段 JSON 序列化、version=1、无软删；getMaterial 按教师域读回", () => {
    const db = createTestDb();
    const unitId = seedUnit(db, TEST_TEACHER_ID, "u1");
    const row = saveMaterial(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      material: materialFixture(),
      order: 0,
      now: NOW,
    });
    expect(row).toMatchObject({
      id: "mat-u1-1",
      teacherId: TEST_TEACHER_ID,
      unitId,
      title: "2023 年税收构成",
      version: 1,
      deletedAt: null,
      updatedAt: NOW,
    });
    expect(JSON.parse(row.anchorsJson)).toEqual([{ id: "seg-1", order: 0 }]);
    expect(JSON.parse(row.slotsJson)).toEqual([
      { id: "slot-1", slotKind: "choice", order: 0 },
    ]);
    expect(JSON.parse(row.mediaPathsJson)).toEqual(["blobs/media/abc123.png"]);

    const got = getMaterial(db, TEST_TEACHER_ID, "mat-u1-1");
    expect(got?.sourceMd).toBe(row.sourceMd);
    expect(getMaterial(db, TEST_TEACHER_ID, "mat-none")).toBeNull();
    db.$client.close();
  });

  it("同源文幂等更新：version 不变、抽取字段与标题更新落库（抽取副本可重建，不升版）", () => {
    const db = createTestDb();
    const unitId = seedUnit(db, TEST_TEACHER_ID, "u1");
    saveMaterial(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      material: materialFixture(),
      order: 0,
      now: NOW,
    });
    const row = saveMaterial(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      material: materialFixture({
        title: "改标题",
        anchors: [
          { id: "seg-1", order: 0 },
          { id: "seg-2", order: 1 },
        ],
      }),
      order: 1,
      now: NOW2,
    });
    expect(row.version).toBe(1);
    expect(row.title).toBe("改标题");
    expect(row.updatedAt).toBe(NOW2);
    expect(row.order).toBe(1);
    expect(JSON.parse(row.anchorsJson)).toHaveLength(2);
    db.$client.close();
  });

  it("源文变更升版：sourceMd 不同 → version+1（内容身份即版本）", () => {
    const db = createTestDb();
    const unitId = seedUnit(db, TEST_TEACHER_ID, "u1");
    saveMaterial(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      material: materialFixture(),
      order: 0,
      now: NOW,
    });
    const v2 = saveMaterial(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      material: materialFixture({ sourceMd: "::::material{id=mat-u1-1}\n新正文\n::::" }),
      order: 0,
      now: NOW2,
    });
    expect(v2.version).toBe(2);
    // 再以原源文保存：与当前行（新正文）不同 → 又升版
    const v3 = saveMaterial(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      material: materialFixture(),
      order: 0,
      now: NOW2,
    });
    expect(v3.version).toBe(3);
    db.$client.close();
  });

  it("软删：deletedAt 置值且幂等；get/list 默认排除、includeDeleted 可见；不存在返回 null", () => {
    const db = createTestDb();
    const unitId = seedUnit(db, TEST_TEACHER_ID, "u1");
    saveMaterial(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      material: materialFixture(),
      order: 0,
      now: NOW,
    });
    const deleted = softDeleteMaterial(db, TEST_TEACHER_ID, "mat-u1-1", NOW2);
    expect(deleted?.deletedAt).toBe(NOW2);
    // 幂等：重复软删不更新时间
    const again = softDeleteMaterial(db, TEST_TEACHER_ID, "mat-u1-1", "2026-10-25T00:00:00.000Z");
    expect(again?.deletedAt).toBe(NOW2);
    expect(getMaterial(db, TEST_TEACHER_ID, "mat-u1-1")).toBeNull();
    expect(
      getMaterial(db, TEST_TEACHER_ID, "mat-u1-1", { includeDeleted: true })
        ?.deletedAt,
    ).toBe(NOW2);
    expect(listMaterialsByUnit(db, TEST_TEACHER_ID, unitId)).toHaveLength(0);
    expect(
      listMaterialsByUnit(db, TEST_TEACHER_ID, unitId, {
        includeDeleted: true,
      }),
    ).toHaveLength(1);
    expect(softDeleteMaterial(db, TEST_TEACHER_ID, "mat-none", NOW2)).toBeNull();
    db.$client.close();
  });

  it("软删后重导复活：deletedAt 清空（题目软删同款规则延续）；源文未变 version 保持", () => {
    const db = createTestDb();
    const unitId = seedUnit(db, TEST_TEACHER_ID, "u1");
    saveMaterial(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      material: materialFixture(),
      order: 0,
      now: NOW,
    });
    softDeleteMaterial(db, TEST_TEACHER_ID, "mat-u1-1", NOW2);
    const revived = saveMaterial(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      material: materialFixture(),
      order: 0,
      now: NOW2,
    });
    expect(revived.deletedAt).toBeNull();
    expect(revived.version).toBe(1);
    expect(getMaterial(db, TEST_TEACHER_ID, "mat-u1-1")?.id).toBe("mat-u1-1");
    db.$client.close();
  });

  it("教师域隔离：同 id 材料两位教师并存，读写互不可见（复合主键承载域内唯一）", () => {
    const db = createTestDb();
    const teacherB = seedTeacherB(db);
    seedUnit(db, TEST_TEACHER_ID, "u1");
    seedUnit(db, teacherB, "u1");
    saveMaterial(db, {
      teacherId: TEST_TEACHER_ID,
      unitId: "u1",
      material: materialFixture(),
      order: 0,
      now: NOW,
    });
    const rowB = saveMaterial(db, {
      teacherId: teacherB,
      unitId: "u1",
      material: materialFixture({ title: "教师 B 的同 id 材料" }),
      order: 0,
      now: NOW,
    });
    expect(rowB.title).toBe("教师 B 的同 id 材料");
    // 各自只读到自己域内的行
    expect(
      getMaterial(db, TEST_TEACHER_ID, "mat-u1-1")?.title,
    ).toBe("2023 年税收构成");
    expect(getMaterial(db, teacherB, "mat-u1-1")?.title).toBe(
      "教师 B 的同 id 材料",
    );
    // 软删 A 的不影响 B
    softDeleteMaterial(db, TEST_TEACHER_ID, "mat-u1-1", NOW2);
    expect(getMaterial(db, teacherB, "mat-u1-1")?.deletedAt).toBeNull();
    // 列表按教师域过滤
    expect(listMaterialsByUnit(db, TEST_TEACHER_ID, "u1")).toHaveLength(0);
    expect(listMaterialsByUnit(db, teacherB, "u1")).toHaveLength(1);
    db.$client.close();
  });
});

describe("题组仓储：saveQuestionGroup 与成员/材料引用索引", () => {
  it("新组落库：introMd/materialRefs/questionIds JSON；成员索引与材料引用索引同事务写入", () => {
    const db = createTestDb();
    const unitId = seedUnit(db, TEST_TEACHER_ID, "u1");
    seedQuestion(db, TEST_TEACHER_ID, unitId, "u1-1");
    seedQuestion(db, TEST_TEACHER_ID, unitId, "u1-2");
    const row = saveQuestionGroup(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      group: groupFixture(),
      order: 0,
      now: NOW,
    });
    expect(row).toMatchObject({
      id: "grp-u1-1",
      teacherId: TEST_TEACHER_ID,
      unitId,
      title: "根据以下材料回答",
      label: "1～5",
      version: 1,
      deletedAt: null,
    });
    expect(JSON.parse(row.questionIdsJson)).toEqual(["u1-1", "u1-2"]);
    expect(JSON.parse(row.materialRefsJson)).toEqual([
      { material: "mat-u1-1" },
    ]);

    // 成员索引：书写顺序 0/1
    const members = db
      .select()
      .from(memberTable)
      .where(eq(memberTable.groupId, "grp-u1-1"))
      .all()
      .sort((a, b) => a.order - b.order);
    expect(members.map((m) => [m.questionId, m.order])).toEqual([
      ["u1-1", 0],
      ["u1-2", 1],
    ]);
    expect(members.every((m) => m.teacherId === TEST_TEACHER_ID)).toBe(true);

    // 材料引用索引：ownerKind='group'、refOrder=数组下标
    const refs = db
      .select()
      .from(materialRefsTable)
      .where(eq(materialRefsTable.ownerId, "grp-u1-1"))
      .all();
    expect(refs).toEqual([
      {
        teacherId: TEST_TEACHER_ID,
        ownerKind: "group",
        ownerId: "grp-u1-1",
        materialId: "mat-u1-1",
        refOrder: 0,
      },
    ]);
    db.$client.close();
  });

  it("同材料多片段引用：一个 owner 两条 ::ref 指向同一 materialId → 索引两行（refOrder 区分）", () => {
    const db = createTestDb();
    const unitId = seedUnit(db, TEST_TEACHER_ID, "u1");
    saveQuestionGroup(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      group: groupFixture({
        materialRefs: [
          { material: "mat-u1-1", segs: "seg-1" },
          { material: "mat-u1-1", segs: "seg-2..seg-3" },
        ],
      }),
      order: 0,
      now: NOW,
    });
    const refs = db
      .select()
      .from(materialRefsTable)
      .where(eq(materialRefsTable.ownerId, "grp-u1-1"))
      .all()
      .sort((a, b) => a.refOrder - b.refOrder);
    expect(refs.map((r) => [r.materialId, r.refOrder])).toEqual([
      ["mat-u1-1", 0],
      ["mat-u1-1", 1],
    ]);
    db.$client.close();
  });

  it("二次保存替换索引：成员与引用变化后旧索引行消失、新行就位；源文未变 version 不变", () => {
    const db = createTestDb();
    const unitId = seedUnit(db, TEST_TEACHER_ID, "u1");
    seedQuestion(db, TEST_TEACHER_ID, unitId, "u1-1");
    seedQuestion(db, TEST_TEACHER_ID, unitId, "u1-2");
    seedQuestion(db, TEST_TEACHER_ID, unitId, "u1-3");
    saveMaterial(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      material: materialFixture(),
      order: 0,
      now: NOW,
    });
    saveQuestionGroup(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      group: groupFixture(),
      order: 0,
      now: NOW,
    });
    const row = saveQuestionGroup(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      group: groupFixture({
        sourceMd:
          "::::group{id=grp-u1-1}\n::ref{material=mat-u1-1}\n::ref{question=u1-3}\n::::",
        questionIds: ["u1-3"],
      }),
      order: 0,
      now: NOW2,
    });
    expect(row.version).toBe(1);
    const members = db
      .select()
      .from(memberTable)
      .where(eq(memberTable.groupId, "grp-u1-1"))
      .all();
    expect(members.map((m) => m.questionId)).toEqual(["u1-3"]);
    expect(JSON.parse(row.questionIdsJson)).toEqual(["u1-3"]);
    db.$client.close();
  });

  it("事务回滚：重复成员触发索引主键冲突 → 保存整体失败，组行与索引行均未落库", () => {
    const db = createTestDb();
    const unitId = seedUnit(db, TEST_TEACHER_ID, "u1");
    seedQuestion(db, TEST_TEACHER_ID, unitId, "u1-1");
    expect(() =>
      saveQuestionGroup(db, {
        teacherId: TEST_TEACHER_ID,
        unitId,
        // 同一子题被重复引用（lint 的 GROUP_MEMBER_DUPLICATED 在导入前拦截；
        // 仓储层兜底：索引主键冲突 → 事务回滚，不留半份数据）
        group: groupFixture({ questionIds: ["u1-1", "u1-1"] }),
        order: 0,
        now: NOW,
      }),
    ).toThrow();
    expect(getQuestionGroup(db, TEST_TEACHER_ID, "grp-u1-1")).toBeNull();
    expect(
      db.select().from(memberTable).where(eq(memberTable.groupId, "grp-u1-1")).all(),
    ).toHaveLength(0);
    expect(
      db
        .select()
        .from(materialRefsTable)
        .where(eq(materialRefsTable.ownerId, "grp-u1-1"))
        .all(),
    ).toHaveLength(0);
    db.$client.close();
  });

  it("组软删与列表：默认排除、includeDeleted 可见；教师域隔离同材料款", () => {
    const db = createTestDb();
    const teacherB = seedTeacherB(db);
    seedUnit(db, TEST_TEACHER_ID, "u1");
    seedUnit(db, teacherB, "u1");
    saveQuestionGroup(db, {
      teacherId: TEST_TEACHER_ID,
      unitId: "u1",
      group: groupFixture(),
      order: 0,
      now: NOW,
    });
    saveQuestionGroup(db, {
      teacherId: teacherB,
      unitId: "u1",
      group: groupFixture({ title: "教师 B 的组" }),
      order: 0,
      now: NOW,
    });
    softDeleteQuestionGroup(db, TEST_TEACHER_ID, "grp-u1-1", NOW2);
    expect(getQuestionGroup(db, TEST_TEACHER_ID, "grp-u1-1")).toBeNull();
    expect(
      getQuestionGroup(db, TEST_TEACHER_ID, "grp-u1-1", {
        includeDeleted: true,
      })?.deletedAt,
    ).toBe(NOW2);
    expect(listQuestionGroupsByUnit(db, TEST_TEACHER_ID, "u1")).toHaveLength(0);
    expect(
      listQuestionGroupsByUnit(db, TEST_TEACHER_ID, "u1", {
        includeDeleted: true,
      }),
    ).toHaveLength(1);
    // B 域不受影响
    expect(listQuestionGroupsByUnit(db, teacherB, "u1")).toHaveLength(1);
    expect(getQuestionGroup(db, teacherB, "grp-u1-1")?.title).toBe("教师 B 的组");
    db.$client.close();
  });
});

describe("题级材料引用索引：replaceQuestionMaterialRefs", () => {
  it("初建与替换：refOrder=数组下标；再次调用整体替换；教师域限定", () => {
    const db = createTestDb();
    const unitId = seedUnit(db, TEST_TEACHER_ID, "u1");
    seedQuestion(db, TEST_TEACHER_ID, unitId, "u1-1");
    replaceQuestionMaterialRefs(db, TEST_TEACHER_ID, "u1-1", [
      { material: "mat-a" },
      { material: "mat-b", segs: "seg-1..seg-2" },
    ]);
    const first = db
      .select()
      .from(materialRefsTable)
      .where(eq(materialRefsTable.ownerId, "u1-1"))
      .all()
      .sort((a, b) => a.refOrder - b.refOrder);
    expect(first.map((r) => [r.materialId, r.ownerKind])).toEqual([
      ["mat-a", "question"],
      ["mat-b", "question"],
    ]);
    // 替换：旧行清空、新行就位（空数组 = 清除全部引用）
    replaceQuestionMaterialRefs(db, TEST_TEACHER_ID, "u1-1", [
      { material: "mat-c", slot: "slot-1" },
    ]);
    const second = db
      .select()
      .from(materialRefsTable)
      .where(eq(materialRefsTable.ownerId, "u1-1"))
      .all();
    expect(second.map((r) => r.materialId)).toEqual(["mat-c"]);
    replaceQuestionMaterialRefs(db, TEST_TEACHER_ID, "u1-1", []);
    expect(
      db
        .select()
        .from(materialRefsTable)
        .where(eq(materialRefsTable.ownerId, "u1-1"))
        .all(),
    ).toHaveLength(0);
    db.$client.close();
  });
});

describe("引用反查与悬垂检测（删除/移动影响查询）", () => {
  it("findMaterialRefOwners：材料被组与题引用 → 反查全部 owner；教师域过滤", () => {
    const db = createTestDb();
    const teacherB = seedTeacherB(db);
    const unitId = seedUnit(db, TEST_TEACHER_ID, "u1");
    seedUnit(db, teacherB, "u1");
    seedQuestion(db, TEST_TEACHER_ID, unitId, "u1-1");
    seedQuestion(db, teacherB, "u1", "u1-1");
    saveQuestionGroup(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      group: groupFixture(),
      order: 0,
      now: NOW,
    });
    saveQuestionGroup(db, {
      teacherId: teacherB,
      unitId: "u1",
      group: groupFixture(),
      order: 0,
      now: NOW,
    });
    replaceQuestionMaterialRefs(db, TEST_TEACHER_ID, "u1-1", [
      { material: "mat-u1-1" },
    ]);
    const owners = findMaterialRefOwners(db, TEST_TEACHER_ID, "mat-u1-1");
    expect(owners).toEqual([
      { ownerKind: "group", ownerId: "grp-u1-1", refOrder: 0 },
      { ownerKind: "question", ownerId: "u1-1", refOrder: 0 },
    ]);
    // B 域只有组引用（B 的题级引用未建）
    expect(findMaterialRefOwners(db, teacherB, "mat-u1-1")).toEqual([
      { ownerKind: "group", ownerId: "grp-u1-1", refOrder: 0 },
    ]);
    expect(findMaterialRefOwners(db, TEST_TEACHER_ID, "mat-none")).toEqual([]);
    db.$client.close();
  });

  it("findGroupsReferencingQuestion：题属多组 → 组 id 列表；教师域过滤", () => {
    const db = createTestDb();
    const unitId = seedUnit(db, TEST_TEACHER_ID, "u1");
    seedQuestion(db, TEST_TEACHER_ID, unitId, "u1-1");
    saveQuestionGroup(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      group: groupFixture(),
      order: 0,
      now: NOW,
    });
    saveQuestionGroup(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      group: groupFixture({
        id: "grp-u1-2",
        sourceMd: "::::group{id=grp-u1-2}\n::ref{question=u1-1}\n::::",
        materialRefs: [],
        questionIds: ["u1-1"],
      }),
      order: 1,
      now: NOW,
    });
    expect(findGroupsReferencingQuestion(db, TEST_TEACHER_ID, "u1-1").sort()).toEqual([
      "grp-u1-1",
      "grp-u1-2",
    ]);
    expect(
      findGroupsReferencingQuestion(db, TEST_TEACHER_ID, "u1-none"),
    ).toEqual([]);
    db.$client.close();
  });

  it("findDanglingMaterialRefs：目标材料缺失或软删 → 悬垂；复活后消失", () => {
    const db = createTestDb();
    const unitId = seedUnit(db, TEST_TEACHER_ID, "u1");
    seedQuestion(db, TEST_TEACHER_ID, unitId, "u1-1");
    // 健康态：空
    expect(findDanglingMaterialRefs(db, TEST_TEACHER_ID)).toEqual([]);
    // 引用从未保存的材料 → 悬垂
    replaceQuestionMaterialRefs(db, TEST_TEACHER_ID, "u1-1", [
      { material: "mat-ghost" },
    ]);
    expect(findDanglingMaterialRefs(db, TEST_TEACHER_ID)).toEqual([
      {
        ownerKind: "question",
        ownerId: "u1-1",
        materialId: "mat-ghost",
        refOrder: 0,
      },
    ]);
    // 材料软删 → 其既有引用变悬垂；复活 → 恢复
    saveMaterial(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      material: materialFixture(),
      order: 0,
      now: NOW,
    });
    replaceQuestionMaterialRefs(db, TEST_TEACHER_ID, "u1-1", [
      { material: "mat-ghost" },
      { material: "mat-u1-1" },
    ]);
    expect(findDanglingMaterialRefs(db, TEST_TEACHER_ID)).toEqual([
      {
        ownerKind: "question",
        ownerId: "u1-1",
        materialId: "mat-ghost",
        refOrder: 0,
      },
    ]);
    softDeleteMaterial(db, TEST_TEACHER_ID, "mat-u1-1", NOW2);
    const afterDelete = findDanglingMaterialRefs(db, TEST_TEACHER_ID);
    expect(afterDelete).toHaveLength(2);
    expect(afterDelete.map((r) => r.materialId).sort()).toEqual([
      "mat-ghost",
      "mat-u1-1",
    ]);
    saveMaterial(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      material: materialFixture(),
      order: 0,
      now: NOW2,
    });
    expect(
      findDanglingMaterialRefs(db, TEST_TEACHER_ID).map((r) => r.materialId),
    ).toEqual(["mat-ghost"]);
    db.$client.close();
  });

  it("findDanglingGroupMembers：题目软删后成员悬垂（题目只软删的既有规则）", () => {
    const db = createTestDb();
    const unitId = seedUnit(db, TEST_TEACHER_ID, "u1");
    seedQuestion(db, TEST_TEACHER_ID, unitId, "u1-1");
    seedQuestion(db, TEST_TEACHER_ID, unitId, "u1-2");
    saveQuestionGroup(db, {
      teacherId: TEST_TEACHER_ID,
      unitId,
      group: groupFixture(),
      order: 0,
      now: NOW,
    });
    expect(findDanglingGroupMembers(db, TEST_TEACHER_ID)).toEqual([]);
    // 软删 u1-2（不物理删除——规则延续）
    db.update(questions)
      .set({ deletedAt: NOW2 })
      .where(eq(questions.id, "u1-2"))
      .run();
    expect(findDanglingGroupMembers(db, TEST_TEACHER_ID)).toEqual([
      { groupId: "grp-u1-1", questionId: "u1-2", order: 1 },
    ]);
    db.$client.close();
  });
});

describe("attempt 上下文冻结快照（§5.6/§5.8.1 预留存储）", () => {
  it("冻结写入与去重：同 (attempt, kind, id, version) 幂等；同 id 不同版本两行不覆盖", () => {
    const db = createTestDb();
    const attemptId = seedAttempt(db);
    const inserted1 = freezeAttemptContextSnapshots(db, attemptId, [
      {
        kind: "material",
        sourceId: "mat-u1-1",
        sourceVersion: 1,
        snapshot: {
          id: "mat-u1-1",
          title: "材料一",
          contentMd: "正文 v1",
          anchors: [],
          slots: [],
          mediaPaths: [],
        },
      },
      {
        kind: "group",
        sourceId: "grp-u1-1",
        sourceVersion: 1,
        snapshot: {
          id: "grp-u1-1",
          introMd: "公共说明",
          materialRefs: [],
          questionIds: [],
        },
      },
    ], NOW);
    expect(inserted1).toBe(2);
    // 同键重复冻结 → 去重（返回新插入数 0，行数不变）
    const inserted2 = freezeAttemptContextSnapshots(db, attemptId, [
      {
        kind: "material",
        sourceId: "mat-u1-1",
        sourceVersion: 1,
        snapshot: {
          id: "mat-u1-1",
          contentMd: "正文 v1",
          anchors: [],
          slots: [],
          mediaPaths: [],
        },
      },
    ], NOW2);
    expect(inserted2).toBe(0);
    // 同 id 不同版本 → 新行（§5.3：材料同 ID 不同版本不互相覆盖）
    const inserted3 = freezeAttemptContextSnapshots(db, attemptId, [
      {
        kind: "material",
        sourceId: "mat-u1-1",
        sourceVersion: 2,
        snapshot: {
          id: "mat-u1-1",
          contentMd: "正文 v2",
          anchors: [],
          slots: [],
          mediaPaths: [],
        },
      },
    ], NOW2);
    expect(inserted3).toBe(1);
    const rows = listAttemptContextSnapshots(db, attemptId);
    expect(rows).toHaveLength(3);
    expect(
      getAttemptContextSnapshot(db, attemptId, "material", "mat-u1-1", 1)
        ?.snapshotJson,
    ).toContain("正文 v1");
    expect(
      getAttemptContextSnapshot(db, attemptId, "material", "mat-u1-1", 2)
        ?.snapshotJson,
    ).toContain("正文 v2");
    db.$client.close();
  });

  it("读取按 attempt 隔离：他卷不可见；事务回滚：批内一条 FK 破坏 → 整批不落", () => {
    const db = createTestDb();
    const attemptA = seedAttempt(db);
    const attemptB = seedAttempt(db);
    freezeAttemptContextSnapshots(db, attemptA, [
      {
        kind: "group",
        sourceId: "grp-x",
        sourceVersion: 1,
        snapshot: { id: "grp-x", introMd: "说明", materialRefs: [], questionIds: [] },
      },
    ], NOW);
    expect(listAttemptContextSnapshots(db, attemptB)).toHaveLength(0);
    expect(getAttemptContextSnapshot(db, attemptB, "group", "grp-x", 1)).toBeNull();

    // 批内第二条 FK 破坏（attempt 不存在）→ 整批回滚，第一条不留
    expect(() =>
      freezeAttemptContextSnapshots(db, attemptB, [
        {
          kind: "group",
          sourceId: "grp-y",
          sourceVersion: 1,
          snapshot: { id: "grp-y", introMd: "说明", materialRefs: [], questionIds: [] },
        },
        {
          kind: "material",
          sourceId: "mat-z",
          sourceVersion: 1,
          snapshot: { id: "mat-z", contentMd: "正文", anchors: [], slots: [], mediaPaths: [] },
        },
      ], NOW2),
    ).toThrow();
    expect(listAttemptContextSnapshots(db, attemptB)).toHaveLength(0);
    db.$client.close();
  });
});

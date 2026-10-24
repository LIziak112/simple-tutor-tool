import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import {
  imports,
  materialRefs as materialRefsTable,
  questionGroupMembers,
  questions,
  teachers,
} from "../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { HttpError } from "../lib/http-error.ts";
import { commitImport } from "./content-service.ts";
import { getMaterial, getQuestionGroup } from "./material-repository.ts";
import {
  assembleQmBlocks,
  assembleUnitDoc,
  deleteMaterial,
  deleteQuestionGroup,
  getMaterialDetail,
  getQuestionGroupDetail,
  rebuildUnitDoc,
  updateMaterial,
  updateQuestionGroup,
} from "./qm-edit-service.ts";
import { exportUnitMd } from "./library-service.ts";

/**
 * tt-06b / QM-05 材料/题组编辑与删除测试（服务层级）：
 * - 编辑走单元文档重建（同一源文解析）：改材料正文 → 槽位/锚点抽取刷新、
 *   组的 slot= 引用继续闭合；改组 → 成员/引用索引同事务替换；
 * - id 不可变 + 实体集合不可增删（ID_IMMUTABLE / VALIDATION_ERROR）；
 * - 破坏引用的编辑被 LINT_ERROR 拒绝（删槽位 → 组引用悬垂；删子题 →
 *   GROUP_MEMBER_NOT_FOUND）且零写入；
 * - NEW_CONTENT_ENABLED 关闭部署：编辑含 QM 语法的片段 403、旧题不受影响；
 * - 删除：软删 + 受影响引用/子题清单；重导同 id 恢复；
 * - 教师域隔离（乙不可见/不可改甲的实体）；
 * - 导出重导经真实 exportUnitMd 覆盖材料正文（库内 sourceMd 原样往返）。
 */

const MATERIAL_ID = "mat-资料分析-1";
const GROUP_ID = "grp-资料分析-1";
const QUESTION_ID = "资料分析-1";

/** 基线 QM 单元：材料（显式 id + 槽位 + seg）、组（材料/子题引用）、一道 choice */
const QM_MD = [
  "---",
  "kind: practice",
  "unit: 资料分析",
  "---",
  "",
  "# 资料分析练习",
  "",
  `::::material{id=${MATERIAL_ID}}`,
  "给定资料正文，含槽位 {{slot-1}}。",
  "",
  ":::seg{id=seg-1}",
  "首段。",
  ":::",
  "::::",
  "",
  `::::group{id=${GROUP_ID} label=1～1}`,
  `::ref{material=${MATERIAL_ID} slot=slot-1}`,
  `::ref{question=${QUESTION_ID}}`,
  "::::",
  "",
  `::::question{type=choice difficulty=2}`,
  "根据材料回答。",
  "",
  "- [ ] 甲",
  "- [x] 乙",
  "::::",
  "",
].join("\n");

function commitBase(db: Db): void {
  commitImport(
    db,
    TEST_TEACHER_ID,
    { markdown: QM_MD, filename: "资料分析.md" },
    undefined,
    undefined,
    true,
  );
}

/** 材料 sourceMd（库内规范化形态）——编辑提交的片段基线 */
function materialSourceMd(db: Db): string {
  const row = getMaterial(db, TEST_TEACHER_ID, MATERIAL_ID);
  if (row === null) throw new Error("基线材料未落库");
  return row.sourceMd;
}

/** 组 sourceMd（库内规范化形态） */
function groupSourceMd(db: Db): string {
  const row = getQuestionGroup(db, TEST_TEACHER_ID, GROUP_ID);
  if (row === null) throw new Error("基线组未落库");
  return row.sourceMd;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("QM-05 材料编辑（单元文档重建，同一源文解析）", () => {
  it("改正文：sourceMd 落库、版本 +1、affectedRefs 报告组引用", () => {
    const db = createTestDb();
    commitBase(db);
    const updated = updateMaterial(
      db,
      TEST_TEACHER_ID,
      MATERIAL_ID,
      {
        sourceMd: materialSourceMd(db).replace(
          "给定资料正文",
          "修改后的资料正文",
        ),
      },
      true,
    );
    expect(updated.version).toBe(2);
    expect(updated.affectedRefs).toEqual([
      { ownerKind: "group", ownerId: GROUP_ID, refOrder: 0 },
    ]);
    const material = getMaterial(db, TEST_TEACHER_ID, MATERIAL_ID);
    expect(material?.contentMd).toContain("修改后的资料正文");
    // 槽位/锚点抽取副本随同一解析刷新
    expect(JSON.parse(material?.slotsJson ?? "[]")).toEqual([
      { id: "slot-1", slotKind: "choice", order: 0 },
    ]);
  });

  it("片段缺省 id 的槽位/锚点在重建中规范化固化", () => {
    const db = createTestDb();
    commitBase(db);
    const fragment = [
      `::::material{id=${MATERIAL_ID}}`,
      "新正文，缺省槽位 {{}} 与缺省锚点。",
      "",
      ":::seg",
      "新首段。",
      ":::",
      "::::",
    ].join("\n");
    const updated = updateMaterial(
      db,
      TEST_TEACHER_ID,
      MATERIAL_ID,
      { sourceMd: fragment },
      true,
    );
    expect(updated.version).toBe(2);
    const material = getMaterial(db, TEST_TEACHER_ID, MATERIAL_ID);
    // 缺省 id 固化进 sourceMd（{{slot-1}} / :::seg{id=seg-1}）
    expect(material?.sourceMd).toContain("{{slot-1}}");
    expect(material?.sourceMd).toContain(":::seg{id=seg-1}");
    expect(JSON.parse(material?.anchorsJson ?? "[]")).toEqual([
      { id: "seg-1", order: 0 },
    ]);
  });

  it("删掉被组引用的槽位 → LINT_ERROR（UNKNOWN_SLOT_REF）且零写入", () => {
    const db = createTestDb();
    commitBase(db);
    const before = materialSourceMd(db);
    const fragment = before.replace("，含槽位 {{slot-1}}。", "，无槽位。");
    const attempt = () =>
      updateMaterial(
        db,
        TEST_TEACHER_ID,
        MATERIAL_ID,
        { sourceMd: fragment },
        true,
      );
    expect(attempt).toThrowError(HttpError);
    try {
      attempt();
    } catch (err) {
      const httpErr = err as HttpError;
      expect(httpErr.status).toBe(422);
      expect(httpErr.code).toBe("LINT_ERROR");
      const issues = httpErr.extra?._issues as { code: string }[] | undefined;
      expect(issues?.some((i) => i.code === "UNKNOWN_SLOT_REF")).toBe(true);
    }
    // 零写入：库内 sourceMd/版本不变
    const material = getMaterial(db, TEST_TEACHER_ID, MATERIAL_ID);
    expect(material?.sourceMd).toBe(before);
    expect(material?.version).toBe(1);
  });

  it("id 不可变：片段解析出别的 id → ID_IMMUTABLE（先过 lint：改 id 且去槽位避免 SLOT_UNBOUND 先拦）", () => {
    const db = createTestDb();
    commitBase(db);
    const fragment = materialSourceMd(db)
      .replace(`id=${MATERIAL_ID}`, "id=mat-别的")
      .replace("{{slot-1}}", "无槽位");
    expect(() =>
      updateMaterial(
        db,
        TEST_TEACHER_ID,
        MATERIAL_ID,
        { sourceMd: fragment },
        true,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "ID_IMMUTABLE",
      }) satisfies Partial<HttpError>,
    );
  });

  it("片段含两个材料 → VALIDATION_ERROR（一次编辑一个实体）", () => {
    const db = createTestDb();
    commitBase(db);
    const fragment = `${materialSourceMd(db)}\n\n::::material{id=mat-新}\n新。\n::::`;
    expect(() =>
      updateMaterial(
        db,
        TEST_TEACHER_ID,
        MATERIAL_ID,
        { sourceMd: fragment },
        true,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_ERROR",
      }) satisfies Partial<HttpError>,
    );
  });

  it("NEW_CONTENT_ENABLED 关闭：编辑含 QM 语法的片段 403；GET 详情不受影响", () => {
    const db = createTestDb();
    commitBase(db);
    expect(() =>
      updateMaterial(
        db,
        TEST_TEACHER_ID,
        MATERIAL_ID,
        { sourceMd: materialSourceMd(db) },
        false,
      ),
    ).toThrowError(
      expect.objectContaining({
        status: 403,
        code: "NEW_CONTENT_DISABLED",
      }) satisfies Partial<HttpError>,
    );
    // 读取不设闸
    const detail = getMaterialDetail(db, TEST_TEACHER_ID, MATERIAL_ID);
    expect(detail.id).toBe(MATERIAL_ID);
    expect(detail.sourceMd).toContain("::::material");
  });

  it("跨单元既有材料引用在重建中教师域解析（组追加引用他单元材料不报错）", () => {
    const db = createTestDb();
    commitBase(db);
    // 另一单元新材料（含槽位，由该单元的题绑定）
    const otherDoc = [
      "---",
      "kind: practice",
      "unit: 另一单元",
      "---",
      "",
      "# 另一单元",
      "",
      "::::material{id=mat-跨单元}",
      "跨单元材料 {{slot-x}}。",
      "::::",
      "",
      "::::question{type=choice difficulty=1}",
      "::ref{material=mat-跨单元 slot=slot-x}",
      "占位。",
      "",
      "- [ ] 甲",
      "- [x] 乙",
      "::::",
      "",
    ].join("\n");
    commitImport(
      db,
      TEST_TEACHER_ID,
      { markdown: otherDoc, filename: "另一单元.md" },
      undefined,
      undefined,
      true,
    );
    // 组片段追加一行跨单元材料引用（原 slot-1 绑定保留——材料槽位必须保持被绑定）
    const fragment = `${groupSourceMd(db).replace(
      /::::$/,
      "::ref{material=mat-跨单元 slot=slot-x}\n::::",
    )}`;
    const updated = updateQuestionGroup(
      db,
      TEST_TEACHER_ID,
      GROUP_ID,
      { sourceMd: fragment },
      true,
    );
    expect(updated.version).toBe(2);
    const refs = db
      .select()
      .from(materialRefsTable)
      .where(
        and(
          eq(materialRefsTable.ownerKind, "group"),
          eq(materialRefsTable.ownerId, GROUP_ID),
        ),
      )
      .all();
    expect(refs.map((r) => r.materialId)).toEqual([MATERIAL_ID, "mat-跨单元"]);
  });
});

describe("QM-05 题组编辑", () => {
  it("改组：成员索引与组引用索引同事务替换；affectedQuestionIds 报告", () => {
    const db = createTestDb();
    commitBase(db);
    const updated = updateQuestionGroup(
      db,
      TEST_TEACHER_ID,
      GROUP_ID,
      { sourceMd: groupSourceMd(db).replace("label=1～1", "label=第 1 题") },
      true,
    );
    expect(updated.version).toBe(2);
    expect(updated.affectedQuestionIds).toEqual([QUESTION_ID]);
    const members = db
      .select()
      .from(questionGroupMembers)
      .where(eq(questionGroupMembers.groupId, GROUP_ID))
      .all();
    expect(members.map((m) => m.questionId)).toEqual([QUESTION_ID]);
  });

  it("引用不存在子题 → LINT_ERROR（GROUP_MEMBER_NOT_FOUND）", () => {
    const db = createTestDb();
    commitBase(db);
    const fragment = groupSourceMd(db).replace(
      `::ref{question=${QUESTION_ID}}`,
      "::ref{question=不存在的题}",
    );
    expect(() =>
      updateQuestionGroup(
        db,
        TEST_TEACHER_ID,
        GROUP_ID,
        { sourceMd: fragment },
        true,
      ),
    ).toThrowError(HttpError);
  });

  it("GET 详情：完整形态含 sourceMd", () => {
    const db = createTestDb();
    commitBase(db);
    const detail = getQuestionGroupDetail(db, TEST_TEACHER_ID, GROUP_ID);
    expect(detail.id).toBe(GROUP_ID);
    expect(detail.sourceMd).toContain("::::group");
    expect(detail.unitId).toBe("资料分析");
  });
});

describe("QM-05 材料/组删除（软删 + 受影响清单）", () => {
  it("删材料：软删 + 删除前引用清单；悬垂引用可检出；重导同 id 恢复", () => {
    const db = createTestDb();
    commitBase(db);
    const deleted = deleteMaterial(db, TEST_TEACHER_ID, MATERIAL_ID);
    expect(deleted.id).toBe(MATERIAL_ID);
    expect(deleted.deletedAt).not.toBe("");
    expect(deleted.affectedRefs).toEqual([
      { ownerKind: "group", ownerId: GROUP_ID, refOrder: 0 },
    ]);
    expect(getMaterial(db, TEST_TEACHER_ID, MATERIAL_ID)).toBeNull();
    // 再删 → 404（软删后按不存在处理）
    expect(() => deleteMaterial(db, TEST_TEACHER_ID, MATERIAL_ID)).toThrowError(
      expect.objectContaining({
        code: "MATERIAL_NOT_FOUND",
      }) satisfies Partial<HttpError>,
    );
    // 重导同 id 恢复（deletedAt 清空）
    commitBase(db);
    const restored = getMaterial(db, TEST_TEACHER_ID, MATERIAL_ID);
    expect(restored).not.toBeNull();
  });

  it("删组：软删 + 软删前子题清单；成员索引保留", () => {
    const db = createTestDb();
    commitBase(db);
    const deleted = deleteQuestionGroup(db, TEST_TEACHER_ID, GROUP_ID);
    expect(deleted.affectedQuestionIds).toEqual([QUESTION_ID]);
    expect(getQuestionGroup(db, TEST_TEACHER_ID, GROUP_ID)).toBeNull();
    // 索引行保留（查历史影响——softDeleteQuestionGroup 语义）
    const members = db
      .select()
      .from(questionGroupMembers)
      .where(eq(questionGroupMembers.groupId, GROUP_ID))
      .all();
    expect(members).toHaveLength(1);
  });
});

describe("QM-05 教师域隔离（编辑与删除）", () => {
  const TEACHER_B_ID = "teacher-b-qm05-edit";
  function seedTeacherB(db: Db): void {
    db.insert(teachers)
      .values({
        id: TEACHER_B_ID,
        loginName: "teacher-b-qm05-edit",
        isAdmin: false,
        disabledAt: null,
        passwordHash: null,
        apiToken: null,
        createdAt: "2026-10-24T08:00:00.000Z",
      })
      .run();
  }

  it("乙读/改/删甲的实体一律 404", () => {
    const db = createTestDb();
    seedTeacherB(db);
    commitBase(db);
    expect(() => getMaterialDetail(db, TEACHER_B_ID, MATERIAL_ID)).toThrowError(
      expect.objectContaining({
        code: "MATERIAL_NOT_FOUND",
      }) satisfies Partial<HttpError>,
    );
    expect(() =>
      updateMaterial(
        db,
        TEACHER_B_ID,
        MATERIAL_ID,
        { sourceMd: "::::material{id=x}\n改。\n::::" },
        true,
      ),
    ).toThrowError(HttpError);
    expect(() => deleteMaterial(db, TEACHER_B_ID, MATERIAL_ID)).toThrowError(
      HttpError,
    );
    expect(() =>
      getQuestionGroupDetail(db, TEACHER_B_ID, GROUP_ID),
    ).toThrowError(
      expect.objectContaining({
        code: "GROUP_NOT_FOUND",
      }) satisfies Partial<HttpError>,
    );
  });
});

describe("QM-05 导出重导覆盖材料正文（真实 exportUnitMd）", () => {
  it("导出含材料/组源文；重导后材料/组/题目逐字节同源、版本不动", async () => {
    const db = createTestDb();
    commitBase(db);
    const { exportUnitMd } = await import("./library-service.ts");
    const exported = exportUnitMd(db, TEST_TEACHER_ID, "资料分析");
    // 导出覆盖材料正文与组源文
    expect(exported.markdown).toContain("::::material");
    expect(exported.markdown).toContain("给定资料正文");
    expect(exported.markdown).toContain("::::group");
    // 重导（材料版本策略：sourceMd 不变 → 版本保持）
    const before = getMaterial(db, TEST_TEACHER_ID, MATERIAL_ID);
    commitImport(
      db,
      TEST_TEACHER_ID,
      { markdown: exported.markdown, filename: "资料分析.md" },
      undefined,
      undefined,
      true,
    );
    const after = getMaterial(db, TEST_TEACHER_ID, MATERIAL_ID);
    expect(after?.sourceMd).toBe(before?.sourceMd);
    expect(after?.version).toBe(before?.version);
    // 再导出逐字节稳定
    expect(exportUnitMd(db, TEST_TEACHER_ID, "资料分析").markdown).toBe(
      exported.markdown,
    );
    // imports 留档两笔
    expect(db.select().from(imports).all()).toHaveLength(2);
  });
});

describe("QM-07 P2-4：拼装规范序单源（assembleQmBlocks 两出口一致）", () => {
  it("assembleUnitDoc：实体块按规范序空行分隔（材料 → 组 → 题）", () => {
    const doc = assembleUnitDoc("u1", {
      materials: ["::::material{id=m1}\n正文\n::::"],
      groups: ["::::group{id=g1}\n::ref{question=q-1}\n::::"],
      questions: ["::::question{id=q-1 type=judge}\n判断。[[]]\n::::"],
    });
    const lines = doc.split("\n");
    // 材料块与组块之间、组块与题块之间各恰一空行（与 exportUnitMd 同规范序）
    const matEnd = lines.indexOf("::::");
    expect(lines[matEnd + 1]).toBe("");
    expect(lines[matEnd + 2]).toBe("::::group{id=g1}");
    const grpEnd = lines.indexOf("::::", matEnd + 2);
    expect(lines[grpEnd + 1]).toBe("");
    expect(lines[grpEnd + 2]).toContain("::::question");
  });

  it("rebuildUnitDoc：fragmentStartLine = 片段首行在重建文档中的实际行号", () => {
    const m1 = ["::::material{id=m1}", "正文", "::::"].join("\n");
    const m2 = ["::::material{id=m2}", "正文二", "::::"].join("\n");
    const rebuilt = rebuildUnitDoc({
      unitId: "u1",
      materials: [
        { id: "m1", sourceMd: m1 },
        { id: "m2", sourceMd: "旧片段" },
      ],
      groups: [],
      questions: [],
      targetId: "m2",
      submittedSourceMd: m2,
    });
    const lines = rebuilt.markdown.split("\n");
    expect(lines[rebuilt.fragmentStartLine - 1]).toBe("::::material{id=m2}");
  });

  it("exportUnitMd 正文段与 assembleQmBlocks 同源（两出口一致锁定）", () => {
    const db = createTestDb();
    // 专用单元：题块带显式引号 id（避免缺省 id 注入改写题块首行，锁定纯拼装口径）
    const md = [
      "---",
      "kind: practice",
      "unit: 拼装单元",
      "---",
      "",
      "# 拼装单元练习",
      "",
      '::::material{id=pz-mat-1}',
      "材料正文 {{pz-slot-1}}。",
      "::::",
      "",
      '::::group{id=pz-grp-1}',
      "::ref{material=pz-mat-1 slot=pz-slot-1}",
      '::ref{question=pz-q-1}',
      "::::",
      "",
      '::::question{id="pz-q-1" type=choice}',
      "根据材料回答。",
      "",
      "- [ ] 甲",
      "- [x] 乙",
      "::::",
      "",
    ].join("\n");
    commitImport(
      db,
      TEST_TEACHER_ID,
      { markdown: md, filename: "拼装单元.md" },
      undefined,
      undefined,
      true,
    );
    const material = getMaterial(db, TEST_TEACHER_ID, "pz-mat-1")?.sourceMd;
    const group = getQuestionGroup(db, TEST_TEACHER_ID, "pz-grp-1")?.sourceMd;
    const question = db
      .select({ sourceMd: questions.sourceMd })
      .from(questions)
      .where(
        and(
          eq(questions.teacherId, TEST_TEACHER_ID),
          eq(questions.unitId, "拼装单元"),
        ),
      )
      .all()[0]?.sourceMd;
    if (material === undefined || group === undefined || question === undefined) {
      throw new Error("拼装单元实体未落库");
    }
    const body = assembleQmBlocks({
      materials: [material],
      groups: [group],
      questions: [question],
    });
    const exported = exportUnitMd(db, TEST_TEACHER_ID, "拼装单元").markdown;
    expect(exported.endsWith(`${body}\n`)).toBe(true);
  });

  it("旧单元（无 QM 行）导出字节级不变（直接断言，非结构等值推演）", () => {
    const db = createTestDb();
    const md = [
      "---",
      "kind: practice",
      "unit: 旧单元",
      "---",
      "",
      "# 旧单元练习",
      "",
      "::::question{type=judge}",
      "判断。[[正确]]",
      "",
      "- [x] 对",
      "::::",
      "",
    ].join("\n");
    commitImport(
      db,
      TEST_TEACHER_ID,
      { markdown: md, filename: "旧单元.md" },
      undefined,
      undefined,
      true,
    );
    const exported = exportUnitMd(db, TEST_TEACHER_ID, "旧单元").markdown;
    expect(exported).toBe(
      [
        "---",
        'kind: practice',
        'unit: "旧单元"',
        "---",
        "",
        // 缺省 id 在导入时注入开围栏（单元slug-序号），导出原样保留
        '::::question{type=judge id="旧单元-1"}',
        "判断。[[正确]]",
        "",
        "- [x] 对",
        "::::",
        "",
      ].join("\n"),
    );
  });
});

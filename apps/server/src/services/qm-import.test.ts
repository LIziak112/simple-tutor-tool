import type { ImportPreviewData } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import {
  imports,
  materialRefs as materialRefsTable,
  materials,
  questionGroupMembers,
  questionGroups,
  questions,
  teachers,
} from "../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { HttpError } from "../lib/http-error.ts";
import { commitImport, previewImport } from "./content-service.ts";
import { getMaterial, getQuestionGroup } from "./material-repository.ts";

/**
 * tt-06b / QM-05 导入主链服务层测试（材料/组/引用）：
 * - 预览：材料/组计数与动作清单（题数口径不把父组/材料重复算题）、
 *   P2-2 题内块式 ::ref{question=} 预览警告、跨单元移动受影响引用警告；
 * - NEW_CONTENT_DISABLED 开关接线（NEW_CONTENT_ENABLED 缺省 false）；
 * - commit：材料/组/题引用索引同事务落库、缺省 id 规范化回写、
 *   失败回滚零残留（vi.mock 中途抛错）、同 ID 重导版本策略；
 * - UNKNOWN_MATERIAL_REF 教师域解析降级（文档外既有材料）；
 * - 导出重导往返稳定（按源文原样导出 → 重导同结构同 id）；
 * - 教师域隔离（同 id 双教师互不可见）。
 */

// saveQuestionGroupWithin 的 vi.mock 在文件底部注册（rollback 用例中途抛错，
// 其余用例走真实实现透传）

/** 基线 QM 文档：材料（缺省 id + 槽位 + seg）、组（材料/子题引用）、一道 choice */
const QM_MD = [
  "---",
  "kind: practice",
  "unit: 资料分析",
  "---",
  "",
  "# 资料分析练习",
  "",
  "::::material",
  "给定资料正文，含槽位 {{}}。",
  "",
  ":::seg",
  "首段。",
  ":::",
  "::::",
  "",
  "::::group{label=1～1}",
  "::ref{material=mat-资料分析-1 slot=slot-1}",
  "::ref{question=资料分析-1}",
  "::::",
  "",
  "::::question{type=choice difficulty=2}",
  "根据材料回答。",
  "",
  "- [ ] 甲",
  "- [x] 乙",
  "::::",
  "",
].join("\n");

/** 第二位教师（隔离测试） */
const TEACHER_B_ID = "teacher-b-qm05";

function seedTeacherB(db: Db): void {
  db.insert(teachers)
    .values({
      id: TEACHER_B_ID,
      loginName: "teacher-b-qm05",
      isAdmin: false,
      disabledAt: null,
      passwordHash: null,
      apiToken: null,
      createdAt: "2026-10-24T08:00:00.000Z",
    })
    .run();
}

function previewQm(
  db: Db,
  markdown: string,
  teacherId = TEST_TEACHER_ID,
): ImportPreviewData {
  return previewImport(
    db,
    teacherId,
    { markdown, filename: "资料分析.md" },
    undefined,
    true,
  );
}

function commitQm(
  db: Db,
  markdown: string,
  teacherId = TEST_TEACHER_ID,
): ReturnType<typeof commitImport> {
  return commitImport(
    db,
    teacherId,
    { markdown, filename: "资料分析.md" },
    undefined,
    undefined,
    true,
  );
}

describe("QM-05 导入预览：材料/组呈现与 P2-2 告警", () => {
  it("summary 携带材料/组计数；动作含 createMaterial/createGroup；题数不把材料/组重复算题", () => {
    const db = createTestDb();
    const preview = previewQm(db, QM_MD);
    expect(preview.summary.questionCount).toBe(1);
    expect(preview.summary.materialCount).toBe(1);
    expect(preview.summary.groupCount).toBe(1);
    const kinds = preview.actions.map((a) => a.kind);
    expect(kinds).toContain("createUnit");
    expect(kinds).toContain("createMaterial");
    expect(kinds).toContain("createGroup");
    const materialAction = preview.actions.find(
      (a) => a.kind === "createMaterial",
    );
    expect(materialAction?.unitId).toBe("资料分析");
    // 材料 title 无值 → id 兜底展示
    expect(materialAction?.title).toBe("材料 mat-资料分析-1");
  });

  it("P2-2：题内块式 ::ref{question=} 预览警告（不静默吞 stemMd）", () => {
    const db = createTestDb();
    const doc = QM_MD.replace(
      "根据材料回答。",
      "::ref{question=资料分析-1}\n根据材料回答。",
    );
    const preview = previewQm(db, doc);
    const warning = preview.warnings.find(
      (w) => w.code === "REF_QUESTION_IN_QUESTION",
    );
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("资料分析-1");
    // warning 不阻断：同文档 commit 照常成功（该行从题干排除、不建引用）
    const report = commitQm(db, doc);
    expect(report.questions.inserted).toBe(1);
  });

  it("重复导入：动作翻为 updateMaterial/updateGroup；材料/组重导恢复标注", () => {
    const db = createTestDb();
    commitQm(db, QM_MD);
    const preview = previewQm(db, QM_MD);
    const kinds = preview.actions.map((a) => a.kind);
    expect(kinds).toContain("updateUnit");
    expect(kinds).toContain("updateMaterial");
    expect(kinds).toContain("updateGroup");
    expect(preview.actions.every((a) => !a.restore)).toBe(true);
  });
});

describe("QM-05 NEW_CONTENT_DISABLED 发布开关", () => {
  it("开关关闭：含新指令的文档 preview/commit 均 403 NEW_CONTENT_DISABLED", () => {
    const db = createTestDb();
    expect(() =>
      previewImport(db, TEST_TEACHER_ID, {
        markdown: QM_MD,
        filename: "x.md",
      }),
    ).toThrowError(
      expect.objectContaining({
        status: 403,
        code: "NEW_CONTENT_DISABLED",
      }) satisfies Partial<HttpError>,
    );
    expect(() =>
      commitImport(db, TEST_TEACHER_ID, {
        markdown: QM_MD,
        filename: "x.md",
      }),
    ).toThrowError(HttpError);
    // 未写任何库行
    expect(db.select().from(questions).all()).toHaveLength(0);
    expect(db.select().from(materials).all()).toHaveLength(0);
  });

  it("开关关闭：旧七型文档不受影响（无新指令 → 不触发）", () => {
    const db = createTestDb();
    const legacy =
      "---\nkind: practice\nunit: 旧单元\n---\n\n# 标题\n\n::::question{type=fill difficulty=1}\n填 [[答案]]。\n::::\n";
    const preview = previewImport(db, TEST_TEACHER_ID, {
      markdown: legacy,
      filename: "旧.md",
    });
    expect(preview.summary.questionCount).toBe(1);
  });

  it("开关打开（newContentEnabled=true）：新指令文档照常导入", () => {
    const db = createTestDb();
    const report = commitQm(db, QM_MD);
    expect(report.materials).toEqual({ inserted: 1, updated: 0 });
    expect(report.groups).toEqual({ inserted: 1, updated: 0 });
  });
});

describe("QM-05 commit 落库与事务原子性", () => {
  it("材料/组/题级引用索引同事务落库；缺省 id 规范化回写进 sourceMd", () => {
    const db = createTestDb();
    const report = commitQm(db, QM_MD);
    expect(report.materials).toEqual({ inserted: 1, updated: 0 });
    expect(report.groups).toEqual({ inserted: 1, updated: 0 });

    const material = getMaterial(db, TEST_TEACHER_ID, "mat-资料分析-1");
    expect(material).not.toBeNull();
    // 规范化回写：缺省 id 已显式进 sourceMd（§5.2.3 回写=是）
    expect(material?.sourceMd).toContain("::::material{id=mat-资料分析-1}");
    expect(material?.sourceMd).toContain(":::seg{id=seg-1}");
    expect(material?.sourceMd).toContain("{{slot-1}}");
    expect(JSON.parse(material?.anchorsJson ?? "[]")).toEqual([
      { id: "seg-1", order: 0 },
    ]);
    expect(JSON.parse(material?.slotsJson ?? "[]")).toEqual([
      { id: "slot-1", slotKind: "choice", order: 0 },
    ]);

    const group = getQuestionGroup(db, TEST_TEACHER_ID, "grp-资料分析-1");
    expect(group).not.toBeNull();
    expect(group?.sourceMd).toContain("::::group{id=grp-资料分析-1");
    // 组成员与组材料引用索引
    const members = db
      .select()
      .from(questionGroupMembers)
      .where(eq(questionGroupMembers.groupId, "grp-资料分析-1"))
      .all();
    expect(members.map((m) => m.questionId)).toEqual(["资料分析-1"]);
    const groupRefs = db
      .select()
      .from(materialRefsTable)
      .where(
        and(
          eq(materialRefsTable.ownerKind, "group"),
          eq(materialRefsTable.ownerId, "grp-资料分析-1"),
        ),
      )
      .all();
    expect(groupRefs.map((r) => r.materialId)).toEqual(["mat-资料分析-1"]);

    // 题行：material_refs_json 无题级引用（本档引用在组上）→ NULL；
    // 题目 sourceMd 同样是解析自规范化后的文档
    const question = db
      .select()
      .from(questions)
      .where(eq(questions.id, "资料分析-1"))
      .get();
    expect(question?.materialRefsJson).toBeNull();
    expect(question?.version).toBe(1);
  });

  it("题级 ::ref：material_refs_json 与 material_refs 索引（ownerKind=question）落库", () => {
    const db = createTestDb();
    const doc = QM_MD.replace(
      "根据材料回答。",
      "::ref{material=mat-资料分析-1 segs=seg-1}\n根据材料回答。",
    );
    commitQm(db, doc);
    const question = db
      .select()
      .from(questions)
      .where(eq(questions.id, "资料分析-1"))
      .get();
    expect(JSON.parse(question?.materialRefsJson ?? "null")).toEqual([
      { material: "mat-资料分析-1", segs: "seg-1" },
    ]);
    const refs = db
      .select()
      .from(materialRefsTable)
      .where(
        and(
          eq(materialRefsTable.ownerKind, "question"),
          eq(materialRefsTable.ownerId, "资料分析-1"),
        ),
      )
      .all();
    expect(refs.map((r) => r.materialId)).toEqual(["mat-资料分析-1"]);
  });

  it("事务回滚：组保存中途抛错 → 题目/材料/索引/imports 零残留", async () => {
    const db = createTestDb();
    const { saveQuestionGroupWithin } = await import(
      "./material-repository.ts"
    );
    vi.mocked(saveQuestionGroupWithin).mockImplementationOnce(() => {
      throw new Error("模拟组保存中途失败");
    });
    expect(() => commitQm(db, QM_MD)).toThrowError("模拟组保存中途失败");
    expect(db.select().from(questions).all()).toHaveLength(0);
    expect(db.select().from(materials).all()).toHaveLength(0);
    expect(db.select().from(questionGroups).all()).toHaveLength(0);
    expect(db.select().from(questionGroupMembers).all()).toHaveLength(0);
    expect(db.select().from(materialRefsTable).all()).toHaveLength(0);
    expect(db.select().from(imports).all()).toHaveLength(0);
  });

  it("同 ID 重导版本策略：材料 sourceMd 不变 version 保持、变更 +1；题目恒 +1", () => {
    const db = createTestDb();
    commitQm(db, QM_MD);
    // 原文重导：规范化后 sourceMd 相同 → 材料版本不动；题目 +1（既有口径）
    const again = commitQm(db, QM_MD);
    expect(again.materials).toEqual({ inserted: 0, updated: 1 });
    expect(again.groups).toEqual({ inserted: 0, updated: 1 });
    expect(again.questions).toEqual({ inserted: 0, updated: 1 });
    expect(getMaterial(db, TEST_TEACHER_ID, "mat-资料分析-1")?.version).toBe(1);
    expect(
      db.select().from(questions).where(eq(questions.id, "资料分析-1")).get()
        ?.version,
    ).toBe(2);
    // 内容变更 → 材料 version+1
    commitQm(db, QM_MD.replace("给定资料正文", "修改后的给定资料正文"));
    expect(getMaterial(db, TEST_TEACHER_ID, "mat-资料分析-1")?.version).toBe(2);
  });
});

describe("QM-05 引用解析与跨单元移动", () => {
  it("UNKNOWN_MATERIAL_REF 教师域降级：题引用库内既有材料（他文档导入）不再报错", () => {
    const db = createTestDb();
    commitQm(db, QM_MD);
    // 新文档（另一单元）的题引用既有材料，但文档本身不声明该材料
    const doc = [
      "---",
      "kind: practice",
      "unit: 引用单元",
      "---",
      "",
      "# 引用练习",
      "",
      "::::question{type=choice difficulty=1}",
      "::ref{material=mat-资料分析-1}",
      "跨文档引用材料作答。",
      "",
      "- [ ] 甲",
      "- [x] 乙",
      "::::",
      "",
    ].join("\n");
    const preview = previewQm(db, doc);
    expect(
      preview.issues.filter((i) => i.code === "UNKNOWN_MATERIAL_REF"),
    ).toEqual([]);
    const report = commitQm(db, doc);
    expect(report.questions.inserted).toBe(1);
  });

  it("UNKNOWN_MATERIAL_REF 不可解析仍报错（教师域内无此材料）", () => {
    const db = createTestDb();
    const doc = QM_MD.replace(
      "::ref{material=mat-资料分析-1 slot=slot-1}",
      "::ref{material=mat-不存在 slot=slot-1}",
    );
    const preview = previewQm(db, doc);
    expect(
      preview.issues.some(
        (i) => i.code === "UNKNOWN_MATERIAL_REF" && i.level === "error",
      ),
    ).toBe(true);
    expect(() => commitQm(db, doc)).toThrowError(HttpError);
  });

  it("跨单元移动：预览警告受影响引用；commit 后材料归属新单元", () => {
    const db = createTestDb();
    commitQm(db, QM_MD);
    const movedDoc = QM_MD.replace("unit: 资料分析", "unit: 目标单元").replace(
      /资料分析/g,
      "目标单元",
    );
    // 同 id 材料（mat-目标单元-1 是新 id——换名重导不是移动；用不改 id 的文档测）
    // 改用：保留材料显式 id 的跨单元文档
    const movedExplicit = [
      "---",
      "kind: practice",
      "unit: 目标单元",
      "---",
      "",
      "# 目标单元练习",
      "",
      "::::material{id=mat-资料分析-1}",
      "给定资料正文，含槽位 {{slot-1}}。",
      "::::",
      "",
      "::::group{id=grp-资料分析-1}",
      "::ref{material=mat-资料分析-1 slot=slot-1}",
      "::ref{question=目标单元-1}",
      "::::",
      "",
      "::::question{type=choice difficulty=2}",
      "根据材料回答。",
      "",
      "- [ ] 甲",
      "- [x] 乙",
      "::::",
      "",
    ].join("\n");
    const movedPreview = previewQm(db, movedExplicit);
    const warning = movedPreview.warnings.find(
      (w) => w.code === "MATERIAL_MOVED_ACROSS_UNITS",
    );
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("目标单元");
    commitQm(db, movedExplicit);
    expect(getMaterial(db, TEST_TEACHER_ID, "mat-资料分析-1")?.unitId).toBe(
      "目标单元",
    );
    // previewQm(movedDoc) 的换名文档是新 id 新材料——不产生移动警告
    expect(
      previewQm(db, movedDoc).warnings.find(
        (w) => w.code === "MATERIAL_MOVED_ACROSS_UNITS",
      ),
    ).toBeUndefined();
  });

  it("教师域隔离：乙导入同名材料不并入甲域；乙解析不了甲的材料引用", () => {
    const db = createTestDb();
    seedTeacherB(db);
    commitQm(db, QM_MD);
    // 乙导入自己的同 id 文档 → 各自独立行
    const reportB = commitQm(db, QM_MD, TEACHER_B_ID);
    expect(reportB.materials?.inserted).toBe(1);
    const materialA = getMaterial(db, TEST_TEACHER_ID, "mat-资料分析-1");
    const materialB = getMaterial(db, TEACHER_B_ID, "mat-资料分析-1");
    expect(materialA?.teacherId).toBe(TEST_TEACHER_ID);
    expect(materialB?.teacherId).toBe(TEACHER_B_ID);
    // 乙域无既有材料：引用未声明材料照报错
    const docB = [
      "---",
      "kind: practice",
      "unit: 乙单元",
      "---",
      "",
      "# 乙练习",
      "",
      "::::question{type=choice difficulty=1}",
      "::ref{material=mat-甲独有}",
      "引用甲的材料。",
      "",
      "- [ ] 甲",
      "- [x] 乙",
      "::::",
      "",
    ].join("\n");
    const previewB = previewQm(db, docB, TEACHER_B_ID);
    expect(previewB.issues.some((i) => i.code === "UNKNOWN_MATERIAL_REF")).toBe(
      true,
    );
  });
});

describe("QM-05 导出重导往返稳定", () => {
  /** 按源文原样导出（§5.2.5-3）：frontmatter + 材料源文 + 组源文 + 题目源文（文档序） */
  function exportUnitMd(db: Db, unitId: string, teacherId: string): string {
    const unitMaterials = db
      .select()
      .from(materials)
      .where(
        and(eq(materials.teacherId, teacherId), eq(materials.unitId, unitId)),
      )
      .all()
      .sort((a, b) => a.order - b.order);
    const unitGroups = db
      .select()
      .from(questionGroups)
      .where(
        and(
          eq(questionGroups.teacherId, teacherId),
          eq(questionGroups.unitId, unitId),
        ),
      )
      .all()
      .sort((a, b) => a.order - b.order);
    const unitQuestions = db
      .select()
      .from(questions)
      .where(
        and(eq(questions.teacherId, teacherId), eq(questions.unitId, unitId)),
      )
      .all()
      .sort((a, b) => a.order - b.order);
    return [
      "---",
      "kind: practice",
      `unit: ${unitId}`,
      "---",
      "",
      `# ${unitId}`,
      "",
      ...unitMaterials.map((m) => `${m.sourceMd}\n`),
      ...unitGroups.map((g) => `${g.sourceMd}\n`),
      ...unitQuestions.map((q) => `${q.sourceMd}\n`),
    ].join("\n");
  }

  it("MD→commit→导出→重导→再导出：同结构同 id，材料版本不动，导出逐字节稳定", () => {
    const db = createTestDb();
    commitQm(db, QM_MD);

    const exported1 = exportUnitMd(db, "资料分析", TEST_TEACHER_ID);
    // 重导（规范化后与库内 sourceMd 一致 → 版本不动）
    commitQm(db, exported1);
    const material = getMaterial(db, TEST_TEACHER_ID, "mat-资料分析-1");
    expect(material?.version).toBe(1);
    expect(JSON.parse(material?.slotsJson ?? "[]")).toEqual([
      { id: "slot-1", slotKind: "choice", order: 0 },
    ]);
    expect(JSON.parse(material?.anchorsJson ?? "[]")).toEqual([
      { id: "seg-1", order: 0 },
    ]);
    const group = getQuestionGroup(db, TEST_TEACHER_ID, "grp-资料分析-1");
    expect(JSON.parse(group?.materialRefsJson ?? "[]")).toEqual([
      { material: "mat-资料分析-1", slot: "slot-1" },
    ]);
    expect(JSON.parse(group?.questionIdsJson ?? "[]")).toEqual(["资料分析-1"]);

    // 再导出：与首次导出逐字节一致（round-trip 稳定）
    const exported2 = exportUnitMd(db, "资料分析", TEST_TEACHER_ID);
    expect(exported2).toBe(exported1);
  });
});

// ---- vi.mock 注册（saveQuestionGroupWithin 默认透传真实实现） ----
vi.mock("./material-repository.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./material-repository.ts")>();
  return {
    ...actual,
    saveQuestionGroupWithin: vi.fn(actual.saveQuestionGroupWithin),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("QM-05 材料含媒体的往返（媒体存在性 + 导出重导不丢）", () => {
  /** 材料正文带 ::image（已上传的内容寻址路径形态）的 QM 文档 */
  const QM_MD_WITH_IMAGE = QM_MD.replace(
    "给定资料正文，含槽位 {{}}。",
    '给定资料正文，含槽位 {{}} 与插图。\n\n::image{src="blobs/media/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png" width=320}',
  );

  it("材料 mediaPaths 落库；导出重导后 mediaPaths 不丢（src 在材料源文原样保留）", async () => {
    const db = createTestDb();
    commitQm(db, QM_MD_WITH_IMAGE);
    const material = getMaterial(db, TEST_TEACHER_ID, "mat-资料分析-1");
    expect(material?.mediaPathsJson).toContain("blobs/media/");
    expect(material?.sourceMd).toContain('::image{src="blobs/media/');

    // 导出重导：真实 exportUnitMd 覆盖材料正文（含 ::image 行）
    const { exportUnitMd } = await import("./library-service.ts");
    const exported = exportUnitMd(db, TEST_TEACHER_ID, "资料分析");
    expect(exported.markdown).toContain('::image{src="blobs/media/');
    commitQm(db, exported.markdown);
    const again = getMaterial(db, TEST_TEACHER_ID, "mat-资料分析-1");
    expect(again?.mediaPathsJson).toBe(material?.mediaPathsJson);
    expect(again?.sourceMd).toBe(material?.sourceMd);
  });

  it("媒体存在性核对覆盖材料内 ::image（缺失 → IMAGE_SRC_NOT_FOUND warning，不阻断）", () => {
    const db = createTestDb();
    const preview = previewImport(
      db,
      TEST_TEACHER_ID,
      { markdown: QM_MD_WITH_IMAGE, filename: "资料分析.md" },
      // 传真实 dataDir（临时目录里没有该图）→ 材料内 ::image 报缺失 warning
      import.meta.dirname,
      true,
    );
    const missing = preview.issues.find(
      (issue) => issue.code === "IMAGE_SRC_NOT_FOUND",
    );
    expect(missing).toBeDefined();
    // warning 级：commit 照常成功（先导 md 后补图的工作流）
    const report = commitImport(
      db,
      TEST_TEACHER_ID,
      { markdown: QM_MD_WITH_IMAGE, filename: "资料分析.md" },
      import.meta.dirname,
      undefined,
      true,
    );
    expect(report.materials?.inserted).toBe(1);
  });
});

describe("QM-05 ZIP 链路（新内容闸门同样生效）", () => {
  it("previewZipImport 对 QM 文档在开关关闭时 403 NEW_CONTENT_DISABLED；开启后正常预览", async () => {
    const db = createTestDb();
    const { ZipArchive } = await import("archiver");
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const chunks: Buffer[] = [];
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.append(Buffer.from(QM_MD, "utf8"), { name: "资料分析.md" });
    await archive.finalize();
    const zipBytes = Buffer.concat(chunks);
    const { decodeImportZipBase64, previewZipImport, unpackImportZip } =
      await import("./zip-import-service.ts");
    // 生产链路两步：base64 解码（路由入口）→ 解包出 bundle（mdFiles 等）
    const bundle = unpackImportZip(
      decodeImportZipBase64(zipBytes.toString("base64"), "资料分析.zip"),
    );
    // 开关关闭（缺省）：QM 文档 403
    const run = { bundle, folderId: null, zipName: "资料分析.zip" };
    expect(() => previewZipImport(db, TEST_TEACHER_ID, run)).toThrowError(
      expect.objectContaining({
        status: 403,
        code: "NEW_CONTENT_DISABLED",
      }) satisfies Partial<HttpError>,
    );
    // 开关打开：预览正常（summary 材料计数可见）
    process.env.NEW_CONTENT_ENABLED = "true";
    try {
      const report = previewZipImport(db, TEST_TEACHER_ID, run);
      const file = report.files[0];
      expect(file?.summary.materialCount).toBe(1);
      expect(file?.summary.groupCount).toBe(1);
    } finally {
      delete process.env.NEW_CONTENT_ENABLED;
    }
  });
});

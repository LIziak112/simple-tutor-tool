import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { QuestionAnswers } from "@tutor/contract";
import {
  learningPackExportRequestSchema,
  learningPackV2Schema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import { annotationBases as annotationBasesTable } from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import {
  frozenDraftAttempt,
  snapshotJsonOf,
  submitAttemptStatus,
} from "../test/evidence-fixtures.ts";
import { gzipJson, makeNotePng, makeStudent } from "../test/note-fixtures.ts";
import { unzipEntries } from "../test/unzip.ts";
import {
  assembleAnnotationBase,
  canonicalAnnotationJson,
  putAnnotationDoc,
  registerBaseImage,
  sealAttemptAnnotations,
} from "./annotation-service.ts";
import { buildLearningPackZip } from "./export-service.ts";
import { assembleReviewPack, zipReviewPack } from "./review-pack-service.ts";

/**
 * T6R.20 导出装配测试（review-pack 与学情数据包 v2 的 annotation kind 扩展）：
 * - 成对文件：annotation/aNNN-base.png（原字节）＋ aNNN-strokes.json（规范化
 *   JSON 文本）进 zip 与 manifest（kind=annotation）；
 * - 底图缺失：整对进 manifest.missing（kind=annotation），zip 无半对——
 *   绝不导出孤立的圈；
 * - 预览附件：底图 PNG 附角色化 downloadUrl（学生/教师直出端点）；
 * - v1 学情包与未勾 evidence 的 v2：零标注条目（「未选模块不夹带内容」）。
 */

const SENTINELS = {
  answer: "42",
  solution: "哨兵解析：先算括号内再取相反数",
} as const;
const Q = "标注导出题-1";
const UNIT = "unit-ann";

/** 建世界＋单题卷（draft）——makeWorld 后必须先调用本函数 */
function makePaper(
  db: Db,
  studentId: string,
): { attemptId: string; revisionId: string } {
  const stemMd = `计算 $(-3)+7-(-2)$，填在括号里：[[${SENTINELS.answer}]]`;
  const { attemptId, rowIds } = frozenDraftAttempt(
    db,
    studentId,
    [
      {
        questionId: Q,
        snapshotJson: snapshotJsonOf({
          id: Q,
          stemMd,
          answers: {
            kind: "fill",
            blanks: [[SENTINELS.answer]],
          } satisfies QuestionAnswers,
          solutionMd: SENTINELS.solution,
          hints: [],
        }),
        unitId: UNIT,
      },
    ],
    { attemptUnitId: UNIT },
  );
  return { attemptId, revisionId: rowIds[0] ?? "" };
}

function annotationDoc(height = 900): {
  version: number;
  baseWidth: number;
  baseHeight: number;
  strokes: Array<{
    tool: string;
    color: string;
    weight: number;
    points: Array<{ x: number; y: number; p: number; t: number }>;
  }>;
} {
  return {
    version: 1,
    baseWidth: 1440,
    baseHeight: height,
    strokes: [
      {
        tool: "pen",
        color: "#c0392b",
        weight: 6,
        points: [
          { x: 10, y: 20, p: 0.5, t: 0 },
          { x: 40, y: 60, p: 0.8, t: 25 },
        ],
      },
    ],
  };
}

/** 建世界→建卷→（可选）落一份已封存 scratch 标注→交卷 */
function makeAnnotatedWorld(options: { withAnnotation?: boolean } = {}): {
  world: { db: Db; dataDir: string; studentId: string };
  attemptId: string;
  revisionId: string;
} {
  const db = createTestDb();
  const dataDir = createTestDir();
  const studentId = makeStudent(db);
  const { attemptId, revisionId } = makePaper(db, studentId);
  if (options.withAnnotation !== false) {
    const preview = assembleAnnotationBase(db, studentId, attemptId, Q);
    registerBaseImage(
      db,
      dataDir,
      studentId,
      attemptId,
      Q,
      makeNotePng(1440, 900),
      {
        questionRevisionId: revisionId,
        baseRenderVersion: preview.baseRenderVersion,
        phase: "scratch",
      },
    );
    putAnnotationDoc(
      db,
      dataDir,
      studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc()),
      {
        baseRevision: 0,
        mutationId: randomUUID(),
      },
    );
  }
  submitAttemptStatus(db, attemptId);
  sealAttemptAnnotations(db, studentId, attemptId);
  return { world: { db, dataDir, studentId }, attemptId, revisionId };
}

describe("review-pack 的 annotation 成对附件", () => {
  it("学生包：zip 含成对文件（原字节/规范化 JSON）；manifest 与附件清单一致", async () => {
    const { world, attemptId } = makeAnnotatedWorld();
    const assembly = assembleReviewPack(
      world.db,
      world.dataDir,
      { kind: "student", id: world.studentId },
      attemptId,
      Q,
    );
    // manifest：两行 kind=annotation（base.png + strokes.json）
    const annFiles = assembly.manifest.files.filter(
      (file) => file.kind === "annotation",
    );
    expect(annFiles.map((file) => file.path).sort()).toEqual([
      "annotation/a001-base.png",
      "annotation/a001-strokes.json",
    ]);
    // 附件：底图 PNG ready＋学生直出 URL（strokes.json 非图片不设逐张下载）
    const annAttachments = assembly.attachments.filter(
      (att) => att.kind === "annotation",
    );
    expect(annAttachments).toHaveLength(1);
    expect(annAttachments[0]?.state).toBe("ready");
    expect(annAttachments[0]?.downloadUrl).toBe(
      `/api/student/attempts/${attemptId}/annotation-base/${assembly.annotationPairs[0]?.baseId}/image.png`,
    );

    const zipBytes = await zipReviewPack(assembly);
    const entries = unzipEntries(zipBytes);
    const baseEntry = entries.get("annotation/a001-base.png");
    expect(baseEntry).toEqual(Buffer.from(makeNotePng(1440, 900)));
    const strokesEntry = entries.get("annotation/a001-strokes.json");
    expect(strokesEntry).toBeDefined();
    expect(JSON.parse(strokesEntry?.toString("utf8") ?? "null")).toEqual(
      JSON.parse(
        canonicalAnnotationJson(
          annotationDoc() as Parameters<typeof canonicalAnnotationJson>[0],
        ),
      ),
    );
    // 学生包文件名与内容不含答案哨兵（stem 投影底图 + 笔迹矢量）
    const strokesText = strokesEntry?.toString("utf8") ?? "";
    expect(strokesText).not.toContain(SENTINELS.answer);
    expect(strokesText).not.toContain(SENTINELS.solution);
  });

  it("教师包：底图附件走教师直出端点", () => {
    const { world, attemptId } = makeAnnotatedWorld();
    const assembly = assembleReviewPack(
      world.db,
      world.dataDir,
      { kind: "teacher", id: TEST_TEACHER_ID },
      attemptId,
      Q,
    );
    const ann = assembly.attachments.find((att) => att.kind === "annotation");
    expect(ann?.downloadUrl).toMatch(
      /^\/api\/teacher\/annotation-bases\/.+\/image\.png$/,
    );
  });

  it("底图文件丢失：整对进缺失清单（kind=annotation），zip 无半对、complete=false", async () => {
    const { world, attemptId } = makeAnnotatedWorld();
    const baseRow = world.db
      .select()
      .from(annotationBasesTable)
      .where(eq(annotationBasesTable.attemptId, attemptId))
      .get();
    expect(baseRow?.imagePath).not.toBeNull();
    if (baseRow?.imagePath !== undefined && baseRow.imagePath !== null) {
      rmSync(join(world.dataDir, baseRow.imagePath));
    }
    const assembly = assembleReviewPack(
      world.db,
      world.dataDir,
      { kind: "student", id: world.studentId },
      attemptId,
      Q,
    );
    expect(
      assembly.manifest.files.filter((file) => file.kind === "annotation"),
    ).toHaveLength(0);
    const miss = assembly.manifest.missing.find((m) => m.kind === "annotation");
    expect(miss?.path).toBe("annotation/a001-base.png");
    expect(miss?.reason).toContain("底图");
    expect(assembly.preview.complete).toBe(false);
    // 附件呈现缺失态
    const ann = assembly.attachments.find((att) => att.kind === "annotation");
    expect(ann?.state).toBe("missing");

    const zipBytes = await zipReviewPack(assembly);
    const entries = unzipEntries(zipBytes);
    expect(entries.has("annotation/a001-base.png")).toBe(false);
    expect(entries.has("annotation/a001-strokes.json")).toBe(false);
  });

  it("未封存（进行中）标注不进包；无标注卷零 annotation 条目", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const studentId = makeStudent(db);
    const { attemptId } = makePaper(db, studentId);
    // 建 base + 落墨但不 seal、不交卷
    const preview = assembleAnnotationBase(db, studentId, attemptId, Q);
    registerBaseImage(
      db,
      dataDir,
      studentId,
      attemptId,
      Q,
      makeNotePng(1440, 900),
      {
        questionRevisionId: preview.questionRevisionId,
        baseRenderVersion: 1,
        phase: "scratch",
      },
    );
    putAnnotationDoc(
      db,
      dataDir,
      studentId,
      attemptId,
      Q,
      gzipJson(annotationDoc()),
      {
        baseRevision: 0,
        mutationId: randomUUID(),
      },
    );
    const assembly = assembleReviewPack(
      db,
      dataDir,
      { kind: "teacher", id: TEST_TEACHER_ID },
      attemptId,
      Q,
    );
    expect(assembly.annotationPairs).toHaveLength(0);
    expect(
      assembly.manifest.files.filter((file) => file.kind === "annotation"),
    ).toHaveLength(0);
    expect(assembly.preview.complete).toBe(true);
  });
});

describe("学情数据包 v2 的 annotation 成对附件", () => {
  function v2Request(
    studentId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return learningPackExportRequestSchema.parse({
      packVersion: 2,
      scope: { studentIds: [studentId] },
      modules: { responses: true, evidence: true },
      goal: "diagnose-weakness",
      ...overrides,
    });
  }

  it("v2＋evidence：manifest 含成对文件、zip 原字节一致、contextNotes 说明口径", async () => {
    const { world } = makeAnnotatedWorld();
    const zip = await buildLearningPackZip(
      world.db,
      world.dataDir,
      TEST_TEACHER_ID,
      v2Request(world.studentId),
    );
    const entries = unzipEntries(zip.bytes);
    const packText = entries.get("pack.json")?.toString("utf8") ?? "";
    const pack = learningPackV2Schema.parse(JSON.parse(packText));
    const annFiles = pack.manifest.files.filter(
      (file) => file.kind === "annotation",
    );
    expect(annFiles.map((file) => file.path).sort()).toEqual([
      "annotation/a001-base.png",
      "annotation/a001-strokes.json",
    ]);
    expect(
      pack.manifest.contextNotes.some((note) => note.includes("题干标注")),
    ).toBe(true);
    expect(entries.get("annotation/a001-base.png")).toEqual(
      Buffer.from(makeNotePng(1440, 900)),
    );
    const strokes = entries
      .get("annotation/a001-strokes.json")
      ?.toString("utf8");
    expect(JSON.parse(strokes ?? "null").baseWidth).toBe(1440);
  });

  it("v2＋evidence：底图缺失的标注对 refs 关联对应 questionRef（审查修复 12）", async () => {
    const { world, attemptId } = makeAnnotatedWorld();
    // 删除底图文件（保留行）→ 整对进缺失清单
    const baseRow = world.db
      .select()
      .from(annotationBasesTable)
      .where(eq(annotationBasesTable.attemptId, attemptId))
      .get();
    expect(baseRow).toBeDefined();
    if (baseRow?.imagePath !== undefined && baseRow.imagePath !== null) {
      rmSync(join(world.dataDir, baseRow.imagePath));
    }
    // 勾 questions（stem 层）：refs 可解析到包内 q 条目——悬空引用形态
    // （questions 未勾）与 responses[].questionRef 同口径，由 contextNotes 声明
    const zip = await buildLearningPackZip(
      world.db,
      world.dataDir,
      TEST_TEACHER_ID,
      v2Request(world.studentId, {
        modules: { questions: "stem", responses: true, evidence: true },
      }),
    );
    const packText =
      unzipEntries(zip.bytes).get("pack.json")?.toString("utf8") ?? "";
    const pack = learningPackV2Schema.parse(JSON.parse(packText));
    const miss = pack.manifest.missing.find((m) => m.kind === "annotation");
    expect(miss).toBeDefined();
    // refs 指向该题的 q 条目（对齐 review-pack 单题侧口径），不再悬空 []
    expect(miss?.refs.length).toBeGreaterThan(0);
    expect(miss?.refs[0]).toMatch(/^q\d{3,}$/);
    // 引用的 q 条目真实在场（content.questions）
    const ref = miss?.refs[0] ?? "";
    expect(
      (pack.content?.questions ?? []).some((question) => question.ref === ref),
    ).toBe(true);
  });

  it("v1：零 annotation 条目（v1 不扩展——kind 只增不改，v1 消费方无感）", async () => {
    const { world } = makeAnnotatedWorld();
    const request = learningPackExportRequestSchema.parse({
      // v1 = 缺省 packVersion（z.literal(2).optional()——不带字段才是 v1）
      scope: { studentIds: [world.studentId] },
      modules: { responses: true },
      goal: "diagnose-weakness",
    });
    const zip = await buildLearningPackZip(
      world.db,
      world.dataDir,
      TEST_TEACHER_ID,
      request,
    );
    const entries = unzipEntries(zip.bytes);
    expect(
      [...entries.keys()].some((name) => name.startsWith("annotation/")),
    ).toBe(false);
    const packText = entries.get("pack.json")?.toString("utf8") ?? "";
    expect(packText).not.toContain('"annotation"');
  });

  it("v2 但未勾 evidence：零 annotation 条目（未选模块不夹带内容）", async () => {
    const { world } = makeAnnotatedWorld();
    const zip = await buildLearningPackZip(
      world.db,
      world.dataDir,
      TEST_TEACHER_ID,
      v2Request(world.studentId, { modules: { summaries: true } }),
    );
    const entries = unzipEntries(zip.bytes);
    expect(
      [...entries.keys()].some((name) => name.startsWith("annotation/")),
    ).toBe(false);
  });
});

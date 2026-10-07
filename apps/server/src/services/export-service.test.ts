import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { LearningPack, LearningPackExportRequest } from "@tutor/contract";
import {
  learningPackExportRequestSchema,
  learningPackSchema,
  learningPackV2Schema,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import {
  attempts,
  events as eventsTable,
  ink,
  lectures,
  noteImages as noteImagesTable,
  responses as responsesTable,
} from "../db/schema";
import { createTestDb, createTestDir, TEST_TEACHER_ID } from "../db/test-utils";
import { HttpError } from "../lib/http-error";
import {
  frozenDraftAttempt,
  snapshotJsonOf,
  submitAttemptStatus,
} from "../test/evidence-fixtures";
import {
  gzipJson,
  makeNotePng,
  makeStudent,
  noteDoc,
} from "../test/note-fixtures";
import {
  insertEvidence,
  setNoteSealedAt,
  setVersionSavedAt,
} from "../test/note-world";
import { unzipEntries } from "../test/unzip";
import { submitAttempt } from "./attempt-service";
import {
  assembleLearningPack,
  buildLearningPackZip,
  previewLearningPack,
} from "./export-service";
import { saveInk } from "./ink-service";
import { saveMedia } from "./media-service";
import {
  attachNoteImage,
  createCorrection,
  saveNoteVersion,
  sealCorrection,
} from "./note-service";
import { type SeedDemoResult, seedDemoData } from "./seed-demo";

/**
 * T4.3 学情数据包服务测试（Phase4 清单 §4 T4.3 验收原文）：用 seed-demo 种子
 * 数据跑通完整导出（解 zip 断言内部结构），覆盖——
 * - 模块勾选组合三例（全勾 / 仅题目+汇总 / 仅讲义大纲）：pack.json 的 section
 *   出现/缺席与 zip 文件清单；
 * - 化名贯穿（D16）：pack.json/summary.md 全文无真名、映射.txt 内容与顺序、
 *   ink 文件名化名；真实姓名开关时真名出现且无映射.txt；
 * - 历次口径（D15）：attemptNo 与首次标记（种子含重做 2 次）、sourceType；
 * - 50MB 预检（D18）：注入小上限触发超限（preview overLimit + 生成 413）；
 * - prompt 按模块拼装（D17）：未勾手写不提笔迹、自定义段附加；
 * - pack.json 通过自身 schema 校验；schema.json 与 schema:export 产物一致；
 * - 教师域隔离（D7）：乙勾甲学生/课程/作业/讲义 → 404 且不泄露。
 *
 * 夹具补充：种子不含笔迹（手写题未作答走待批），对作业 A2 的草稿补传一道
 * solve 笔迹后交卷，使 ink 模块有真实 PNG 可装配（saveInk + submitAttempt
 * 走既有服务链路）。
 */

/** 固定时间基准（与 analytics-service.test.ts 同款：周四 12:00 北京） */
const SEED_NOW = "2026-10-01T04:00:00.000Z";
/** 教师乙（域隔离用；服务层直接以 teacherId 区分域） */
const TEACHER_B_ID = "teacher-b-t43-000001";
/** 种子学生真名（化名贯穿断言的禁词表） */
const REAL_NAMES = ["陈小明", "李小红", "王小刚"] as const;

let db: Db;
let seed: SeedDemoResult;
let dataDir: string;
/** 补传笔迹后交卷的 A2 草稿 attempt（ink 装配夹具） */
let inkedAttemptId: string;
/** 补传的 PNG 字节（zip 内逐字节比对用） */
let inkPngBytes: Uint8Array;

/** 最小合法 PNG（与 export-csv.test.ts 同构造；服务端只校验魔数/IHDR） */
function fakePng(width = 320, height = 200): Uint8Array {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return new Uint8Array(buf);
}

/** 解包结果 → pack.json 经 schema 校验的 pack 对象（v1/v2 样板收敛，复审 D14） */
function packEntryOf<T>(
  entries: Map<string, Buffer>,
  schema: { parse: (value: unknown) => T },
): T {
  return schema.parse(
    JSON.parse(entries.get("pack.json")?.toString("utf8") ?? "{}"),
  );
}

/**
 * 请求体构造器（preview 与生成共用 schema；覆盖片段合并后整体再过一遍契约，
 * 输出类型即解析结果——缺省字段由 default 填充）。
 */
function makeRequest(
  overrides: Record<string, unknown> = {},
): LearningPackExportRequest {
  return learningPackExportRequestSchema.parse({
    scope: {
      studentIds: [
        seed.students.s1.id,
        seed.students.s2.id,
        seed.students.s3.id,
      ],
    },
    modules: {
      lectures: [
        { lectureId: seed.lectures.l1.id, sectionIndexes: [0] },
        { lectureId: seed.lectures.l2.id },
      ],
      questions: "solution",
      responses: true,
      summaries: true,
      ink: true,
      traces: true,
    },
    goal: "diagnose-weakness",
    ...overrides,
  });
}

beforeAll(async () => {
  db = createTestDb();
  dataDir = createTestDir();
  seed = await seedDemoData(db, TEST_TEACHER_ID, { now: SEED_NOW });

  // —— 夹具补充：A2 草稿补传 solve 笔迹后交卷（ink 模块有真实 PNG） ——
  const draft = db
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      and(
        eq(attempts.studentId, seed.students.s1.id),
        eq(attempts.assignmentId, seed.assignments.a2.id),
        eq(attempts.status, "draft"),
      ),
    )
    .get();
  if (draft === undefined) throw new Error("夹具缺少 A2 草稿 attempt");
  inkedAttemptId = draft.id;
  const doc = JSON.stringify({
    engine: "atrament",
    version: 1,
    data: { width: 1000, strokes: [] },
    updatedAt: 1727392800000,
  });
  const { gzipSync } = await import("node:zlib");
  inkPngBytes = fakePng();
  saveInk(
    db,
    dataDir,
    seed.students.s1.id,
    inkedAttemptId,
    seed.questions.u1q5,
    gzipSync(Buffer.from(doc, "utf8")),
    inkPngBytes,
  );
  submitAttempt(
    db,
    seed.students.s1.id,
    inkedAttemptId,
    "2026-09-30T08:00:00.000Z",
  );
});

describe("模块勾选组合：pack 结构与 zip 清单（D14/D19）", () => {
  it("全勾：content/attempts/traces/summary 全出现，zip 清单含映射与 ink", async () => {
    const zip = await buildLearningPackZip(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest(),
      {
        now: SEED_NOW,
      },
    );
    const entries = unzipEntries(zip.bytes);
    const pack: LearningPack = packEntryOf(entries, learningPackSchema);
    expect(pack.content?.lectures).toHaveLength(2);
    expect(pack.content?.questions?.length).toBeGreaterThan(0);
    expect(pack.attempts?.responses?.length).toBeGreaterThan(0);
    expect(pack.attempts?.summaries?.length).toBeGreaterThan(0);
    expect(pack.traces?.questions?.length).toBeGreaterThan(0);
    expect(pack.traces?.lectures?.length).toBeGreaterThan(0);
    expect(pack.summary?.overall.studentCount).toBe(3);
    // zip 清单：固定五文件 + ink 条目（化名模式含映射.txt）
    const names = [...entries.keys()];
    for (const fixed of [
      "pack.json",
      "summary.md",
      "prompt.md",
      "schema.json",
      "映射.txt",
    ]) {
      expect(names).toContain(fixed);
    }
    const inkNames = names.filter((name) => name.startsWith("ink/"));
    expect(inkNames).toHaveLength(1);
    expect(inkNames[0]).toMatch(/^ink\/学生A-.+\.png$/);
    // ink 逐字节一致（archiver file() 走文件系统）
    expect(
      entries.get(inkNames[0] ?? "")?.equals(Buffer.from(inkPngBytes)),
    ).toBe(true);
    // 下载文件名（北京时间戳）
    expect(zip.filename).toMatch(/^learning-pack-\d{8}-\d{6}\.zip$/);
  });

  it("勾选 ink 但快照文件已缺失：zip 宽松构建（条目缺席、不抛错）——v1 既有口径锁定（T6R.14 迁移护栏）", async () => {
    // ink 行在而 PNG 文件被外部删除（部署级损坏）：archiver 对读不到的文件
    // 只 emit warning 并跳过条目——v1 学情包是宽松语义（warning 非致命），
    // T6R.14 管道迁移到 lib/zip-write.zipBufferOf 时以 warningAsError:false
    // 保持。此测试在迁移前后都必须绿（行为锁，非驱动性红测试）。
    const row = db
      .select()
      .from(ink)
      .where(
        and(
          eq(ink.attemptId, inkedAttemptId),
          eq(ink.questionId, seed.questions.u1q5),
        ),
      )
      .get();
    if (row === undefined) throw new Error("夹具缺少 ink 行");
    const abs = resolve(dataDir, row.pngPath);
    const bytes = readFileSync(abs);
    try {
      rmSync(abs);
      const zip = await buildLearningPackZip(
        db,
        dataDir,
        TEST_TEACHER_ID,
        makeRequest(),
        { now: SEED_NOW },
      );
      const names = [...unzipEntries(zip.bytes).keys()];
      expect(names.filter((name) => name.startsWith("ink/"))).toEqual([]);
    } finally {
      writeFileSync(abs, bytes);
    }
  });

  it("仅题目+汇总：content.questions 与 attempts.summaries 出现，responses/traces 缺席", async () => {
    const assembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest({
        modules: { questions: "answer", summaries: true },
      }),
      { now: SEED_NOW },
    );
    const pack = learningPackSchema.parse(JSON.parse(assembly.packJson));
    expect(pack.content?.questions).toBeDefined();
    expect(pack.content?.lectures).toBeUndefined();
    expect(pack.attempts?.summaries?.length).toBeGreaterThan(0);
    expect(pack.attempts?.responses).toBeUndefined();
    expect(pack.traces).toBeUndefined();
    expect(pack.summary).toBeDefined(); // 汇总勾选 → summary section 出现
    // zip 清单：无 ink 条目
    expect(
      assembly.files
        .map((file) => file.path)
        .some((path) => path.startsWith("ink/")),
    ).toBe(false);
  });

  it("仅讲义大纲：content.lectures 出现、其余 section 全缺席、无 summary", async () => {
    const assembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest({
        modules: { lectures: [{ lectureId: seed.lectures.l1.id }] },
      }),
      { now: SEED_NOW },
    );
    const pack = learningPackSchema.parse(JSON.parse(assembly.packJson));
    expect(pack.content?.lectures).toHaveLength(1);
    expect(pack.content?.lectures?.[0]?.sections).toEqual([]); // 仅大纲
    expect(pack.content?.lectures?.[0]?.outline.length).toBe(4); // 第1讲 四节
    expect(pack.content?.questions).toBeUndefined();
    expect(pack.attempts).toBeUndefined();
    expect(pack.traces).toBeUndefined();
    expect(pack.summary).toBeUndefined();
    // summary.md 只含讲义清单段，不含作答段
    expect(assembly.summaryMd).toContain("## 讲义");
    expect(assembly.summaryMd).not.toContain("## 作答汇总");
    expect(assembly.summaryMd).not.toContain("## 逐题作答");
  });

  it("讲义勾选小节全文：sections 含标题行与正文", async () => {
    const assembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest({
        modules: {
          lectures: [{ lectureId: seed.lectures.l1.id, sectionIndexes: [0] }],
        },
      }),
      { now: SEED_NOW },
    );
    const pack = learningPackSchema.parse(JSON.parse(assembly.packJson));
    const sections = pack.content?.lectures?.[0]?.sections ?? [];
    expect(sections).toHaveLength(1);
    expect(sections[0]?.headingIndex).toBe(0);
    expect(sections[0]?.markdown).toContain("## 一、正数与负数");
    expect(sections[0]?.markdown).toContain("零既不是正数，也不是负数");
  });

  it("题目三层：stem 层题干隐去答案标记，solution 层含答案与详解", async () => {
    const stemAssembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest({ modules: { questions: "stem" } }),
      { now: SEED_NOW },
    );
    const stemPack = learningPackSchema.parse(
      JSON.parse(stemAssembly.packJson),
    );
    for (const question of stemPack.content?.questions ?? []) {
      expect(question.stemMd).not.toMatch(/\[\[(?!])(?!\]\]).+?\]\]/); // [[答案]] 已公开化
      expect(question.answers).toBeUndefined();
      expect(question.solutionMd).toBeUndefined();
    }
    const fullAssembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest({ modules: { questions: "solution" } }),
      { now: SEED_NOW },
    );
    const fullPack = learningPackSchema.parse(
      JSON.parse(fullAssembly.packJson),
    );
    const fill = fullPack.content?.questions?.find(
      (question) => question.type === "fill",
    );
    expect(fill?.stemMd).toContain("[[4]]");
    expect(fill?.answers).toBeDefined();
    const solveWithSolution = fullPack.content?.questions?.find(
      (question) => question.solutionMd !== undefined,
    );
    expect(solveWithSolution?.solutionMd?.length).toBeGreaterThan(0);
  });
});

describe("化名贯穿（D16）", () => {
  it("化名模式：pack.json/summary.md 全文无真名；映射.txt 顺序正确；ink 文件名化名", async () => {
    const zip = await buildLearningPackZip(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest(),
      {
        now: SEED_NOW,
      },
    );
    const entries = unzipEntries(zip.bytes);
    const packJson = entries.get("pack.json")?.toString("utf8") ?? "";
    const summaryMd = entries.get("summary.md")?.toString("utf8") ?? "";
    const promptMd = entries.get("prompt.md")?.toString("utf8") ?? "";
    for (const text of [packJson, summaryMd, promptMd]) {
      for (const name of REAL_NAMES) {
        expect(text).not.toContain(name);
      }
    }
    // 学生行：化名 + id，请求名单顺序编号
    const pack = learningPackSchema.parse(JSON.parse(packJson));
    expect(pack.students.map((student) => student.name)).toEqual([
      "学生A",
      "学生B",
      "学生C",
    ]);
    // 映射.txt：化名 ↔ 真名，顺序与请求名单一致；不进 pack.json
    const mapping = entries.get("映射.txt")?.toString("utf8") ?? "";
    expect(mapping).toContain("学生A = 陈小明");
    expect(mapping).toContain("学生B = 李小红");
    expect(mapping).toContain("学生C = 王小刚");
    expect(mapping.indexOf("学生A")).toBeLessThan(mapping.indexOf("学生B"));
    expect(packJson).not.toContain("映射");
  });

  it("真实姓名开关（anonymize=false）：真名出现、无映射.txt", async () => {
    const zip = await buildLearningPackZip(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest({ privacy: { anonymize: false } }),
      { now: SEED_NOW },
    );
    const entries = unzipEntries(zip.bytes);
    const packJson = entries.get("pack.json")?.toString("utf8") ?? "";
    expect(packJson).toContain("陈小明");
    expect(entries.has("映射.txt")).toBe(false);
  });
});

describe("历次口径（D15）", () => {
  it("attemptNo 与首次标记：陈小明课程 U1 三连做（1/2/3，首个 isFirst）", () => {
    const assembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest({
        scope: { studentIds: [seed.students.s1.id] },
        modules: { summaries: true },
      }),
      { now: SEED_NOW },
    );
    const pack = learningPackSchema.parse(JSON.parse(assembly.packJson));
    const courseRows = (pack.attempts?.summaries ?? []).filter(
      (row) => row.sourceType === "course" && row.unitId === seed.units.u1.id,
    );
    expect(courseRows.map((row) => row.attemptNo)).toEqual([1, 2, 3]);
    expect(courseRows.map((row) => row.isFirst)).toEqual([true, false, false]);
    const assignmentRows = pack.attempts?.summaries?.filter(
      (row) => row.sourceType === "assignment",
    );
    expect(
      assignmentRows?.every((row) => row.attemptNo === 1 && row.isFirst),
    ).toBe(true);
  });

  it("draft 不收录：汇总行全部已交卷（submittedAt 非空）", () => {
    const assembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest({ modules: { summaries: true } }),
      { now: SEED_NOW },
    );
    const pack = learningPackSchema.parse(JSON.parse(assembly.packJson));
    for (const row of pack.attempts?.summaries ?? []) {
      expect(row.submittedAt.length).toBeGreaterThan(0);
      expect(row.status).not.toBe("draft");
    }
  });
});

describe("50MB 预检（D18）", () => {
  it("注入小上限：preview 返回 overLimit 与精简提示；生成接口 413 EXPORT_TOO_LARGE", async () => {
    const options = { now: SEED_NOW, maxBytes: 1024 };
    const preview = previewLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest(),
      options,
    );
    expect(preview.overLimit).toBe(true);
    expect(preview.limitBytes).toBe(1024);
    expect(preview.totalEstimatedBytes).toBeGreaterThan(1024);
    expect(preview.hint).toContain("精简方向");
    await expect(
      buildLearningPackZip(
        db,
        dataDir,
        TEST_TEACHER_ID,
        makeRequest(),
        options,
      ),
    ).rejects.toMatchObject({
      status: 413,
      code: "EXPORT_TOO_LARGE",
    });
  });

  it("preview 文件清单与生成 zip 条目一致（正常上限）", async () => {
    const preview = previewLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest(),
      {
        now: SEED_NOW,
      },
    );
    expect(preview.overLimit).toBe(false);
    expect(preview.hint).toBeNull();
    const zip = await buildLearningPackZip(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest(),
      {
        now: SEED_NOW,
      },
    );
    const names = [...unzipEntries(zip.bytes).keys()].sort();
    expect(preview.files.map((file) => file.path).sort()).toEqual(names);
  });
});

describe("prompt 按模块拼装（D17）", () => {
  it("未勾手写：prompt.md 不提笔迹；自定义段附加", () => {
    const assembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest({
        modules: { questions: "stem", summaries: true },
        goal: "variant-practice",
        customPrompt: "重点看异号加法的符号处理。",
      }),
      { now: SEED_NOW },
    );
    expect(assembly.promptMd).not.toContain("ink/");
    expect(assembly.promptMd).toContain("内容 DSL v2");
    expect(assembly.promptMd).toContain("## 教师附加要求");
    expect(assembly.promptMd).toContain("重点看异号加法的符号处理。");
  });

  it("勾选手写：prompt.md 说明 ink 图片", () => {
    const assembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest({ modules: { ink: true, summaries: true } }),
      { now: SEED_NOW },
    );
    expect(assembly.promptMd).toContain("ink/*.png");
  });
});

describe("schema 一致性（D19）", () => {
  it("schema.json 与 pnpm schema:export 产物逐字节一致", () => {
    const assembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest(),
      { now: SEED_NOW },
    );
    const exported = readFileSync(
      new URL(
        "../../../../docs/dsl/schema/learning-pack.json",
        import.meta.url,
      ),
      "utf8",
    );
    expect(assembly.schemaJson).toBe(exported);
  });
});

describe("教师域隔离（D7）", () => {
  it("乙勾甲学生/课程/作业/讲义 → 404 且错误码不泄露存在性", () => {
    const expectNotFound = (
      request: LearningPackExportRequest,
      code: string,
    ): void => {
      try {
        assembleLearningPack(db, dataDir, TEACHER_B_ID, request, {
          now: SEED_NOW,
        });
        throw new Error("应当 404");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        const httpErr = err as HttpError;
        expect(httpErr.status).toBe(404);
        expect(httpErr.code).toBe(code);
      }
    };
    expectNotFound(
      makeRequest({
        scope: { studentIds: [seed.students.s1.id] },
        modules: { summaries: true },
      }),
      "STUDENT_NOT_FOUND",
    );
    expectNotFound(
      makeRequest({
        scope: { courseId: seed.courses.a.id },
        modules: { summaries: true },
      }),
      "COURSE_NOT_FOUND",
    );
    expectNotFound(
      makeRequest({
        scope: { assignmentId: seed.assignments.a1.id },
        modules: { summaries: true },
      }),
      "ASSIGNMENT_NOT_FOUND",
    );
    expectNotFound(
      makeRequest({
        scope: {},
        modules: { lectures: [{ lectureId: seed.lectures.l1.id }] },
      }),
      "LECTURE_NOT_FOUND",
    );
  });

  it("乙按时间范围（无 id 维度）→ 空集 pack，不泄露甲任何数据", () => {
    const assembly = assembleLearningPack(
      db,
      dataDir,
      TEACHER_B_ID,
      makeRequest({ scope: {}, modules: { summaries: true, responses: true } }),
      { now: SEED_NOW },
    );
    const pack = learningPackSchema.parse(JSON.parse(assembly.packJson));
    expect(pack.students).toEqual([]);
    expect(pack.attempts?.summaries).toEqual([]);
    expect(pack.attempts?.responses).toEqual([]);
    expect(pack.summary?.overall.attemptCount).toBe(0);
    expect(assembly.packJson).not.toContain(seed.assignments.a1.id);
  });
});

// ---------- 媒体管线第三单：::image 引用的图片进学习包 ----------

describe("::image 配图进学习包（媒体管线第三单）", () => {
  /** 已落盘图片的 src 与字节（saveMedia 内容寻址返回） */
  let mediaSrc: string;
  let mediaBytes: Uint8Array;
  /** 含三类 ::image 引用的讲义 id（命中 / 合法形态但缺文件 / 旧式路径） */
  const picLectureId = "0e8d6b1e-7f3a-4c2d-9b5e-1a2b3c4d5e6f";

  beforeAll(() => {
    mediaBytes = fakePng();
    mediaSrc = saveMedia(dataDir, mediaBytes).src;
    db.insert(lectures)
      .values({
        id: picLectureId,
        teacherId: TEST_TEACHER_ID,
        courseId: null,
        folderId: null,
        title: "第9讲 配图讲义",
        markdown: [
          "# 第9讲 配图讲义",
          "",
          "## 插图小节",
          "",
          `::image{src="${mediaSrc}" alt="测试图"}`,
          "",
          '::image{src="blobs/media/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.png"}',
          "",
          '::image{src="blobs/fig-1.png"}',
          "",
        ].join("\n"),
        order: 99,
        updatedAt: "2026-10-01T00:00:00.000Z",
        deletedAt: null,
      })
      .run();
  });

  /** 只勾选配图讲义第一节（全部 ::image 引用都在该节内） */
  function mediaRequest(): LearningPackExportRequest {
    return makeRequest({
      modules: { lectures: [{ lectureId: picLectureId, sectionIndexes: [0] }] },
    });
  }

  it("含图讲义导出：zip 含 blobs/media/<hash>.png 条目且逐字节一致；缺文件与旧式引用静默跳过", async () => {
    const zip = await buildLearningPackZip(
      db,
      dataDir,
      TEST_TEACHER_ID,
      mediaRequest(),
      { now: SEED_NOW },
    );
    const entries = unzipEntries(zip.bytes);
    // 条目名 = src 原相对路径（zip 内含 blobs/media/ 子目录条目）
    expect(entries.has(mediaSrc)).toBe(true);
    expect(entries.get(mediaSrc)?.equals(Buffer.from(mediaBytes))).toBe(true);
    // 合法形态但文件不存在（未上传）与旧式路径：不产生条目、不炸
    const blobsNames = [...entries.keys()].filter((name) =>
      name.startsWith("blobs/"),
    );
    expect(blobsNames).toEqual([mediaSrc]);
  });

  it("装配与 preview：media 条目进 files 清单；summary.md 列「讲义配图」；pack.json 形状不变", () => {
    const assembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      mediaRequest(),
      { now: SEED_NOW },
    );
    expect(assembly.mediaEntries).toEqual([
      {
        entry: mediaSrc,
        absPath: join(dataDir, ...mediaSrc.split("/")),
        bytes: mediaBytes.byteLength,
      },
    ]);
    expect(assembly.files).toContainEqual({
      path: mediaSrc,
      estimatedBytes: mediaBytes.byteLength,
    });
    expect(assembly.summaryMd).toContain("## 讲义配图（1 张）");
    expect(assembly.summaryMd).toContain(`- ${mediaSrc}`);
    const preview = previewLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      mediaRequest(),
      { now: SEED_NOW },
    );
    expect(preview.files.map((file) => file.path)).toContain(mediaSrc);
    // pack.json 仍是契约形状（服务内已做往返校验，这里锁定讲义切片原文带引用）
    const pack = learningPackSchema.parse(JSON.parse(assembly.packJson));
    expect(pack.content?.lectures?.[0]?.sections?.[0]?.markdown).toContain(
      mediaSrc,
    );
  });

  it("无图文档：无 media 条目、files 无 blobs/ 路径、summary 不出现配图节（响应形状与现状一致）", () => {
    const assembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest({
        modules: {
          lectures: [{ lectureId: seed.lectures.l1.id, sectionIndexes: [0] }],
        },
      }),
      { now: SEED_NOW },
    );
    expect(assembly.mediaEntries).toEqual([]);
    expect(assembly.files.some((file) => file.path.startsWith("blobs/"))).toBe(
      false,
    );
    expect(assembly.summaryMd).not.toContain("讲义配图");
  });
});
// extractMediaImageSrcs 的纯函数单测随函数本体迁至 media-service.test.ts

// ---------- T6R.12：LearningPack v2（证据装配、快照关联与 manifest） ----------

describe("T6R.12 LearningPack v2：快照关联、证据与 manifest", () => {
  /**
   * 独立小世界（复用文件级 db/dataDir，scope 只圈本世界学生，与种子数据隔离）：
   * - 同 qid 两轮不同内容（round1 fill「2+3」/ round2 choice「12+13」）；
   * - round1：frozen 证据两页分析图（第二页文件删除）+ 题干两处 ::image
   *   （一在场一缺失）；
   * - round2：无证据行（not_collected）。
   */
  const V2_NOW = "2026-10-05T04:00:00.000Z";
  /** round1 已封存订正的封存时间（回拨；≤ V2_NOW） */
  const V2_SEAL = "2026-10-03T00:00:00.000Z";
  let v2Student: string;
  let round1AttemptId: string;
  let round2AttemptId: string;
  let frozenVersionId: string;
  let v2MediaSrc: string;
  /** 合法内容寻址形态但文件缺失的 src（64 位 hex） */
  const v2MissingMediaSrc = `blobs/media/${"e".repeat(64)}.png`;

  beforeAll(() => {
    v2Student = makeStudent(db);
    const v2MediaBytes = fakePng(60, 60);
    v2MediaSrc = saveMedia(dataDir, v2MediaBytes).src;
    // 引用同一张图（v2MediaSrc）的讲义（C12：同图双源去重夹具）
    db.insert(lectures)
      .values({
        id: v2LectureId,
        teacherId: TEST_TEACHER_ID,
        courseId: null,
        folderId: null,
        title: "v2 配图讲义",
        markdown: [
          "# v2 配图讲义",
          "",
          "## 插图节",
          "",
          `::image{src="${v2MediaSrc}"}`,
          "",
          `::image{src="${v2MissingMediaSrc}"}`,
          "",
        ].join("\n"),
        order: 98,
        updatedAt: "2026-10-01T00:00:00.000Z",
        deletedAt: null,
      })
      .run();
    const stemWithImages = [
      "看图计算：",
      "",
      `::image{src="${v2MediaSrc}"}`,
      "",
      `::image{src="${v2MissingMediaSrc}"}`,
      "",
      "计算 $2+3=[[5]]$",
    ].join("\n");
    round1AttemptId = frozenDraftAttempt(db, v2Student, [
      {
        questionId: "v2配对题-1",
        snapshotJson: snapshotJsonOf({
          id: "v2配对题-1",
          stemMd: stemWithImages,
          answers: { kind: "fill", blanks: [["5"]] },
          solutionMd: "v2解析一",
        }),
      },
    ]).attemptId;
    const receipt = saveNoteVersion(
      db,
      dataDir,
      v2Student,
      round1AttemptId,
      "v2配对题-1",
      gzipJson(noteDoc(2, 30)),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    frozenVersionId = receipt.versionId;
    const page1 = attachNoteImage(
      db,
      dataDir,
      { kind: "student", id: v2Student },
      receipt.versionId,
      makeNotePng(1000, 800),
      {
        spec: "analysis",
        pageIndex: 0,
        crop: { x: 0, y: 0, width: 1000, height: 800 },
        pixelWidth: 1000,
        pixelHeight: 800,
      },
    );
    void page1;
    const page2 = attachNoteImage(
      db,
      dataDir,
      { kind: "student", id: v2Student },
      receipt.versionId,
      makeNotePng(1000, 640),
      {
        spec: "analysis",
        pageIndex: 1,
        crop: { x: 0, y: 760, width: 1000, height: 640 },
        pixelWidth: 1000,
        pixelHeight: 640,
      },
    );
    // 删除第二页文件（磁盘缺失 → manifest.missing）
    const page2Row = db
      .select()
      .from(noteImagesTable)
      .where(eq(noteImagesTable.id, page2.imageId))
      .get();
    if (page2Row === undefined) throw new Error("v2 夹具缺第二页分析图行");
    rmSync(join(dataDir, page2Row.path), { force: true });
    // 交卷（直插状态与证据行：round1 frozen；round2 交卷不采集）
    submitAttemptStatus(db, round1AttemptId, "2026-10-02T00:00:00.000Z");
    insertEvidence(
      db,
      round1AttemptId,
      "v2配对题-1",
      "frozen",
      receipt.versionId,
    );
    round2AttemptId = frozenDraftAttempt(db, v2Student, [
      {
        questionId: "v2配对题-1",
        snapshotJson: snapshotJsonOf({
          id: "v2配对题-1",
          type: "choice",
          stemMd: "12+13 = ？",
          options: [{ text: "25" }, { text: "35" }],
          answers: { kind: "choice", index: 0 },
          solutionMd: "v2解析二",
        }),
      },
    ]).attemptId;
    submitAttemptStatus(db, round2AttemptId, "2026-10-04T00:00:00.000Z");
    // T6R.16：round1 追加一份已封存订正（复制原稿 + 一页分析图 + 反思两列，
    // 封存时间回拨）——让全链测试的 evidenceRefs 成为多元素数组（多阶段）
    const corrHead = createCorrection(
      db,
      dataDir,
      v2Student,
      round1AttemptId,
      "v2配对题-1",
      { copyFromOriginal: true },
    );
    const corr = corrHead.corrections[corrHead.corrections.length - 1];
    if (corr === undefined || corr.currentVersionId === null) {
      throw new Error("v2 夹具缺少订正 seeded 版本");
    }
    attachNoteImage(
      db,
      dataDir,
      { kind: "student", id: v2Student },
      corr.currentVersionId,
      makeNotePng(1000, 800),
      {
        spec: "analysis",
        pageIndex: 0,
        crop: { x: 0, y: 0, width: 1000, height: 800 },
        pixelWidth: 1000,
        pixelHeight: 800,
      },
    );
    sealCorrection(db, v2Student, round1AttemptId, "v2配对题-1", {
      baseRevision: 1,
      stuckAt: "去括号变号遗漏",
    });
    setNoteSealedAt(db, corr.noteId, V2_SEAL);
  });

  /** v2 请求（默认题目 solution 层 + 逐题作答 + 证据；含订正阶段→evidenceRefs 多元素） */
  function makeV2Request(
    overrides: Record<string, unknown> = {},
  ): LearningPackExportRequest {
    return learningPackExportRequestSchema.parse({
      packVersion: 2,
      scope: { studentIds: [v2Student] },
      modules: {
        questions: "solution",
        responses: true,
        evidence: true,
        evidencePhases: ["scratch", "correction"],
      },
      goal: "diagnose-weakness",
      ...overrides,
    });
  }

  /** v2 配图讲义 id（与题目引用同一张图，C12 夹具） */
  const v2LectureId = "1f9e2c3d-4b5a-6c7e-8f90-abcdefabcdef";

  it("v2 全链：pack 过 v2 schema、同 qid 两轮一一配对、manifest 与 zip 一致、引用全部可解析或显式缺失", async () => {
    const zip = await buildLearningPackZip(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeV2Request(),
      { now: V2_NOW },
    );
    const entries = unzipEntries(zip.bytes);
    const pack = packEntryOf(entries, learningPackV2Schema);

    // —— meta：v2 + evidence 回显 ——
    expect(pack.meta.version).toBe(2);
    expect(pack.meta.modules.evidence).toBe(true);

    // —— 快照一一配对：同 qid 两条目，各轮 response 指向自己的版本 ——
    const questions = pack.content?.questions ?? [];
    expect(questions).toHaveLength(2);
    expect(questions[0]?.questionId).toBe("v2配对题-1");
    expect(questions[0]?.stemMd).toContain("2+3");
    expect(questions[1]?.stemMd).toContain("12+13");
    expect(questions[1]?.options).toEqual(["25", "35"]);
    const responses = pack.attempts?.responses ?? [];
    expect(responses).toHaveLength(2);
    expect(responses[0]?.attemptId).toBe(round1AttemptId);
    expect(responses[0]?.questionRef).toBe(questions[0]?.ref);
    expect(responses[0]?.snapshotHash).toBe(questions[0]?.snapshotHash);
    expect(responses[1]?.attemptId).toBe(round2AttemptId);
    expect(responses[1]?.questionRef).toBe(questions[1]?.ref);

    // —— 证据：round1 scratch（两页一在场一缺失）+ 封存订正；round2 not_collected ——
    const evidence = pack.evidence ?? [];
    expect(evidence).toHaveLength(3);
    // T6R.16 多阶段：round1 行挂 scratch+correction 两条引用（固定产出序）；
    // round2 行无订正 → 单元素
    expect(responses[0]?.evidenceRefs).toEqual([
      evidence[0]?.ref,
      evidence[1]?.ref,
    ]);
    expect(responses[1]?.evidenceRefs).toEqual([evidence[2]?.ref]);
    expect(evidence[0]?.state).toBe("frozen");
    expect(evidence[0]?.version?.versionId).toBe(frozenVersionId);
    expect(evidence[0]?.images).toHaveLength(2);
    expect(evidence[0]?.images[0]?.state).toBe("ready");
    expect(evidence[0]?.images[1]?.state).toBe("missing");
    // 订正条目：封存列 + 反思两列入包（errorCause 缺省归一 null 直传）
    expect(evidence[1]?.phase).toBe("correction");
    expect(evidence[1]?.sealedAt).toBe(V2_SEAL);
    expect(evidence[1]?.stuckAt).toBe("去括号变号遗漏");
    expect(evidence[1]?.errorCause).toBeNull();
    expect(evidence[1]?.images).toHaveLength(1);
    expect(evidence[1]?.images[0]?.state).toBe("ready");
    expect(evidence[1]?.images[0]?.file).toBe(
      "evidence/e002-correction-01.png",
    );
    expect(evidence[2]?.state).toBe("not_collected");
    // meta 回显装配端规范化阶段（去重 + 规范序）
    expect(pack.meta.modules.evidencePhases).toEqual(["scratch", "correction"]);

    // —— manifest：files 全在 zip、missing 不在 zip、refs 全可解析 ——
    const manifest = pack.manifest;
    for (const file of manifest.files) {
      expect(entries.has(file.path)).toBe(true);
    }
    for (const miss of manifest.missing) {
      expect(entries.has(miss.path)).toBe(false);
    }
    const qRefs = new Set(questions.map((q) => q.ref));
    const eRefs = new Set(evidence.map((e) => e.ref));
    for (const response of responses) {
      expect(qRefs.has(response.questionRef)).toBe(true);
      for (const ref of response.evidenceRefs ?? []) {
        expect(eRefs.has(ref)).toBe(true);
      }
    }
    for (const item of [...manifest.files, ...manifest.missing]) {
      for (const ref of item.refs) {
        expect(qRefs.has(ref) || eRefs.has(ref)).toBe(true);
      }
    }
    // 媒体：在场图进 files（refs 指向 round1 的 q 条目），缺失图进 missing
    const mediaFile = manifest.files.find((f) => f.path === v2MediaSrc);
    expect(mediaFile?.kind).toBe("media");
    expect(mediaFile?.refs).toEqual([questions[0]?.ref]);
    const missingMedia = manifest.missing.find(
      (m) => m.path === v2MissingMediaSrc,
    );
    expect(missingMedia?.kind).toBe("media");
    expect(missingMedia?.reason.length).toBeGreaterThan(0);
    // 删除的第二页分析图进 missing（evidence-image）
    expect(
      manifest.missing.some(
        (m) =>
          m.kind === "evidence-image" &&
          m.path === "evidence/e001-original-02.png" &&
          m.refs.includes(evidence[0]?.ref ?? ""),
      ),
    ).toBe(true);

    // —— zip 条目可移植（相对路径、无盘符/.. 段） ——
    for (const name of entries.keys()) {
      expect(name.startsWith("/")).toBe(false);
      expect(name.includes("..")).toBe(false);
      expect(name.includes(":")).toBe(false);
    }

    // —— 固定文件在场；prompt 提及 evidence ——
    for (const fixed of [
      "pack.json",
      "summary.md",
      "prompt.md",
      "schema.json",
      "映射.txt",
    ]) {
      expect(entries.has(fixed)).toBe(true);
    }
    expect(entries.get("prompt.md")?.toString("utf8")).toContain("evidence/");
    // 在场证据图条目存在（scratch 原稿 + 订正分标签命名）
    expect(entries.has("evidence/e001-original-01.png")).toBe(true);
    expect(entries.has("evidence/e002-correction-01.png")).toBe(true);
  });

  it("只选证据不选题目：manifest 标明上下文未提供，不夹带题目媒体", async () => {
    const zip = await buildLearningPackZip(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeV2Request({ modules: { responses: true, evidence: true } }),
      { now: V2_NOW },
    );
    const entries = unzipEntries(zip.bytes);
    const pack = packEntryOf(entries, learningPackV2Schema);
    expect(pack.content).toBeUndefined();
    expect(
      pack.manifest.contextNotes.some((note) =>
        note.includes("题目上下文未提供"),
      ),
    ).toBe(true);
    // 题目媒体未选不夹带（无论在场缺失），证据图照常
    expect(
      [...entries.keys()].some((name) => name.startsWith("blobs/media/")),
    ).toBe(false);
    expect(pack.manifest.missing.some((m) => m.kind === "media")).toBe(false);
    expect(pack.manifest.files.some((f) => f.kind === "media")).toBe(false);
    expect(entries.has("evidence/e001-original-01.png")).toBe(true);
    // responses 仍带配对键（snapshotHash 恒在场）
    expect(pack.attempts?.responses?.[0]?.snapshotHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("v1 深比较回归锁（复审 B12）：materialOf/packHeaderOf 演进不静默改 v1", () => {
    // 小夹具最小勾选（仅题目 answer 层）→ 构造期望对象逐字段深比较
    // （非快照文件，避免脆性；快照文本/结构演进由显式期望承载）
    const assembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeV2Request({
        packVersion: undefined,
        modules: { questions: "answer" },
      }),
      { now: V2_NOW },
    );
    const expected = {
      meta: {
        version: 1,
        generatedAt: "2026-10-05T04:00:00.000Z",
        goal: "diagnose-weakness",
        days: 30,
        from: "2026-09-05T04:00:00.000Z",
        to: "2026-10-05T04:00:00.000Z",
        anonymized: true,
        modules: {
          lectures: false,
          questions: "answer",
          responses: false,
          summaries: false,
          ink: false,
          traces: false,
        },
        note: "评语为教师原文（不改动），可能包含学生真实姓名；学习痕迹指标与阅读状态均为行为推断，仅供参考。",
      },
      students: [{ id: v2Student, name: "学生A", archived: false }],
      // 同 qid 两轮 → v1 取最新（round2 choice「12+13」）；answer 层含
      // options+answers、不含 solutionMd；本世界无题库行 → unitId/unitTitle null
      content: {
        questions: [
          {
            questionId: "v2配对题-1",
            unitId: null,
            unitTitle: null,
            type: "choice",
            difficulty: 2,
            knowledge: ["考点"],
            stemMd: "12+13 = ？",
            options: ["25", "35"],
            answers: { kind: "choice", index: 0 },
          },
        ],
      },
    };
    expect(JSON.parse(assembly.packJson)).toEqual(expected);
  });

  it("v1 请求（无 packVersion）形状锁定：version=1、无 manifest 键", () => {
    const assembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest(),
      { now: SEED_NOW },
    );
    const pack = JSON.parse(assembly.packJson);
    expect(pack.meta.version).toBe(1);
    expect("manifest" in pack).toBe(false);
    expect(learningPackSchema.parse(pack)).toBeTruthy();
  });

  it("v2 schema.json 与 pnpm schema:export 产物逐字节一致", () => {
    const assembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeV2Request(),
      { now: V2_NOW },
    );
    const exported = readFileSync(
      new URL(
        "../../../../docs/dsl/schema/learning-pack-v2.json",
        import.meta.url,
      ),
      "utf8",
    );
    expect(assembly.schemaJson).toBe(exported);
  });

  it("preview v2：files 清单含 evidence 条目与题目媒体", () => {
    const preview = previewLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeV2Request(),
      { now: V2_NOW },
    );
    const paths = preview.files.map((file) => file.path);
    expect(paths).toContain("evidence/e001-original-01.png");
    expect(paths).toContain(v2MediaSrc);
    expect(preview.totalEstimatedBytes).toBeGreaterThan(0);
  });

  it("同图双源去重（C12）：讲义与题目引用同一 src → zip 单条目/manifest 单行/字节单计", async () => {
    const zip = await buildLearningPackZip(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeV2Request({
        modules: {
          lectures: [{ lectureId: v2LectureId, sectionIndexes: [0] }],
          questions: "solution",
          responses: true,
          evidence: false,
        },
      }),
      { now: V2_NOW },
    );
    const entries = unzipEntries(zip.bytes);
    // zip：同 src 只有一个条目（archiver 重复 name 会产生双条目/覆盖歧义）
    const sameSrcNames = [...entries.keys()].filter(
      (name) => name === v2MediaSrc,
    );
    expect(sameSrcNames).toHaveLength(1);
    // manifest：media 行唯一且携带题目 q 关联（讲义先行收录、题目并入去重）
    const pack = packEntryOf(entries, learningPackV2Schema);
    const mediaRows = pack.manifest.files.filter(
      (file) => file.kind === "media" && file.path === v2MediaSrc,
    );
    expect(mediaRows).toHaveLength(1);
    expect(mediaRows[0]?.refs).toEqual([pack.content?.questions?.[0]?.ref]);
    // preview/预检清单同样单计
    const preview = previewLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeV2Request({
        modules: {
          lectures: [{ lectureId: v2LectureId, sectionIndexes: [0] }],
          questions: "solution",
          responses: true,
          evidence: false,
        },
      }),
      { now: V2_NOW },
    );
    expect(
      preview.files.filter((file) => file.path === v2MediaSrc),
    ).toHaveLength(1);
  });

  it("缺失媒体同 src 双源：manifest 单行且合并题目 refs（复审 A6）", async () => {
    const zip = await buildLearningPackZip(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeV2Request({
        modules: {
          lectures: [{ lectureId: v2LectureId, sectionIndexes: [0] }],
          questions: "solution",
          responses: true,
          evidence: false,
        },
      }),
      { now: V2_NOW },
    );
    const pack = packEntryOf(unzipEntries(zip.bytes), learningPackV2Schema);
    // 讲义先行行（refs=[]）与题目侧缺失行同 src → 单行，refs 合并题目 q 关联
    const missingRows = pack.manifest.missing.filter(
      (row) => row.path === v2MissingMediaSrc,
    );
    expect(missingRows).toHaveLength(1);
    expect(missingRows[0]?.kind).toBe("media");
    expect(missingRows[0]?.refs).toEqual([pack.content?.questions?.[0]?.ref]);
  });

  it("questions 未勾选：manifest 媒体行 refs 恒空（题目侧关系不外泄，复审 A4）", async () => {
    const zip = await buildLearningPackZip(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeV2Request({
        modules: {
          lectures: [{ lectureId: v2LectureId, sectionIndexes: [0] }],
          responses: true,
          evidence: false,
        },
      }),
      { now: V2_NOW },
    );
    const pack = packEntryOf(unzipEntries(zip.bytes), learningPackV2Schema);
    expect(pack.content?.questions).toBeUndefined(); // 题目模块未勾不夹带
    const mediaRows = pack.manifest.files.filter(
      (file) => file.kind === "media",
    );
    expect(mediaRows).toHaveLength(1); // 仅讲义在场图
    expect(mediaRows[0]?.path).toBe(v2MediaSrc);
    expect(mediaRows[0]?.refs).toEqual([]);
  });
});

// ---------- T6R.16：多阶段证据与固定选择（evidencePhases / asOf / preview） ----------

describe("T6R.16 多阶段证据与固定选择（evidencePhases/asOf/preview）", () => {
  /**
   * 多阶段世界（独立学生圈，不碰种子与 v2 配对世界）：
   * - 学生A 两轮 + 学生B 一轮，题 P1 两份内容——内容甲（A 第 1 轮与 B 轮同一份
   *   快照 JSON → 同内容共享 q 条目）、内容乙（A 第 2 轮 → 新 q 条目）；
   * - A 第 1 轮挂三阶段：scratch（两页分析图）+ 已封存订正#1（一页图、反思两列）
   *   + 补充稿两版本（v1@SUPP_1 一页图 / v2@SUPP_2 零图——P_NOW 钉 v2 时的
   *   缺失登记素材）；
   * - 对错混合：A1 错 / B 对 / A2 待批（教师可导错题也可含答对题，D10）。
   * 里程碑全部 ≤ P_NOW（「预览时刻」已存在的写入）；预览后的变化（订正#2 /
   * 第 3 轮交卷 / 补充稿 v3）只在最后一个固定选择用例内追加并回拨到 > P_NOW
   * （该用例改变共享 DB，故放最后）。
   */
  const P_NOW = "2026-10-06T00:00:00.000Z";
  const P_LATE = "2026-10-07T00:00:00.000Z";
  const SUB_A1 = "2026-10-01T00:00:00.000Z";
  const SUB_B1 = "2026-10-02T00:00:00.000Z";
  const SEAL_1 = "2026-10-03T02:00:00.000Z";
  const SUPP_1 = "2026-10-03T03:00:00.000Z";
  const SUB_A2 = "2026-10-04T00:00:00.000Z";
  const SUPP_2 = "2026-10-05T00:00:00.000Z";
  // 预览后变化的里程碑（> P_NOW；固定选择用例内使用）
  const SEAL_2 = "2026-10-06T12:00:00.000Z";
  const SUB_A3 = "2026-10-06T12:30:00.000Z";
  const SUPP_3 = "2026-10-06T13:00:00.000Z";

  let phaseStudentA: string;
  let phaseStudentB: string;
  /** 学生A 第 1 轮（内容甲，三阶段证据） */
  let phaseA1: string;
  /** 学生B（内容甲，scratch） */
  let phaseB1: string;
  /** 学生A 第 2 轮（内容乙，scratch） */
  let phaseA2: string;
  let phaseA1RowId: string;
  let phaseScratchVersionId: string;

  /** 分析图上传元信息（一页 1000×800） */
  const pageMeta = (pageIndex: number) => ({
    spec: "analysis" as const,
    pageIndex,
    crop: { x: 0, y: 0, width: 1000, height: 800 },
    pixelWidth: 1000,
    pixelHeight: 800,
  });

  beforeAll(() => {
    phaseStudentA = makeStudent(db);
    phaseStudentB = makeStudent(db);
    const snapshotAlpha = snapshotJsonOf({
      id: "P1",
      stemMd: "计算 2+3=[[5]]",
      answers: { kind: "fill", blanks: [["5"]] },
      solutionMd: "内容甲解析",
    });
    // —— A1：内容甲 + 三阶段 ——
    const a1 = frozenDraftAttempt(db, phaseStudentA, [
      { questionId: "P1", snapshotJson: snapshotAlpha },
    ]);
    phaseA1 = a1.attemptId;
    phaseA1RowId = a1.rowIds[0] ?? "";
    const scratch = saveNoteVersion(
      db,
      dataDir,
      phaseStudentA,
      phaseA1,
      "P1",
      gzipJson(noteDoc(1, 20)),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    phaseScratchVersionId = scratch.versionId;
    attachNoteImage(
      db,
      dataDir,
      { kind: "student", id: phaseStudentA },
      scratch.versionId,
      makeNotePng(1000, 800),
      pageMeta(0),
    );
    const scratchPage2 = attachNoteImage(
      db,
      dataDir,
      { kind: "student", id: phaseStudentA },
      scratch.versionId,
      makeNotePng(1000, 800),
      pageMeta(1),
    );
    // 删除第二页文件（磁盘缺失 → preview missing 行 + manifest.missing 素材）
    const scratchPage2Row = db
      .select()
      .from(noteImagesTable)
      .where(eq(noteImagesTable.id, scratchPage2.imageId))
      .get();
    if (scratchPage2Row === undefined) {
      throw new Error("阶段夹具缺 scratch 第二页分析图行");
    }
    rmSync(join(dataDir, scratchPage2Row.path), { force: true });
    submitAttemptStatus(db, phaseA1, SUB_A1);
    insertEvidence(db, phaseA1, "P1", "frozen", scratch.versionId);
    // 订正#1：复制原稿 + 一页图 + 封存回拨 SEAL_1
    const corrHead = createCorrection(
      db,
      dataDir,
      phaseStudentA,
      phaseA1,
      "P1",
      { copyFromOriginal: true },
    );
    const corr = corrHead.corrections[corrHead.corrections.length - 1];
    if (corr === undefined || corr.currentVersionId === null) {
      throw new Error("阶段夹具缺少订正 seeded 版本");
    }
    attachNoteImage(
      db,
      dataDir,
      { kind: "student", id: phaseStudentA },
      corr.currentVersionId,
      makeNotePng(1000, 800),
      pageMeta(0),
    );
    sealCorrection(db, phaseStudentA, phaseA1, "P1", {
      baseRevision: 1,
      stuckAt: "移项符号",
      errorCause: "去括号变号遗漏",
    });
    setNoteSealedAt(db, corr.noteId, SEAL_1);
    // 补充稿 v1@SUPP_1（一页图）→ v2@SUPP_2（零图 → P_NOW 钉 v2 的缺失素材）
    const supp1 = saveNoteVersion(
      db,
      dataDir,
      phaseStudentA,
      phaseA1,
      "P1",
      gzipJson(noteDoc(2, 40)),
      { baseRevision: 0, mutationId: randomUUID(), phase: "supplement" },
    );
    attachNoteImage(
      db,
      dataDir,
      { kind: "student", id: phaseStudentA },
      supp1.versionId,
      makeNotePng(1000, 800),
      pageMeta(0),
    );
    setVersionSavedAt(db, supp1.versionId, SUPP_1);
    const supp2 = saveNoteVersion(
      db,
      dataDir,
      phaseStudentA,
      phaseA1,
      "P1",
      gzipJson(noteDoc(3, 60)),
      { baseRevision: 1, mutationId: randomUUID(), phase: "supplement" },
    );
    setVersionSavedAt(db, supp2.versionId, SUPP_2);
    // —— B1：内容甲（同一份快照 JSON）+ scratch 一页 ——
    const b1 = frozenDraftAttempt(db, phaseStudentB, [
      { questionId: "P1", snapshotJson: snapshotAlpha },
    ]);
    phaseB1 = b1.attemptId;
    const scratchB = saveNoteVersion(
      db,
      dataDir,
      phaseStudentB,
      phaseB1,
      "P1",
      gzipJson(noteDoc(1, 20)),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    attachNoteImage(
      db,
      dataDir,
      { kind: "student", id: phaseStudentB },
      scratchB.versionId,
      makeNotePng(1000, 800),
      pageMeta(0),
    );
    submitAttemptStatus(db, phaseB1, SUB_B1);
    insertEvidence(db, phaseB1, "P1", "frozen", scratchB.versionId);
    // —— A2：内容乙（新快照）+ scratch 一页 ——
    const a2 = frozenDraftAttempt(db, phaseStudentA, [
      {
        questionId: "P1",
        snapshotJson: snapshotJsonOf({
          id: "P1",
          stemMd: "计算 12+13=[[25]]",
          answers: { kind: "fill", blanks: [["25"]] },
        }),
      },
    ]);
    phaseA2 = a2.attemptId;
    const scratchA2 = saveNoteVersion(
      db,
      dataDir,
      phaseStudentA,
      phaseA2,
      "P1",
      gzipJson(noteDoc(1, 20)),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    attachNoteImage(
      db,
      dataDir,
      { kind: "student", id: phaseStudentA },
      scratchA2.versionId,
      makeNotePng(1000, 800),
      pageMeta(0),
    );
    submitAttemptStatus(db, phaseA2, SUB_A2);
    insertEvidence(db, phaseA2, "P1", "frozen", scratchA2.versionId);
    // 对错混合：A1 错 / B 对 / A2 待批（finalCorrect 保持 null）
    db.update(responsesTable)
      .set({ finalCorrect: false })
      .where(eq(responsesTable.id, phaseA1RowId))
      .run();
    db.update(responsesTable)
      .set({ finalCorrect: true })
      .where(
        and(
          eq(responsesTable.attemptId, phaseB1),
          eq(responsesTable.questionId, "P1"),
        ),
      )
      .run();
  });

  /** 本世界 v2 请求（三阶段全选；覆盖片段合并后仍整体过契约） */
  function phaseRequest(
    overrides: Record<string, unknown> = {},
  ): LearningPackExportRequest {
    return learningPackExportRequestSchema.parse({
      packVersion: 2,
      scope: { studentIds: [phaseStudentA, phaseStudentB], days: "all" },
      modules: {
        questions: "solution",
        responses: true,
        evidence: true,
        evidencePhases: ["scratch", "correction", "supplement"],
      },
      goal: "per-question-review",
      ...overrides,
    });
  }

  it("多学生×多轮×多题版本配对与多阶段产出序；对错混合都在包；封存列/反思/钉定版本入包", () => {
    const assembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      phaseRequest(),
      { now: P_NOW },
    );
    const pack = learningPackV2Schema.parse(JSON.parse(assembly.packJson));
    // 两份内容 → 两个 q 条目；A1 与 B1 同内容共享 q001（snapshotHash 相同），
    // A2 新内容 q002（多学生×多轮×多题版本一一配对）
    const questions = pack.content?.questions ?? [];
    expect(questions).toHaveLength(2);
    const responses = pack.attempts?.responses ?? [];
    expect(responses).toHaveLength(3);
    const byAttempt = new Map(responses.map((row) => [row.attemptId, row]));
    const qOfA1 = byAttempt.get(phaseA1)?.questionRef;
    expect(qOfA1).toBe(questions[0]?.ref);
    expect(byAttempt.get(phaseB1)?.questionRef).toBe(qOfA1);
    expect(byAttempt.get(phaseB1)?.snapshotHash).toBe(
      byAttempt.get(phaseA1)?.snapshotHash,
    );
    expect(byAttempt.get(phaseA2)?.questionRef).toBe(questions[1]?.ref);
    // 多阶段产出序：A1 行挂 scratch+correction+supplement；A2/B1 各一条 scratch
    expect(byAttempt.get(phaseA1)?.evidenceRefs).toEqual([
      "e001",
      "e002",
      "e003",
    ]);
    expect(byAttempt.get(phaseA2)?.evidenceRefs).toEqual(["e004"]);
    expect(byAttempt.get(phaseB1)?.evidenceRefs).toEqual(["e005"]);
    const evidence = pack.evidence ?? [];
    expect(evidence.map((entry) => [entry.phase, entry.ref])).toEqual([
      ["scratch", "e001"],
      ["correction", "e002"],
      ["supplement", "e003"],
      ["scratch", "e004"],
      ["scratch", "e005"],
    ]);
    // 订正封存列与反思两列；scratch/supplement 不带这三键
    expect(evidence[1]?.sealedAt).toBe(SEAL_1);
    expect(evidence[1]?.stuckAt).toBe("移项符号");
    expect(evidence[1]?.errorCause).toBe("去括号变号遗漏");
    expect(evidence[0]?.sealedAt).toBeUndefined();
    expect(evidence[2]?.sealedAt).toBeUndefined();
    expect(evidence[2]?.stuckAt).toBeUndefined();
    // 补充稿在 P_NOW 钉 v2（SUPP_2 最新 ≤ now；零图 → 缺失登记 supplement 标签）
    expect(evidence[2]?.version?.savedAt).toBe(SUPP_2);
    expect(pack.manifest.missing).toContainEqual({
      path: "evidence/e003-supplement-01.png",
      kind: "evidence-image",
      reason: "该版本尚无分析图（未生成）",
      refs: ["e003"],
    });
    // 对错混合：错 / 对 / 待批都在包（教师可导错题也可含答对题）
    expect(byAttempt.get(phaseA1)?.finalCorrect).toBe(false);
    expect(byAttempt.get(phaseB1)?.finalCorrect).toBe(true);
    expect(byAttempt.get(phaseA2)?.finalCorrect).toBeNull();
    // 闸门 F4：多阶段世界的 summary 标题按阶段感知（correction/supplement
    // 在场 → 「手写证据」，纯 scratch 才是「手写原稿」）
    expect(assembly.summaryMd).toContain("## 手写证据（4 张）");
    expect(assembly.summaryMd).not.toContain("## 手写原稿（");
    // meta 回显规范序 + 逐题评析目标 + prompt 阶段细化 + contextNotes 口径
    expect(pack.meta.modules.evidencePhases).toEqual([
      "scratch",
      "correction",
      "supplement",
    ]);
    expect(pack.meta.goal).toBe("per-question-review");
    expect(assembly.summaryMd).toContain("任务目标：逐题评析");
    expect(assembly.promptMd).toContain("本次收录阶段");
    expect(assembly.promptMd).toContain("订正（correction）");
    expect(
      pack.manifest.contextNotes.some((note) =>
        note.includes("订正证据只收录已封存检查点"),
      ),
    ).toBe(true);
    expect(
      pack.manifest.contextNotes.some((note) => note.includes("补充稿")),
    ).toBe(true);
    expect(
      pack.manifest.contextNotes.some((note) =>
        note.includes("原稿阶段未勾选"),
      ),
    ).toBe(false);
  });

  it("evidencePhases 回显规范化：乱序请求 → meta 回显规范序，prompt 三阶段细化", () => {
    // 契约 max(3) 锁长度、装配端负责去重与规范序——此处验证乱序重排（去重的
    // 单元覆盖在 question-evidence.test 的 normalizeEvidencePhases 用例）
    const assembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      phaseRequest({
        modules: {
          questions: "solution",
          responses: true,
          evidence: true,
          evidencePhases: ["supplement", "correction", "scratch"],
        },
      }),
      { now: P_NOW },
    );
    const pack = learningPackV2Schema.parse(JSON.parse(assembly.packJson));
    expect(pack.meta.modules.evidencePhases).toEqual([
      "scratch",
      "correction",
      "supplement",
    ]);
    expect(assembly.promptMd).toContain("本次收录阶段");
    expect(assembly.promptMd).toContain("补充稿（supplement）");
  });

  it("只勾订正阶段：未选阶段零条目零文件；原稿未勾选的 contextNote 出现", () => {
    const assembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      phaseRequest({
        modules: {
          questions: "solution",
          responses: true,
          evidence: true,
          evidencePhases: ["correction"],
        },
      }),
      { now: P_NOW },
    );
    const pack = learningPackV2Schema.parse(JSON.parse(assembly.packJson));
    const evidence = pack.evidence ?? [];
    // 只有 A1 的订正#1（B/A2 无订正行；scratch/supplement 零条目）
    expect(evidence.map((entry) => entry.phase)).toEqual(["correction"]);
    const byAttempt = new Map(
      (pack.attempts?.responses ?? []).map((row) => [row.attemptId, row]),
    );
    expect(byAttempt.get(phaseA1)?.evidenceRefs).toEqual(["e001"]);
    expect(byAttempt.get(phaseA2)?.evidenceRefs).toBeUndefined();
    expect(byAttempt.get(phaseB1)?.evidenceRefs).toBeUndefined();
    // 零 scratch/supplement 文件（唯一证据图 = 订正一页）
    expect(
      assembly.files
        .filter((file) => file.path.startsWith("evidence/"))
        .map((file) => file.path),
    ).toEqual(["evidence/e001-correction-01.png"]);
    // contextNotes：订正说明 + 原稿未勾选说明；补充稿未勾不谈
    expect(
      pack.manifest.contextNotes.some((note) =>
        note.includes("订正证据只收录已封存检查点"),
      ),
    ).toBe(true);
    expect(
      pack.manifest.contextNotes.some((note) =>
        note.includes("原稿阶段未勾选"),
      ),
    ).toBe(true);
    expect(
      pack.manifest.contextNotes.some(
        (note) => note.includes("找回稿") || note.includes("交卷前已固定"),
      ),
    ).toBe(false);
    // 闸门 F4：只勾订正 = 多阶段（非纯 scratch）→ 「手写证据（1 张）」
    expect(assembly.summaryMd).toContain("## 手写证据（1 张）");
  });

  it("F4：只勾原稿阶段 summary 标题零漂移（「手写原稿（3 张）」）", () => {
    const assembly = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      phaseRequest({
        modules: {
          questions: "solution",
          responses: true,
          evidence: true,
          evidencePhases: ["scratch"],
        },
      }),
      { now: P_NOW },
    );
    // 纯 scratch：e001 第一页 + e004 + e005（e001 第二页已删为缺失，不计标题）
    expect(assembly.summaryMd).toContain("## 手写原稿（3 张）");
    expect(assembly.summaryMd).not.toContain("## 手写证据（");
  });

  it("asOf 贯穿：窗口/收录/meta.to 以 asOf 为准；generatedAt 仍真实 now；preview 回传 asOf", () => {
    // asOf 优先于 options.now：窗口 [asOf-3d, asOf] 只含 A2；meta.to=asOf
    const pack = learningPackV2Schema.parse(
      JSON.parse(
        assembleLearningPack(
          db,
          dataDir,
          TEST_TEACHER_ID,
          phaseRequest({
            scope: { studentIds: [phaseStudentA, phaseStudentB], days: 3 },
            asOf: P_NOW,
          }),
          { now: P_LATE },
        ).packJson,
      ),
    );
    expect(pack.meta.to).toBe(P_NOW);
    expect(pack.meta.from).toBe("2026-10-03T00:00:00.000Z");
    expect(pack.meta.generatedAt).toBe(P_LATE);
    const responses = pack.attempts?.responses ?? [];
    expect(responses).toHaveLength(1);
    expect(responses[0]?.attemptId).toBe(phaseA2);
    // preview：显式 asOf 原样回传；缺省 = 装配时刻（nowIso）
    const preview = previewLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      phaseRequest({
        scope: { studentIds: [phaseStudentA, phaseStudentB], days: 3 },
        asOf: P_NOW,
      }),
      { now: P_LATE },
    );
    expect(preview.asOf).toBe(P_NOW);
    const previewDefault = previewLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      phaseRequest(),
      { now: P_NOW },
    );
    expect(previewDefault.asOf).toBe(P_NOW);
  });

  it("F13①：asOf+traces → contextNotes 声明阅读地图未按 asOf 钉定；无 asOf 或未勾 traces 无此条", () => {
    const tracesModules = {
      questions: "solution",
      responses: true,
      evidence: true,
      evidencePhases: ["scratch", "correction", "supplement"],
      traces: true,
    } as const;
    const withNote = learningPackV2Schema.parse(
      JSON.parse(
        assembleLearningPack(
          db,
          dataDir,
          TEST_TEACHER_ID,
          phaseRequest({ modules: tracesModules, asOf: P_NOW }),
          { now: P_LATE },
        ).packJson,
      ),
    );
    expect(
      withNote.manifest.contextNotes.some((note) =>
        note.includes("学习痕迹中的讲义阅读地图按生成时刻计算"),
      ),
    ).toBe(true);
    // 无 asOf（缺省 = 生成时刻，无钉定语义）→ 无此条
    const noAsOf = learningPackV2Schema.parse(
      JSON.parse(
        assembleLearningPack(
          db,
          dataDir,
          TEST_TEACHER_ID,
          phaseRequest({ modules: tracesModules }),
          { now: P_NOW },
        ).packJson,
      ),
    );
    expect(
      noAsOf.manifest.contextNotes.some((note) =>
        note.includes("学习痕迹中的讲义阅读地图"),
      ),
    ).toBe(false);
    // 有 asOf 但未勾 traces → 无此条
    const noTraces = learningPackV2Schema.parse(
      JSON.parse(
        assembleLearningPack(
          db,
          dataDir,
          TEST_TEACHER_ID,
          phaseRequest({ asOf: P_NOW }),
          { now: P_LATE },
        ).packJson,
      ),
    );
    expect(
      noTraces.manifest.contextNotes.some((note) =>
        note.includes("学习痕迹中的讲义阅读地图"),
      ),
    ).toBe(false);
  });

  it("preview 真实图片清单：ready 带 downloadUrl/bytes，missing 带 reason；v1 恒空数组", () => {
    const preview = previewLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      phaseRequest(),
      { now: P_NOW },
    );
    expect(preview.asOf).toBe(P_NOW);
    const images = preview.evidenceImages;
    // ready 4 行（e001 第一页 + e002 订正 + e004/e005 原稿；e001 第二页文件
    // 已删除）+ missing 2 行（e001-original-02 磁盘缺失；e003-supplement-01
    // 零图「未生成」——闸门 F3：无 images 行的缺失也进 preview 清单，此前只
    // 在 manifest.missing）
    expect(images.filter((image) => image.state === "ready")).toHaveLength(4);
    expect(images.filter((image) => image.state === "missing")).toHaveLength(2);
    // 闸门 F3：并入缺失行后按 ref+pageIndex 去重排序的完整序
    expect(images.map((image) => `${image.file}:${image.state}`)).toEqual([
      "evidence/e001-original-01.png:ready",
      "evidence/e001-original-02.png:missing",
      "evidence/e002-correction-01.png:ready",
      "evidence/e003-supplement-01.png:missing",
      "evidence/e004-original-01.png:ready",
      "evidence/e005-original-01.png:ready",
    ]);
    for (const image of images) {
      if (image.state === "ready") {
        expect(image.bytes).toBeGreaterThan(0);
        expect(image.downloadUrl).toMatch(
          /^\/api\/teacher\/note-versions\/[^/]+\/images\/[^/]+\.png$/,
        );
        expect(image.reason).toBeUndefined();
      } else {
        expect(image.bytes).toBe(0);
        expect(image.downloadUrl).toBeUndefined();
        expect(image.reason).toBeTruthy();
      }
    }
    expect(
      images.find((image) => image.file === "evidence/e001-original-02.png")
        ?.reason,
    ).toBe("图片文件缺失（磁盘无此文件）");
    expect(
      images.find((image) => image.file === "evidence/e003-supplement-01.png")
        ?.reason,
    ).toBe("该版本尚无分析图（未生成）");
    // 阶段标签与文件名对应；downloadUrl 含被钉定版本 id（scratch 原稿）
    expect(
      images
        .filter((image) => image.phase === "correction")
        .map((image) => image.file),
    ).toEqual(["evidence/e002-correction-01.png"]);
    // 零图补充稿（e003）的 preview 行 = missing（不再恒空）
    expect(
      images
        .filter((image) => image.phase === "supplement")
        .map((image) => image.file),
    ).toEqual(["evidence/e003-supplement-01.png"]);
    const scratchPage1 = images.find(
      (image) => image.file === "evidence/e001-original-01.png",
    );
    expect(scratchPage1?.downloadUrl).toContain(phaseScratchVersionId);
    // 闸门 F3：preview 清单扩充不动 pack.json——e003 证据条目 images 仍 []
    // （zip 形状不变，缺失仍只登记 manifest.missing）
    const packOfPreview = learningPackV2Schema.parse(
      JSON.parse(
        assembleLearningPack(db, dataDir, TEST_TEACHER_ID, phaseRequest(), {
          now: P_NOW,
        }).packJson,
      ),
    );
    expect(
      packOfPreview.evidence?.find((entry) => entry.ref === "e003")?.images,
    ).toEqual([]);
    // v1（未勾 evidence）恒空数组
    const v1Preview = previewLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      makeRequest(),
      { now: P_NOW },
    );
    expect(v1Preview.evidenceImages).toEqual([]);
  });

  it("文件名不碰撞：多轮×多阶段×多页 zip 条目与 manifest 行一一对应且唯一", async () => {
    const zip = await buildLearningPackZip(
      db,
      dataDir,
      TEST_TEACHER_ID,
      phaseRequest(),
      { now: P_NOW },
    );
    const entries = unzipEntries(zip.bytes);
    const pack = packEntryOf(entries, learningPackV2Schema);
    const evidenceRows = pack.manifest.files.filter(
      (file) => file.kind === "evidence",
    );
    // ready 4 条（e001 第二页已删除、e003 零图——均走 manifest.missing）
    expect(evidenceRows).toHaveLength(4);
    // manifest 行路径两两唯一
    expect(new Set(evidenceRows.map((file) => file.path)).size).toBe(4);
    // zip 条目与 manifest 一一对应（unzipEntries 的 Map 键去重后仍相等 =
    // 中央目录无重名条目）
    const zipEvidence = [...entries.keys()].filter((name) =>
      name.startsWith("evidence/"),
    );
    expect(zipEvidence.sort()).toEqual(
      evidenceRows.map((file) => file.path).sort(),
    );
  });

  it("超限：maxBytes 注入 → preview overLimit 与精简提示；生成 413 EXPORT_TOO_LARGE（文案逐字锁定）", async () => {
    const options = { now: P_NOW, maxBytes: 1024 };
    const preview = previewLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      phaseRequest(),
      options,
    );
    expect(preview.overLimit).toBe(true);
    expect(preview.limitBytes).toBe(1024);
    expect(preview.hint).toMatch(
      /^数据包预估 [\d.]+ MB，超过 0 MB 上限。精简方向：减少学生人数、取消手写 PNG 或证据附件、或缩小时间范围后重试。$/,
    );
    try {
      await buildLearningPackZip(
        db,
        dataDir,
        TEST_TEACHER_ID,
        phaseRequest(),
        options,
      );
      throw new Error("应当 413");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const httpErr = err as HttpError;
      expect(httpErr.status).toBe(413);
      expect(httpErr.code).toBe("EXPORT_TOO_LARGE");
      expect(httpErr.message).toMatch(
        /^数据包预估 [\d.]+ MB，超过 0 MB 上限。请减少学生人数、取消手写 PNG 或证据附件、或缩小时间范围后重试。$/,
      );
    }
  });

  it("固定选择：preview 后封存新订正/新交卷/补充稿再编辑 → download asOf 与预览时刻一致；无 asOf 反映最新", async () => {
    // ① 预览时刻（P_NOW）的选择
    const before = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      phaseRequest(),
      { now: P_NOW },
    );
    expect(before.asOfIso).toBe(P_NOW);
    // ② 其间发生：新订正封存（零图）/ 第 3 轮交卷 / 补充稿 v3（里程碑 > P_NOW）
    const corr2Head = createCorrection(
      db,
      dataDir,
      phaseStudentA,
      phaseA1,
      "P1",
      { copyFromOriginal: true },
    );
    const corr2 = corr2Head.corrections[corr2Head.corrections.length - 1];
    if (corr2 === undefined) throw new Error("订正#2 创建失败");
    sealCorrection(db, phaseStudentA, phaseA1, "P1", {
      baseRevision: 1,
      stuckAt: "第二轮订正",
    });
    setNoteSealedAt(db, corr2.noteId, SEAL_2);
    const a3 = frozenDraftAttempt(db, phaseStudentA, [
      { questionId: "P1", snapshotJson: snapshotJsonOf({ id: "P1" }) },
    ]);
    const scratchA3 = saveNoteVersion(
      db,
      dataDir,
      phaseStudentA,
      a3.attemptId,
      "P1",
      gzipJson(noteDoc(1, 20)),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    submitAttemptStatus(db, a3.attemptId, SUB_A3);
    insertEvidence(db, a3.attemptId, "P1", "frozen", scratchA3.versionId);
    const supp3 = saveNoteVersion(
      db,
      dataDir,
      phaseStudentA,
      phaseA1,
      "P1",
      gzipJson(noteDoc(4, 80)),
      { baseRevision: 2, mutationId: randomUUID(), phase: "supplement" },
    );
    setVersionSavedAt(db, supp3.versionId, SUPP_3);
    // ③ download 带 asOf=P_NOW（生成时刻 now=P_LATE）：选择与预览时刻一致
    const zip = await buildLearningPackZip(
      db,
      dataDir,
      TEST_TEACHER_ID,
      phaseRequest({ asOf: P_NOW }),
      { now: P_LATE },
    );
    const entries = unzipEntries(zip.bytes);
    const pinned = learningPackV2Schema.parse(
      JSON.parse(entries.get("pack.json")?.toString("utf8") ?? "{}"),
    );
    const beforePack = learningPackV2Schema.parse(JSON.parse(before.packJson));
    expect(pinned.meta.to).toBe(P_NOW);
    expect(pinned.meta.generatedAt).toBe(P_LATE); // 真实生成时刻语义
    expect(pinned.attempts?.responses).toEqual(beforePack.attempts?.responses);
    expect(pinned.evidence).toEqual(beforePack.evidence);
    expect(pinned.content?.questions).toEqual(beforePack.content?.questions);
    expect(pinned.manifest.files).toEqual(beforePack.manifest.files);
    expect(pinned.manifest.missing).toEqual(beforePack.manifest.missing);
    // ④ 无 asOf（now=P_LATE）：反映最新（新订正 / 第 3 轮 / 补充稿钉 v3）
    const latest = assembleLearningPack(
      db,
      dataDir,
      TEST_TEACHER_ID,
      phaseRequest(),
      { now: P_LATE },
    );
    const latestPack = learningPackV2Schema.parse(JSON.parse(latest.packJson));
    expect(latestPack.attempts?.responses).toHaveLength(4);
    const corr2Entry = latestPack.evidence?.find(
      (entry) => entry.sealedAt === SEAL_2,
    );
    expect(corr2Entry?.stuckAt).toBe("第二轮订正");
    expect(
      latestPack.evidence?.find((entry) => entry.phase === "supplement")
        ?.version?.savedAt,
    ).toBe(SUPP_3);
    // 订正#2 零分析图 → 缺失登记带 correction 标签与原因
    expect(corr2Entry?.ref).toBeDefined();
    expect(
      latestPack.manifest.missing.some(
        (miss) =>
          miss.kind === "evidence-image" &&
          miss.path ===
            `evidence/${corr2Entry?.ref ?? "e000"}-correction-01.png` &&
          miss.reason === "该版本尚无分析图（未生成）",
      ),
    ).toBe(true);
  });

  it("F13②：traces 事件按 asOf 钉定——晚于 asOf 的解析回看不计入 reviewedSolution（放最后：本用例向共享库插事件行）", () => {
    // 手插一行晚于 P_NOW 的解析回看事件（serverTs=P_LATE > asOf=P_NOW；
    // clientTs 取交卷后——reviewedSolution 只认交卷后的 solution open）
    db.insert(eventsTable)
      .values({
        id: randomUUID(),
        attemptId: phaseA2,
        questionId: "P1",
        studentId: phaseStudentA,
        lectureId: null,
        type: "directive_interact",
        clientTs: Date.parse(SUB_A2) + 1000,
        serverTs: P_LATE,
        payloadJson: JSON.stringify({
          host: "result",
          directive: "solution",
          action: "open",
          questionId: "P1",
        }),
      })
      .run();
    const traceOf = (request: LearningPackExportRequest, now: string) => {
      const pack = learningPackV2Schema.parse(
        JSON.parse(
          assembleLearningPack(db, dataDir, TEST_TEACHER_ID, request, {
            now,
          }).packJson,
        ),
      );
      return pack.traces?.questions?.find(
        (row) => row.attemptId === phaseA2 && row.questionId === "P1",
      );
    };
    const tracesModules = {
      questions: "stem",
      responses: true,
      evidence: true,
      evidencePhases: ["scratch"],
      traces: true,
    } as const;
    // asOf=P_NOW：该事件 serverTs=P_LATE 晚于 asOf，被过滤——未回看
    expect(
      traceOf(
        phaseRequest({
          scope: { studentIds: [phaseStudentA], days: "all" },
          modules: tracesModules,
          asOf: P_NOW,
        }),
        P_LATE,
      )?.reviewedSolution,
    ).toBe(false);
    // 无 asOf（now=P_LATE）：事件在场——已回看
    expect(
      traceOf(
        phaseRequest({
          scope: { studentIds: [phaseStudentA], days: "all" },
          modules: tracesModules,
        }),
        P_LATE,
      )?.reviewedSolution,
    ).toBe(true);
  });
});

// ---------- ink 路径目录边界（T6R.14 收敛：resolveWithinRootOrNull 强算法） ----------

describe("ink 路径目录边界（T6R.14：同前缀相邻目录/向上逃逸/绝对路径拒绝）", () => {
  /**
   * 独立小世界（不碰共享种子世界——ink 行数被多处测试锁死精确值）：
   * 一名学生 + 一道已交卷题 + 一行 ink（pngPath 由用例注入）。
   * 旧实现 export-service 内联 `abs.startsWith(inkRoot)`（T6R.12 安全审查
   * 留档「既有」）：blobs/inkfoo 这类**同前缀相邻目录**能骗过字符串前缀
   * 比对——换成 lib/blob-io 的 path.relative 强边界后必须整批拒绝。
   */
  function makeInkWorld(
    pngPath: string,
    fileRel?: string,
  ): {
    db: Db;
    dataDir: string;
    studentId: string;
  } {
    const worldDb = createTestDb();
    const worldDir = createTestDir();
    const worldStudent = makeStudent(worldDb);
    const { attemptId } = frozenDraftAttempt(worldDb, worldStudent, [
      {
        questionId: "q-boundary",
        snapshotJson: snapshotJsonOf({ id: "q-boundary" }),
      },
    ]);
    submitAttemptStatus(worldDb, attemptId);
    worldDb
      .insert(ink)
      .values({
        id: randomUUID(),
        attemptId,
        questionId: "q-boundary",
        strokesPath: join("blobs", "ink", attemptId, "q-boundary.json.gz"),
        pngPath,
        width: 10,
        height: 10,
        strokeCount: 1,
        updatedAt: "2026-10-01T00:00:00.000Z",
      })
      .run();
    // 越界路径物理落文件：证明拒绝的是目录边界而非文件缺失（statSync 可达）
    if (fileRel !== undefined) {
      mkdirSync(dirname(resolve(worldDir, fileRel)), { recursive: true });
      writeFileSync(resolve(worldDir, fileRel), "png-bytes");
    }
    return { db: worldDb, dataDir: worldDir, studentId: worldStudent };
  }

  async function assembleErrorOf(
    world: ReturnType<typeof makeInkWorld>,
  ): Promise<unknown> {
    try {
      assembleLearningPack(
        world.db,
        world.dataDir,
        TEST_TEACHER_ID,
        learningPackExportRequestSchema.parse({
          scope: { studentIds: [world.studentId] },
          // ink 是附件开关，须伴一个内容模块（summaries 最轻）才过契约
          modules: { ink: true, summaries: true },
          goal: "diagnose-weakness",
        }),
      );
      return null; // 未抛错
    } catch (err: unknown) {
      return err;
    } finally {
      world.db.$client.close();
    }
  }

  it("同前缀相邻目录（blobs/inkfoo）越界：500 INK_UNREADABLE（startsWith 弱校验的缺口）", async () => {
    const world = makeInkWorld(
      "blobs/inkfoo/evil.png",
      join("blobs", "inkfoo", "evil.png"),
    );
    const err = await assembleErrorOf(world);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(500);
    expect((err as HttpError).code).toBe("INK_UNREADABLE");
  });

  it(".. 向上逃逸出 blobs/ink：500 INK_UNREADABLE（既有行为的回归守卫）", async () => {
    const world = makeInkWorld(
      "blobs/ink/../../secret.png",
      join("blobs", "..", "secret.png"),
    );
    const err = await assembleErrorOf(world);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe("INK_UNREADABLE");
  });

  it("绝对路径（UNC 形态）整体替换 base：500 INK_UNREADABLE（回归守卫）", async () => {
    // Windows 下 resolve() 对绝对路径直接替换 base——relative 判定产绝对
    // 结果 → 越界；字符串 startsWith 同样拦不住（它不是 dataDir 内路径）。
    // UNC 前缀用 join 构造（\\\\evil\share\x.png），避开字面量转义噪音
    const uncPath = ["", "", "evil", "share", "x.png"].join("\\");
    const world = makeInkWorld(uncPath);
    const err = await assembleErrorOf(world);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe("INK_UNREADABLE");
  });
});

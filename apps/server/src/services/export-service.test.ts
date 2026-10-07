import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
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
  ink,
  lectures,
  noteImages as noteImagesTable,
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
import { insertEvidence } from "../test/note-world";
import { submitAttempt } from "./attempt-service";
import {
  assembleLearningPack,
  buildLearningPackZip,
  previewLearningPack,
} from "./export-service";
import { saveInk } from "./ink-service";
import { saveMedia } from "./media-service";
import { attachNoteImage, saveNoteVersion } from "./note-service";
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

/**
 * 测试内嵌的最小 zip 解包器（central directory 权威口径；不引入新依赖——
 * 技术栈清单无解压库，EOCD → CD → local header → inflateRaw）。
 */
function unzipEntries(buffer: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(buffer);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("测试夹具：zip 缺少 EOCD");
  const count = buf.readUInt16LE(eocd + 10);
  let cursor = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("测试夹具：central directory 签名错误");
    }
    const method = buf.readUInt16LE(cursor + 10);
    const compSize = buf.readUInt32LE(cursor + 20);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString("utf8", cursor + 46, cursor + 46 + nameLen);
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`测试夹具：${name} 的 local header 签名错误`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return out;
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
  });

  /** v2 请求（默认题目 solution 层 + 逐题作答 + 证据） */
  function makeV2Request(
    overrides: Record<string, unknown> = {},
  ): LearningPackExportRequest {
    return learningPackExportRequestSchema.parse({
      packVersion: 2,
      scope: { studentIds: [v2Student] },
      modules: { questions: "solution", responses: true, evidence: true },
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

    // —— 证据：round1 frozen（两页一在场一缺失）+ round2 not_collected ——
    const evidence = pack.evidence ?? [];
    expect(evidence).toHaveLength(2);
    // T6R.16：evidenceRef 单值 → evidenceRefs 数组（单1 过渡为单元素数组）
    expect(responses[0]?.evidenceRefs).toEqual([evidence[0]?.ref]);
    expect(responses[1]?.evidenceRefs).toEqual([evidence[1]?.ref]);
    expect(evidence[0]?.state).toBe("frozen");
    expect(evidence[0]?.version?.versionId).toBe(frozenVersionId);
    expect(evidence[0]?.images).toHaveLength(2);
    expect(evidence[0]?.images[0]?.state).toBe("ready");
    expect(evidence[0]?.images[1]?.state).toBe("missing");
    expect(evidence[1]?.state).toBe("not_collected");

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
    // 在场证据图条目存在
    expect(entries.has("evidence/e001-original-01.png")).toBe(true);
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

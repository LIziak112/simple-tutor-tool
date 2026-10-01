import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import type { LearningPack, LearningPackExportRequest } from "@tutor/contract";
import {
  learningPackExportRequestSchema,
  learningPackSchema,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { attempts } from "../db/schema";
import { createTestDb, createTestDir, TEST_TEACHER_ID } from "../db/test-utils";
import { HttpError } from "../lib/http-error";
import { submitAttempt } from "./attempt-service";
import {
  assembleLearningPack,
  buildLearningPackZip,
  previewLearningPack,
} from "./export-service";
import { saveInk } from "./ink-service";
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
    const pack: LearningPack = learningPackSchema.parse(
      JSON.parse(entries.get("pack.json")?.toString("utf8") ?? "{}"),
    );
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

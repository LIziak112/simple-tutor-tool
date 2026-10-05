import { randomUUID } from "node:crypto";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { NoteDoc, NoteDocInput } from "@tutor/contract";
import {
  NOTE_BODY_GZIP_MAX_BYTES,
  NOTE_MAX_TOTAL_POINTS,
  noteDocSchema,
  noteVersionReceiptSchema,
} from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { createDb, type Db } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  type Attempt,
  attempts as attemptsTable,
  noteImages as noteImagesTable,
  notes as notesTable,
  noteVersions as noteVersionsTable,
  students as studentsTable,
  submissionEvidence as submissionEvidenceTable,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { insertFrozenResponse, newDraftAttempt } from "./attempt-service.ts";
import {
  canonicalNoteJson,
  gcNoteVersions,
  noteBodyRelPath,
  noteDocSha256,
  readNoteVersionDoc,
  resolveNoteBodyPath,
  saveNoteVersion,
  writeNoteBodyFile,
} from "./note-service.ts";

/**
 * T6R.4 服务层测试：不可变版本存储、CAS 与幂等。
 * 覆盖任务清单全部失败测试项（直接建库插行，不经路由）：
 * - 规范化 hash：固定字段顺序、默认值物化、gzip 字节/客户端键序不参与；
 * - 限额分级：gzip 字节/解压/复杂度 → 413 NOTE_LIMIT_EXCEEDED，形状错误 → 400；
 * - 文件协议：唯一临时文件 → rename 不可变路径；两请求不共享 tmp；失败清理；
 * - CAS/幂等：A/B 并发仅一个成功、丢回执重试逐字段原回执、同 mutationId 不同
 *   正文拒绝、幂等检查先于冲突判断、跨学生/跨 attempt mutation 重放拒绝；
 * - 故障注入：写文件失败/rename 失败/DB 失败/rename 前后中断不破坏上一版本；
 * - 目录边界：../、同前缀相邻目录、DSL 特殊 id（含 Windows 保留名）不进路径；
 * - 服务重启（新进程重开文件库）后已确认正文可读且 hash 稳定；
 * - GC：安全窗口 + 保留集合（head/evidence 引用）+ 过期 tmp 清扫。
 */

// ---------- 夹具 ----------

let studentSeq = 0;

/** 直插学生行（归属测试教师；requireUsableAttempt 只需 studentId 匹配） */
function makeStudent(db: Db): string {
  const id = randomUUID();
  studentSeq += 1;
  db.insert(studentsTable)
    .values({
      id,
      teacherId: TEST_TEACHER_ID,
      displayName: `学生${studentSeq}`,
      loginName: `stu-${id.slice(0, 8)}`,
      passwordHash: null,
      linkToken: `link-${id}`,
      linkEnabled: true,
      passwordEnabled: false,
      note: null,
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  return id;
}

/**
 * 直插已冻结 attempt + 逐题冻结 responses 行（questionRevisionId = 行 id）。
 * assignment 来源（归属即权限）+ frozenAt 置位，避免懒冻结分支干扰。
 */
function makeFrozenAttempt(
  db: Db,
  studentId: string,
  questionIds: readonly string[],
  status: "draft" | "submitted" = "draft",
): { attemptId: string; revisionIds: Map<string, string> } {
  const base = newDraftAttempt({
    id: randomUUID(),
    studentId,
    sourceType: "assignment",
    assignmentId: null,
    courseId: null,
    unitId: null,
    attemptNo: 1,
    startedAt: "2026-10-01T00:00:00.000Z",
  });
  const attempt: Attempt =
    status === "submitted"
      ? {
          ...base,
          status: "submitted",
          submittedAt: "2026-10-01T01:00:00.000Z",
        }
      : base;
  const revisionIds = new Map<string, string>();
  db.transaction((tx) => {
    tx.insert(attemptsTable).values(attempt).run();
    for (const qid of questionIds) {
      // insertFrozenResponse 返回行 id（= questionRevisionId），直接取用
      revisionIds.set(
        qid,
        insertFrozenResponse(tx, {
          attemptId: attempt.id,
          questionId: qid,
          questionVersion: 1,
          questionSnapshotJson: JSON.stringify({ id: qid, stem: "占位" }),
          unitId: null,
        }),
      );
    }
  });
  return { attemptId: attempt.id, revisionIds };
}

/** 最小合法 NoteDoc（n 笔，每笔 2 点，y 可区分不同稿） */
function noteDoc(strokes = 1, y = 20): NoteDoc {
  return {
    version: 1,
    ink: {
      width: 1000,
      strokes: Array.from({ length: strokes }, (_, i) => ({
        tool: "pen" as const,
        color: "#1f2328",
        weight: 4,
        points: [
          { x: 10 + i, y, p: 0.5, t: 0 },
          { x: 30 + i, y: y + 5, p: 0.8, t: 25 },
        ],
      })),
    },
    paperHeightLogical: 800,
    background: "grid",
  };
}

function gzipJson(value: unknown): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(JSON.stringify(value), "utf8")));
}

interface SaveArgs {
  studentId: string;
  attemptId: string;
  questionId: string;
  body: Uint8Array | NoteDocInput;
  baseRevision?: number;
  mutationId?: string;
}

/** 直调服务（默认 gzip 打包 NoteDocInput；body 传字节则原样使用） */
function save(db: Db, dataDir: string, args: SaveArgs) {
  const bytes =
    args.body instanceof Uint8Array ? args.body : gzipJson(args.body);
  return saveNoteVersion(
    db,
    dataDir,
    args.studentId,
    args.attemptId,
    args.questionId,
    bytes,
    {
      baseRevision: args.baseRevision ?? 0,
      mutationId: args.mutationId ?? randomUUID(),
    },
  );
}

function errInfo(err: unknown): {
  status: number;
  code: string;
  extra: Record<string, unknown> | undefined;
} {
  const e = err as {
    status?: number;
    code?: string;
    extra?: Record<string, unknown>;
  };
  return { status: e.status ?? -1, code: e.code ?? "", extra: e.extra };
}

/** 捕获抛错（不抛则测试失败）；配合 errInfo 断言状态码/错误码 */
function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("期望抛错但成功了");
}

/** 取唯一行（空/多行即测试失败；替代非空断言的行断言口径） */
function sole<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`预期存在唯一行：${what}`);
  expect(rows).toHaveLength(1);
  return row;
}

/** blobs/notes 下全部文件（相对 dataDir），用于断言落盘布局与残留 */
function noteFiles(dataDir: string): string[] {
  const root = join(dataDir, "blobs", "notes");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  // 根被同名文件占据等异常形态（故障注入现场）按无文件处理
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const dir of entries) {
    if (!dir.isDirectory()) continue;
    for (const f of readdirSync(join(root, dir.name))) {
      out.push(join("blobs", "notes", dir.name, f));
    }
  }
  return out;
}

function tmpFiles(dataDir: string): string[] {
  return noteFiles(dataDir).filter((f) => f.includes(".tmp-"));
}

/** 标准测试世界：内存库 + 临时目录 + 一名学生 + 已冻结 attempt（默认两题） */
function makeWorld(questionIds: readonly string[] = ["q1", "q2"]): {
  db: Db;
  dataDir: string;
  studentId: string;
  attemptId: string;
  revisionIds: Map<string, string>;
} {
  const db = createTestDb();
  const dataDir = createTestDir();
  const studentId = makeStudent(db);
  const { attemptId, revisionIds } = makeFrozenAttempt(
    db,
    studentId,
    questionIds,
  );
  return { db, dataDir, studentId, attemptId, revisionIds };
}

/** 把某版本 serverSavedAt 改到过去（模拟安全窗口流逝；直插场景专用） */
function ageVersion(
  db: Db,
  versionId: string,
  iso = "2026-01-01T00:00:00.000Z",
) {
  db.$client
    .prepare("UPDATE note_versions SET server_saved_at = ? WHERE id = ?")
    .run(iso, versionId);
}

// ---------- 规范化与 hash ----------

describe("hash 规范化：固定字段顺序 + 默认值物化", () => {
  it("canonicalNoteJson 输出固定键序的紧凑 JSON（逐字符断言）", () => {
    const doc = noteDoc(1);
    const stroke = doc.ink.strokes[0];
    if (stroke === undefined) throw new Error("夹具错误：无笔画");
    stroke.points = [{ x: 10, y: 20, p: 0.5, t: 0 }];
    expect(canonicalNoteJson(doc)).toBe(
      JSON.stringify({
        version: 1,
        ink: {
          width: 1000,
          strokes: [
            {
              tool: "pen",
              color: "#1f2328",
              weight: 4,
              points: [{ x: 10, y: 20, p: 0.5, t: 0 }],
            },
          ],
        },
        paperHeightLogical: 800,
        background: "grid",
      }),
    );
  });

  it("客户端 JSON 键序不参与 hash：两份键序不同的同一文档 hash 相同且稳定", () => {
    const doc = noteDoc(2);
    const reordered = {
      background: doc.background,
      paperHeightLogical: doc.paperHeightLogical,
      ink: {
        strokes: doc.ink.strokes.map((s) => ({
          points: s.points,
          weight: s.weight,
          color: s.color,
          tool: s.tool,
        })),
        width: 1000,
      },
      version: 1,
    };
    const a = noteDocSha256(
      noteDocSchema.parse(JSON.parse(JSON.stringify(doc))),
    );
    expect(noteDocSha256(noteDocSchema.parse(reordered))).toBe(a);
    expect(noteDocSha256(doc)).toBe(a);
  });

  it("缺省 paperHeightLogical/background 与显式默认值物化后 hash 相同", () => {
    const doc = noteDoc(1);
    const noDefaults = {
      version: 1,
      ink: { width: 1000, strokes: doc.ink.strokes },
    };
    expect(noteDocSha256(noteDocSchema.parse(noDefaults))).toBe(
      noteDocSha256(doc),
    );
  });

  it("gzip 压缩字节不参与 hash：同文档不同压缩级别上传命中同一幂等回执", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld(["q1"]);
    const doc = noteDoc(1);
    const m = "00000000-0000-4000-8000-000000000001";
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: doc,
      mutationId: m,
    });
    const raw = JSON.stringify(doc);
    const r2 = saveNoteVersion(
      db,
      dataDir,
      studentId,
      attemptId,
      "q1",
      new Uint8Array(gzipSync(Buffer.from(raw, "utf8"), { level: 1 })),
      { baseRevision: 0, mutationId: m },
    );
    expect(r2).toEqual(r1);
  });
});

// ---------- 解析与限额 ----------

describe("正文解析与限额分级", () => {
  const db = createTestDb();
  const dataDir = createTestDir();
  const studentId = makeStudent(db);
  const { attemptId } = makeFrozenAttempt(db, studentId, ["q1"]);

  it("gzip 与原始 JSON 两种通道都可上传成功", () => {
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: gzipJson(noteDoc(1)),
    });
    expect(r1.revision).toBe(1);
    const r2 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: new Uint8Array(Buffer.from(JSON.stringify(noteDoc(2)), "utf8")),
      baseRevision: 1,
    });
    expect(r2.revision).toBe(2);
  });

  it("gzip 字节超 NOTE_BODY_GZIP_MAX_BYTES → 413 NOTE_LIMIT_EXCEEDED（不落盘不落库）", () => {
    const big = new Uint8Array(NOTE_BODY_GZIP_MAX_BYTES + 1).fill(0x61);
    const info = errInfo(
      capture(() =>
        save(db, dataDir, {
          studentId,
          attemptId,
          questionId: "q1",
          body: big,
          baseRevision: 2,
        }),
      ),
    );
    expect(info).toMatchObject({ status: 413, code: "NOTE_LIMIT_EXCEEDED" });
    expect(
      db
        .select()
        .from(noteVersionsTable)
        .all()
        .filter((r) => r.revision === 3),
    ).toHaveLength(0);
  });

  it("高压缩比 gzip 炸弹（解压超 32MiB 上限）→ 413 NOTE_LIMIT_EXCEEDED，而非 400 或解出大 Buffer", () => {
    // 40MiB 全零 → gzip 后仅数十 KB，绕过压缩字节限额；必须被解压上限拦截
    const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024));
    const info = errInfo(
      capture(() =>
        save(db, dataDir, {
          studentId,
          attemptId,
          questionId: "q1",
          body: new Uint8Array(bomb),
          baseRevision: 2,
        }),
      ),
    );
    expect(info).toMatchObject({ status: 413, code: "NOTE_LIMIT_EXCEEDED" });
  });

  it("损坏 gzip（魔数对但截断）→ 400 NOTE_VALIDATION_FAILED", () => {
    const gz = gzipJson(noteDoc(1)).slice(0, 10);
    const info = errInfo(
      capture(() =>
        save(db, dataDir, {
          studentId,
          attemptId,
          questionId: "q1",
          body: gz,
          baseRevision: 2,
        }),
      ),
    );
    expect(info).toMatchObject({ status: 400, code: "NOTE_VALIDATION_FAILED" });
  });

  it("非 JSON / 坐标形状错误 → 400 NOTE_VALIDATION_FAILED", () => {
    const bad1 = errInfo(
      capture(() =>
        save(db, dataDir, {
          studentId,
          attemptId,
          questionId: "q1",
          body: new Uint8Array(Buffer.from("not-json{", "utf8")),
          baseRevision: 2,
        }),
      ),
    );
    expect(bad1).toMatchObject({ status: 400, code: "NOTE_VALIDATION_FAILED" });

    const badDoc = noteDoc(1);
    const badStroke = badDoc.ink.strokes[0];
    if (badStroke === undefined) throw new Error("夹具错误：无笔画");
    badStroke.points[0] = { x: -1, y: 20, p: 0.5, t: 0 };
    const bad2 = errInfo(
      capture(() =>
        save(db, dataDir, {
          studentId,
          attemptId,
          questionId: "q1",
          body: badDoc,
          baseRevision: 2,
        }),
      ),
    );
    expect(bad2).toMatchObject({ status: 400, code: "NOTE_VALIDATION_FAILED" });
  });

  it("复杂度超预算（单笔/总点数超上限）→ 413 NOTE_LIMIT_EXCEEDED（与形状错误分级）", () => {
    // 单笔 2001 点 > NOTE_MAX_POINTS_PER_STROKE(2000)
    const perStroke = noteDoc(1);
    const perStrokeStroke = perStroke.ink.strokes[0];
    if (perStrokeStroke === undefined) throw new Error("夹具错误：无笔画");
    perStrokeStroke.points = Array.from({ length: 2001 }, (_, i) => ({
      x: i % 1000,
      y: 20,
      p: 0.5,
      t: i,
    }));
    const r1 = errInfo(
      capture(() =>
        save(db, dataDir, {
          studentId,
          attemptId,
          questionId: "q1",
          body: perStroke,
          baseRevision: 2,
        }),
      ),
    );
    expect(r1).toMatchObject({ status: 413, code: "NOTE_LIMIT_EXCEEDED" });

    // 151 笔 × 2000 点 = 302000 > NOTE_MAX_TOTAL_POINTS(300000)
    const total = noteDoc(151);
    for (const s of total.ink.strokes) {
      s.points = Array.from({ length: 2000 }, (_, i) => ({
        x: i % 1000,
        y: 20,
        p: 0.5,
        t: i,
      }));
    }
    const r2 = errInfo(
      capture(() =>
        save(db, dataDir, {
          studentId,
          attemptId,
          questionId: "q1",
          body: total,
          baseRevision: 2,
        }),
      ),
    );
    expect(r2).toMatchObject({ status: 413, code: "NOTE_LIMIT_EXCEEDED" });
    expect(NOTE_MAX_TOTAL_POINTS).toBe(300_000);
  });
});

// ---------- 目录边界 ----------

describe("路径与目录边界", () => {
  it("resolveNoteBodyPath：合法相对路径解析进 blobs/notes；../、同前缀相邻目录、根本身均拒绝", () => {
    const dataDir = createTestDir();
    const abs = resolveNoteBodyPath(
      dataDir,
      join("blobs", "notes", "n1", "v1-abc.json.gz"),
    );
    expect(abs.startsWith(join(dataDir, "blobs", "notes"))).toBe(true);

    // 同前缀相邻目录（字符串 startsWith 会误放行，目录边界校验必须拒绝）
    expect(() =>
      resolveNoteBodyPath(dataDir, join("blobs", "notes-evil", "v1.json.gz")),
    ).toThrowError();
    expect(() =>
      resolveNoteBodyPath(
        dataDir,
        join("blobs", "notes", "..", "ink", "a.json.gz"),
      ),
    ).toThrowError();
    // 根目录本身与向上逃逸
    expect(() =>
      resolveNoteBodyPath(dataDir, join("blobs", "notes")),
    ).toThrowError();
    expect(() =>
      resolveNoteBodyPath(dataDir, join("blobs", "notes", "a", "..", "..")),
    ).toThrowError();
    // 非 .json.gz 后缀拒绝（纵深防御）
    expect(() =>
      resolveNoteBodyPath(dataDir, join("blobs", "notes", "a", "v1.png")),
    ).toThrowError();
  });

  it("DSL 特殊 questionId 与 Windows 保留名不进文件路径：目录只有 noteId UUID 段", () => {
    const db = createTestDb();
    const dir = createTestDir();
    const studentId = makeStudent(db);
    const specialIds = [
      "练习四-7",
      "q.with.dots",
      "a..b",
      "CON",
      "NUL",
      "相对/../路径",
      "空 格",
    ];
    const { attemptId } = makeFrozenAttempt(db, studentId, specialIds);
    for (const qid of specialIds) {
      save(db, dir, {
        studentId,
        attemptId,
        questionId: qid,
        body: noteDoc(1),
      });
    }
    const root = join(dir, "blobs", "notes");
    const dirs = readdirSync(root);
    expect(dirs).toHaveLength(specialIds.length);
    for (const d of dirs) {
      expect(d).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });
});

// ---------- CAS / 幂等 / 并发 ----------

describe("CAS 与幂等（T6R.4 核心不变量）", () => {
  it("首次上传：revision 1、回执过契约 schema、文件与行齐全、questionRevisionId=responses 行 id", () => {
    const { db, dataDir, studentId, attemptId, revisionIds } = makeWorld();
    const doc = noteDoc(2);
    const r = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: doc,
    });
    expect(noteVersionReceiptSchema.safeParse(r).success).toBe(true);
    expect(r.revision).toBe(1);
    expect(r.hash).toBe(noteDocSha256(doc));

    const noteRow = sole(db.select().from(notesTable).all(), "notes 行");
    expect(noteRow.attemptId).toBe(attemptId);
    expect(noteRow.questionId).toBe("q1");
    expect(noteRow.phase).toBe("scratch");
    expect(noteRow.questionRevisionId).toBe(revisionIds.get("q1"));
    expect(noteRow.currentRevision).toBe(1);
    expect(noteRow.currentVersionId).toBe(r.versionId);
    expect(noteRow.serverSavedAt).toBe(r.savedAt);

    const vRow = sole(
      db.select().from(noteVersionsTable).all(),
      "note_versions 行",
    );
    expect(vRow.noteId).toBe(r.noteId);
    expect(vRow.revision).toBe(1);
    expect(vRow.strokeCount).toBe(2);
    expect(vRow.pointCount).toBe(4);
    expect(vRow.paperWidth).toBe(1000);
    expect(vRow.paperHeight).toBe(800);
    expect(vRow.bodyPath).toBe(
      noteBodyRelPath(r.noteId, 1, noteDocSha256(doc)),
    );
    expect(vRow.mutationId).toBeTruthy(); // 服务层恒写非空
    // 文件存在且为规范化正文的 gzip
    const abs = resolveNoteBodyPath(dataDir, vRow.bodyPath);
    expect(gunzipSync(readFileSync(abs)).toString("utf8")).toBe(
      canonicalNoteJson(doc),
    );
  });

  it("A/B 并发（同 baseRevision）：仅一个成功，另一个 409 附当前版本摘要且无文件残留", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld();
    const docA = noteDoc(1, 20);
    const docB = noteDoc(1, 99);
    const ra = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: docA,
      mutationId: "11111111-1111-4111-8111-111111111111",
    });
    expect(ra.revision).toBe(1);
    const err = capture(() =>
      save(db, dataDir, {
        studentId,
        attemptId,
        questionId: "q1",
        body: docB,
        mutationId: "22222222-2222-4222-8222-222222222222",
      }),
    ) as { status: number; code: string; extra?: Record<string, unknown> };
    expect(err.status).toBe(409);
    expect(err.code).toBe("NOTE_REVISION_CONFLICT");
    expect(err.extra?._current).toMatchObject({
      revision: 1,
      hash: noteDocSha256(docA),
    });
    // B 无落盘：目录里只有 A 的 v1 文件，且无任何 tmp
    expect(noteFiles(dataDir)).toHaveLength(1);
    expect(tmpFiles(dataDir)).toHaveLength(0);
    expect(db.select().from(noteVersionsTable).all()).toHaveLength(1);
  });

  it("丢回执重试：同 mutationId 同正文 → 逐字段相同回执，不产生新版本", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld();
    const doc = noteDoc(1);
    const mutationId = "33333333-3333-4333-8333-333333333333";
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: doc,
      mutationId,
    });
    // 客户端丢了回执，仍以旧 baseRevision 重试（含键序重排的同一文档）
    const reorderedRaw: NoteDocInput = {
      version: 1,
      ink: {
        strokes: doc.ink.strokes.map((s) => ({
          points: s.points,
          weight: s.weight,
          color: s.color,
          tool: s.tool,
        })),
        width: 1000,
      },
    };
    const r2 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: reorderedRaw,
      mutationId,
    });
    expect(r2).toEqual(r1);
    expect(db.select().from(noteVersionsTable).all()).toHaveLength(1);
  });

  it("同 mutationId 不同正文 → 409 NOTE_MUTATION_MISMATCH，不落盘不落库", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld();
    const mutationId = "44444444-4444-4444-8444-444444444444";
    save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      mutationId,
    });
    const info = errInfo(
      capture(() =>
        save(db, dataDir, {
          studentId,
          attemptId,
          questionId: "q1",
          body: noteDoc(2),
          baseRevision: 1,
          mutationId,
        }),
      ),
    );
    expect(info).toMatchObject({ status: 409, code: "NOTE_MUTATION_MISMATCH" });
    expect(db.select().from(noteVersionsTable).all()).toHaveLength(1);
    expect(noteFiles(dataDir)).toHaveLength(1);
  });

  it("幂等检查先于冲突判断：head 已是 2 时重放 mutation1（base 0）仍返回 revision 1 原回执", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld();
    const m1 = "55555555-5555-4555-8555-555555555555";
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      mutationId: m1,
    });
    const r2 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(2),
      baseRevision: 1,
    });
    expect(r2.revision).toBe(2);
    const replay = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      baseRevision: 0,
      mutationId: m1,
    });
    expect(replay).toEqual(r1);
  });

  it("幂等重放前置于状态门槛：已交卷后重放原请求仍得原回执（复审①裁决）", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld(["q1"]);
    const m = "88888888-8888-4888-8888-888888888888";
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      mutationId: m,
    });
    // 置为已交卷（重放不应被状态门槛挡）
    db.$client
      .prepare(
        "UPDATE attempts SET status = 'submitted', submitted_at = ? WHERE id = ?",
      )
      .run("2026-10-02T00:00:00.000Z", attemptId);
    const replay = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      mutationId: m,
    });
    expect(replay).toEqual(r1);
    // 新 mutation 的写入仍受交卷门槛约束（只有重放豁免）
    const info = errInfo(
      capture(() =>
        save(db, dataDir, {
          studentId,
          attemptId,
          questionId: "q1",
          body: noteDoc(2),
          baseRevision: 1,
        }),
      ),
    );
    expect(info).toMatchObject({ status: 409, code: "ALREADY_SUBMITTED" });
  });

  it("续写：revision 递增、head 切换、旧版本文件仍在、scratch 行唯一且 noteId 稳定", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld();
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });
    const r2 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(2),
      baseRevision: 1,
    });
    expect(r2.noteId).toBe(r1.noteId);
    expect(r2.revision).toBe(2);
    expect(db.select().from(notesTable).all()).toHaveLength(1);
    expect(db.select().from(noteVersionsTable).all()).toHaveLength(2);
    expect(noteFiles(dataDir)).toHaveLength(2);
    const head = sole(db.select().from(notesTable).all(), "notes head 行");
    expect(head.currentRevision).toBe(2);
    expect(head.currentVersionId).toBe(r2.versionId);
  });

  it("跨学生重放他人 mutationId → 409 NOTE_MUTATION_MISMATCH，不回他回执也不落行", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const aId = makeStudent(db);
    const bId = makeStudent(db);
    const a = makeFrozenAttempt(db, aId, ["q1"]);
    const b = makeFrozenAttempt(db, bId, ["q1"]);
    const m = "66666666-6666-4666-8666-666666666666";
    save(db, dataDir, {
      studentId: aId,
      attemptId: a.attemptId,
      questionId: "q1",
      body: noteDoc(1),
      mutationId: m,
    });
    const info = errInfo(
      capture(() =>
        save(db, dataDir, {
          studentId: bId,
          attemptId: b.attemptId,
          questionId: "q1",
          body: noteDoc(1),
          mutationId: m,
        }),
      ),
    );
    expect(info).toMatchObject({ status: 409, code: "NOTE_MUTATION_MISMATCH" });
    // B 没有任何笔记行；notes 只属 A
    const noteRows = db.select().from(notesTable).all();
    expect(noteRows).toHaveLength(1);
    expect(sole(noteRows, "A 的 notes 行").attemptId).toBe(a.attemptId);
  });

  it("跨 attempt 重放自己的 mutationId → 409 NOTE_MUTATION_MISMATCH", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const studentId = makeStudent(db);
    const a1 = makeFrozenAttempt(db, studentId, ["q1"]);
    const a2 = makeFrozenAttempt(db, studentId, ["q1"]);
    const m = "77777777-7777-4777-8777-777777777777";
    save(db, dataDir, {
      studentId,
      attemptId: a1.attemptId,
      questionId: "q1",
      body: noteDoc(1),
      mutationId: m,
    });
    const info = errInfo(
      capture(() =>
        save(db, dataDir, {
          studentId,
          attemptId: a2.attemptId,
          questionId: "q1",
          body: noteDoc(1),
          mutationId: m,
        }),
      ),
    );
    expect(info).toMatchObject({ status: 409, code: "NOTE_MUTATION_MISMATCH" });
  });

  it("门槛：非本人 403、attempt 不存在 404、题目不在冻结集合 404、已交卷 409、快照空行 404、baseRevision 超前 409", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const aId = makeStudent(db);
    const bId = makeStudent(db);
    const { attemptId } = makeFrozenAttempt(db, aId, ["q1"]);
    const submitted = makeFrozenAttempt(db, aId, ["q1"], "submitted");

    expect(
      errInfo(
        capture(() =>
          save(db, dataDir, {
            studentId: bId,
            attemptId,
            questionId: "q1",
            body: noteDoc(1),
          }),
        ),
      ),
    ).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(
      errInfo(
        capture(() =>
          save(db, dataDir, {
            studentId: aId,
            attemptId: randomUUID(),
            questionId: "q1",
            body: noteDoc(1),
          }),
        ),
      ),
    ).toMatchObject({ status: 404, code: "ATTEMPT_NOT_FOUND" });
    expect(
      errInfo(
        capture(() =>
          save(db, dataDir, {
            studentId: aId,
            attemptId,
            questionId: "nope",
            body: noteDoc(1),
          }),
        ),
      ),
    ).toMatchObject({ status: 404, code: "QUESTION_NOT_FOUND" });
    expect(
      errInfo(
        capture(() =>
          save(db, dataDir, {
            studentId: aId,
            attemptId: submitted.attemptId,
            questionId: "q1",
            body: noteDoc(1),
          }),
        ),
      ),
    ).toMatchObject({ status: 409, code: "ALREADY_SUBMITTED" });
    // baseRevision 超前（head=0，期望 99）
    expect(
      errInfo(
        capture(() =>
          save(db, dataDir, {
            studentId: aId,
            attemptId,
            questionId: "q1",
            body: noteDoc(1),
            baseRevision: 99,
          }),
        ),
      ),
    ).toMatchObject({ status: 409, code: "NOTE_REVISION_CONFLICT" });
    // 快照为空的历史行不算冻结集合成员（T6R.3 口径）
    db.$client
      .prepare(
        "UPDATE responses SET question_snapshot_json = NULL WHERE attempt_id = ?",
      )
      .run(attemptId);
    expect(
      errInfo(
        capture(() =>
          save(db, dataDir, {
            studentId: aId,
            attemptId,
            questionId: "q1",
            body: noteDoc(1),
          }),
        ),
      ),
    ).toMatchObject({ status: 404, code: "QUESTION_NOT_FOUND" });
  });
});

// ---------- 故障注入 ----------

describe("故障注入：不破坏上一版本", () => {
  it("写临时文件失败：抛错、无 tmp 残留、无新行，v1 完好可读", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld(["q1"]);
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });

    expect(() =>
      saveNoteVersion(
        db,
        dataDir,
        studentId,
        attemptId,
        "q1",
        gzipJson(noteDoc(2)),
        { baseRevision: 1, mutationId: randomUUID() },
        {
          beforeTmpWrite: () => {
            throw new Error("模拟磁盘写失败");
          },
        },
      ),
    ).toThrowError(/模拟磁盘写失败/);
    expect(tmpFiles(dataDir)).toHaveLength(0);
    expect(db.select().from(noteVersionsTable).all()).toHaveLength(1);
    const read = readNoteVersionDoc(db, dataDir, r1.versionId);
    expect(read.doc).toEqual(noteDoc(1));
    expect(read.recomputedHash).toBe(r1.hash);
  });

  it("rename 失败（目标不可变路径被目录占据）：tmp 清理、无新行，v1 完好", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld(["q1"]);
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });

    const doc2 = noteDoc(2);
    const hash2 = noteDocSha256(doc2);
    // 抢先在目标不可变路径建目录，让 renameSync(file→dir) 失败
    mkdirSync(
      resolveNoteBodyPath(dataDir, noteBodyRelPath(r1.noteId, 2, hash2)),
    );

    expect(() =>
      save(db, dataDir, {
        studentId,
        attemptId,
        questionId: "q1",
        body: doc2,
        baseRevision: 1,
      }),
    ).toThrowError();
    expect(tmpFiles(dataDir)).toHaveLength(0);
    expect(db.select().from(noteVersionsTable).all()).toHaveLength(1);
    expect(readNoteVersionDoc(db, dataDir, r1.versionId).doc).toEqual(
      noteDoc(1),
    );
  });

  it("DB 失败（rename 后事务前关闭连接）：抛错、孤儿不可变文件被清理、重开库 v1 完好 head 未变", () => {
    const dataDir = createTestDir();
    const dbFile = join(dataDir, "tutor.db");
    const db = createDb(dbFile);
    runMigrations(db);
    const studentId = makeStudent(db);
    const { attemptId } = makeFrozenAttempt(db, studentId, ["q1"]);
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });

    expect(() =>
      saveNoteVersion(
        db,
        dataDir,
        studentId,
        attemptId,
        "q1",
        gzipJson(noteDoc(2)),
        { baseRevision: 1, mutationId: randomUUID() },
        { afterRename: () => db.$client.close() },
      ),
    ).toThrowError();

    // 重开库（服务重启口径）：head 仍是 v1、v2 无行；v2 孤儿文件已被清理
    const db2 = createDb(dbFile);
    expect(
      sole(db2.select().from(notesTable).all(), "head 行").currentRevision,
    ).toBe(1);
    expect(db2.select().from(noteVersionsTable).all()).toHaveLength(1);
    expect(noteFiles(dataDir)).toHaveLength(1);
    expect(readNoteVersionDoc(db2, dataDir, r1.versionId).doc).toEqual(
      noteDoc(1),
    );
    db2.$client.close();
  });

  it("崩溃模拟——rename 后中断：留下未引用文件但 DB 无行，v1 完好；GC 在安全窗口后清掉孤儿", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld(["q1"]);
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });

    // 直接构造「rename 完成、事务未开始」的崩溃现场（进程若在此刻死掉）
    const doc2 = noteDoc(2);
    const hash2 = noteDocSha256(doc2);
    writeNoteBodyFile(
      dataDir,
      r1.noteId,
      2,
      hash2,
      Buffer.from(canonicalNoteJson(doc2), "utf8"),
    );
    expect(noteFiles(dataDir)).toHaveLength(2);
    // v1 仍完好、head 未变
    expect(readNoteVersionDoc(db, dataDir, r1.versionId).doc).toEqual(
      noteDoc(1),
    );
    expect(
      sole(db.select().from(notesTable).all(), "head 行").currentRevision,
    ).toBe(1);
    // GC（远期 now）清掉未引用孤儿文件（无 DB 行的崩溃残留）
    const gcResult = gcNoteVersions(db, dataDir, {
      now: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(gcResult.sweptOrphanFiles).toBe(1);
    expect(noteFiles(dataDir)).toHaveLength(1);
  });

  it("崩溃模拟——rename 前中断：留 tmp 不伤 v1；GC 清过期 tmp、保留窗口内 tmp", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld(["q1"]);
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });

    const noteDir = join(dataDir, "blobs", "notes", r1.noteId);
    // 过期 tmp（48h 前）与在途 tmp（现在）各一个
    const staleTmp = join(noteDir, ".tmp-stale-deadbeef.json.gz");
    const freshTmp = join(noteDir, ".tmp-fresh-cafebabe.json.gz");
    writeFileSync(staleTmp, "x");
    writeFileSync(freshTmp, "y");
    const staleTime = new Date(Date.now() - 48 * 3600 * 1000);
    utimesSync(staleTmp, staleTime, staleTime);

    expect(readNoteVersionDoc(db, dataDir, r1.versionId).doc).toEqual(
      noteDoc(1),
    );
    const result = gcNoteVersions(db, dataDir, { now: new Date() });
    expect(result.sweptTmp).toBe(1);
    expect(existsSync(staleTmp)).toBe(false);
    expect(existsSync(freshTmp)).toBe(true);
  });

  it("两并发请求不共享 tmp：两次在途写入的临时文件名互不相同", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld(["q1"]);
    const seen: string[] = [];
    const hook = () => {
      const tmp = noteFiles(dataDir).find((f) => f.includes(".tmp-"));
      if (tmp) seen.push(tmp);
      throw new Error("中断");
    };
    capture(() =>
      saveNoteVersion(
        db,
        dataDir,
        studentId,
        attemptId,
        "q1",
        gzipJson(noteDoc(1)),
        { baseRevision: 0, mutationId: randomUUID() },
        { beforeRename: hook },
      ),
    );
    capture(() =>
      saveNoteVersion(
        db,
        dataDir,
        studentId,
        attemptId,
        "q1",
        gzipJson(noteDoc(2)),
        { baseRevision: 0, mutationId: randomUUID() },
        { beforeRename: hook },
      ),
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("首传即写失败（blobs/notes 根被同名文件占据）：抛错、零文件零行", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld(["q1"]);
    mkdirSync(join(dataDir, "blobs"), { recursive: true });
    writeFileSync(join(dataDir, "blobs", "notes"), "占位文件");
    // mkdirSync 在「同名文件占据目录路径」时抛 ENOTDIR/EEXIST
    expect(() =>
      save(db, dataDir, {
        studentId,
        attemptId,
        questionId: "q1",
        body: noteDoc(1),
      }),
    ).toThrowError();
    expect(noteFiles(dataDir)).toHaveLength(0);
    expect(db.select().from(notesTable).all()).toHaveLength(0);
  });
});

// ---------- 服务重启 ----------

describe("服务重启：新进程重开库后已确认正文可读且 hash 稳定", () => {
  it("close → 重开文件库 → 文档逐字段一致、hash 与行内一致、文件字节未变、幂等记录仍在", () => {
    const dataDir = createTestDir();
    const dbFile = join(dataDir, "tutor.db");
    const db = createDb(dbFile);
    runMigrations(db);
    const studentId = makeStudent(db);
    const { attemptId } = makeFrozenAttempt(db, studentId, ["q1"]);
    const doc1 = noteDoc(1, 20);
    const doc2 = noteDoc(2, 99);
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: doc1,
    });
    const r2 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: doc2,
      baseRevision: 1,
    });
    const bytes1 = readFileSync(
      resolveNoteBodyPath(dataDir, noteBodyRelPath(r1.noteId, 1, r1.hash)),
    );

    db.$client.close();
    const db2 = createDb(dbFile);

    const v1 = readNoteVersionDoc(db2, dataDir, r1.versionId);
    expect(v1.doc).toEqual(doc1);
    expect(v1.recomputedHash).toBe(r1.hash);
    const v2 = readNoteVersionDoc(db2, dataDir, r2.versionId);
    expect(v2.doc).toEqual(doc2);
    expect(v2.recomputedHash).toBe(r2.hash);
    // 文件字节稳定（未被重启/读取改动）
    expect(
      readFileSync(
        resolveNoteBodyPath(dataDir, noteBodyRelPath(r1.noteId, 1, r1.hash)),
      ),
    ).toEqual(bytes1);
    // 幂等记录仍在：重开库后重放 mutation1 依旧原回执
    const m1Row = db2
      .select()
      .from(noteVersionsTable)
      .all()
      .find((row) => row.revision === 1);
    if (m1Row === undefined || m1Row.mutationId === null) {
      throw new Error("缺 v1 幂等行");
    }
    const m1 = m1Row.mutationId;
    const replay = save(db2, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: doc1,
      mutationId: m1,
    });
    expect(replay).toEqual(r1);
    db2.$client.close();
  });
});

// ---------- GC ----------

describe("未引用版本延迟回收（GC 骨架）", () => {
  it("超窗口的未引用版本被删（行+文件）；head 版本无论如何保留", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld();
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });
    const r2 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(2),
      baseRevision: 1,
    });
    ageVersion(db, r1.versionId);
    ageVersion(db, r2.versionId);

    const result = gcNoteVersions(db, dataDir, {
      now: new Date("2026-10-06T00:00:00.000Z"),
    });
    expect(result.deletedVersionRows).toBe(1);
    expect(result.deletedFiles).toBe(1);
    expect(result.malformedBodyPaths).toBe(0);
    const rows = db.select().from(noteVersionsTable).all();
    expect(rows).toHaveLength(1);
    const keptRow = sole(rows, "保留的 head 版本行");
    expect(keptRow.id).toBe(r2.versionId);
    // v1 文件删、v2（head）文件留
    expect(existsSync(resolveNoteBodyPath(dataDir, keptRow.bodyPath))).toBe(
      true,
    );
    expect(noteFiles(dataDir)).toHaveLength(1);
    // head 未受影响
    expect(
      sole(db.select().from(notesTable).all(), "head 行").currentVersionId,
    ).toBe(r2.versionId);
  });

  it("submission_evidence 引用的版本超窗口仍保留", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld();
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });
    save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(2),
      baseRevision: 1,
    });
    db.insert(submissionEvidenceTable)
      .values({
        id: randomUUID(),
        attemptId,
        questionId: "q1",
        state: "frozen",
        versionId: r1.versionId,
        recordedAt: "2026-10-01T00:00:00.000Z",
      })
      .run();
    db.$client
      .prepare(
        "UPDATE note_versions SET server_saved_at = '2026-01-01T00:00:00.000Z'",
      )
      .run();
    const result = gcNoteVersions(db, dataDir, {
      now: new Date("2026-10-06T00:00:00.000Z"),
    });
    expect(result.deletedVersionRows).toBe(0);
    // 两行都超窗口：v1 被证据引用、v2 是 head——keptByReference 计两笔
    expect(result.keptByReference).toBe(2);
    expect(db.select().from(noteVersionsTable).all()).toHaveLength(2);
    expect(noteFiles(dataDir)).toHaveLength(2);
  });

  it("窗口内的未引用版本保留（安全窗口）", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld();
    save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });
    save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(2),
      baseRevision: 1,
    });
    const result = gcNoteVersions(db, dataDir, { now: new Date() });
    expect(result.deletedVersionRows).toBe(0);
    // 窗口内非候选：不走保留集合判定（keptByReference 恒 0），仅靠时间挡下
    expect(result.keptByReference).toBe(0);
    expect(db.select().from(noteVersionsTable).all()).toHaveLength(2);
    expect(noteFiles(dataDir)).toHaveLength(2);
  });

  it("存量 bodyPath 形态异常 → 放弃本轮孤儿清扫（保守不删），tmp 清扫不受影响", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld();
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });
    ageVersion(db, r1.versionId);
    // 构造超窗孤儿文件（崩溃残留形态）
    const orphanRel = join(
      "blobs",
      "notes",
      r1.noteId,
      "v9-abcdef012345.json.gz",
    );
    writeFileSync(resolve(dataDir, orphanRel), "orphan");
    utimesSync(
      resolve(dataDir, orphanRel),
      new Date(Date.now() - 48 * 3600 * 1000),
      new Date(Date.now() - 48 * 3600 * 1000),
    );
    // 存量行 body_path 指向 notes 域外（形态异常）
    db.$client
      .prepare("UPDATE note_versions SET body_path = ? WHERE id = ?")
      .run(join("blobs", "other", "v1.json.gz"), r1.versionId);

    const result = gcNoteVersions(db, dataDir, { now: new Date() });
    expect(result.malformedBodyPaths).toBe(1);
    // 孤儿文件保守保留（宁可漏删不可误删）
    expect(result.sweptOrphanFiles).toBe(0);
    expect(existsSync(resolve(dataDir, orphanRel))).toBe(true);
    // tmp 清扫不受形态异常影响（本测试无 tmp，下一测试覆盖）
  });

  it("删除版本时连带删其 note_images 行与图片文件", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld();
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });
    save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(2),
      baseRevision: 1,
    });
    // 给 v1 挂一张派生图（直插行 + 落一个假 PNG 文件）
    const imgRel = join("blobs", "notes", r1.noteId, "img-thumb-0.png");
    const imgAbs = join(dataDir, imgRel);
    writeFileSync(imgAbs, "png");
    db.insert(noteImagesTable)
      .values({
        id: randomUUID(),
        noteVersionId: r1.versionId,
        spec: "thumbnail",
        pageIndex: 0,
        cropX: 0,
        cropY: 0,
        cropW: 1000,
        cropH: 800,
        pixelWidth: 500,
        pixelHeight: 400,
        path: imgRel,
        hash: null,
        state: "ready",
      })
      .run();
    ageVersion(db, r1.versionId);

    const result = gcNoteVersions(db, dataDir, {
      now: new Date("2026-10-06T00:00:00.000Z"),
    });
    expect(result.deletedVersionRows).toBe(1);
    expect(result.deletedImageRows).toBe(1);
    expect(db.select().from(noteImagesTable).all()).toHaveLength(0);
    expect(existsSync(imgAbs)).toBe(false);
    expect(noteFiles(dataDir)).toHaveLength(1); // 只剩 v2
  });
});

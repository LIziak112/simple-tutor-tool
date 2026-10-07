import { randomUUID } from "node:crypto";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { NoteDocInput, NotePhase } from "@tutor/contract";
import {
  NOTE_BODY_GZIP_MAX_BYTES,
  NOTE_MAX_TOTAL_POINTS,
  noteDocSchema,
  noteHeadDataSchema,
  noteVersionReceiptSchema,
} from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  type Attempt,
  attempts as attemptsTable,
  assignments as assignmentsTable,
  noteImages as noteImagesTable,
  notes as notesTable,
  noteVersions as noteVersionsTable,
  submissionEvidence as submissionEvidenceTable,
} from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { insertEvidence } from "../test/note-world.ts";
import { gzipJson, makeStudent, noteDoc } from "../test/note-fixtures.ts";
import { insertFrozenResponse, newDraftAttempt } from "./attempt-service.ts";
import { createSnapshot } from "./backup-service.ts";
import {
  canonicalNoteJson,
  createCorrection,
  gcNoteVersions,
  getStudentNoteHead,
  getStudentQuestionNotebook,
  noteBodyRelPath,
  noteDocSha256,
  readNoteVersionDoc,
  resolveNoteBodyPath,
  saveNoteVersion,
  sealCorrection,
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

/**
 * 直插已冻结 attempt + 逐题冻结 responses 行（questionRevisionId = 行 id）。
 * assignment 来源（归属即权限）+ frozenAt 置位，避免懒冻结分支干扰。
 * overrides 供 T6R.15 笔记本测试改来源/时间（多轮排序、sourceType 分派）。
 */
function makeFrozenAttempt(
  db: Db,
  studentId: string,
  questionIds: readonly string[],
  status: "draft" | "submitted" = "draft",
  overrides: {
    sourceType?: "assignment" | "course" | "wrong";
    assignmentId?: string | null;
    courseId?: string | null;
    unitId?: string | null;
    attemptNo?: number;
    submittedAt?: string;
    questionVersion?: number;
  } = {},
): { attemptId: string; revisionIds: Map<string, string> } {
  const base = newDraftAttempt({
    id: randomUUID(),
    studentId,
    sourceType: overrides.sourceType ?? "assignment",
    assignmentId: overrides.assignmentId ?? null,
    courseId: overrides.courseId ?? null,
    unitId: overrides.unitId ?? null,
    attemptNo: overrides.attemptNo ?? 1,
    startedAt: "2026-10-01T00:00:00.000Z",
  });
  const attempt: Attempt =
    status === "submitted"
      ? {
          ...base,
          status: "submitted",
          submittedAt: overrides.submittedAt ?? "2026-10-01T01:00:00.000Z",
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
          questionVersion: overrides.questionVersion ?? 1,
          questionSnapshotJson: JSON.stringify({ id: qid, stem: "占位" }),
          unitId: null,
        }),
      );
    }
  });
  return { attemptId: attempt.id, revisionIds };
}

interface SaveArgs {
  studentId: string;
  attemptId: string;
  questionId: string;
  body: Uint8Array | NoteDocInput;
  baseRevision?: number;
  mutationId?: string;
  /** T6R.15：笔记阶段（缺省 scratch——与契约缺省同语义） */
  phase?: NotePhase;
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
      ...(args.phase !== undefined ? { phase: args.phase } : {}),
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

  it("混合错误（坐标越界+单笔超点数并存）→ 413 且消息为限额 issue 文案（复审⑥）", () => {
    // 2002 点（超单笔上限）且首点 x=-1（形状错误）：两类 issue 并存时按
    // 限额口径 413，消息取限额 issue 自身文案（含具体数值，可诊断）
    const points = [
      { x: -1, y: 20, p: 0.5, t: 0 },
      ...Array.from({ length: 2001 }, (_, i) => ({
        x: i % 1000,
        y: 20,
        p: 0.5,
        t: i,
      })),
    ];
    const rawErr = capture(() =>
      save(db, dataDir, {
        studentId,
        attemptId,
        questionId: "q1",
        body: {
          version: 1,
          ink: {
            width: 1000,
            strokes: [{ tool: "pen", color: "#1f2328", weight: 4, points }],
          },
        },
        baseRevision: 2,
      }),
    );
    expect(errInfo(rawErr)).toMatchObject({
      status: 413,
      code: "NOTE_LIMIT_EXCEEDED",
    });
    expect((rawErr as { message?: string }).message).toContain(
      "单笔点数超上限",
    );
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
    // 五字段全量锁定（复审⑤：摘要契约化后形态受契约保护）
    expect(err.extra?._current).toEqual({
      noteId: ra.noteId,
      revision: 1,
      versionId: ra.versionId,
      hash: noteDocSha256(docA),
      serverSavedAt: ra.savedAt,
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
    // savedAt 是行内原确认时间（复审⑫行级直查锁定——不是本次重放的新时钟）
    const rowSavedAt = db
      .select()
      .from(noteVersionsTable)
      .all()
      .find((row) => row.revision === 1)?.serverSavedAt;
    expect(rowSavedAt).toBe(r1.savedAt);
    expect(r2.savedAt).toBe(rowSavedAt);
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
    // baseRevision 超前（head=0，期望 99）：无 head 摘要（除 revision 外全空）
    const stale = errInfo(
      capture(() =>
        save(db, dataDir, {
          studentId: aId,
          attemptId,
          questionId: "q1",
          body: noteDoc(1),
          baseRevision: 99,
        }),
      ),
    );
    expect(stale).toMatchObject({
      status: 409,
      code: "NOTE_REVISION_CONFLICT",
    });
    expect(stale.extra?._current).toEqual({
      noteId: null,
      revision: 0,
      versionId: null,
      hash: null,
      serverSavedAt: null,
    });
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

// ---------- 跨进程约束兜底（复审③） ----------

describe("mutationId 唯一索引冲突的跨进程兜底", () => {
  it("rename 后另一『进程』抢先提交同一 mutation（同 note 同 hash）→ 返回胜者回执、不清理文件", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld(["q1"]);
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });
    const doc2 = noteDoc(2);
    const hash2 = noteDocSha256(doc2);
    const m = "99999999-9999-4999-8999-999999999999";
    // 胜者行：同笔记、不同 revision（5）、同 mutation 同 hash——本请求事务内
    // 的版本插入将撞 mutation_id 唯一索引
    const winnerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const receipt = saveNoteVersion(
      db,
      dataDir,
      studentId,
      attemptId,
      "q1",
      gzipJson(doc2),
      { baseRevision: 1, mutationId: m },
      {
        afterRename: () => {
          db.insert(noteVersionsTable)
            .values({
              id: winnerId,
              noteId: r1.noteId,
              revision: 5,
              bodyPath: join(
                "blobs",
                "notes",
                r1.noteId,
                "v5-deadbeefcafe.json.gz",
              ),
              hash: hash2,
              strokeCount: 2,
              pointCount: 4,
              paperWidth: 1000,
              paperHeight: 800,
              serverSavedAt: "2026-10-06T00:00:00.000Z",
              renderVersion: 1,
              mutationId: m,
            })
            .run();
        },
      },
    );
    // 返回胜者回执（revision=5、胜者 versionId/savedAt），不是本请求的 v2
    expect(receipt).toEqual({
      noteId: r1.noteId,
      revision: 5,
      versionId: winnerId,
      hash: hash2,
      savedAt: "2026-10-06T00:00:00.000Z",
    });
    // 本请求的事务已回滚：head 仍指向 v1；本请求落位的 v2 文件成为孤儿
    // （胜者路径是 v5-…，不同路径，未被动过）
    expect(db.select().from(notesTable).all()[0]?.currentRevision).toBe(1);
    expect(noteFiles(dataDir).some((f) => f.includes("v2-"))).toBe(true);
  });

  it("胜者同 mutation 但不同 hash → 清理孤儿后 409 NOTE_MUTATION_MISMATCH", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld(["q1"]);
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });
    const m = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const info = errInfo(
      capture(() =>
        saveNoteVersion(
          db,
          dataDir,
          studentId,
          attemptId,
          "q1",
          gzipJson(noteDoc(2)),
          { baseRevision: 1, mutationId: m },
          {
            afterRename: () => {
              db.insert(noteVersionsTable)
                .values({
                  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                  noteId: r1.noteId,
                  revision: 9,
                  bodyPath: join(
                    "blobs",
                    "notes",
                    r1.noteId,
                    "v9-1234567890ab.json.gz",
                  ),
                  hash: "d".repeat(64),
                  strokeCount: 1,
                  pointCount: 2,
                  paperWidth: 1000,
                  paperHeight: 800,
                  serverSavedAt: "2026-10-06T00:00:00.000Z",
                  renderVersion: 1,
                  mutationId: m,
                })
                .run();
            },
          },
        ),
      ),
    );
    expect(info).toMatchObject({ status: 409, code: "NOTE_MUTATION_MISMATCH" });
    // 本请求 v2 孤儿文件被清理（胜者路径 v9-… 不同名，不受影响）
    expect(noteFiles(dataDir).some((f) => f.includes("v2-"))).toBe(false);
  });
});

// ---------- 读路径防御（复审②） ----------

describe("readNoteVersionDoc 读侧防御", () => {
  it("落盘文件为高压缩比炸弹（解压超 32MiB）→ 404 NOTE_NOT_FOUND，不解出大 Buffer", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld(["q1"]);
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });
    // 篡改正文文件为炸弹（模拟备份植入）
    writeFileSync(
      resolveNoteBodyPath(dataDir, noteBodyRelPath(r1.noteId, 1, r1.hash)),
      gzipSync(Buffer.alloc(40 * 1024 * 1024)),
    );
    const info = errInfo(
      capture(() => readNoteVersionDoc(db, dataDir, r1.versionId)),
    );
    expect(info).toMatchObject({ status: 404, code: "NOTE_NOT_FOUND" });
  });

  it("落盘文件 JSON 非法 → 500 NOTE_BODY_UNREADABLE（而非裸 INTERNAL）", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld(["q1"]);
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });
    writeFileSync(
      resolveNoteBodyPath(dataDir, noteBodyRelPath(r1.noteId, 1, r1.hash)),
      gzipSync(Buffer.from("not-json{", "utf8")),
    );
    const info = errInfo(
      capture(() => readNoteVersionDoc(db, dataDir, r1.versionId)),
    );
    expect(info).toMatchObject({ status: 500, code: "NOTE_BODY_UNREADABLE" });
  });

  it("bodyPath 越界 → HttpError(NOTE_BODY_PATH_INVALID) 原码重抛（不被读侧 catch 吞成 404）", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld(["q1"]);
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });
    db.$client
      .prepare("UPDATE note_versions SET body_path = ? WHERE id = ?")
      .run(join("blobs", "notes-evil", "v1.json.gz"), r1.versionId);
    const info = errInfo(
      capture(() => readNoteVersionDoc(db, dataDir, r1.versionId)),
    );
    expect(info).toMatchObject({ status: 500, code: "NOTE_BODY_PATH_INVALID" });
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

  it("tmp 清扫跨域覆盖 blobs/ink 与 blobs/media（复审⑧），窗口内保留", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld();
    save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });
    const stale = new Date(Date.now() - 48 * 3600 * 1000);
    // ink 子目录、media 根级散文件各放一个过期 tmp 与一个窗口内 tmp
    const inkTmp = join(
      dataDir,
      "blobs",
      "ink",
      "att-1",
      ".tmp-old-aaaa.json.gz",
    );
    mkdirSync(join(dataDir, "blobs", "ink", "att-1"), { recursive: true });
    writeFileSync(inkTmp, "x");
    utimesSync(inkTmp, stale, stale);
    const mediaTmp = join(dataDir, "blobs", "media", ".tmp-old-bbbb");
    mkdirSync(join(dataDir, "blobs", "media"), { recursive: true });
    writeFileSync(mediaTmp, "x");
    utimesSync(mediaTmp, stale, stale);
    const freshMediaTmp = join(dataDir, "blobs", "media", ".tmp-fresh-cccc");
    writeFileSync(freshMediaTmp, "y");

    const result = gcNoteVersions(db, dataDir, { now: new Date() });
    expect(result.sweptTmp).toBe(2);
    expect(existsSync(inkTmp)).toBe(false);
    expect(existsSync(mediaTmp)).toBe(false);
    expect(existsSync(freshMediaTmp)).toBe(true);
  });

  it("磁盘目录名与 DB 路径仅大小写不同（NTFS 手工迁移形态）→ 活文件不被误判孤儿（复审④）", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld();
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });
    // 模拟：目录名被改成大写（NTFS 大小写不敏感场景的可见形态；Linux 上
    // 则是磁盘目录与 DB 存储路径仅大小写不同的等价形态）
    const dirAbs = resolve(dataDir, "blobs", "notes", r1.noteId);
    renameSync(
      dirAbs,
      resolve(dataDir, "blobs", "notes", r1.noteId.toUpperCase()),
    );
    ageVersion(db, r1.versionId);
    const result = gcNoteVersions(db, dataDir, {
      now: new Date("2026-10-06T00:00:00.000Z"),
    });
    // head 版本：行在保留集合（本就不可删）——这里关键断言文件未被孤儿
    // 清扫路径误删（目录大小写不同也能对账）
    expect(result.deletedVersionRows).toBe(0);
    expect(result.sweptOrphanFiles).toBe(0);
    const dirs = readdirSync(join(dataDir, "blobs", "notes"));
    expect(dirs).toContain(r1.noteId.toUpperCase());
    expect(
      readdirSync(join(dataDir, "blobs", "notes", dirs[0] ?? "")).length,
    ).toBe(1);
  });

  it("img 孤儿文件纳入清扫（复审轮⑥）：删行留文件→清；被行引用→不删", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld();
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });
    const stale = new Date(Date.now() - 48 * 3600 * 1000);
    const imgDir = join(dataDir, "blobs", "notes", r1.noteId);

    // 1) 被行引用的 img 文件（head 版本目录下；行在→文件活）
    const liveName = `img-${randomUUID()}.png`;
    writeFileSync(join(imgDir, liveName), "live");
    utimesSync(join(imgDir, liveName), stale, stale);
    db.insert(noteImagesTable)
      .values({
        id: randomUUID(),
        noteVersionId: r1.versionId,
        spec: "analysis",
        pageIndex: 0,
        cropX: 0,
        cropY: 0,
        cropW: 1000,
        cropH: 800,
        pixelWidth: 320,
        pixelHeight: 200,
        path: ["blobs", "notes", r1.noteId, liveName].join("/"),
        byteSize: 4,
        hash: "e".repeat(64),
        state: "ready",
      })
      .run();
    // 2) 孤儿 img 文件（合模式命名、无任何行引用——行已删文件残留形态）
    const orphanName = `img-${randomUUID()}.png`;
    writeFileSync(join(imgDir, orphanName), "orphan");
    utimesSync(join(imgDir, orphanName), stale, stale);

    const result = gcNoteVersions(db, dataDir, { now: new Date() });
    // head 版本与其图片行均在保留集合——不删；孤儿 img 被清
    expect(result.malformedBodyPaths).toBe(0);
    expect(result.sweptOrphanFiles).toBe(1);
    expect(existsSync(join(imgDir, liveName))).toBe(true);
    expect(existsSync(join(imgDir, orphanName))).toBe(false);
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

  it("备份引用的图片挡下 bodyPath 形态异常版本的删除（C4：图片键也进删除判定）", () => {
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
    // v1 挂一张派生图（直插行 + 落文件）
    const imgRel = join("blobs", "notes", r1.noteId, "img-c4.png");
    const imgAbs = resolve(dataDir, imgRel);
    writeFileSync(imgAbs, "png-c4");
    db.insert(noteImagesTable)
      .values({
        id: randomUUID(),
        noteVersionId: r1.versionId,
        spec: "analysis",
        pageIndex: 0,
        cropX: 0,
        cropY: 0,
        cropW: 1000,
        cropH: 800,
        pixelWidth: 320,
        pixelHeight: 200,
        path: imgRel,
        hash: null,
        state: "ready",
      })
      .run();
    // v1 bodyPath 改成形态异常（越出根）——relKeyOf=null，body 键判定失效；
    // 但图片路径合法且被快照引用
    db.$client
      .prepare("UPDATE note_versions SET body_path = ? WHERE id = ?")
      .run(join("blobs", "other", "v1.json.gz"), r1.versionId);
    const snapName = createSnapshot(
      dataDir,
      db,
      new Date("2026-10-03T00:00:00.000Z"),
    );
    expect(snapName).toMatch(/\.db$/);
    ageVersion(db, r1.versionId);
    // head 版本同样推到窗外（两版本都必须超窗才会进入删除判定）
    const allVersions = db.select().from(noteVersionsTable).all();
    for (const version of allVersions) {
      ageVersion(db, version.id);
    }

    const result = gcNoteVersions(db, dataDir, {
      now: new Date("2026-10-06T00:00:00.000Z"),
    });
    // C4：body 键判定虽失效，该版本任一图片键命中备份保留集合同样保守跳过
    // ——否则快照引用的图片被连带 unlink，备份恢复出缺图
    expect(result.deletedVersionRows).toBe(0);
    expect(result.keptByBackup).toBe(1);
    expect(existsSync(imgAbs)).toBe(true);
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

// ---------- T6R.15：correction / supplement（订正与补充稿） ----------

/** 已交卷世界（correction/supplement 的默认前置：status=submitted） */
function submittedWorld(
  questionIds: readonly string[] = ["q1"],
): ReturnType<typeof makeWorld> {
  const db = createTestDb();
  const dataDir = createTestDir();
  const studentId = makeStudent(db);
  const { attemptId, revisionIds } = makeFrozenAttempt(
    db,
    studentId,
    questionIds,
    "submitted",
  );
  return { db, dataDir, studentId, attemptId, revisionIds };
}

/** 该 (attempt,question) 某 phase 的 notes 行（phase 过滤版 noteRowOf） */
function phaseRows(
  db: Db,
  attemptId: string,
  questionId: string,
  phase: NotePhase,
) {
  return db
    .select()
    .from(notesTable)
    .where(
      and(
        eq(notesTable.attemptId, attemptId),
        eq(notesTable.questionId, questionId),
        eq(notesTable.phase, phase),
      ),
    )
    .all();
}

describe("T6R.15 saveNoteVersion：三 phase 分派", () => {
  it("scratch 零回归：缺省 phase 走既有链路——draft 可写、交卷后新写 ALREADY_SUBMITTED、丢回执重放原回执", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld(["q1"]);
    const m = randomUUID();
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      mutationId: m,
    });
    expect(r1.revision).toBe(1);
    // 交卷（直改行状态——服务层测试不走 submitAttempt）
    db.update(attemptsTable)
      .set({ status: "submitted", submittedAt: "2026-10-01T01:00:00.000Z" })
      .where(eq(attemptsTable.id, attemptId))
      .run();
    const rejected = capture(() =>
      save(db, dataDir, {
        studentId,
        attemptId,
        questionId: "q1",
        body: noteDoc(2),
        baseRevision: 1,
      }),
    );
    expect(errInfo(rejected)).toMatchObject({
      status: 409,
      code: "ALREADY_SUBMITTED",
    });
    // 幂等重放不受交卷门槛约束（既有裁决，复审①）
    const replay = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      mutationId: m,
    });
    expect(replay).toEqual(r1);
  });

  it("draft attempt：PUT correction / supplement → 409 NOTE_NOT_SUBMITTED（D3 措辞修正的新码）", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld(["q1"]);
    for (const phase of ["correction", "supplement"] as const) {
      const err = capture(() =>
        save(db, dataDir, {
          studentId,
          attemptId,
          questionId: "q1",
          body: noteDoc(1),
          phase,
        }),
      );
      expect(errInfo(err)).toMatchObject({
        status: 409,
        code: "NOTE_NOT_SUBMITTED",
      });
    }
    expect(phaseRows(db, attemptId, "q1", "correction")).toHaveLength(0);
    expect(phaseRows(db, attemptId, "q1", "supplement")).toHaveLength(0);
  });

  it("已交卷：PUT correction 建行（revision 1、sealed_at 空），续写 CAS 递增", () => {
    const { db, dataDir, studentId, attemptId } = submittedWorld();
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      phase: "correction",
    });
    expect(r1.revision).toBe(1);
    const rows = phaseRows(db, attemptId, "q1", "correction");
    expect(sole(rows, "correction 行")).toMatchObject({
      id: r1.noteId,
      phase: "correction",
      sealedAt: null,
      currentRevision: 1,
    });
    const r2 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(2),
      baseRevision: 1,
      phase: "correction",
    });
    expect(r2.revision).toBe(2);
    expect(r2.noteId).toBe(r1.noteId);
    expect(phaseRows(db, attemptId, "q1", "correction")).toHaveLength(1);
  });

  it("已交卷：PUT supplement 建行并 CAS 续写；每 (attempt,question) 单行、无封存语义", () => {
    const { db, dataDir, studentId, attemptId } = submittedWorld();
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      phase: "supplement",
    });
    const r2 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(2),
      baseRevision: 1,
      phase: "supplement",
    });
    expect(r2.revision).toBe(2);
    const rows = phaseRows(db, attemptId, "q1", "supplement");
    expect(sole(rows, "supplement 行")).toMatchObject({
      id: r1.noteId,
      phase: "supplement",
      sealedAt: null,
    });
  });

  it("correction 幂等：丢回执重试原回执；他 phase 的 mutationId 重放 → 跨 phase MISMATCH", () => {
    const { db, dataDir, studentId, attemptId } = submittedWorld();
    const m = randomUUID();
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      phase: "correction",
      mutationId: m,
    });
    const replay = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      phase: "correction",
      mutationId: m,
    });
    expect(replay).toEqual(r1);
    // 跨 phase 重放：拿 correction 的 mutationId 打 supplement → MISMATCH
    const cross = capture(() =>
      save(db, dataDir, {
        studentId,
        attemptId,
        questionId: "q1",
        body: noteDoc(1),
        phase: "supplement",
        mutationId: m,
      }),
    );
    expect(errInfo(cross)).toMatchObject({
      status: 409,
      code: "NOTE_MUTATION_MISMATCH",
    });
  });

  it("correction CAS 冲突：同 baseRevision 两写一胜一败（409 附 _current），对齐后重试成功（两份内容先后落版本）", () => {
    const { db, dataDir, studentId, attemptId } = submittedWorld();
    const first = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      phase: "correction",
    });
    const second = capture(() =>
      save(db, dataDir, {
        studentId,
        attemptId,
        questionId: "q1",
        body: noteDoc(2),
        phase: "correction",
      }),
    );
    const info = errInfo(second);
    expect(info).toMatchObject({ status: 409, code: "NOTE_REVISION_CONFLICT" });
    expect(info.extra?._current).toMatchObject({
      noteId: first.noteId,
      revision: 1,
      versionId: first.versionId,
    });
    // 客户端对齐 baseRevision=1 后重试成功（第二份内容落为 v2）
    const third = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(2),
      baseRevision: 1,
      phase: "correction",
    });
    expect(third.revision).toBe(2);
  });

  it("宽松题目口径：快照空行（软删/历史缺失题）correction/supplement 可写", () => {
    const { db, dataDir, studentId, attemptId } = submittedWorld();
    db.$client
      .prepare(
        "UPDATE responses SET question_snapshot_json = NULL WHERE attempt_id = ?",
      )
      .run(attemptId);
    const r = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      phase: "correction",
    });
    expect(r.revision).toBe(1);
    const sup = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      phase: "supplement",
    });
    expect(sup.revision).toBe(1);
  });

  it("对已封存行 PUT（baseRevision>0）→ 409 NOTE_CORRECTION_SEALED；baseRevision=0 新开未封存行（D1/D2）", () => {
    const { db, dataDir, studentId, attemptId } = submittedWorld();
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      phase: "correction",
    });
    // 封存（直接落列——封存链路 sealCorrection 另测）
    db.update(notesTable)
      .set({ sealedAt: "2026-10-02T00:00:00.000Z" })
      .where(eq(notesTable.id, r1.noteId))
      .run();
    const sealedPut = capture(() =>
      save(db, dataDir, {
        studentId,
        attemptId,
        questionId: "q1",
        body: noteDoc(2),
        baseRevision: 1,
        phase: "correction",
      }),
    );
    expect(errInfo(sealedPut)).toMatchObject({
      status: 409,
      code: "NOTE_CORRECTION_SEALED",
    });
    // 再编辑 = 新开一行：baseRevision=0 走先查后插
    const r2 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(3),
      phase: "correction",
    });
    expect(r2.noteId).not.toBe(r1.noteId);
    const rows = phaseRows(db, attemptId, "q1", "correction");
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.sealedAt === null)).toHaveLength(1);
  });

  it("无任何 correction 行且 baseRevision>0 → 409 NOTE_REVISION_CONFLICT（revision 0 摘要）", () => {
    const { db, dataDir, studentId, attemptId } = submittedWorld();
    const err = capture(() =>
      save(db, dataDir, {
        studentId,
        attemptId,
        questionId: "q1",
        body: noteDoc(1),
        baseRevision: 2,
        phase: "correction",
      }),
    );
    const info = errInfo(err);
    expect(info).toMatchObject({ status: 409, code: "NOTE_REVISION_CONFLICT" });
    expect(info.extra?._current).toMatchObject({ revision: 0, noteId: null });
  });
});

describe("T6R.15 createCorrection（订正创建）", () => {
  it("空白创建（copyFromOriginal=false）：revision 0 空行；头投影 corrections 含新行、note 位仍 null", () => {
    const { db, dataDir, studentId, attemptId } = submittedWorld();
    const head = createCorrection(db, dataDir, studentId, attemptId, "q1", {
      copyFromOriginal: false,
    });
    expect(noteHeadDataSchema.safeParse(head).success).toBe(true);
    expect(head.note).toBeNull();
    const corr = sole(head.corrections, "新建订正行");
    expect(corr).toMatchObject({
      attemptId,
      questionId: "q1",
      phase: "correction",
      revision: 0,
      currentVersionId: null,
      serverSavedAt: null,
      sealedAt: null,
    });
  });

  it("复制原稿（frozen 证据）：首版本与原稿同 doc 同 hash、行 revision=1；原稿证据行与版本行不动", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld(["q1"]);
    const orig = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(2, 33),
    });
    db.update(attemptsTable)
      .set({ status: "submitted", submittedAt: "2026-10-01T01:00:00.000Z" })
      .where(eq(attemptsTable.id, attemptId))
      .run();
    insertEvidence(db, attemptId, "q1", "frozen", orig.versionId);

    const head = createCorrection(db, dataDir, studentId, attemptId, "q1", {
      copyFromOriginal: true,
    });
    const corr = sole(head.corrections, "复制原稿的订正行");
    expect(corr.revision).toBe(1);
    expect(corr.currentVersionId).not.toBeNull();
    // 复制正文 = 原稿正文（同 hash 同 doc），且是新行（不共用版本行）
    const corrVersionId = corr.currentVersionId ?? "";
    expect(corrVersionId).not.toBe(orig.versionId);
    const copyDoc = readNoteVersionDoc(db, dataDir, corrVersionId);
    expect(copyDoc.doc).toEqual(noteDoc(2, 33));
    const origRow = sole(
      db
        .select()
        .from(noteVersionsTable)
        .where(eq(noteVersionsTable.id, orig.versionId))
        .all(),
      "原稿版本行",
    );
    const corrRow = sole(
      db
        .select()
        .from(noteVersionsTable)
        .where(eq(noteVersionsTable.id, corrVersionId))
        .all(),
      "订正首版本行",
    );
    expect(corrRow.hash).toBe(origRow.hash);
    // 证据行指向不变（原稿身份由交卷事务唯一铸成）
    expect(head.evidence).toMatchObject({
      state: "frozen",
      versionId: orig.versionId,
    });
  });

  it("订正清空不改 original：复制原稿后上传空稿（strokes=[]），证据 versionId 与原稿文件不变", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld(["q1"]);
    const orig = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(2, 33),
    });
    db.update(attemptsTable)
      .set({ status: "submitted", submittedAt: "2026-10-01T01:00:00.000Z" })
      .where(eq(attemptsTable.id, attemptId))
      .run();
    insertEvidence(db, attemptId, "q1", "frozen", orig.versionId);
    const head = createCorrection(db, dataDir, studentId, attemptId, "q1", {
      copyFromOriginal: true,
    });
    const corr = sole(head.corrections, "订正行");
    // 上传空稿到订正行（清空订正）
    const cleared = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(0),
      baseRevision: 1,
      phase: "correction",
    });
    expect(cleared.revision).toBe(2);
    expect(cleared.noteId).toBe(corr.noteId);
    // 证据行原样：frozen + 原稿 versionId（原稿图片/正文随 versionId 挂在证据上）
    const evidenceRow = sole(
      db
        .select()
        .from(submissionEvidenceTable)
        .where(
          and(
            eq(submissionEvidenceTable.attemptId, attemptId),
            eq(submissionEvidenceTable.questionId, "q1"),
          ),
        )
        .all(),
      "证据行",
    );
    expect(evidenceRow).toMatchObject({
      state: "frozen",
      versionId: orig.versionId,
    });
    // 原稿文件仍在（订正清空绝不触碰原稿）
    expect(
      existsSync(
        resolveNoteBodyPath(dataDir, noteBodyRelPath(orig.noteId, 1, orig.hash)),
      ),
    ).toBe(true);
  });

  it("copyFromOriginal 但证据 missing / none / 无行 → 409 NOTE_ORIGINAL_UNAVAILABLE", () => {
    const { db, dataDir, studentId, attemptId } = submittedWorld();
    for (const state of ["missing", "none"] as const) {
      insertEvidence(db, attemptId, "q1", state, null);
      const err = capture(() =>
        createCorrection(db, dataDir, studentId, attemptId, "q1", {
          copyFromOriginal: true,
        }),
      );
      expect(errInfo(err)).toMatchObject({
        status: 409,
        code: "NOTE_ORIGINAL_UNAVAILABLE",
      });
      db.delete(submissionEvidenceTable)
        .where(eq(submissionEvidenceTable.attemptId, attemptId))
        .run();
    }
    // 无证据行同拒
    const noRow = capture(() =>
      createCorrection(db, dataDir, studentId, attemptId, "q1", {
        copyFromOriginal: true,
      }),
    );
    expect(errInfo(noRow)).toMatchObject({
      status: 409,
      code: "NOTE_ORIGINAL_UNAVAILABLE",
    });
    // 对照：空白创建不受证据状态影响
    const blank = createCorrection(db, dataDir, studentId, attemptId, "q1", {
      copyFromOriginal: false,
    });
    expect(blank.corrections).toHaveLength(1);
  });

  it("已存在未封存行 → 409 NOTE_CORRECTION_OPEN_EXISTS；draft attempt → 409 NOTE_NOT_SUBMITTED", () => {
    const { db, dataDir, studentId, attemptId } = submittedWorld();
    createCorrection(db, dataDir, studentId, attemptId, "q1", {
      copyFromOriginal: false,
    });
    const dup = capture(() =>
      createCorrection(db, dataDir, studentId, attemptId, "q1", {
        copyFromOriginal: false,
      }),
    );
    expect(errInfo(dup)).toMatchObject({
      status: 409,
      code: "NOTE_CORRECTION_OPEN_EXISTS",
    });
    // draft：门口先于一切业务分支
    const draftWorld = makeWorld(["q1"]);
    const draftErr = capture(() =>
      createCorrection(
        draftWorld.db,
        draftWorld.dataDir,
        draftWorld.studentId,
        draftWorld.attemptId,
        "q1",
        { copyFromOriginal: false },
      ),
    );
    expect(errInfo(draftErr)).toMatchObject({
      status: 409,
      code: "NOTE_NOT_SUBMITTED",
    });
  });
});

describe("T6R.15 sealCorrection（保存订正 = 检查点）", () => {
  function correctionWithVersion(): ReturnType<typeof submittedWorld> & {
    receipt: ReturnType<typeof save>;
  } {
    const world = submittedWorld();
    const receipt = save(world.db, world.dataDir, {
      studentId: world.studentId,
      attemptId: world.attemptId,
      questionId: "q1",
      body: noteDoc(1),
      phase: "correction",
    });
    return { ...world, receipt };
  }

  it("seal 成功：sealedAt 与两反思列落库、头投影带三字段、封存后 PUT → SEALED", () => {
    const { db, dataDir, studentId, attemptId, receipt } =
      correctionWithVersion();
    expect(receipt.revision).toBe(1);
    const head = sealCorrection(db, studentId, attemptId, "q1", {
      baseRevision: 1,
      stuckAt: "第二步的变形没看出来",
      errorCause: "移项忘变号",
    });
    expect(noteHeadDataSchema.safeParse(head).success).toBe(true);
    const corr = sole(head.corrections, "已封存订正行");
    expect(corr.sealedAt).not.toBeNull();
    expect(corr.stuckAt).toBe("第二步的变形没看出来");
    expect(corr.errorCause).toBe("移项忘变号");
    const row = sole(phaseRows(db, attemptId, "q1", "correction"), "订正行");
    expect(row.sealedAt).toBe(corr.sealedAt);
    expect(row.reflectionStuckAt).toBe("第二步的变形没看出来");
    expect(row.reflectionErrorCause).toBe("移项忘变号");
    // 封存后行永不再接受写入
    const put = capture(() =>
      save(db, dataDir, {
        studentId,
        attemptId,
        questionId: "q1",
        body: noteDoc(2),
        baseRevision: 1,
        phase: "correction",
      }),
    );
    expect(errInfo(put)).toMatchObject({
      status: 409,
      code: "NOTE_CORRECTION_SEALED",
    });
  });

  it("seal 反思缺省 → 两列 null（反思可选）", () => {
    const { db, studentId, attemptId } = correctionWithVersion();
    const head = sealCorrection(db, studentId, attemptId, "q1", {
      baseRevision: 1,
    });
    const corr = sole(head.corrections, "已封存订正行");
    expect(corr.stuckAt).toBeNull();
    expect(corr.errorCause).toBeNull();
  });

  it("seal CAS：baseRevision 不符 → 409 附 _current；无未封存行 → 404；空行（revision 0）→ 409 附 revision 0 摘要", () => {
    const { db, dataDir, studentId, attemptId } = submittedWorld();
    // 无任何订正行 → 404
    const none = capture(() =>
      sealCorrection(db, studentId, attemptId, "q1", { baseRevision: 1 }),
    );
    expect(errInfo(none)).toMatchObject({ status: 404, code: "NOTE_NOT_FOUND" });
    // 空白行（revision 0）：契约锁 baseRevision≥1，CAS 必不匹配 → 409 revision 0
    createCorrection(db, dataDir, studentId, attemptId, "q1", {
      copyFromOriginal: false,
    });
    const empty = capture(() =>
      sealCorrection(db, studentId, attemptId, "q1", { baseRevision: 1 }),
    );
    const emptyInfo = errInfo(empty);
    expect(emptyInfo).toMatchObject({
      status: 409,
      code: "NOTE_REVISION_CONFLICT",
    });
    expect(emptyInfo.extra?._current).toMatchObject({ revision: 0 });
    // 有版本后 baseRevision 落后 → 409 附当前摘要
    save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      phase: "correction",
    });
    save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(2),
      baseRevision: 1,
      phase: "correction",
    });
    const stale = capture(() =>
      sealCorrection(db, studentId, attemptId, "q1", { baseRevision: 1 }),
    );
    const staleInfo = errInfo(stale);
    expect(staleInfo).toMatchObject({
      status: 409,
      code: "NOTE_REVISION_CONFLICT",
    });
    expect(staleInfo.extra?._current).toMatchObject({ revision: 2 });
  });

  it("seal 后再编辑新开一行：两行 corrections 投影已封存在前、未封存在后", () => {
    const { db, dataDir, studentId, attemptId } = submittedWorld();
    createCorrection(db, dataDir, studentId, attemptId, "q1", {
      copyFromOriginal: false,
    });
    const r1 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      phase: "correction",
    });
    sealCorrection(db, studentId, attemptId, "q1", {
      baseRevision: 1,
      errorCause: "第一轮的错因",
    });
    const r2 = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(2),
      phase: "correction",
    });
    expect(r2.noteId).not.toBe(r1.noteId);
    expect(phaseRows(db, attemptId, "q1", "correction")).toHaveLength(2);
    // 已封存在前（sealedAt 升序）、未封存最后（头投影公开读直取）
    const head = getStudentNoteHead(db, studentId, attemptId, "q1");
    expect(head.corrections.map((corr) => corr.sealedAt === null)).toEqual([
      false,
      true,
    ]);
  });

  it("draft attempt：seal → 409 NOTE_NOT_SUBMITTED", () => {
    const { db, studentId, attemptId } = makeWorld(["q1"]);
    const err = capture(() =>
      sealCorrection(db, studentId, attemptId, "q1", { baseRevision: 1 }),
    );
    expect(errInfo(err)).toMatchObject({
      status: 409,
      code: "NOTE_NOT_SUBMITTED",
    });
  });
});

describe("T6R.15 找回稿不能升级成原稿（D4 结构保证）", () => {
  it("missing 交卷后 supplement PUT 成功：证据行不变（state 仍 missing、versionId null）", () => {
    const { db, dataDir, studentId, attemptId } = makeWorld(["q1"]);
    // 交卷前有一份 scratch（声明 missing 交卷的典型场景：本地有稿但选择缺稿交卷）
    save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
    });
    db.update(attemptsTable)
      .set({ status: "submitted", submittedAt: "2026-10-01T01:00:00.000Z" })
      .where(eq(attemptsTable.id, attemptId))
      .run();
    insertEvidence(db, attemptId, "q1", "missing", null);
    // 交卷后找回：同一内容作为 supplement 落行
    const sup = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      phase: "supplement",
    });
    expect(sup.revision).toBe(1);
    // 证据行原样 missing / null——supplement 结构上进不了 submission_evidence
    const evidenceRow = sole(
      db
        .select()
        .from(submissionEvidenceTable)
        .where(eq(submissionEvidenceTable.attemptId, attemptId))
        .all(),
      "证据行",
    );
    expect(evidenceRow).toMatchObject({ state: "missing", versionId: null });
  });
});

describe("T6R.15 题目笔记本聚合（getStudentQuestionNotebook）", () => {
  it("跨来源轮次：仅已交卷 attempt 进 rounds，按 submittedAt 升序 roundOrdinal 1..n；draft 不进", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const studentId = makeStudent(db);
    // 轮 1：assignment 来源（带真实作业标题）
    const assignmentId = randomUUID();
    db.insert(assignmentsTable)
      .values({
        id: assignmentId,
        teacherId: null,
        unitId: null,
        courseId: null,
        title: "国庆假期练习卷",
        createdAt: "2026-09-30T00:00:00.000Z",
      })
      .run();
    const round1 = makeFrozenAttempt(db, studentId, ["q1"], "submitted", {
      assignmentId,
      submittedAt: "2026-10-01T01:00:00.000Z",
    });
    // 轮 2：wrong 来源（错题重练第 2 次）
    const round2 = makeFrozenAttempt(db, studentId, ["q1"], "submitted", {
      sourceType: "wrong",
      attemptNo: 2,
      submittedAt: "2026-10-03T02:00:00.000Z",
    });
    // draft：不进 rounds
    makeFrozenAttempt(db, studentId, ["q1"], "draft");

    const data = getStudentQuestionNotebook(db, studentId, "q1");
    expect(data.rounds).toHaveLength(2);
    const first = data.rounds[0];
    const second = data.rounds[1];
    expect(first?.attemptId).toBe(round1.attemptId);
    expect(first?.roundOrdinal).toBe(1);
    expect(first?.sourceType).toBe("assignment");
    expect(first?.sourceLabel).toBe("国庆假期练习卷");
    expect(first?.submittedAt).toBe("2026-10-01T01:00:00.000Z");
    expect(second?.attemptId).toBe(round2.attemptId);
    expect(second?.roundOrdinal).toBe(2);
    expect(second?.sourceType).toBe("wrong");
    expect(second?.sourceLabel).toBe("错题重练 · 第 2 次");
    // 每轮默认空集合 + 无证据行 null
    expect(first?.evidence).toBeNull();
    expect(first?.corrections).toEqual([]);
    expect(first?.supplements).toEqual([]);
  });

  it("每轮投影：evidence/corrections/supplements/questionVersion（冻结版本 0 → null，绝不回填题库）", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const studentId = makeStudent(db);
    const round = makeFrozenAttempt(db, studentId, ["q1"], "submitted", {
      questionVersion: 3,
    });
    insertEvidence(db, round.attemptId, "q1", "none", null);
    // 该轮一份订正（封存带反思）+ 一份补充稿
    const corrReceipt = saveNoteVersion(
      db,
      dataDir,
      studentId,
      round.attemptId,
      "q1",
      gzipJson(noteDoc(1)),
      { baseRevision: 0, mutationId: randomUUID(), phase: "correction" },
    );
    sealCorrection(db, studentId, round.attemptId, "q1", {
      baseRevision: 1,
      stuckAt: "卡在分类讨论",
    });
    saveNoteVersion(
      db,
      dataDir,
      studentId,
      round.attemptId,
      "q1",
      gzipJson(noteDoc(1)),
      { baseRevision: 0, mutationId: randomUUID(), phase: "supplement" },
    );

    const data = getStudentQuestionNotebook(db, studentId, "q1");
    const only = sole(data.rounds, "唯一轮次");
    expect(only.questionVersion).toBe(3);
    expect(only.evidence).toMatchObject({ state: "none", versionId: null });
    expect(only.corrections).toHaveLength(1);
    expect(only.corrections[0]).toMatchObject({
      noteId: corrReceipt.noteId,
      sealedAt: expect.any(String),
      stuckAt: "卡在分类讨论",
    });
    expect(only.supplements).toHaveLength(1);

    // 版本号 0（升级遗留未冻结语义）→ null；绝不查当前题库回填
    const legacy = makeFrozenAttempt(db, studentId, ["q1"], "submitted", {
      questionVersion: 0,
      submittedAt: "2026-10-05T00:00:00.000Z",
    });
    const again = getStudentQuestionNotebook(db, studentId, "q1");
    const legacyRound = again.rounds.find((r) => r.attemptId === legacy.attemptId);
    expect(legacyRound?.questionVersion).toBeNull();
  });

  it("无轮次 → rounds=[]；跨学生隔离（他人 attempt 不进本人笔记本）", () => {
    const db = createTestDb();
    const mine = makeStudent(db);
    const other = makeStudent(db);
    makeFrozenAttempt(db, other, ["q1"], "submitted");
    const data = getStudentQuestionNotebook(db, mine, "q1");
    expect(data).toEqual({ questionId: "q1", rounds: [] });
    // 题目从未出现过的 id 同样空数组（不探测存在性）
    expect(getStudentQuestionNotebook(db, mine, "never-seen").rounds).toEqual(
      [],
    );
  });
});

describe("T6R.15 GC 回归（D11：封存头/补充稿头不被回收）", () => {
  it("封存订正头与补充稿头超安全窗口后仍 keptByReference", () => {
    const { db, dataDir, studentId, attemptId } = submittedWorld();
    const corr = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      phase: "correction",
    });
    sealCorrection(db, studentId, attemptId, "q1", { baseRevision: 1 });
    const sup = save(db, dataDir, {
      studentId,
      attemptId,
      questionId: "q1",
      body: noteDoc(1),
      phase: "supplement",
    });
    db.$client
      .prepare(
        "UPDATE note_versions SET server_saved_at = '2026-01-01T00:00:00.000Z'",
      )
      .run();
    const result = gcNoteVersions(db, dataDir, {
      now: new Date("2026-10-06T00:00:00.000Z"),
    });
    expect(result.deletedVersionRows).toBe(0);
    // 两头指针都在保留集合（notes.currentVersionId 全量收录，D11 零逻辑新增）
    expect(result.keptByReference).toBe(2);
    expect(
      existsSync(
        resolveNoteBodyPath(dataDir, noteBodyRelPath(corr.noteId, 1, corr.hash)),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolveNoteBodyPath(dataDir, noteBodyRelPath(sup.noteId, 1, sup.hash)),
      ),
    ).toBe(true);
  });
});

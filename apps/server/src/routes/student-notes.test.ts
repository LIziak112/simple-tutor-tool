import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ApiErr, NoteDoc } from "@tutor/contract";
import {
  NOTE_BODY_GZIP_MAX_BYTES,
  noteVersionReceiptSchema,
} from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client.ts";
import {
  notes as notesTable,
  noteVersions as noteVersionsTable,
} from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { insertFrozenResponse } from "../services/attempt-service.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { submitAttemptRequest } from "../test/submit-revisions";

/**
 * T6R.4 路由层测试：学生端 PUT /api/student/attempts/:id/notes/:qid
 * （本任务唯一写入口；读/图/教师端路由在 T6R.5）。
 * 覆盖：鉴权矩阵（401/403/404/409 已交卷）、multipart 元信息校验 400、
 * A/B 同 baseRevision 仅一个成功、丢回执重试逐字段原回执、同 mutationId
 * 不同正文 409、DSL 特殊 questionId（含 Windows 保留名）不进文件路径、
 * 客户端多余字段（noteId/serverSavedAt/phase）被忽略、限额 413 两级防线、
 * assertNoLeak（成功与错误响应）。
 * 夹具用 samples/v2/练习样例.md（题目 id：p4-q7 / 练习四-7）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

const PRACTICE_MD = readFileSync(
  new URL("../../../../samples/v2/练习样例.md", import.meta.url),
  "utf8",
);

/** 样例题 id（solve=纯 ASCII；apply=中文含连字符） */
const Q = { solve: "p4-q7", apply: "练习四-7" } as const;

type App = ReturnType<typeof createApp>;

/** 最小合法 NoteDoc（n 笔） */
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

function gzipDoc(doc: unknown): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(JSON.stringify(doc), "utf8")));
}

interface PutNoteOptions {
  baseRevision?: number;
  mutationId?: string;
  /** 模拟恶意/多余客户端字段（应被服务端忽略） */
  extra?: Record<string, string>;
}

/** PUT 草稿正文（multipart：body 文件 + baseRevision/mutationId 字段） */
function putNote(
  app: App,
  cookie: string | undefined,
  attemptId: string,
  questionId: string,
  body: Uint8Array,
  options: PutNoteOptions = {},
): Promise<Response> {
  const form = new FormData();
  form.append(
    "body",
    new Blob([body], { type: "application/gzip" }),
    "note.json.gz",
  );
  form.append("baseRevision", String(options.baseRevision ?? 0));
  form.append("mutationId", options.mutationId ?? randomUUID());
  for (const [k, v] of Object.entries(options.extra ?? {})) {
    form.append(k, v);
  }
  return Promise.resolve(
    app.request(`/api/student/attempts/${attemptId}/notes/${questionId}`, {
      method: "PUT",
      headers: cookie === undefined ? {} : { cookie },
      body: form,
    }),
  );
}

/** 全套前置：教师 + 导入样例 + 张三（被指派）/李四（未被指派）+ attempt */
async function makeNotesApp(): Promise<{
  app: App;
  db: Db;
  dataDir: string;
  aCookie: string;
  bCookie: string;
  attemptId: string;
}> {
  const db = createTestDb();
  const dataDir = createTestDir();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    dataDir,
    publicUrl: "http://localhost:8787",
  });
  const setup = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "teacher", password: TEACHER_PASSWORD }),
  });
  const teacherCookie = `tutor_session=${extractSessionToken(setup)}`;

  const importRes = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ markdown: PRACTICE_MD, filename: "练习样例.md" }),
  });
  expect(importRes.status).toBe(200);
  const unitId = (
    (await importRes.json()) as { data: { units: { id: string }[] } }
  ).data.units[0]?.id;
  if (!unitId) throw new Error("样例导入未产出单元");

  const aId = await createStudent(app, teacherCookie, "张三");
  await createStudent(app, teacherCookie, "李四");
  const createRes = await app.request("/api/teacher/assignments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ unitIds: [unitId], studentIds: [aId] }),
  });
  expect(createRes.status).toBe(201);
  const assignmentId = (
    (await createRes.json()) as { data: { assignments: { id: string }[] } }
  ).data.assignments[0]?.id;
  if (assignmentId === undefined) throw new Error("布置作业响应缺少作业 id");

  const attemptRes = await app.request(
    `/api/student/assignments/${assignmentId}/attempt`,
    { method: "POST", headers: { cookie: await loginStudent(app, "张三") } },
  );
  expect(attemptRes.status).toBe(200);
  const attemptId = ((await attemptRes.json()) as { data: { id: string } }).data
    .id;
  return {
    app,
    db,
    dataDir,
    aCookie: await loginStudent(app, "张三"),
    bCookie: await loginStudent(app, "李四"),
    attemptId,
  };
}

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c: string) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

async function createStudent(
  app: App,
  teacherCookie: string,
  name: string,
): Promise<string> {
  const res = await app.request("/api/teacher/students", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      displayName: name,
      loginName: name,
      password: STUDENT_PASSWORD,
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { student: { id: string } } }).data
    .student.id;
}

async function loginStudent(app: App, name: string): Promise<string> {
  const res = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: name, password: STUDENT_PASSWORD }),
  });
  expect(res.status).toBe(200);
  return `tutor_session=${extractSessionToken(res)}`;
}

// ---------- 鉴权与门槛矩阵 ----------

describe("PUT /attempts/:id/notes/:qid 鉴权与状态门槛", () => {
  it("未登录 401", async () => {
    const { app, attemptId } = await makeNotesApp();
    const res = await putNote(
      app,
      undefined,
      attemptId,
      Q.solve,
      gzipDoc(noteDoc()),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as ApiErr).error).toBe("UNAUTHORIZED");
  });

  it("非本人 attempt 403；attempt 不存在 404；题目不在卷内 404", async () => {
    const { app, aCookie, bCookie, attemptId } = await makeNotesApp();
    expect(
      (await putNote(app, bCookie, attemptId, Q.solve, gzipDoc(noteDoc())))
        .status,
    ).toBe(403);
    expect(
      (await putNote(app, aCookie, randomUUID(), Q.solve, gzipDoc(noteDoc())))
        .status,
    ).toBe(404);
    expect(
      (
        await putNote(
          app,
          aCookie,
          attemptId,
          "not-in-paper",
          gzipDoc(noteDoc()),
        )
      ).status,
    ).toBe(404);
  });

  it("已交卷 attempt 409 ALREADY_SUBMITTED（原稿固定后不可再写）", async () => {
    const { app, aCookie, attemptId } = await makeNotesApp();
    expect(
      (await putNote(app, aCookie, attemptId, Q.solve, gzipDoc(noteDoc())))
        .status,
    ).toBe(200);
    const submitRes = await submitAttemptRequest(app, aCookie, attemptId);
    expect(submitRes.status).toBe(200);
    const res = await putNote(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipDoc(noteDoc(2)),
      {
        baseRevision: 1,
      },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErr).error).toBe("ALREADY_SUBMITTED");
  });
});

// ---------- 请求形态校验 ----------

describe("multipart 元信息校验 400", () => {
  it("非 multipart（JSON body）→ 400 VALIDATION_ERROR", async () => {
    const { app, aCookie, attemptId } = await makeNotesApp();
    const res = await app.request(
      `/api/student/attempts/${attemptId}/notes/${Q.solve}`,
      {
        method: "PUT",
        headers: { cookie: aCookie, "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: 0, mutationId: randomUUID() }),
      },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
  });

  it("body 文件缺失 / baseRevision 非数字 / mutationId 非 uuid → 400", async () => {
    const { app, aCookie, attemptId } = await makeNotesApp();
    const url = `/api/student/attempts/${attemptId}/notes/${Q.solve}`;
    const headers = { cookie: aCookie };

    // body 文件缺失（只有元信息字段）
    const form1 = new FormData();
    form1.append("baseRevision", "0");
    form1.append("mutationId", randomUUID());
    const res1 = await app.request(url, {
      method: "PUT",
      headers,
      body: form1,
    });
    expect(res1.status).toBe(400);

    // baseRevision 非数字（字符串字段直传，绕不过元信息校验）
    const form2 = new FormData();
    form2.append(
      "body",
      new Blob([gzipDoc(noteDoc())], { type: "application/gzip" }),
    );
    form2.append("baseRevision", "abc");
    form2.append("mutationId", randomUUID());
    const res2 = await app.request(url, {
      method: "PUT",
      headers,
      body: form2,
    });
    expect(res2.status).toBe(400);

    const res3 = await putNote(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipDoc(noteDoc()),
      { mutationId: "not-uuid" },
    );
    expect(res3.status).toBe(400);
    expect(((await res3.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
  });
});

// ---------- 上传成功与幂等/CAS ----------

describe("上传、CAS 与幂等（路由级）", () => {
  it("gzip 上传成功：回执过契约 schema、noteId 稳定、泄露检查通过", async () => {
    const { app, db, aCookie, attemptId } = await makeNotesApp();
    const m = randomUUID();
    const res1 = await putNote(
      app,
      aCookie,
      attemptId,
      Q.apply,
      gzipDoc(noteDoc(1)),
      { mutationId: m },
    );
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { data: unknown };
    expect(noteVersionReceiptSchema.safeParse(body1.data).success).toBe(true);
    assertNoLeak(body1);

    const res2 = await putNote(
      app,
      aCookie,
      attemptId,
      Q.apply,
      gzipDoc(noteDoc(2)),
      { baseRevision: 1 },
    );
    const body2 = (await res2.json()) as {
      data: { noteId: string; revision: number };
    };
    expect(body2.data.noteId).toBe((body1.data as { noteId: string }).noteId);
    expect(body2.data.revision).toBe(2);
    // notes 表一行 scratch；版本两行
    expect(db.select().from(notesTable).all()).toHaveLength(1);
    expect(db.select().from(noteVersionsTable).all()).toHaveLength(2);
  });

  it("原始 JSON 直传成功（老浏览器回退通道）", async () => {
    const { app, aCookie, attemptId } = await makeNotesApp();
    const res = await putNote(
      app,
      aCookie,
      attemptId,
      Q.solve,
      new Uint8Array(Buffer.from(JSON.stringify(noteDoc(1)), "utf8")),
    );
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { data: { revision: number } }).data.revision,
    ).toBe(1);
  });

  it("A/B 同 baseRevision：仅一个 200，另一个 409 NOTE_REVISION_CONFLICT 附 _current 摘要", async () => {
    const { app, db, aCookie, attemptId } = await makeNotesApp();
    const first = await putNote(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipDoc(noteDoc(1, 20)),
    );
    expect(first.status).toBe(200);
    const firstData = (await first.json()) as { data: { hash: string } };

    const second = await putNote(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipDoc(noteDoc(1, 99)),
    );
    expect(second.status).toBe(409);
    const err = (await second.json()) as ApiErr & { _current?: unknown };
    expect(err.error).toBe("NOTE_REVISION_CONFLICT");
    expect(err._current).toMatchObject({
      revision: 1,
      hash: firstData.data.hash,
    });
    // 输掉的请求没有留下任何版本行；错误响应同样过泄露检查
    expect(db.select().from(noteVersionsTable).all()).toHaveLength(1);
    assertNoLeak(err);
  });

  it("丢回执重试：同 mutationId 同正文 → 逐字段相同回执", async () => {
    const { app, db, aCookie, attemptId } = await makeNotesApp();
    const m = randomUUID();
    const doc = noteDoc(1);
    const r1 = await putNote(app, aCookie, attemptId, Q.solve, gzipDoc(doc), {
      mutationId: m,
    });
    const r2 = await putNote(app, aCookie, attemptId, Q.solve, gzipDoc(doc), {
      mutationId: m,
    });
    expect(await r1.json()).toEqual(await r2.json());
    expect(db.select().from(noteVersionsTable).all()).toHaveLength(1);
  });

  it("同 mutationId 不同正文 → 409 NOTE_MUTATION_MISMATCH", async () => {
    const { app, db, aCookie, attemptId } = await makeNotesApp();
    const m = randomUUID();
    await putNote(app, aCookie, attemptId, Q.solve, gzipDoc(noteDoc(1)), {
      mutationId: m,
    });
    const res = await putNote(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipDoc(noteDoc(2)),
      {
        mutationId: m,
      },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErr).error).toBe("NOTE_MUTATION_MISMATCH");
    expect(db.select().from(noteVersionsTable).all()).toHaveLength(1);
  });

  it("李四（非本人）带张三的 mutationId 写 → 403 在权限门口拦截，不触达幂等查重", async () => {
    // 跨学生/跨 attempt 的 mutation 重放拒绝在服务层测试覆盖（mutationId 全局
    // 查重 + 归属比对）；路由层这里锁定权限先于一切的顺序
    const { app, db, aCookie, bCookie, attemptId } = await makeNotesApp();
    const m = randomUUID();
    await putNote(app, aCookie, attemptId, Q.solve, gzipDoc(noteDoc(1)), {
      mutationId: m,
    });
    const res = await putNote(
      app,
      bCookie,
      attemptId,
      Q.solve,
      gzipDoc(noteDoc(1)),
      {
        mutationId: m,
      },
    );
    expect(res.status).toBe(403);
    expect(db.select().from(notesTable).all()).toHaveLength(1);
  });
});

// ---------- 路径安全与字段不可覆盖 ----------

describe("DSL 特殊 questionId 与服务端字段不可覆盖", () => {
  it("中文/含点/Windows 保留名 id 上传成功，文件目录只有 noteId UUID 段", async () => {
    const { app, db, dataDir, aCookie, attemptId } = await makeNotesApp();
    // 直插冻结行扩展特殊 id（路由级真实链路：requireAttemptQuestion 校验后落盘）
    const specialIds = ["练习四.7 点号", "CON", "NUL", "a..b"];
    db.transaction((tx) => {
      for (const qid of specialIds) {
        insertFrozenResponse(tx, {
          attemptId,
          questionId: qid,
          questionVersion: 1,
          questionSnapshotJson: JSON.stringify({ id: qid }),
          unitId: null,
        });
      }
    });
    for (const qid of specialIds) {
      const res = await putNote(
        app,
        aCookie,
        attemptId,
        qid,
        gzipDoc(noteDoc(1)),
      );
      expect(res.status).toBe(200);
    }
    const root = join(dataDir, "blobs", "notes");
    const dirs = readdirSync(root);
    expect(dirs).toHaveLength(specialIds.length);
    for (const d of dirs) {
      expect(d).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  it("客户端发送 noteId/serverSavedAt/phase/studentId 等字段被忽略：行值全由服务端定", async () => {
    const { app, db, aCookie, attemptId } = await makeNotesApp();
    const evilNoteId = "99999999-9999-4999-8999-999999999999";
    const res = await putNote(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipDoc(noteDoc(1)),
      {
        extra: {
          noteId: evilNoteId,
          serverSavedAt: "1999-01-01T00:00:00.000Z",
          phase: "correction",
          studentId: "someone-else",
          teacherId: "someone-else",
          currentVersionId: evilNoteId,
        },
      },
    );
    expect(res.status).toBe(200);
    const receipt = (await res.json()) as {
      data: { noteId: string; savedAt: string };
    };
    expect(receipt.data.noteId).not.toBe(evilNoteId);
    const rows = db.select().from(notesTable).all();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error("缺少 notes 行");
    expect(row.id).toBe(receipt.data.noteId);
    expect(row.phase).toBe("scratch");
    expect(row.serverSavedAt).toBe(receipt.data.savedAt);
    expect(row.serverSavedAt).not.toBe("1999-01-01T00:00:00.000Z");
  });
});

// ---------- 限额（两级防线） ----------

describe("限额 413（入口预检 + service 精确校验）", () => {
  it("body 文件超 2MiB（body 总体在预检线内）→ 413 NOTE_LIMIT_EXCEEDED，不落盘", async () => {
    const { app, db, dataDir, aCookie, attemptId } = await makeNotesApp();
    // 2MiB + 1B，body 总体 < 预检线（2MiB+64KiB）→ 命中 service 精确校验
    const big = new Uint8Array(NOTE_BODY_GZIP_MAX_BYTES + 1).fill(0x61);
    const res = await putNote(app, aCookie, attemptId, Q.solve, big);
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiErr).error).toBe("NOTE_LIMIT_EXCEEDED");
    expect(db.select().from(notesTable).all()).toHaveLength(0);
    expect(existsSync(join(dataDir, "blobs", "notes"))).toBe(false);
  });

  it("超大 multipart body（content-length 超入口预检线）→ 413，不进解析", async () => {
    const { app, db, aCookie, attemptId } = await makeNotesApp();
    const big = new Uint8Array(3 * 1024 * 1024).fill(0x61);
    const res = await putNote(app, aCookie, attemptId, Q.solve, big);
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiErr).error).toBe("NOTE_LIMIT_EXCEEDED");
    expect(db.select().from(notesTable).all()).toHaveLength(0);
  });

  it("高压缩比 gzip 炸弹（解压超 32MiB）→ 413 NOTE_LIMIT_EXCEEDED", async () => {
    const { app, db, aCookie, attemptId } = await makeNotesApp();
    const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024));
    const res = await putNote(
      app,
      aCookie,
      attemptId,
      Q.solve,
      new Uint8Array(bomb),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiErr).error).toBe("NOTE_LIMIT_EXCEEDED");
    expect(db.select().from(notesTable).all()).toHaveLength(0);
  });
});

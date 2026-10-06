import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ApiErr } from "@tutor/contract";
import {
  NOTE_BODY_GZIP_MAX_BYTES,
  noteVersionReceiptSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client.ts";
import { noteVersions as noteVersionsTable } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { insertFrozenResponse } from "../services/attempt-service.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { gzipJson, noteDoc, putNoteBodyForm } from "../test/note-fixtures.ts";
import { freshNoteAttempt, noteRowOf } from "../test/note-world.ts";
import {
  submitAttemptRequest,
  submitAttemptRequestWithEvidence,
} from "../test/submit-revisions";

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

interface PutNoteOptions {
  baseRevision?: number;
  mutationId?: string;
  /** 模拟恶意/多余客户端字段（应被服务端忽略） */
  extra?: Record<string, string>;
}

/** PUT 草稿正文（multipart 组装收敛在 note-fixtures.putNoteBodyForm；extra 恶意字段本地附加） */
function putNote(
  app: App,
  cookie: string | undefined,
  attemptId: string,
  questionId: string,
  body: Uint8Array,
  options: PutNoteOptions = {},
): Promise<Response> {
  const form = putNoteBodyForm(body, options);
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

// ---------- 共享世界（复审⑩：17 遍全栈世界收敛为一次 beforeAll 构建） ----------

let app: App;
let db: Db;
let dataDir: string;
let teacherCookie: string;
let unitId: string;
let aId: string;
let aCookie: string;
let bCookie: string;

beforeAll(async () => {
  db = createTestDb();
  dataDir = createTestDir();
  app = createApp({
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
  teacherCookie = `tutor_session=${extractSessionToken(setup)}`;

  const importRes = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ markdown: PRACTICE_MD, filename: "练习样例.md" }),
  });
  expect(importRes.status).toBe(200);
  const importedUnitId = (
    (await importRes.json()) as { data: { units: { id: string }[] } }
  ).data.units[0]?.id;
  if (!importedUnitId) throw new Error("样例导入未产出单元");
  unitId = importedUnitId;

  aId = await createStudent(app, teacherCookie, "张三");
  await createStudent(app, teacherCookie, "李四");
  aCookie = await loginStudent(app, "张三");
  bCookie = await loginStudent(app, "李四");
});

/** 每测试取新 attempt：同单元布置新作业 → 开卷（组装收敛在 note-world.freshNoteAttempt） */
function freshAttempt(): Promise<string> {
  return freshNoteAttempt(app, teacherCookie, unitId, [aId], aCookie);
}

/** 该 attempt 该题的 scratch 笔记行（共享自 note-world——按 attempt 过滤断言用） */

/** 该 attempt 该题的版本行数（经 scratch 笔记行关联） */
function versionCountOf(attemptId: string, questionId: string): number {
  const row = noteRowOf(db, attemptId, questionId);
  if (row === undefined) return 0;
  return db
    .select()
    .from(noteVersionsTable)
    .where(eq(noteVersionsTable.noteId, row.id))
    .all().length;
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
    const attemptId = await freshAttempt();
    const res = await putNote(
      app,
      undefined,
      attemptId,
      Q.solve,
      gzipJson(noteDoc()),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as ApiErr).error).toBe("UNAUTHORIZED");
  });

  it("非本人 attempt 403；attempt 不存在 404；题目不在卷内 404", async () => {
    const attemptId = await freshAttempt();
    expect(
      (await putNote(app, bCookie, attemptId, Q.solve, gzipJson(noteDoc())))
        .status,
    ).toBe(403);
    expect(
      (await putNote(app, aCookie, randomUUID(), Q.solve, gzipJson(noteDoc())))
        .status,
    ).toBe(404);
    expect(
      (
        await putNote(
          app,
          aCookie,
          attemptId,
          "not-in-paper",
          gzipJson(noteDoc()),
        )
      ).status,
    ).toBe(404);
  });

  it("已交卷 attempt：新写入 409 ALREADY_SUBMITTED；幂等重放仍返回原回执（复审①）", async () => {
    const attemptId = await freshAttempt();
    const m = randomUUID();
    const doc = noteDoc();
    const first = await putNote(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipJson(doc),
      {
        mutationId: m,
      },
    );
    expect(first.status).toBe(200);
    // T6R.10：有笔记的卷以新客户端声明交卷（旧式缺字段提交已被兼容规则拒绝）
    const submitRes = await submitAttemptRequestWithEvidence(
      app,
      aCookie,
      db,
      attemptId,
    );
    expect(submitRes.status).toBe(200);
    // 新 mutation 的新写入 → 409（原稿固定）
    const res = await putNote(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipJson(noteDoc(2)),
      {
        baseRevision: 1,
      },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErr).error).toBe("ALREADY_SUBMITTED");
    // 同 mutationId 同正文的重放 → 原回执逐字段（不被状态门槛挡）
    const replay = await putNote(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipJson(doc),
      {
        mutationId: m,
      },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
  });
});

// ---------- 请求形态校验 ----------

describe("multipart 元信息校验 400", () => {
  it("非 multipart（JSON body）→ 400 VALIDATION_ERROR", async () => {
    const attemptId = await freshAttempt();
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
    const attemptId = await freshAttempt();
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
      new Blob([gzipJson(noteDoc())], { type: "application/gzip" }),
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
      gzipJson(noteDoc()),
      { mutationId: "not-uuid" },
    );
    expect(res3.status).toBe(400);
    expect(((await res3.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
  });

  it("baseRevision 空串/纯空白/非十进制整数串 → 400（Number('') 的 0 缺口，T6R.4 复审③）", async () => {
    const attemptId = await freshAttempt();
    const url = `/api/student/attempts/${attemptId}/notes/${Q.solve}`;
    const headers = { cookie: aCookie };
    // 反例集合：空串（Number('')===0 会骗过 min(0)）、空白、科学计数、
    // 十六进制、负号、小数——multipart 字符串一律按严格十进制整数解析
    for (const bad of ["", "   ", "1e0", "0x1", "-1", "1.5", "１"]) {
      const form = new FormData();
      form.append(
        "body",
        new Blob([gzipJson(noteDoc())], { type: "application/gzip" }),
      );
      form.append("baseRevision", bad);
      form.append("mutationId", randomUUID());
      const res = await app.request(url, {
        method: "PUT",
        headers,
        body: form,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
    }
    // 合法形态仍通：前导零十进制
    const formOk = new FormData();
    formOk.append(
      "body",
      new Blob([gzipJson(noteDoc())], { type: "application/gzip" }),
    );
    formOk.append("baseRevision", "000");
    formOk.append("mutationId", randomUUID());
    const resOk = await app.request(url, {
      method: "PUT",
      headers,
      body: formOk,
    });
    expect(resOk.status).toBe(200);
    expect(noteRowOf(db, attemptId, Q.solve)).toBeDefined();
  });
});

// ---------- 上传成功与幂等/CAS ----------

describe("上传、CAS 与幂等（路由级）", () => {
  it("gzip 上传成功：回执过契约 schema、noteId 稳定、泄露检查通过", async () => {
    const attemptId = await freshAttempt();
    const m = randomUUID();
    const res1 = await putNote(
      app,
      aCookie,
      attemptId,
      Q.apply,
      gzipJson(noteDoc(1)),
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
      gzipJson(noteDoc(2)),
      { baseRevision: 1 },
    );
    const body2 = (await res2.json()) as {
      data: { noteId: string; revision: number };
    };
    expect(body2.data.noteId).toBe((body1.data as { noteId: string }).noteId);
    expect(body2.data.revision).toBe(2);
    // notes 表一行 scratch；版本两行（共享世界按 attempt 过滤）
    expect(versionCountOf(attemptId, Q.apply)).toBe(2);
  });

  it("原始 JSON 直传成功（老浏览器回退通道）", async () => {
    const attemptId = await freshAttempt();
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
    const attemptId = await freshAttempt();
    const first = await putNote(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipJson(noteDoc(1, 20)),
    );
    expect(first.status).toBe(200);
    const firstData = (await first.json()) as {
      data: {
        noteId: string;
        versionId: string;
        hash: string;
        savedAt: string;
      };
    };

    const second = await putNote(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipJson(noteDoc(1, 99)),
    );
    expect(second.status).toBe(409);
    const err = (await second.json()) as ApiErr & { _current?: unknown };
    expect(err.error).toBe("NOTE_REVISION_CONFLICT");
    // 五字段全量锁定（复审⑤：摘要形态契约化）
    expect(err._current).toEqual({
      noteId: firstData.data.noteId,
      revision: 1,
      versionId: firstData.data.versionId,
      hash: firstData.data.hash,
      serverSavedAt: firstData.data.savedAt,
    });
    // 输掉的请求没有留下任何版本行；错误响应同样过泄露检查
    expect(versionCountOf(attemptId, Q.solve)).toBe(1);
    assertNoLeak(err);
  });

  it("丢回执重试：同 mutationId 同正文 → 逐字段相同回执", async () => {
    const attemptId = await freshAttempt();
    const m = randomUUID();
    const doc = noteDoc(1);
    const r1 = await putNote(app, aCookie, attemptId, Q.solve, gzipJson(doc), {
      mutationId: m,
    });
    const r2 = await putNote(app, aCookie, attemptId, Q.solve, gzipJson(doc), {
      mutationId: m,
    });
    expect(await r1.json()).toEqual(await r2.json());
    expect(versionCountOf(attemptId, Q.solve)).toBe(1);
  });

  it("同 mutationId 不同正文 → 409 NOTE_MUTATION_MISMATCH", async () => {
    const attemptId = await freshAttempt();
    const m = randomUUID();
    await putNote(app, aCookie, attemptId, Q.solve, gzipJson(noteDoc(1)), {
      mutationId: m,
    });
    const res = await putNote(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipJson(noteDoc(2)),
      {
        mutationId: m,
      },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErr).error).toBe("NOTE_MUTATION_MISMATCH");
    expect(versionCountOf(attemptId, Q.solve)).toBe(1);
  });

  it("李四（非本人）带张三的 mutationId 写 → 403 在权限门口拦截，不触达幂等查重", async () => {
    // 跨学生/跨 attempt 的 mutation 重放拒绝在服务层测试覆盖（mutationId 全局
    // 查重 + 归属比对）；路由层这里锁定权限先于一切的顺序
    const attemptId = await freshAttempt();
    const m = randomUUID();
    await putNote(app, aCookie, attemptId, Q.solve, gzipJson(noteDoc(1)), {
      mutationId: m,
    });
    const res = await putNote(
      app,
      bCookie,
      attemptId,
      Q.solve,
      gzipJson(noteDoc(1)),
      {
        mutationId: m,
      },
    );
    expect(res.status).toBe(403);
    expect(noteRowOf(db, attemptId, Q.solve)).toBeDefined();
  });
});

// ---------- 路径安全与字段不可覆盖 ----------

describe("DSL 特殊 questionId 与服务端字段不可覆盖", () => {
  it("中文/含点/Windows 保留名 id 上传成功，文件目录只有 noteId UUID 段", async () => {
    const attemptId = await freshAttempt();
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
        gzipJson(noteDoc(1)),
      );
      expect(res.status).toBe(200);
    }
    // 共享世界里 blobs/notes 已有其它测试的目录——按本 attempt 的笔记行核：
    // 4 行、目录名全是 UUID、各目录恰一个正文文件
    const root = join(dataDir, "blobs", "notes");
    for (const qid of specialIds) {
      const row = noteRowOf(db, attemptId, qid);
      expect(row).toBeDefined();
      if (row === undefined) continue;
      expect(row.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      const files = readdirSync(join(root, row.id));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^v1-[0-9a-f]{12}\.json\.gz$/);
    }
  });

  it("客户端发送 noteId/serverSavedAt/phase/studentId 等字段被忽略：行值全由服务端定", async () => {
    const attemptId = await freshAttempt();
    const evilNoteId = "99999999-9999-4999-8999-999999999999";
    const res = await putNote(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipJson(noteDoc(1)),
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
    const row = noteRowOf(db, attemptId, Q.solve);
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
    const attemptId = await freshAttempt();
    // 2MiB + 1B，body 总体 < 预检线（2MiB+64KiB）→ 命中 service 精确校验
    const big = new Uint8Array(NOTE_BODY_GZIP_MAX_BYTES + 1).fill(0x61);
    const res = await putNote(app, aCookie, attemptId, Q.solve, big);
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiErr).error).toBe("NOTE_LIMIT_EXCEEDED");
    expect(noteRowOf(db, attemptId, Q.solve)).toBeUndefined();
    expect(versionCountOf(attemptId, Q.solve)).toBe(0);
  });

  it("超大 multipart body（content-length 超入口预检线）→ 413，不进解析", async () => {
    const attemptId = await freshAttempt();
    const big = new Uint8Array(3 * 1024 * 1024).fill(0x61);
    const res = await putNote(app, aCookie, attemptId, Q.solve, big);
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiErr).error).toBe("NOTE_LIMIT_EXCEEDED");
    expect(noteRowOf(db, attemptId, Q.solve)).toBeUndefined();
  });

  it("高压缩比 gzip 炸弹（解压超 32MiB）→ 413 NOTE_LIMIT_EXCEEDED", async () => {
    const attemptId = await freshAttempt();
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
    expect(noteRowOf(db, attemptId, Q.solve)).toBeUndefined();
  });
});

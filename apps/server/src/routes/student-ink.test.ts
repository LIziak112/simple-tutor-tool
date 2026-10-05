import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { ApiErr, InkDoc } from "@tutor/contract";
import { inkUploadOkSchema } from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client.ts";
import { ink as inkTable } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { safeInkFileName } from "../services/ink-service.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { fetchSubmitRevisions } from "../test/submit-revisions";

/**
 * 手写笔迹接口集成测试（T2.8 全部验收项，app.request() 直调路由 + 内存库 +
 * 临时数据目录）：上传/取回往返、超限 413（验收项）、非本人 403（验收项）、
 * 已交 409、非法 gzip/InkDoc/PNG 400、gzip 炸弹（解压超 32MB 上限）400、
 * 无笔迹 404、教师 PNG 与元数据、
 * 路径安全（../ 与特殊字符不越界）、泄露（assertNoLeak）。
 * 夹具用 samples/v2/练习样例.md（手写题 id：p4-q7 / 练习四-7 / 练习四-8）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

const PRACTICE_MD = readFileSync(
  new URL("../../../../samples/v2/练习样例.md", import.meta.url),
  "utf8",
);

/** 样例手写题 id（solve / apply / find-error） */
const Q = {
  solve: "p4-q7",
  apply: "练习四-7",
} as const;

type App = ReturnType<typeof createApp>;

/** 最小合法 PNG（魔数 + IHDR 头 + 指定宽高；服务端只校验魔数/IHDR/尺寸） */
function makePng(width = 320, height = 200): Uint8Array {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR 数据长度
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return new Uint8Array(buf);
}

/** 构造 atrament InkDoc（n 笔） */
function atramentDoc(strokes = 2, updatedAt = 1727392800000): InkDoc {
  return {
    engine: "atrament",
    version: 1,
    data: {
      width: 1000,
      strokes: Array.from({ length: strokes }, (_, i) => ({
        tool: "pen" as const,
        color: "#1f2328",
        weight: 4,
        points: [
          { x: 10 + i, y: 20, p: 0.5, t: 0 },
          { x: 30 + i, y: 1240, p: 0.8, t: 25 },
        ],
      })),
    },
    updatedAt,
  };
}

/** 构造 excalidraw InkDoc（n 个元素） */
function excalidrawDoc(elements = 1): InkDoc {
  return {
    engine: "excalidraw",
    version: 1,
    data: {
      scene: {
        elements: Array.from({ length: elements }, (_, i) => ({
          id: `el-${i}`,
          type: "freedraw",
          points: [
            [0, 0],
            [10, 10],
          ],
        })),
      },
    },
    updatedAt: 1727392800001,
  };
}

function gzipDoc(doc: InkDoc): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(JSON.stringify(doc), "utf8")));
}

/** 全套前置：教师 + 导入样例 + 张三（被指派）/李四（未被指派）+ attempt */
async function makeInkApp(): Promise<{
  app: App;
  db: Db;
  dataDir: string;
  teacherCookie: string;
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
  const imported = (await importRes.json()) as {
    data: { units: { id: string }[] };
  };
  const unitId = imported.data.units[0]?.id;
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
  if (assignmentId === undefined) {
    throw new Error("布置作业响应缺少作业 id");
  }

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
    teacherCookie,
    aCookie: await loginStudent(app, "张三"),
    bCookie: await loginStudent(app, "李四"),
    attemptId,
  };
}

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
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

/** PUT 笔迹（multipart：strokes + snapshot） */
function putInk(
  app: App,
  cookie: string | undefined,
  attemptId: string,
  questionId: string,
  strokes: Uint8Array,
  snapshot: Uint8Array,
): Promise<Response> {
  const form = new FormData();
  form.append(
    "strokes",
    new Blob([strokes], { type: "application/gzip" }),
    "strokes.json.gz",
  );
  form.append(
    "snapshot",
    new Blob([snapshot], { type: "image/png" }),
    "snapshot.png",
  );
  return Promise.resolve(
    app.request(`/api/student/attempts/${attemptId}/ink/${questionId}`, {
      method: "PUT",
      headers: cookie === undefined ? {} : { cookie },
      body: form,
    }),
  );
}

/** GET 笔迹矢量文档 */
function getInk(
  app: App,
  cookie: string | undefined,
  attemptId: string,
  questionId: string,
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/student/attempts/${attemptId}/ink/${questionId}`, {
      headers: cookie === undefined ? {} : { cookie },
    }),
  );
}

async function submitAttempt(
  app: App,
  cookie: string,
  attemptId: string,
): Promise<Response> {
  return (async () => {
    // T6R.3：自动回传题目版本集合（与前端同流程）
    const revisions = await fetchSubmitRevisions(app, cookie, attemptId);
    return app.request(`/api/student/attempts/${attemptId}/submit`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ revisions }),
    });
  })();
}

describe("PUT + GET 笔迹：上传取回往返", () => {
  it("上传成功 → 回执字段齐全 → GET 取回 InkDoc 往返一致 → ink 行与文件落盘", async () => {
    const { app, db, dataDir, aCookie, attemptId } = await makeInkApp();
    const doc = atramentDoc(2);
    const res = await putInk(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipDoc(doc),
      makePng(320, 200),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(inkUploadOkSchema.safeParse(body).success).toBe(true);
    expect(body.data.strokeCount).toBe(2);
    expect(body.data.width).toBe(320);
    expect(body.data.height).toBe(200);

    // ink 表一行，路径入库（相对 DATA_DIR）
    const rows = db.select().from(inkTable).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.strokesPath).toContain(join("blobs", "ink", attemptId));
    expect(rows[0]?.strokesPath.endsWith(".json.gz")).toBe(true);
    expect(rows[0]?.pngPath.endsWith(".png")).toBe(true);
    // 文件真实存在且是 gzip 后的原文
    const strokesFile = join(dataDir, rows[0]?.strokesPath ?? "");
    expect(existsSync(strokesFile)).toBe(true);
    expect(
      JSON.parse(gunzipSync(readFileSync(strokesFile)).toString("utf8")),
    ).toEqual(doc);

    // GET 取回：InkDoc 深度一致（验收：上传→取回往返）
    const getRes = await getInk(app, aCookie, attemptId, Q.solve);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { data: InkDoc };
    expect(getBody.data).toEqual(doc);

    // 学生 PNG 直出：字节与 content-type
    const pngRes = await app.request(
      `/api/student/attempts/${attemptId}/ink/${Q.solve}.png`,
      { headers: { cookie: aCookie } },
    );
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await pngRes.arrayBuffer())).toEqual(
      makePng(320, 200),
    );
  });

  it("excalidraw 文档：strokeCount = 元素数；中文 questionId 文件名安全", async () => {
    const { app, db, dataDir, aCookie, attemptId } = await makeInkApp();
    const doc = excalidrawDoc(3);
    const res = await putInk(
      app,
      aCookie,
      attemptId,
      Q.apply,
      gzipDoc(doc),
      makePng(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { strokeCount: number } };
    expect(body.data.strokeCount).toBe(3);
    const row = db.select().from(inkTable).all()[0];
    // 中文 questionId（练习四-7）经 safeInkFileName 落盘，目录内无中文原名文件
    expect(row?.questionId).toBe(Q.apply);
    const dir = join(dataDir, "blobs", "ink", attemptId);
    const files = readdirSync(dir);
    expect(files.some((f) => f.startsWith("q-"))).toBe(true);
    expect(files.some((f) => f.includes("练习四"))).toBe(false);
  });

  it("未压缩 JSON 直传（老浏览器回退路径）也能上传与取回", async () => {
    const { app, aCookie, attemptId } = await makeInkApp();
    const doc = atramentDoc(1);
    const raw = new TextEncoder().encode(JSON.stringify(doc));
    const res = await putInk(app, aCookie, attemptId, Q.solve, raw, makePng());
    expect(res.status).toBe(200);
    const getRes = await getInk(app, aCookie, attemptId, Q.solve);
    expect(((await getRes.json()) as { data: InkDoc }).data).toEqual(doc);
  });

  it("幂等覆盖：同题再传 → inkId 不变、库仍一行、GET 返回新内容", async () => {
    const { app, db, aCookie, attemptId } = await makeInkApp();
    const first = await putInk(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipDoc(atramentDoc(2)),
      makePng(),
    );
    const firstData = (
      (await first.json()) as {
        data: { inkId: string };
      }
    ).data;
    const second = await putInk(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipDoc(atramentDoc(5, 1727392900000)),
      makePng(640, 480),
    );
    expect(second.status).toBe(200);
    const secondData = (
      (await second.json()) as {
        data: { inkId: string; strokeCount: number; width: number };
      }
    ).data;
    expect(secondData.inkId).toBe(firstData.inkId);
    expect(secondData.strokeCount).toBe(5);
    expect(secondData.width).toBe(640);
    expect(db.select().from(inkTable).all()).toHaveLength(1);

    const getBody = (await (
      await getInk(app, aCookie, attemptId, Q.solve)
    ).json()) as { data: InkDoc };
    if (getBody.data.engine === "atrament") {
      expect(getBody.data.data.strokes).toHaveLength(5);
    }
  });
});

describe("验收项：超限 413", () => {
  it("两文件合计超 2MB（body 在入口预检线内）→ 413 INK_TOO_LARGE，不落盘", async () => {
    const { app, db, dataDir, aCookie, attemptId } = await makeInkApp();
    // 1.5MB 随机（不可压缩）strokes + 0.6MB png = 2.1MB > 2MiB，
    // 但 body < 入口预检线（2MiB + 64KB）→ 命中 service 的精确合计校验
    const bigStrokes = randomBytes(1536 * 1024);
    const bigPng = randomBytes(614 * 1024);
    const res = await putInk(
      app,
      aCookie,
      attemptId,
      Q.solve,
      new Uint8Array(bigStrokes),
      new Uint8Array(bigPng),
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("INK_TOO_LARGE");
    // 未落任何文件、未写库
    expect(db.select().from(inkTable).all()).toHaveLength(0);
    expect(existsSync(join(dataDir, "blobs", "ink", attemptId))).toBe(false);
  });

  it("超大 body（content-length 超入口预检线）→ 413，不进 multipart 解析", async () => {
    const { app, db, aCookie, attemptId } = await makeInkApp();
    const form = new FormData();
    form.append(
      "strokes",
      new Blob([randomBytes(3 * 1024 * 1024)]),
      "strokes.json.gz",
    );
    form.append(
      "snapshot",
      new Blob([makePng()], { type: "image/png" }),
      "snapshot.png",
    );
    const res = await app.request(
      `/api/student/attempts/${attemptId}/ink/${Q.solve}`,
      { method: "PUT", headers: { cookie: aCookie }, body: form },
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiErr).error).toBe("INK_TOO_LARGE");
    expect(db.select().from(inkTable).all()).toHaveLength(0);
  });
});

describe("验收项：非本人 attempt 403", () => {
  it("别人的 attempt 上传/取回/PNG 都 403 FORBIDDEN", async () => {
    const { app, aCookie, bCookie, attemptId } = await makeInkApp();
    await putInk(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipDoc(atramentDoc(1)),
      makePng(),
    );
    // 李四（未被指派、无自己 attempt 的会话）冒用张三的 attemptId
    const putRes = await putInk(
      app,
      bCookie,
      attemptId,
      Q.solve,
      gzipDoc(atramentDoc(9)),
      makePng(),
    );
    expect(putRes.status).toBe(403);
    expect(((await putRes.json()) as ApiErr).error).toBe("FORBIDDEN");
    const getRes = await getInk(app, bCookie, attemptId, Q.solve);
    expect(getRes.status).toBe(403);
    const pngRes = await app.request(
      `/api/student/attempts/${attemptId}/ink/${Q.solve}.png`,
      { headers: { cookie: bCookie } },
    );
    expect(pngRes.status).toBe(403);
  });

  it("未登录 PUT/GET 都 401", async () => {
    const { app, attemptId } = await makeInkApp();
    const res = await putInk(
      app,
      undefined,
      attemptId,
      Q.solve,
      gzipDoc(atramentDoc(1)),
      makePng(),
    );
    expect(res.status).toBe(401);
    const notFound = await getInk(app, undefined, attemptId, Q.solve);
    expect(notFound.status).toBe(401);
  });
});

describe("状态与校验错误", () => {
  it("已交卷后 PUT → 409 ALREADY_SUBMITTED；GET 自己的笔迹仍可（回看）", async () => {
    const { app, aCookie, attemptId } = await makeInkApp();
    await putInk(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipDoc(atramentDoc(1)),
      makePng(),
    );
    expect((await submitAttempt(app, aCookie, attemptId)).status).toBe(200);
    const putRes = await putInk(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipDoc(atramentDoc(2)),
      makePng(),
    );
    expect(putRes.status).toBe(409);
    expect(((await putRes.json()) as ApiErr).error).toBe("ALREADY_SUBMITTED");
    // 交卷后取回自己的笔迹不受限（结果页/续看需要）
    expect((await getInk(app, aCookie, attemptId, Q.solve)).status).toBe(200);
  });

  it("strokes 非法：随机字节（非 gzip 非 JSON）→ 400 INK_INVALID", async () => {
    const { app, db, aCookie, attemptId } = await makeInkApp();
    const res = await putInk(
      app,
      aCookie,
      attemptId,
      Q.solve,
      randomBytes(64),
      makePng(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErr).error).toBe("INK_INVALID");
    expect(db.select().from(inkTable).all()).toHaveLength(0);
  });

  it("strokes 是合法 JSON 但不符合 inkDocSchema → 400 INK_INVALID", async () => {
    const { app, aCookie, attemptId } = await makeInkApp();
    const res = await putInk(
      app,
      aCookie,
      attemptId,
      Q.solve,
      new TextEncoder().encode(JSON.stringify({ hello: "world" })),
      makePng(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErr).error).toBe("INK_INVALID");
  });

  it("gzip 炸弹：压缩体积过上传限额但解压超 32MB 上限 → 400 INK_INVALID，不落盘", async () => {
    const { app, db, dataDir, aCookie, attemptId } = await makeInkApp();
    // 64MiB 高度可压缩字节：gzip 后只有几十 KB，远低于 2MiB 压缩侧限额，
    // 解压后超 32MB 上限——须被拒绝而非解出大 Buffer
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(64 * 1024 * 1024)));
    expect(bomb.byteLength).toBeLessThan(1024 * 1024); // 前置：确实绕过压缩侧限额
    const res = await putInk(app, aCookie, attemptId, Q.solve, bomb, makePng());
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("INK_INVALID");
    expect(body.message).toContain("32MB");
    // 坏数据不落盘不写库
    expect(db.select().from(inkTable).all()).toHaveLength(0);
    expect(existsSync(join(dataDir, "blobs", "ink", attemptId))).toBe(false);
  });

  it("snapshot 魔数不是 PNG → 400 INK_INVALID", async () => {
    const { app, aCookie, attemptId } = await makeInkApp();
    const res = await putInk(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipDoc(atramentDoc(1)),
      randomBytes(32),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErr).error).toBe("INK_INVALID");
  });

  it("缺文件字段（只有 strokes）→ 400 VALIDATION_ERROR", async () => {
    const { app, aCookie, attemptId } = await makeInkApp();
    const form = new FormData();
    form.append(
      "strokes",
      new Blob([gzipDoc(atramentDoc(1))]),
      "strokes.json.gz",
    );
    const res = await app.request(
      `/api/student/attempts/${attemptId}/ink/${Q.solve}`,
      { method: "PUT", headers: { cookie: aCookie }, body: form },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
  });

  it("无笔迹：GET 404 INK_NOT_FOUND；GET .png 404", async () => {
    const { app, aCookie, attemptId } = await makeInkApp();
    const getRes = await getInk(app, aCookie, attemptId, Q.solve);
    expect(getRes.status).toBe(404);
    expect(((await getRes.json()) as ApiErr).error).toBe("INK_NOT_FOUND");
    const pngRes = await app.request(
      `/api/student/attempts/${attemptId}/ink/${Q.solve}.png`,
      { headers: { cookie: aCookie } },
    );
    expect(pngRes.status).toBe(404);
  });

  it("题目不属于该作业单元 → 404 QUESTION_NOT_FOUND", async () => {
    const { app, aCookie, attemptId } = await makeInkApp();
    // 练习四-2 是选择题（在单元内，可以传——类型不限制笔迹上传）；
    // 用一个不存在于库里的 id 验证跨单元/不存在口径
    const res = await putInk(
      app,
      aCookie,
      attemptId,
      "不存在-9999",
      gzipDoc(atramentDoc(1)),
      makePng(),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErr).error).toBe("QUESTION_NOT_FOUND");
  });
});

describe("教师侧 ink 接口", () => {
  it("GET /api/teacher/ink/:inkId.png：200 + image/png + 缓存头；不存在 404", async () => {
    const { app, teacherCookie, aCookie, attemptId } = await makeInkApp();
    const putRes = await putInk(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipDoc(atramentDoc(1)),
      makePng(),
    );
    const inkId = ((await putRes.json()) as { data: { inkId: string } }).data
      .inkId;

    const pngRes = await app.request(`/api/teacher/ink/${inkId}.png`, {
      headers: { cookie: teacherCookie },
    });
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get("content-type")).toBe("image/png");
    expect(pngRes.headers.get("cache-control")).toContain("private");
    expect(pngRes.headers.get("etag")).toContain(inkId);

    const missing = await app.request(
      "/api/teacher/ink/00000000-0000-4000-8000-000000000000.png",
      { headers: { cookie: teacherCookie } },
    );
    expect(missing.status).toBe(404);
  });

  it("GET /api/teacher/ink/:inkId：元数据（attemptId/questionId/strokeCount）", async () => {
    const { app, teacherCookie, aCookie, attemptId } = await makeInkApp();
    const putRes = await putInk(
      app,
      aCookie,
      attemptId,
      Q.apply,
      gzipDoc(excalidrawDoc(4)),
      makePng(),
    );
    const inkId = ((await putRes.json()) as { data: { inkId: string } }).data
      .inkId;
    const metaRes = await app.request(`/api/teacher/ink/${inkId}`, {
      headers: { cookie: teacherCookie },
    });
    expect(metaRes.status).toBe(200);
    const meta = (
      (await metaRes.json()) as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(meta.attemptId).toBe(attemptId);
    expect(meta.questionId).toBe(Q.apply);
    expect(meta.strokeCount).toBe(4);
  });

  it("学生会话访问教师 ink 接口 401；未登录 401", async () => {
    const { app, teacherCookie, aCookie, attemptId } = await makeInkApp();
    const putRes = await putInk(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipDoc(atramentDoc(1)),
      makePng(),
    );
    const inkId = ((await putRes.json()) as { data: { inkId: string } }).data
      .inkId;
    const asStudent = await app.request(`/api/teacher/ink/${inkId}.png`, {
      headers: { cookie: aCookie },
    });
    expect(asStudent.status).toBe(401);
    const anonymous = await app.request(`/api/teacher/ink/${inkId}.png`);
    expect(anonymous.status).toBe(401);
    void teacherCookie;
  });
});

describe("路径安全", () => {
  it("questionId 含 ../ 的上传 → 404 QUESTION_NOT_FOUND，DATA_DIR 无越界文件", async () => {
    const { app, dataDir, aCookie, attemptId } = await makeInkApp();
    for (const evil of ["../../secret", "..\\..\\secret", "a/../../b"]) {
      const res = await putInk(
        app,
        aCookie,
        attemptId,
        evil,
        gzipDoc(atramentDoc(1)),
        makePng(),
      );
      expect(res.status).toBe(404);
    }
    // 整个 DATA_DIR 下只有空目录结构，无任何笔迹文件越出 blobs/ink
    expect(existsSync(join(dataDir, "secret"))).toBe(false);
    expect(existsSync(join(dataDir, "..", "secret"))).toBe(false);
    // blobs 之外无文件
    const blobsDir = join(dataDir, "blobs");
    if (existsSync(blobsDir)) {
      expect(readdirSync(blobsDir)).toEqual(["ink"]);
    }
  });

  it("safeInkFileName：目录穿越/中文/点/超长/保留名都映射为安全文件名", () => {
    // 分隔符与 .. 被编码，join 后不可能越出 attemptId 目录
    expect(safeInkFileName("../evil")).not.toContain("/");
    expect(safeInkFileName("../evil")).not.toContain("\\");
    expect(safeInkFileName("练习四-7")).toBe("q-%E7%BB%83%E4%B9%A0%E5%9B%9B-7");
    expect(safeInkFileName("a.b")).toBe("q-a.b");
    // 超长中文 id（编码后 >120）回退 hash，长度可控
    const long = "题".repeat(100);
    expect(safeInkFileName(long).length).toBeLessThanOrEqual(42);
    expect(safeInkFileName(long)).toMatch(/^q-[0-9a-f]{40}$/);
    // Windows 保留名加前缀后不再冲突
    expect(safeInkFileName("CON")).not.toBe("CON");
  });
});

describe("泄露（AGENTS.md 第 3 条）", () => {
  it("GET ink 响应 assertNoLeak：只有学生自己的笔迹，无题目侧字段", async () => {
    const { app, aCookie, attemptId } = await makeInkApp();
    await putInk(
      app,
      aCookie,
      attemptId,
      Q.solve,
      gzipDoc(atramentDoc(1)),
      makePng(),
    );
    await putInk(
      app,
      aCookie,
      attemptId,
      Q.apply,
      gzipDoc(excalidrawDoc(2)),
      makePng(),
    );
    for (const questionId of [Q.solve, Q.apply]) {
      const res = await getInk(app, aCookie, attemptId, questionId);
      expect(res.status).toBe(200);
      assertNoLeak(await res.json());
    }
  });
});

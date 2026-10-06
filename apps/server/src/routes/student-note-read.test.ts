import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { ApiErr } from "@tutor/contract";
import {
  NOTE_IMAGE_PNG_MAX_BYTES,
  NOTE_VERSION_IMAGES_MAX_BYTES,
  noteHeadDataSchema,
  noteImageMetaSchema,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client.ts";
import {
  notes as notesTable,
  noteImages as noteImagesTable,
  submissionEvidence as submissionEvidenceTable,
} from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { canonicalNoteJson } from "../services/note-service.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { gzipJson, makeNotePng, noteDoc } from "../test/note-fixtures.ts";
import { submitAttemptRequest } from "../test/submit-revisions";

/**
 * T6R.5 学生端读/图路由测试：
 * - GET /api/student/attempts/:id/notes/:qid（工作稿头，①）；
 * - GET /api/student/attempts/:id/evidence/:qid（只读证据，②）；
 * - GET /api/student/note-versions/:id/document（正文 gzip 直出，③）；
 * - GET /api/student/note-versions/:id/images/:imageId(.png)（PNG 直出，④）；
 * - POST /api/student/note-versions/:id/images（补派生图上传，⑤）。
 * 覆盖派单失败测试清单：401；学生 B 读学生 A 的一切（403）；交卷后写拒绝/
 * 读放行；软删题历史证据可读；课程撤权与冻结语义一致；引用其他 attempt 的
 * versionId/imageId 拒绝（跨学生/跨教师全组合在 teacher-notes.test 补齐）；
 * 异常报文不含磁盘路径；Cache-Control 不跨账号缓存复用；assertNoLeak。
 * 夹具用 samples/v2/练习样例.md（题目 id：p4-q7 / 练习四-7）。
 */

const silentLogger: Logger = pino({ enabled: false });
const STUDENT_PASSWORD = "stu-pass-6";

const PRACTICE_MD = readFileSync(
  new URL("../../../../samples/v2/练习样例.md", import.meta.url),
  "utf8",
);

/** 样例题 id（solve=纯 ASCII；apply=中文含连字符） */
const Q = { solve: "p4-q7", apply: "练习四-7" } as const;

type App = ReturnType<typeof createApp>;

// ---------- 共享世界（对齐 student-notes.test：一次 beforeAll 构建） ----------

let app: App;
let db: Db;
let dataDir: string;
let teacherCookie: string;
let unitId: string;
let aId: string;
let bId: string;
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
    body: JSON.stringify({ loginName: "teacher", password: "teacher-pass-8" }),
  });
  teacherCookie = `tutor_session=${extractSessionToken(setup)}`;

  const importRes = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ markdown: PRACTICE_MD, filename: "练习样例.md" }),
  });
  expect(importRes.status).toBe(200);
  unitId = (
    (await importRes.json()) as { data: { units: { id: string }[] } }
  ).data.units[0]?.id ?? "";

  aId = await createStudent(app, teacherCookie, "张三");
  bId = await createStudent(app, teacherCookie, "李四");
  aCookie = await loginStudent(app, "张三");
  bCookie = await loginStudent(app, "李四");
});

/** 每测试取新 attempt（默认张三；可换学生，跨学生引用测试用） */
async function freshAttempt(studentIds: string[] = [aId]): Promise<string> {
  const createRes = await app.request("/api/teacher/assignments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ unitIds: [unitId], studentIds }),
  });
  expect(createRes.status).toBe(201);
  const assignmentId = (
    (await createRes.json()) as { data: { assignments: { id: string }[] } }
  ).data.assignments[0]?.id;
  if (assignmentId === undefined) throw new Error("布置作业响应缺少作业 id");
  const cookie = studentIds[0] === bId ? bCookie : aCookie;
  const attemptRes = await app.request(
    `/api/student/assignments/${assignmentId}/attempt`,
    { method: "POST", headers: { cookie } },
  );
  expect(attemptRes.status).toBe(200);
  return ((await attemptRes.json()) as { data: { id: string } }).data.id;
}

interface PutNoteOptions {
  baseRevision?: number;
  mutationId?: string;
}

/** PUT 草稿正文（T6R.4 写入口），返回回执里的 versionId（默认再取 revision） */
async function putNote(
  attemptId: string,
  questionId: string,
  strokes = 1,
  options: PutNoteOptions = {},
): Promise<string> {
  const form = new FormData();
  form.append(
    "body",
    new Blob([gzipJson(noteDoc(strokes))], { type: "application/gzip" }),
    "note.json.gz",
  );
  form.append("baseRevision", String(options.baseRevision ?? 0));
  form.append("mutationId", options.mutationId ?? randomUUID());
  const res = await app.request(
    `/api/student/attempts/${attemptId}/notes/${questionId}`,
    { method: "PUT", headers: { cookie: aCookie }, body: form },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { versionId: string } }).data.versionId;
}

interface PostImageOptions {
  spec?: string;
  pageIndex?: number;
  pixelWidth?: number;
  pixelHeight?: number;
  cookie?: string;
}

/** POST 补派生图（multipart：image 文件 + 元信息字符串字段） */
function postImage(
  versionId: string,
  png: Uint8Array,
  options: PostImageOptions = {},
): Promise<Response> {
  const form = new FormData();
  form.append("image", new Blob([png], { type: "image/png" }), "note.png");
  form.append("spec", options.spec ?? "analysis");
  form.append("pageIndex", String(options.pageIndex ?? 0));
  form.append("cropX", "0");
  form.append("cropY", "0");
  form.append("cropW", "1000");
  form.append("cropH", "800");
  form.append("pixelWidth", String(options.pixelWidth ?? 320));
  form.append("pixelHeight", String(options.pixelHeight ?? 200));
  return Promise.resolve(
    app.request(`/api/student/note-versions/${versionId}/images`, {
      method: "POST",
      headers: { cookie: options.cookie ?? aCookie },
      body: form,
    }),
  );
}

/** 直插提交证据行（交卷事务写入口在 T6R.10——本任务读侧按行存在性投影） */
function insertEvidence(
  attemptId: string,
  questionId: string,
  state: "none" | "frozen" | "missing" | "legacy_unverified",
  versionId: string | null,
): void {
  db.insert(submissionEvidenceTable)
    .values({
      id: randomUUID(),
      attemptId,
      questionId,
      state,
      versionId,
      recordedAt: new Date().toISOString(),
    })
    .run();
}

/** 该 attempt 该题的 scratch 笔记行 */
function noteRowOf(attemptId: string, questionId: string) {
  return db
    .select()
    .from(notesTable)
    .where(
      and(
        eq(notesTable.attemptId, attemptId),
        eq(notesTable.questionId, questionId),
      ),
    )
    .get();
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

// ---------- 鉴权矩阵 ----------

describe("读/图接口鉴权矩阵", () => {
  it("未登录 401：五个接口全量", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);
    const imageRes = await postImage(versionId, makeNotePng());
    expect(imageRes.status).toBe(200);
    const imageId = (
      (await imageRes.json()) as { data: { imageId: string } }
    ).data.imageId;
    const targets = [
      `/api/student/attempts/${attemptId}/notes/${Q.solve}`,
      `/api/student/attempts/${attemptId}/evidence/${Q.solve}`,
      `/api/student/note-versions/${versionId}/document`,
      `/api/student/note-versions/${versionId}/images/${imageId}`,
      `/api/student/note-versions/${versionId}/images`,
    ];
    for (const path of targets) {
      const res = await app.request(path, {
        method: path.endsWith("/images") ? "POST" : "GET",
        ...(path.endsWith("/images") ? { body: new FormData() } : {}),
      });
      expect(res.status, path).toBe(401);
      expect(((await res.json()) as ApiErr).error).toBe("UNAUTHORIZED");
    }
  });

  it("学生 B（李四）读学生 A（张三）的一切：head/evidence 403，document/image/补图 403", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);
    const imageRes = await postImage(versionId, makeNotePng());
    const imageId = (
      (await imageRes.json()) as { data: { imageId: string } }
    ).data.imageId;

    expect(
      (
        await app.request(`/api/student/attempts/${attemptId}/notes/${Q.solve}`, {
          headers: { cookie: bCookie },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          `/api/student/attempts/${attemptId}/evidence/${Q.solve}`,
          { headers: { cookie: bCookie } },
        )
      ).status,
    ).toBe(403);
    // T6R.4 遗留验收：versionId/imageId 读侧授权——他人 versionId 一律拒
    expect(
      (
        await app.request(`/api/student/note-versions/${versionId}/document`, {
          headers: { cookie: bCookie },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          `/api/student/note-versions/${versionId}/images/${imageId}`,
          { headers: { cookie: bCookie } },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await postImage(versionId, makeNotePng(), { cookie: bCookie })
      ).status,
    ).toBe(403);
  });

  it("attempt 不存在 404 ATTEMPT_NOT_FOUND；题目不在冻结集合 404 QUESTION_NOT_FOUND", async () => {
    await freshAttempt();
    expect(
      (
        await app.request(`/api/student/attempts/${randomUUID()}/notes/${Q.solve}`, {
          headers: { cookie: aCookie },
        })
      ).status,
    ).toBe(404);
    const attemptId = await freshAttempt();
    for (const path of ["notes", "evidence"]) {
      const res = await app.request(
        `/api/student/attempts/${attemptId}/${path}/not-in-paper`,
        { headers: { cookie: aCookie } },
      );
      expect(res.status, path).toBe(404);
      expect(((await res.json()) as ApiErr).error).toBe("QUESTION_NOT_FOUND");
    }
  });

  it("versionId/imageId 不存在 → 404 NOTE_NOT_FOUND", async () => {
    const ghost = randomUUID();
    expect(
      (
        await app.request(`/api/student/note-versions/${ghost}/document`, {
          headers: { cookie: aCookie },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/api/student/note-versions/${ghost}/images/${ghost}`, {
          headers: { cookie: aCookie },
        })
      ).status,
    ).toBe(404);
    expect((await postImage(ghost, makeNotePng())).status).toBe(404);
  });

  it("引用其他 attempt 的 versionId：张三补图/读李四笔记的版本 → 403/404", async () => {
    const bAttemptId = await freshAttempt([bId]);
    const form = new FormData();
    form.append(
      "body",
      new Blob([gzipJson(noteDoc(1))], { type: "application/gzip" }),
      "note.json.gz",
    );
    form.append("baseRevision", "0");
    form.append("mutationId", randomUUID());
    const putRes = await app.request(
      `/api/student/attempts/${bAttemptId}/notes/${Q.solve}`,
      { method: "PUT", headers: { cookie: bCookie }, body: form },
    );
    expect(putRes.status).toBe(200);
    const bVersionId = (
      (await putRes.json()) as { data: { versionId: string } }
    ).data.versionId;

    // 张三引用李四的 versionId：读 403（attempt 归属门口）、补图 403
    expect(
      (
        await app.request(`/api/student/note-versions/${bVersionId}/document`, {
          headers: { cookie: aCookie },
        })
      ).status,
    ).toBe(403);
    expect(
      (await postImage(bVersionId, makeNotePng())).status,
    ).toBe(403);
  });
});

// ---------- 空态、头投影与证据 ----------

describe("工作稿头与证据投影", () => {
  it("无笔记 → 显式空态（note=null / images=[] / evidence=null），过契约与泄露检查", async () => {
    const attemptId = await freshAttempt();
    for (const path of ["notes", "evidence"]) {
      const res = await app.request(
        `/api/student/attempts/${attemptId}/${path}/${Q.solve}`,
        { headers: { cookie: aCookie } },
      );
      expect(res.status, path).toBe(200);
      const body = (await res.json()) as { data: unknown };
      expect(noteHeadDataSchema.safeParse(body.data).success).toBe(true);
      expect(body.data).toEqual({ note: null, images: [], evidence: null });
      assertNoLeak(body);
    }
  });

  it("上传后 head 反映回执；补图后 images 聚合到当前 head 版本", async () => {
    const attemptId = await freshAttempt();
    const form = new FormData();
    form.append(
      "body",
      new Blob([gzipJson(noteDoc(2))], { type: "application/gzip" }),
      "note.json.gz",
    );
    form.append("baseRevision", "0");
    form.append("mutationId", randomUUID());
    const putRes = await app.request(
      `/api/student/attempts/${attemptId}/notes/${Q.apply}`,
      { method: "PUT", headers: { cookie: aCookie }, body: form },
    );
    const receipt = (await putRes.json()) as {
      data: { noteId: string; versionId: string; revision: number; savedAt: string };
    };

    const headRes = await app.request(
      `/api/student/attempts/${attemptId}/notes/${Q.apply}`,
      { headers: { cookie: aCookie } },
    );
    const head = (await headRes.json()) as {
      data: { note: { revision: number; currentVersionId: string } | null; images: unknown[] };
    };
    expect(head.data.note?.revision).toBe(1);
    expect(head.data.note?.currentVersionId).toBe(receipt.data.versionId);
    expect(head.data.images).toEqual([]);
    assertNoLeak(head);

    // 补两张图（analysis 两页切片）→ head.images 两条 ready
    const img1 = await postImage(receipt.data.versionId, makeNotePng(1000, 800), {
      pageIndex: 0,
      pixelWidth: 1000,
      pixelHeight: 800,
    });
    expect(img1.status).toBe(200);
    const img2 = await postImage(receipt.data.versionId, makeNotePng(1000, 300), {
      pageIndex: 1,
      pixelWidth: 1000,
      pixelHeight: 300,
    });
    expect(img2.status).toBe(200);
    for (const res of [img1, img2]) {
      const body = (await res.json()) as { data: unknown };
      expect(noteImageMetaSchema.safeParse(body.data).success).toBe(true);
      assertNoLeak(body);
    }

    const head2 = (await (
      await app.request(`/api/student/attempts/${attemptId}/notes/${Q.apply}`, {
        headers: { cookie: aCookie },
      })
    ).json()) as { data: { images: { pageIndex: number; state: string }[] } };
    expect(head2.data.images.map((i) => i.pageIndex)).toEqual([0, 1]);
    expect(head2.data.images.every((i) => i.state === "ready")).toBe(true);
  });

  it("frozen 证据行 → evidence 端点回传证据与原稿版本图片（读侧投影，行由 T6R.10 交卷事务落）", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);
    await postImage(versionId, makeNotePng());
    insertEvidence(attemptId, Q.solve, "frozen", versionId);

    const res = await app.request(
      `/api/student/attempts/${attemptId}/evidence/${Q.solve}`,
      { headers: { cookie: aCookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        note: { currentVersionId: string } | null;
        images: { noteVersionId: string }[];
        evidence: { state: string; versionId: string | null } | null;
      };
    };
    expect(noteHeadDataSchema.safeParse(body.data).success).toBe(true);
    expect(body.data.evidence?.state).toBe("frozen");
    expect(body.data.evidence?.versionId).toBe(versionId);
    expect(body.data.images).toHaveLength(1);
    expect(body.data.images[0]?.noteVersionId).toBe(versionId);
    assertNoLeak(body);
  });

  it("交卷（无证据行）后 evidence 仍为 null 空态；head/版本读照常", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);
    const submitRes = await submitAttemptRequest(app, aCookie, attemptId);
    expect(submitRes.status).toBe(200);

    const evidenceRes = await app.request(
      `/api/student/attempts/${attemptId}/evidence/${Q.solve}`,
      { headers: { cookie: aCookie } },
    );
    expect(evidenceRes.status).toBe(200);
    const body = (await evidenceRes.json()) as { data: { evidence: unknown } };
    expect(body.data.evidence).toBeNull();
    assertNoLeak(body);
    expect(
      (
        await app.request(`/api/student/note-versions/${versionId}/document`, {
          headers: { cookie: aCookie },
        })
      ).status,
    ).toBe(200);
  });
});

// ---------- 版本文档与图片直出（③④） ----------

describe("版本文档与图片字节直出", () => {
  it("document：application/gzip + no-store + attachment；解压后等于服务端规范化正文", async () => {
    const attemptId = await freshAttempt();
    const doc = noteDoc(3);
    const versionId = await putNote(attemptId, Q.solve, 3);

    const res = await app.request(
      `/api/student/note-versions/${versionId}/document`,
      { headers: { cookie: aCookie } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(gunzipSync(bytes).toString("utf8")).toBe(canonicalNoteJson(doc));
  });

  it("image：image/png + no-store，字节原样回传；.png 后缀与裸 imageId 同一资源", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);
    const png = makeNotePng(320, 200);
    const imageRes = await postImage(versionId, png);
    const imageId = (
      (await imageRes.json()) as { data: { imageId: string } }
    ).data.imageId;

    for (const file of [imageId, `${imageId}.png`]) {
      const res = await app.request(
        `/api/student/note-versions/${versionId}/images/${file}`,
        { headers: { cookie: aCookie } },
      );
      expect(res.status, file).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      // 跨账号不可缓存复用：no-store（不允许任何缓存回放，非 private,max-age）
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-disposition")).toBeNull();
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
    }
  });

  it("文件缺失（部署级损坏）→ 404 NOTE_NOT_FOUND，报文不含磁盘路径", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);
    const imageRes = await postImage(versionId, makeNotePng());
    const imageId = (
      (await imageRes.json()) as { data: { imageId: string } }
    ).data.imageId;

    const noteRow = noteRowOf(attemptId, Q.solve);
    if (noteRow === undefined) throw new Error("缺少 notes 行");
    const noteRoot = join(dataDir, "blobs", "notes", noteRow.id);
    for (const name of readdirSync(noteRoot)) {
      rmSync(join(noteRoot, name));
    }

    for (const path of ["document", `images/${imageId}`]) {
      const res = await app.request(
        `/api/student/note-versions/${versionId}/${path}`,
        { headers: { cookie: aCookie } },
      );
      expect(res.status, path).toBe(404);
      const err = (await res.json()) as ApiErr;
      expect(err.error).toBe("NOTE_NOT_FOUND");
      expect(err.message).not.toContain(dataDir);
      expect(err.message).not.toContain("blobs");
      expect(err.message).not.toContain("\\");
    }
  });
});

// ---------- 交卷门槛：写拒绝、读放行 ----------

describe("交卷后门槛（ALREADY_SUBMITTED 只拦新写）", () => {
  it("PUT 新版本 409；GET head/evidence/document 放行；POST 补图放行（恢复通道）", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);
    const submitRes = await submitAttemptRequest(app, aCookie, attemptId);
    expect(submitRes.status).toBe(200);

    const form = new FormData();
    form.append(
      "body",
      new Blob([gzipJson(noteDoc(9))], { type: "application/gzip" }),
      "note.json.gz",
    );
    form.append("baseRevision", "1");
    form.append("mutationId", randomUUID());
    const putRes = await app.request(
      `/api/student/attempts/${attemptId}/notes/${Q.solve}`,
      { method: "PUT", headers: { cookie: aCookie }, body: form },
    );
    expect(putRes.status).toBe(409);
    expect(((await putRes.json()) as ApiErr).error).toBe("ALREADY_SUBMITTED");

    expect(
      (
        await app.request(`/api/student/attempts/${attemptId}/notes/${Q.solve}`, {
          headers: { cookie: aCookie },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          `/api/student/attempts/${attemptId}/evidence/${Q.solve}`,
          { headers: { cookie: aCookie } },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/api/student/note-versions/${versionId}/document`, {
          headers: { cookie: aCookie },
        })
      ).status,
    ).toBe(200);
    expect(
      (await postImage(versionId, makeNotePng(500, 400), {
        pixelWidth: 500,
        pixelHeight: 400,
      })).status,
    ).toBe(200);
  });
});

// ---------- 补图上传校验（⑤） ----------

describe("补图上传校验", () => {
  it("非 multipart / 缺 image 文件 / 元信息非法 → 400", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);

    const jsonRes = await app.request(
      `/api/student/note-versions/${versionId}/images`,
      {
        method: "POST",
        headers: { cookie: aCookie, "content-type": "application/json" },
        body: JSON.stringify({ spec: "analysis" }),
      },
    );
    expect(jsonRes.status).toBe(400);
    expect(((await jsonRes.json()) as ApiErr).error).toBe("VALIDATION_ERROR");

    const noFile = new FormData();
    noFile.append("spec", "analysis");
    noFile.append("pageIndex", "0");
    const noFileRes = await app.request(
      `/api/student/note-versions/${versionId}/images`,
      { method: "POST", headers: { cookie: aCookie }, body: noFile },
    );
    expect(noFileRes.status).toBe(400);

    // crop 越硬上限（multipart 字符串组装后契约拒绝）
    const badCrop = new FormData();
    badCrop.append("image", new Blob([makeNotePng()], { type: "image/png" }));
    badCrop.append("spec", "analysis");
    badCrop.append("pageIndex", "0");
    badCrop.append("cropX", "0");
    badCrop.append("cropY", "0");
    badCrop.append("cropW", "1001");
    badCrop.append("cropH", "800");
    badCrop.append("pixelWidth", "320");
    badCrop.append("pixelHeight", "200");
    const badCropRes = await app.request(
      `/api/student/note-versions/${versionId}/images`,
      { method: "POST", headers: { cookie: aCookie }, body: badCrop },
    );
    expect(badCropRes.status).toBe(400);
    expect(((await badCropRes.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
    // 非十进制整数串同拒（对齐 T6R.4 multipart 传输层口径）
    const badIndex = new FormData();
    badIndex.append("image", new Blob([makeNotePng()], { type: "image/png" }));
    badIndex.append("spec", "analysis");
    badIndex.append("pageIndex", "1e0");
    badIndex.append("cropX", "0");
    badIndex.append("cropY", "0");
    badIndex.append("cropW", "1000");
    badIndex.append("cropH", "800");
    badIndex.append("pixelWidth", "320");
    badIndex.append("pixelHeight", "200");
    expect(
      (
        await app.request(`/api/student/note-versions/${versionId}/images`, {
          method: "POST",
          headers: { cookie: aCookie },
          body: badIndex,
        })
      ).status,
    ).toBe(400);
  });

  it("PNG 魔数错误 / IHDR 尺寸与声明不符 → 400 NOTE_VALIDATION_FAILED", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);

    const notPng = new TextEncoder().encode("not a png at all");
    const res1 = await postImage(versionId, notPng);
    expect(res1.status).toBe(400);
    expect(((await res1.json()) as ApiErr).error).toBe("NOTE_VALIDATION_FAILED");

    // IHDR 声明 320×200，元信息声称 999×200 → 尺寸不匹配
    const res2 = await postImage(versionId, makeNotePng(), {
      pixelWidth: 999,
    });
    expect(res2.status).toBe(400);
    expect(((await res2.json()) as ApiErr).error).toBe("NOTE_VALIDATION_FAILED");
    // 成功后无残留行（两败一空）
    expect(
      db
        .select()
        .from(noteImagesTable)
        .where(eq(noteImagesTable.noteVersionId, versionId))
        .all(),
    ).toHaveLength(0);
  });

  it("单图超 2MiB → 413 NOTE_LIMIT_EXCEEDED（service 精确线）", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);
    const big = makeNotePng(
      320,
      200,
      NOTE_IMAGE_PNG_MAX_BYTES + 1 - 64, // 总长恰为限额+1
    );
    const res = await postImage(versionId, big);
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiErr).error).toBe("NOTE_LIMIT_EXCEEDED");
    expect(
      db
        .select()
        .from(noteImagesTable)
        .where(eq(noteImagesTable.noteVersionId, versionId))
        .all(),
    ).toHaveLength(0);
  });

  it("同版本派生图合计超 8MiB → 413；槽位 upsert 替换后旧文件回收", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);
    const noteRow = noteRowOf(attemptId, Q.solve);
    if (noteRow === undefined) throw new Error("缺少 notes 行");
    const noteRoot = join(dataDir, "blobs", "notes", noteRow.id);

    // 直插 3 个占位槽位行 + 真实大文件（合计 8.1MiB > 8MiB 聚合线）
    const bigFile = Buffer.alloc(Math.ceil(NOTE_VERSION_IMAGES_MAX_BYTES / 3));
    for (let slot = 0; slot < 3; slot++) {
      const fileName = `img-seed-${slot}.png`;
      writeFileSync(join(noteRoot, fileName), bigFile);
      db.insert(noteImagesTable)
        .values({
          id: randomUUID(),
          noteVersionId: versionId,
          spec: "analysis",
          pageIndex: slot + 1, // 占 1..3，留 0 号槽给本测试上传
          cropX: 0,
          cropY: 0,
          cropW: 1000,
          cropH: 800,
          pixelWidth: 320,
          pixelHeight: 200,
          path: `blobs/notes/${noteRow.id}/${fileName}`,
          hash: "c".repeat(64),
          state: "ready",
        })
        .run();
    }
    const overRes = await postImage(versionId, makeNotePng());
    expect(overRes.status).toBe(413);
    expect(((await overRes.json()) as ApiErr).error).toBe("NOTE_LIMIT_EXCEEDED");

    // 槽位 upsert：替换种子槽位 1（其余两个种子 5.4MiB + 小图 ≤ 8MiB 通过）→
    // 同 (spec, pageIndex) 再传 → 行数不变、imageId 换新、旧文件删除
    const first = await postImage(versionId, makeNotePng(320, 200, 1024), {
      pageIndex: 1,
    });
    expect(first.status).toBe(200);
    const firstImageId = ((await first.json()) as { data: { imageId: string } })
      .data.imageId;
    const second = await postImage(versionId, makeNotePng(640, 400), {
      pageIndex: 1,
      pixelWidth: 640,
      pixelHeight: 400,
    });
    expect(second.status).toBe(200);
    const secondMeta = (await second.json()) as { data: { imageId: string } };
    expect(secondMeta.data.imageId).not.toBe(firstImageId);
    const rows = db
      .select()
      .from(noteImagesTable)
      .where(
        and(
          eq(noteImagesTable.noteVersionId, versionId),
          eq(noteImagesTable.spec, "analysis"),
          eq(noteImagesTable.pageIndex, 1),
        ),
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(secondMeta.data.imageId);
    // 上传产物文件（img-<uuid>.png）只剩最终那一份——首次上传的旧文件已被替换回收
    const files = readdirSync(noteRoot).filter((f) =>
      /^img-[0-9a-f-]{36}\.png$/.test(f),
    );
    expect(files).toHaveLength(1);
  });
});

// ---------- 课程撤权与学生归档（独立课程世界） ----------

describe("课程撤权与学生停用（冻结语义一致）", () => {
  let courseApp: App;
  let courseDb: Db;
  let courseTeacherCookie: string;
  let courseId: string;
  let courseUnitId: string;
  let memberCookie: string;
  let memberStudentId: string;

  beforeAll(async () => {
    courseDb = createTestDb();
    courseApp = createApp({
      isProduction: false,
      logger: silentLogger,
      db: courseDb,
      dataDir: createTestDir(),
      publicUrl: "http://localhost:8787",
    });
    const setup = await courseApp.request("/api/public/teacher/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginName: "teacher", password: "teacher-pass-8" }),
    });
    courseTeacherCookie = `tutor_session=${extractSessionToken(setup)}`;
    const created = await courseApp.request("/api/teacher/courses", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: courseTeacherCookie },
      body: JSON.stringify({ title: "初一上" }),
    });
    courseId = ((await created.json()) as { data: { id: string } }).data.id;
    const imported = await courseApp.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: courseTeacherCookie },
      body: JSON.stringify({
        markdown: PRACTICE_MD,
        filename: "练习样例.md",
        courseId,
      }),
    });
    expect(imported.status).toBe(200);
    courseUnitId =
      ((await imported.json()) as { data: { units: { id: string }[] } }).data
        .units[0]?.id ?? "";
    const detail = await courseApp.request(`/api/teacher/courses/${courseId}`, {
      headers: { cookie: courseTeacherCookie },
    });
    const item = (
      (await detail.json()) as {
        data: { items: { id: string; refId: string | null }[] };
      }
    ).data.items.find((entry) => entry.refId === courseUnitId);
    if (!item) throw new Error("课程目录中未找到单元条目");
    const patched = await courseApp.request(
      `/api/teacher/course-items/${item.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: courseTeacherCookie },
        body: JSON.stringify({ visible: true }),
      },
    );
    expect(patched.status).toBe(200);
    const student = await courseApp.request("/api/teacher/students", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: courseTeacherCookie },
      body: JSON.stringify({
        displayName: "成员",
        loginName: "member-stu",
        password: STUDENT_PASSWORD,
      }),
    });
    memberStudentId = (
      (await student.json()) as { data: { student: { id: string } } }
    ).data.student.id;
    const login = await courseApp.request("/api/public/student/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginName: "member-stu", password: STUDENT_PASSWORD }),
    });
    memberCookie = `tutor_session=${extractSessionToken(login)}`;
    const added = await courseApp.request(
      `/api/teacher/courses/${courseId}/members`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: courseTeacherCookie },
        body: JSON.stringify({ studentIds: [memberStudentId] }),
      },
    );
    expect(added.status).toBe(200);
  });

  async function startCourseAttempt(): Promise<string> {
    const res = await courseApp.request(
      `/api/student/courses/${courseId}/units/${courseUnitId}/attempts`,
      { method: "POST", headers: { cookie: memberCookie } },
    );
    // 新建 201 / 取回进行中 200（course-attempts 路由既有口径）
    expect([200, 201]).toContain(res.status);
    return ((await res.json()) as { data: { id: string } }).data.id;
  }

  async function coursePutNote(
    attemptId: string,
    questionId: string,
  ): Promise<{ status: number; versionId?: string }> {
    const form = new FormData();
    form.append(
      "body",
      new Blob([gzipJson(noteDoc(1))], { type: "application/gzip" }),
      "note.json.gz",
    );
    form.append("baseRevision", "0");
    form.append("mutationId", randomUUID());
    const res = await courseApp.request(
      `/api/student/attempts/${attemptId}/notes/${questionId}`,
      { method: "PUT", headers: { cookie: memberCookie }, body: form },
    );
    if (res.status !== 200) return { status: res.status };
    const versionId = (
      (await res.json()) as { data: { versionId: string } }
    ).data.versionId;
    return { status: res.status, versionId };
  }

  /** 加回成员（上一用例可能已移出；幂等——已在册时服务端按集合处理） */
  async function readdMember(): Promise<void> {
    const res = await courseApp.request(
      `/api/teacher/courses/${courseId}/members`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: courseTeacherCookie },
        body: JSON.stringify({ studentIds: [memberStudentId] }),
      },
    );
    expect(res.status).toBe(200);
  }

  /** 移出成员（D7） */
  async function removeMember(): Promise<void> {
    const res = await courseApp.request(
      `/api/teacher/courses/${courseId}/members`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json", cookie: courseTeacherCookie },
        body: JSON.stringify({ studentIds: [memberStudentId] }),
      },
    );
    expect(res.status).toBe(200);
  }

  it("已交卷卷：移出成员后 head/evidence/版本读照常（本人历史权限）", async () => {
    await readdMember();
    const attemptId = await startCourseAttempt();
    const { versionId } = await coursePutNote(attemptId, Q.solve);
    expect(versionId).toBeDefined();
    const submitRes = await submitAttemptRequest(courseApp, memberCookie, attemptId);
    expect(submitRes.status).toBe(200);

    await removeMember();

    expect(
      (
        await courseApp.request(
          `/api/student/attempts/${attemptId}/notes/${Q.solve}`,
          { headers: { cookie: memberCookie } },
        )
      ).status,
    ).toBe(200);
    const evidence = await courseApp.request(
      `/api/student/attempts/${attemptId}/evidence/${Q.solve}`,
      { headers: { cookie: memberCookie } },
    );
    expect(evidence.status).toBe(200);
    assertNoLeak(await evidence.json());
    expect(
      (
        await courseApp.request(
          `/api/student/note-versions/${versionId}/document`,
          { headers: { cookie: memberCookie } },
        )
      ).status,
    ).toBe(200);
  });

  it("进行中卷：移出成员后写/读全部 403（撤权拒写保持既有策略，读亦随 detail 口径）", async () => {
    await readdMember();
    const attemptId = await startCourseAttempt();
    const { versionId } = await coursePutNote(attemptId, Q.solve);
    expect(versionId).toBeDefined();

    await removeMember();

    const putAgain = await coursePutNote(attemptId, Q.apply);
    expect(putAgain.status).toBe(403);
    expect(
      (
        await courseApp.request(
          `/api/student/attempts/${attemptId}/notes/${Q.solve}`,
          { headers: { cookie: memberCookie } },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await courseApp.request(
          `/api/student/attempts/${attemptId}/evidence/${Q.solve}`,
          { headers: { cookie: memberCookie } },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await courseApp.request(
          `/api/student/note-versions/${versionId}/document`,
          { headers: { cookie: memberCookie } },
        )
      ).status,
    ).toBe(403);
  });

  it("学生归档 → 会话立即失效，全部接口 401（停用始终拒绝）", async () => {
    await readdMember();
    const attemptId = await startCourseAttempt();
    // 上一用例的同题 scratch 笔记已在（进行中 attempt 被取回、revision=1），
    // 换一道题建新笔记（baseRevision=0 起步）
    const { versionId } = await coursePutNote(attemptId, Q.apply);
    expect(versionId).toBeDefined();

    const archived = await courseApp.request(
      `/api/teacher/students/${memberStudentId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: courseTeacherCookie },
        body: JSON.stringify({ archived: true }),
      },
    );
    expect(archived.status).toBe(200);

    for (const path of [
      `/api/student/attempts/${attemptId}/notes/${Q.solve}`,
      `/api/student/attempts/${attemptId}/evidence/${Q.solve}`,
      `/api/student/note-versions/${versionId}/document`,
    ]) {
      const res = await courseApp.request(path, {
        headers: { cookie: memberCookie },
      });
      expect(res.status, path).toBe(401);
    }
  });
});

// ---------- 软删题历史证据（放最后：软删影响共享世界的题目行） ----------

describe("软删题的历史证据可读（不查询当前题库存活）", () => {
  it("交卷+证据行后软删题目 → evidence/head 照常返回冻结证据", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);
    await postImage(versionId, makeNotePng());
    const submitRes = await submitAttemptRequest(app, aCookie, attemptId);
    expect(submitRes.status).toBe(200);
    insertEvidence(attemptId, Q.solve, "frozen", versionId);

    const deleted = await app.request(`/api/teacher/questions/${Q.solve}`, {
      method: "DELETE",
      headers: { cookie: teacherCookie },
    });
    expect(deleted.status).toBe(200);

    const res = await app.request(
      `/api/student/attempts/${attemptId}/evidence/${Q.solve}`,
      { headers: { cookie: aCookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { evidence: { state: string } | null; images: unknown[] };
    };
    expect(body.data.evidence?.state).toBe("frozen");
    expect(body.data.images).toHaveLength(1);
    assertNoLeak(body);
    expect(
      (
        await app.request(`/api/student/attempts/${attemptId}/notes/${Q.solve}`, {
          headers: { cookie: aCookie },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/api/student/note-versions/${versionId}/document`, {
          headers: { cookie: aCookie },
        })
      ).status,
    ).toBe(200);
  });
});

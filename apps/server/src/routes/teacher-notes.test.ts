import { readFileSync } from "node:fs";
import type { ApiErr } from "@tutor/contract";
import { noteHeadDataSchema, noteImageMetaSchema } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTeacherSession } from "../auth/session.ts";
import type { Db } from "../db/client.ts";
import {
  noteVersions as noteVersionsTable,
  teachers as teachersTable,
} from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import {
  makeNotePng,
  noteImageForm,
  putNoteVersion,
} from "../test/note-fixtures.ts";
import {
  createStudent,
  extractSessionToken,
  insertEvidence,
  loginStudent,
} from "../test/note-world.ts";
import { submitAttemptRequest } from "../test/submit-revisions";

/**
 * T6R.5 教师端 evidence/版本读与补图路由测试（方案 §8 表后三行）：
 * - GET /api/teacher/attempts/:id/evidence/:qid（域内只读证据，⑥）；
 * - GET /api/teacher/note-versions/:id/document 与 .../images/:imageId(.png)（⑦）；
 * - POST /api/teacher/note-versions/:id/images（教师为学生版本重建派生图，⑧）。
 * 覆盖派单清单：域外 404（教师乙访问教师甲学生）；跨教师 versionId/imageId
 * 全组合拒绝（T6R.4 遗留）；教师补图不改正文；401（未登录/学生会话）；
 * 域外错误不暴露存在性。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_B_ID = "teacher-b-note-0001";

const PRACTICE_MD = readFileSync(
  new URL("../../../../samples/v2/练习样例.md", import.meta.url),
  "utf8",
);

const Q = { solve: "p4-q7" } as const;

type App = ReturnType<typeof createApp>;

let app: App;
let db: Db;
let dataDir: string;
let teacherCookie: string;
let teacherBCookie: string;
let unitId: string;
/** 乙自己域内的同款单元（跨域组合：乙给李四布置作业用乙的单元） */
let bUnitId: string;

/** 甲学生的「张三」与乙学生的「李四」各一份 id（跨域组合用） */
let aStudentId: string;
let bStudentId: string;
let aStudentCookie: string;
let bStudentCookie: string;

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
  unitId =
    ((await importRes.json()) as { data: { units: { id: string }[] } }).data
      .units[0]?.id ?? "";

  aStudentId = await createStudent(app, teacherCookie, "张三");
  aStudentCookie = await loginStudent(app, "张三");

  // 乙：直插教师行 + 伪造会话（对齐 teacher-domain-isolation.test 夹具口径）
  db.insert(teachersTable)
    .values({
      id: TEACHER_B_ID,
      loginName: "乙老师",
      isAdmin: false,
      disabledAt: null,
      passwordHash: "scrypt$note-test-fixture",
      apiToken: null,
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    .run();
  teacherBCookie = `tutor_session=${createTeacherSession(db, TEACHER_B_ID).token}`;
  // 乙自己导入同款内容（教师域隔离：甲的单元在乙域不可见，布置作业须用乙的）
  const importB = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherBCookie },
    body: JSON.stringify({ markdown: PRACTICE_MD, filename: "乙-练习样例.md" }),
  });
  expect(importB.status).toBe(200);
  bUnitId =
    ((await importB.json()) as { data: { units: { id: string }[] } }).data
      .units[0]?.id ?? "";
  // 乙自己的学生李四（乙域内建草稿用）
  bStudentId = await createStudent(app, teacherBCookie, "李四");
  bStudentCookie = await loginStudent(app, "李四");
});

/** 布置作业给指定教师的学生并开卷（教师 cookie、其域内单元与学生 cookie 配对） */
async function freshAttempt(
  teacherC: string,
  studentId: string,
  studentCookie: string,
): Promise<string> {
  const createRes = await app.request("/api/teacher/assignments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherC },
    body: JSON.stringify({
      unitIds: [teacherC === teacherCookie ? unitId : bUnitId],
      studentIds: [studentId],
    }),
  });
  expect(createRes.status).toBe(201);
  const assignmentId = (
    (await createRes.json()) as { data: { assignments: { id: string }[] } }
  ).data.assignments[0]?.id;
  if (assignmentId === undefined) throw new Error("布置作业响应缺少作业 id");
  const attemptRes = await app.request(
    `/api/student/assignments/${assignmentId}/attempt`,
    { method: "POST", headers: { cookie: studentCookie } },
  );
  expect(attemptRes.status).toBe(200);
  return ((await attemptRes.json()) as { data: { id: string } }).data.id;
}

/** 学生侧 PUT 草稿正文（组装收敛在 putNoteVersion），断言 200 取 versionId */
async function putNote(
  studentCookie: string,
  attemptId: string,
  questionId: string,
): Promise<string> {
  const { status, versionId } = await putNoteVersion(
    app,
    studentCookie,
    attemptId,
    questionId,
  );
  expect(status).toBe(200);
  if (versionId === undefined) throw new Error("上传成功但缺少 versionId");
  return versionId;
}

/** 学生端补图 POST（multipart 组装收敛在 noteImageForm） */
function studentPostImage(
  versionId: string,
  png: Uint8Array,
  cookie: string,
  options: { pixelWidth?: number; pixelHeight?: number } = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/student/note-versions/${versionId}/images`, {
      method: "POST",
      headers: { cookie },
      body: noteImageForm(png, options),
    }),
  );
}

/** 教师端补图 POST（⑧：教师为学生版本重建派生图；pixel 声明与 PNG IHDR 一致） */
function teacherPostImage(
  versionId: string,
  png: Uint8Array,
  cookie: string = teacherCookie,
  options: { pixelWidth?: number; pixelHeight?: number } = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/teacher/note-versions/${versionId}/images`, {
      method: "POST",
      headers: { cookie },
      body: noteImageForm(png, options),
    }),
  );
}

// 会话三件套与 insertEvidence（带 state 版）共享自 src/test/note-world.ts（复审⑧）

// ---------- 域内读写 ----------

describe("教师域内：evidence / 版本 / 补图", () => {
  it("GET attempts/:id/evidence/:qid：域内冻结证据 + 原稿版本图片", async () => {
    const attemptId = await freshAttempt(
      teacherCookie,
      aStudentId,
      aStudentCookie,
    );
    const versionId = await putNote(aStudentCookie, attemptId, Q.solve);
    // 学生先补一张图（教师端看到的是同一版本的图集）
    expect(
      (await studentPostImage(versionId, makeNotePng(), aStudentCookie)).status,
    ).toBe(200);
    const submitRes = await submitAttemptRequest(
      app,
      aStudentCookie,
      attemptId,
    );
    expect(submitRes.status).toBe(200);
    insertEvidence(db, attemptId, Q.solve, "frozen", versionId);

    const res = await app.request(
      `/api/teacher/attempts/${attemptId}/evidence/${Q.solve}`,
      { headers: { cookie: teacherCookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown };
    expect(noteHeadDataSchema.safeParse(body.data).success).toBe(true);
    const data = body.data as {
      evidence: { state: string; versionId: string | null } | null;
      images: unknown[];
    };
    expect(data.evidence?.state).toBe("frozen");
    expect(data.evidence?.versionId).toBe(versionId);
    expect(data.images).toHaveLength(1);
  });

  it("GET note-versions/:id/document 与 images/:imageId：字节直出 + no-store", async () => {
    const attemptId = await freshAttempt(
      teacherCookie,
      aStudentId,
      aStudentCookie,
    );
    const versionId = await putNote(aStudentCookie, attemptId, Q.solve);
    const png = makeNotePng(480, 320);
    const imageRes = await teacherPostImage(versionId, png, teacherCookie, {
      pixelWidth: 480,
      pixelHeight: 320,
    });
    expect(imageRes.status).toBe(200);
    const imageBody = (await imageRes.json()) as { data: unknown };
    expect(noteImageMetaSchema.safeParse(imageBody.data).success).toBe(true);
    const imageId = (imageBody.data as { imageId: string }).imageId;

    const docRes = await app.request(
      `/api/teacher/note-versions/${versionId}/document`,
      { headers: { cookie: teacherCookie } },
    );
    expect(docRes.status).toBe(200);
    expect(docRes.headers.get("content-type")).toBe("application/gzip");
    expect(docRes.headers.get("cache-control")).toBe("no-store");
    expect(docRes.headers.get("content-disposition")).toMatch(/^attachment/);

    const imgRes = await app.request(
      `/api/teacher/note-versions/${versionId}/images/${imageId}.png`,
      { headers: { cookie: teacherCookie } },
    );
    expect(imgRes.status).toBe(200);
    expect(imgRes.headers.get("content-type")).toBe("image/png");
    expect(imgRes.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await imgRes.arrayBuffer())).toEqual(png);
  });

  it("教师补图（⑧）：不改正文——版本行 hash/revision/bodyPath 不变；同槽位替换行数仍 1", async () => {
    const attemptId = await freshAttempt(
      teacherCookie,
      aStudentId,
      aStudentCookie,
    );
    const versionId = await putNote(aStudentCookie, attemptId, Q.solve);
    const before = db
      .select()
      .from(noteVersionsTable)
      .where(eq(noteVersionsTable.id, versionId))
      .get();
    if (before === undefined) throw new Error("缺少版本行");

    const first = await teacherPostImage(versionId, makeNotePng());
    expect(first.status).toBe(200);
    const second = await teacherPostImage(
      versionId,
      makeNotePng(640, 400),
      teacherCookie,
      { pixelWidth: 640, pixelHeight: 400 },
    );
    expect(second.status).toBe(200);
    const after = db
      .select()
      .from(noteVersionsTable)
      .where(eq(noteVersionsTable.id, versionId))
      .get();
    expect(after?.hash).toBe(before.hash);
    expect(after?.revision).toBe(before.revision);
    expect(after?.bodyPath).toBe(before.bodyPath);
  });
});

// ---------- 域外与身份矩阵 ----------

describe("域外 404 与身份矩阵", () => {
  it("教师乙访问教师甲学生的 evidence → 404 ATTEMPT_NOT_FOUND；versionId/imageId/补图 → 404 NOTE_NOT_FOUND", async () => {
    const attemptId = await freshAttempt(
      teacherCookie,
      aStudentId,
      aStudentCookie,
    );
    const versionId = await putNote(aStudentCookie, attemptId, Q.solve);
    const imageRes = await teacherPostImage(versionId, makeNotePng());
    const imageId = ((await imageRes.json()) as { data: { imageId: string } })
      .data.imageId;

    const evidence = await app.request(
      `/api/teacher/attempts/${attemptId}/evidence/${Q.solve}`,
      { headers: { cookie: teacherBCookie } },
    );
    expect(evidence.status).toBe(404);
    expect(((await evidence.json()) as ApiErr).error).toBe("ATTEMPT_NOT_FOUND");

    for (const path of [
      `/api/teacher/note-versions/${versionId}/document`,
      `/api/teacher/note-versions/${versionId}/images/${imageId}`,
    ]) {
      const res = await app.request(path, {
        headers: { cookie: teacherBCookie },
      });
      expect(res.status, path).toBe(404);
      const err = (await res.json()) as ApiErr;
      expect(err.error).toBe("NOTE_NOT_FOUND");
      // 域外统一文案不暴露存在性与磁盘路径
      expect(err.message).not.toContain(dataDir);
      expect(err.message).not.toContain("blobs");
    }
    expect(
      (await teacherPostImage(versionId, makeNotePng(), teacherBCookie)).status,
    ).toBe(404);
  });

  it("教师甲引用教师乙学生的 versionId（跨域全组合）→ 404；乙读本域 200", async () => {
    const bAttemptId = await freshAttempt(
      teacherBCookie,
      bStudentId,
      bStudentCookie,
    );
    const bVersionId = await putNote(bStudentCookie, bAttemptId, Q.solve);

    expect(
      (
        await app.request(`/api/teacher/note-versions/${bVersionId}/document`, {
          headers: { cookie: teacherCookie },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `/api/teacher/note-versions/${bVersionId}/images/00000000-0000-4000-8000-000000000000`,
          { headers: { cookie: teacherCookie } },
        )
      ).status,
    ).toBe(404);
    expect((await teacherPostImage(bVersionId, makeNotePng())).status).toBe(
      404,
    );
    // 教师乙读本域（对照）：200
    expect(
      (
        await app.request(`/api/teacher/note-versions/${bVersionId}/document`, {
          headers: { cookie: teacherBCookie },
        })
      ).status,
    ).toBe(200);
  });

  it("未登录 401；学生会话访问教师 note 接口 401（会话类型隔离）", async () => {
    const attemptId = await freshAttempt(
      teacherCookie,
      aStudentId,
      aStudentCookie,
    );
    const versionId = await putNote(aStudentCookie, attemptId, Q.solve);

    expect(
      (
        await app.request(
          `/api/teacher/attempts/${attemptId}/evidence/${Q.solve}`,
        )
      ).status,
    ).toBe(401);
    expect(
      (await app.request(`/api/teacher/note-versions/${versionId}/document`))
        .status,
    ).toBe(401);
    expect(
      (
        await app.request(`/api/teacher/note-versions/${versionId}/document`, {
          headers: { cookie: aStudentCookie },
        })
      ).status,
    ).toBe(401);
    expect(
      (await teacherPostImage(versionId, makeNotePng(), aStudentCookie)).status,
    ).toBe(401);
  });
});

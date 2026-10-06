import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
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
import { noteImages as noteImagesTable } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { insertFrozenResponse } from "../services/attempt-service.ts";
import { canonicalNoteJson } from "../services/note-service.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import {
  makeNotePng,
  noteDoc,
  noteImageForm,
  type PutNoteOptions,
  postNoteImage,
  putNoteForm,
  putNoteOk,
  putNoteVersion,
} from "../test/note-fixtures.ts";
import {
  createStudent,
  extractSessionToken,
  freshNoteAttempt,
  insertEvidence,
  loginStudent,
  noteRowOf,
} from "../test/note-world.ts";
import {
  submitAttemptRequest,
  submitAttemptRequestWithEvidence,
} from "../test/submit-revisions";

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
  unitId =
    ((await importRes.json()) as { data: { units: { id: string }[] } }).data
      .units[0]?.id ?? "";

  aId = await createStudent(app, teacherCookie, "张三");
  bId = await createStudent(app, teacherCookie, "李四");
  aCookie = await loginStudent(app, "张三");
  bCookie = await loginStudent(app, "李四");
});

/** 每测试取新 attempt（默认张三；可换学生，跨学生引用测试用——组装在 freshNoteAttempt） */
function freshAttempt(studentIds: string[] = [aId]): Promise<string> {
  return freshNoteAttempt(
    app,
    teacherCookie,
    unitId,
    studentIds,
    studentIds[0] === bId ? bCookie : aCookie,
  );
}

/** PUT 草稿正文（张三），断言 200 取 versionId（收敛在 putNoteOk） */
function putNote(
  attemptId: string,
  questionId: string,
  strokes = 1,
  options: PutNoteOptions = {},
): Promise<string> {
  return putNoteOk(app, aCookie, attemptId, questionId, strokes, options);
}

interface PostImageOptions {
  spec?: string;
  pageIndex?: number | string;
  pixelWidth?: number;
  pixelHeight?: number;
  cookie?: string;
}

/** POST 补派生图（学生端；组装收敛在 postNoteImage/noteImageForm） */
function postImage(
  versionId: string,
  png: Uint8Array,
  options: PostImageOptions = {},
): Promise<Response> {
  return postNoteImage(
    app,
    "student",
    versionId,
    png,
    options.cookie ?? aCookie,
    options,
  );
}

// noteRowOf / 会话三件套 / insertEvidence 共享自 src/test/note-world.ts（复审⑧⑭）

// ---------- 鉴权矩阵 ----------

describe("读/图接口鉴权矩阵", () => {
  it("未登录 401：五个接口全量", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);
    const imageRes = await postImage(versionId, makeNotePng());
    expect(imageRes.status).toBe(200);
    const imageId = ((await imageRes.json()) as { data: { imageId: string } })
      .data.imageId;
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
    const imageId = ((await imageRes.json()) as { data: { imageId: string } })
      .data.imageId;

    expect(
      (
        await app.request(
          `/api/student/attempts/${attemptId}/notes/${Q.solve}`,
          {
            headers: { cookie: bCookie },
          },
        )
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
      (await postImage(versionId, makeNotePng(), { cookie: bCookie })).status,
    ).toBe(403);
  });

  it("attempt 不存在 404 ATTEMPT_NOT_FOUND；题目不在冻结集合 404 QUESTION_NOT_FOUND", async () => {
    await freshAttempt();
    expect(
      (
        await app.request(
          `/api/student/attempts/${randomUUID()}/notes/${Q.solve}`,
          {
            headers: { cookie: aCookie },
          },
        )
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
        await app.request(
          `/api/student/note-versions/${ghost}/images/${ghost}`,
          {
            headers: { cookie: aCookie },
          },
        )
      ).status,
    ).toBe(404);
    expect((await postImage(ghost, makeNotePng())).status).toBe(404);
  });

  it("引用其他 attempt 的 versionId：张三补图/读李四笔记的版本 → 403/404", async () => {
    const bAttemptId = await freshAttempt([bId]);
    const { status, versionId: bVersionId } = await putNoteVersion(
      app,
      bCookie,
      bAttemptId,
      Q.solve,
    );
    expect(status).toBe(200);
    if (bVersionId === undefined) throw new Error("缺少 versionId");

    // 张三引用李四的 versionId：读 403（attempt 归属门口）、补图 403
    expect(
      (
        await app.request(`/api/student/note-versions/${bVersionId}/document`, {
          headers: { cookie: aCookie },
        })
      ).status,
    ).toBe(403);
    expect((await postImage(bVersionId, makeNotePng())).status).toBe(403);
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
    const { versionId } = await putNoteVersion(
      app,
      aCookie,
      attemptId,
      Q.apply,
      2,
    );
    if (versionId === undefined) throw new Error("缺少 versionId");

    const headRes = await app.request(
      `/api/student/attempts/${attemptId}/notes/${Q.apply}`,
      { headers: { cookie: aCookie } },
    );
    const head = (await headRes.json()) as {
      data: {
        note: { revision: number; currentVersionId: string } | null;
        images: unknown[];
      };
    };
    expect(head.data.note?.revision).toBe(1);
    expect(head.data.note?.currentVersionId).toBe(versionId);
    expect(head.data.images).toEqual([]);
    assertNoLeak(head);

    // 补两张图（analysis 两页切片）→ head.images 两条 ready
    const img1 = await postImage(versionId, makeNotePng(1000, 800), {
      pageIndex: 0,
      pixelWidth: 1000,
      pixelHeight: 800,
    });
    expect(img1.status).toBe(200);
    const img2 = await postImage(versionId, makeNotePng(1000, 300), {
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
    insertEvidence(db, attemptId, Q.solve, "frozen", versionId);

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

  it("missing 证据行：两投影 images 恒空、不回退工作头（复审轮①）", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);
    // 工作头版本挂着一张图——missing 证据行存在时不得把它当生效版本展示
    expect((await postImage(versionId, makeNotePng())).status).toBe(200);
    insertEvidence(db, attemptId, Q.solve, "missing", null);

    for (const path of ["notes", "evidence"]) {
      const res = await app.request(
        `/api/student/attempts/${attemptId}/${path}/${Q.solve}`,
        { headers: { cookie: aCookie } },
      );
      expect(res.status, path).toBe(200);
      const body = (await res.json()) as {
        data: { evidence: { state: string } | null; images: unknown[] };
      };
      expect(body.data.evidence?.state).toBe("missing");
      expect(body.data.images).toEqual([]);
      assertNoLeak(body);
    }
    // none 同理：显式空稿声明后 images 恒空（新 attempt 无既有证据行）
    const noneAttempt = await freshAttempt();
    const noneVersion = await putNote(noneAttempt, Q.solve);
    expect((await postImage(noneVersion, makeNotePng())).status).toBe(200);
    insertEvidence(db, noneAttempt, Q.solve, "none", null);
    const noneRes = await app.request(
      `/api/student/attempts/${noneAttempt}/evidence/${Q.solve}`,
      { headers: { cookie: aCookie } },
    );
    const noneBody = (await noneRes.json()) as {
      data: { evidence: { state: string } | null; images: unknown[] };
    };
    expect(noneBody.data.evidence?.state).toBe("none");
    expect(noneBody.data.images).toEqual([]);
  });

  it("交卷（新客户端带声明）后 evidence 为冻结行；head/版本读照常", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);
    // T6R.10：有笔记的卷必须以新客户端（evidence 声明）交卷——旧式缺字段
    // 提交被 409 NOTE_EVIDENCE_MISMATCH 拒绝（兼容规则，见 attempt-submit-evidence）
    const submitRes = await submitAttemptRequestWithEvidence(
      app,
      aCookie,
      db,
      attemptId,
    );
    expect(submitRes.status).toBe(200);

    const evidenceRes = await app.request(
      `/api/student/attempts/${attemptId}/evidence/${Q.solve}`,
      { headers: { cookie: aCookie } },
    );
    expect(evidenceRes.status).toBe(200);
    const body = (await evidenceRes.json()) as {
      data: { evidence: { state: string; versionId: string | null } | null };
    };
    expect(body.data.evidence?.state).toBe("frozen");
    expect(body.data.evidence?.versionId).toBe(versionId);
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
    const imageId = ((await imageRes.json()) as { data: { imageId: string } })
      .data.imageId;

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
    const imageId = ((await imageRes.json()) as { data: { imageId: string } })
      .data.imageId;

    const noteRow = noteRowOf(db, attemptId, Q.solve);
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
    const submitRes = await submitAttemptRequestWithEvidence(
      app,
      aCookie,
      db,
      attemptId,
    );
    expect(submitRes.status).toBe(200);

    // 新 mutation 的新写入 → 409（原稿固定）
    const putRes = await app.request(
      `/api/student/attempts/${attemptId}/notes/${Q.solve}`,
      {
        method: "PUT",
        headers: { cookie: aCookie },
        body: putNoteForm(9, { baseRevision: 1 }),
      },
    );
    expect(putRes.status).toBe(409);
    expect(((await putRes.json()) as ApiErr).error).toBe("ALREADY_SUBMITTED");

    expect(
      (
        await app.request(
          `/api/student/attempts/${attemptId}/notes/${Q.solve}`,
          {
            headers: { cookie: aCookie },
          },
        )
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
      (
        await postImage(versionId, makeNotePng(500, 400), {
          pixelWidth: 500,
          pixelHeight: 400,
        })
      ).status,
    ).toBe(200);
  });

  it("graded 列（复审轮⑦）：教师批完待批→graded；PUT 409、五读放行", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);
    const imageRes = await postImage(versionId, makeNotePng());
    const imageId = ((await imageRes.json()) as { data: { imageId: string } })
      .data.imageId;
    const submitRes = await submitAttemptRequestWithEvidence(
      app,
      aCookie,
      db,
      attemptId,
    );
    expect(submitRes.status).toBe(200);
    // 教师批完全部待批 → 全 finalCorrect 非空 → attempt 进入 graded
    const pending = await app.request(
      `/api/teacher/pending-marks?studentId=${aId}`,
      { headers: { cookie: teacherCookie } },
    );
    expect(pending.status).toBe(200);
    const marks = (
      (await pending.json()) as { data: { marks: { responseId: string }[] } }
    ).data.marks;
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      const res = await app.request(
        `/api/teacher/responses/${mark.responseId}/mark`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: teacherCookie,
          },
          body: JSON.stringify({ mark: "correct", comment: null }),
        },
      );
      expect(res.status).toBe(200);
    }
    const detail = await app.request(`/api/student/attempts/${attemptId}`, {
      headers: { cookie: aCookie },
    });
    const detailBody = (await detail.json()) as {
      data: { attempt: { status: string } };
    };
    expect(detailBody.data.attempt.status).toBe("graded");

    // graded 状态：写仍拒（原稿固定）、五读全放行
    const putRes = await app.request(
      `/api/student/attempts/${attemptId}/notes/${Q.solve}`,
      {
        method: "PUT",
        headers: { cookie: aCookie },
        body: putNoteForm(2, { baseRevision: 1 }),
      },
    );
    expect(putRes.status).toBe(409);
    expect(((await putRes.json()) as ApiErr).error).toBe("ALREADY_SUBMITTED");
    for (const path of [
      `/api/student/attempts/${attemptId}/notes/${Q.solve}`,
      `/api/student/attempts/${attemptId}/evidence/${Q.solve}`,
      `/api/student/note-versions/${versionId}/document`,
      `/api/student/note-versions/${versionId}/images/${imageId}`,
    ]) {
      expect(
        (await app.request(path, { headers: { cookie: aCookie } })).status,
        path,
      ).toBe(200);
    }
    expect(
      (
        await postImage(versionId, makeNotePng(500, 400), {
          pixelWidth: 500,
          pixelHeight: 400,
        })
      ).status,
    ).toBe(200);
  });
});

// ---------- 鉴权矩阵补充（复审轮⑪⑫） ----------

describe("版本/图片错配与遗留行", () => {
  it("imageId 跨版本错配（⑪）：真 imageId + 错 versionId → 404", async () => {
    const attemptA = await freshAttempt();
    const attemptB = await freshAttempt();
    const versionA = await putNote(attemptA, Q.solve);
    const versionB = await putNote(attemptB, Q.solve);
    const imageRes = await postImage(versionA, makeNotePng());
    const imageId = ((await imageRes.json()) as { data: { imageId: string } })
      .data.imageId;

    // imageId 真实存在，但挂在另一版本下 → 按不存在口径 404（不暴露跨版本存在性）
    expect(
      (
        await app.request(
          `/api/student/note-versions/${versionB}/images/${imageId}`,
          { headers: { cookie: aCookie } },
        )
      ).status,
    ).toBe(404);
    // 正确配对（对照）200
    expect(
      (
        await app.request(
          `/api/student/note-versions/${versionA}/images/${imageId}`,
          { headers: { cookie: aCookie } },
        )
      ).status,
    ).toBe(200);
  });

  it("遗留空快照 responses 行（⑫）：evidence 宽口径空投影 / head 严口径 404", async () => {
    const attemptId = await freshAttempt();
    // 直插升级前遗留形态：responses 行在、快照为空（qid 不在单元内，懒冻结
    // 不会为它回填快照）
    db.transaction((tx) => {
      insertFrozenResponse(tx, {
        attemptId,
        questionId: "legacy-empty-snapshot",
        questionVersion: 1,
        questionSnapshotJson: JSON.stringify({ id: "legacy-empty-snapshot" }),
        unitId: null,
      });
    });
    // 置空快照（insertFrozenResponse 的插入类型只收 string——遗留形态用
    // 原生 UPDATE 构造，与 note-service.test 的 $client 模式同口径）
    db.$client
      .prepare(
        "UPDATE responses SET question_snapshot_json = NULL WHERE attempt_id = ? AND question_id = ?",
      )
      .run(attemptId, "legacy-empty-snapshot");
    // 严口径（写通道同门）：快照缺失不算可用题 → 404
    const headRes = await app.request(
      `/api/student/attempts/${attemptId}/notes/legacy-empty-snapshot`,
      { headers: { cookie: aCookie } },
    );
    expect(headRes.status).toBe(404);
    expect(((await headRes.json()) as ApiErr).error).toBe("QUESTION_NOT_FOUND");
    // 宽口径（历史读取）：行在 → 空投影 200（不 404、不回填当前题库）
    const evidenceRes = await app.request(
      `/api/student/attempts/${attemptId}/evidence/legacy-empty-snapshot`,
      { headers: { cookie: aCookie } },
    );
    expect(evidenceRes.status).toBe(200);
    const body = (await evidenceRes.json()) as { data: unknown };
    expect(body.data).toEqual({ note: null, images: [], evidence: null });
    assertNoLeak(body);
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
    const badCropRes = await app.request(
      `/api/student/note-versions/${versionId}/images`,
      {
        method: "POST",
        headers: { cookie: aCookie },
        body: noteImageForm(makeNotePng(), { cropW: 1001 }),
      },
    );
    expect(badCropRes.status).toBe(400);
    expect(((await badCropRes.json()) as ApiErr).error).toBe(
      "VALIDATION_ERROR",
    );
    // 非十进制整数串同拒（对齐 T6R.4 multipart 传输层口径）
    expect(
      (
        await app.request(`/api/student/note-versions/${versionId}/images`, {
          method: "POST",
          headers: { cookie: aCookie },
          body: noteImageForm(makeNotePng(), { pageIndex: "1e0" }),
        })
      ).status,
    ).toBe(400);
    // pageIndex 上限 999（复审轮②：槽位写入面封顶，防无界行集）
    expect(
      (
        await app.request(`/api/student/note-versions/${versionId}/images`, {
          method: "POST",
          headers: { cookie: aCookie },
          body: noteImageForm(makeNotePng(), { pageIndex: 1000 }),
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
    expect(((await res1.json()) as ApiErr).error).toBe(
      "NOTE_VALIDATION_FAILED",
    );

    // IHDR 声明 320×200，元信息声称 999×200 → 尺寸不匹配
    const res2 = await postImage(versionId, makeNotePng(), {
      pixelWidth: 999,
    });
    expect(res2.status).toBe(400);
    expect(((await res2.json()) as ApiErr).error).toBe(
      "NOTE_VALIDATION_FAILED",
    );
    // 截断文件（丢尾部 IEND 块）与私造 IHDR 长度 → 完整性拒绝（复审轮③）
    const full = makeNotePng();
    const truncated = full.slice(0, full.length - 4);
    const res3 = await postImage(versionId, truncated);
    expect(res3.status).toBe(400);
    expect(((await res3.json()) as ApiErr).error).toBe(
      "NOTE_VALIDATION_FAILED",
    );
    const fakeLen = new Uint8Array(makeNotePng());
    fakeLen.set([0, 0, 0, 12], 8); // IHDR 长度字段私造为 12
    const res4 = await postImage(versionId, fakeLen);
    expect(res4.status).toBe(400);
    // 成功后无残留行（四败一空）
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

  it("同版本派生图合计超 8MiB（跨 spec 全槽位）→ 413；槽位 upsert 替换后旧文件回收", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);
    const noteRow = noteRowOf(db, attemptId, Q.solve);
    if (noteRow === undefined) throw new Error("缺少 notes 行");
    const noteRoot = join(dataDir, "blobs", "notes", noteRow.id);

    /** 直插一个 ready 槽位行（byteSize 记账——聚合限额按列求和，不依赖文件） */
    const seedSlot = (spec: string, pageIndex: number, byteSize: number) => {
      db.insert(noteImagesTable)
        .values({
          id: randomUUID(),
          noteVersionId: versionId,
          spec: spec as "analysis" | "thumbnail",
          pageIndex,
          cropX: 0,
          cropY: 0,
          cropW: 1000,
          cropH: 800,
          pixelWidth: 320,
          pixelHeight: 200,
          path: `blobs/notes/${noteRow.id}/img-seed-${spec}-${pageIndex}.png`,
          byteSize,
          hash: "c".repeat(64),
          state: "ready",
        })
        .run();
    };

    // 直插 3 个 analysis 占位槽（各 ~2.7MiB，合计 > 8MiB 聚合线）
    const seedSize = Math.ceil(NOTE_VERSION_IMAGES_MAX_BYTES / 3);
    for (let slot = 1; slot <= 3; slot++) {
      seedSlot("analysis", slot, seedSize);
    }
    const overRes = await postImage(versionId, makeNotePng());
    expect(overRes.status).toBe(413);
    expect(((await overRes.json()) as ApiErr).error).toBe(
      "NOTE_LIMIT_EXCEEDED",
    );

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

  it("聚合限额跨 spec 计（复审①回归）：thumbnail 已满额时 analysis 也 413", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);
    const noteRow = noteRowOf(db, attemptId, Q.solve);
    if (noteRow === undefined) throw new Error("缺少 notes 行");

    // thumbnail 0 号槽占满 8MiB（旧实现的 eq(spec) 漏算它——只统计同 spec 时
    // 本次 analysis 上传会被放行，绕过「同版本合计」契约口径）
    db.insert(noteImagesTable)
      .values({
        id: randomUUID(),
        noteVersionId: versionId,
        spec: "thumbnail",
        pageIndex: 0,
        cropX: 0,
        cropY: 0,
        cropW: 1000,
        cropH: 800,
        pixelWidth: 320,
        pixelHeight: 200,
        path: `blobs/notes/${noteRow.id}/img-seed-thumb.png`,
        byteSize: NOTE_VERSION_IMAGES_MAX_BYTES,
        hash: "d".repeat(64),
        state: "ready",
      })
      .run();
    // 传 analysis（不同 spec、不同槽位）：thumbnail 占的额度必须计入 → 413
    // （旧实现的 eq(spec) 漏算它——只统计同 spec 时本次上传被放行，绕过合计口径）
    const crossSpec = await postImage(versionId, makeNotePng());
    expect(crossSpec.status).toBe(413);
    expect(((await crossSpec.json()) as ApiErr).error).toBe(
      "NOTE_LIMIT_EXCEEDED",
    );
    // 替换 thumbnail 自身槽位：排除目标槽位后其余为 0 → 放行（口径正交性）
    const replaceOwn = await postImage(versionId, makeNotePng(), {
      spec: "thumbnail",
    });
    expect(replaceOwn.status).toBe(200);
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
      body: JSON.stringify({
        loginName: "teacher",
        password: "teacher-pass-8",
      }),
    });
    courseTeacherCookie = `tutor_session=${extractSessionToken(setup)}`;
    const created = await courseApp.request("/api/teacher/courses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: courseTeacherCookie,
      },
      body: JSON.stringify({ title: "初一上" }),
    });
    courseId = ((await created.json()) as { data: { id: string } }).data.id;
    const imported = await courseApp.request("/api/teacher/import/commit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: courseTeacherCookie,
      },
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
        headers: {
          "content-type": "application/json",
          cookie: courseTeacherCookie,
        },
        body: JSON.stringify({ visible: true }),
      },
    );
    expect(patched.status).toBe(200);
    memberStudentId = await createStudent(
      courseApp,
      courseTeacherCookie,
      "member-stu",
    );
    memberCookie = await loginStudent(courseApp, "member-stu");
    const added = await courseApp.request(
      `/api/teacher/courses/${courseId}/members`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: courseTeacherCookie,
        },
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

  /** 课程世界的成员 PUT 草稿（组装收敛在 putNoteVersion） */
  function coursePutNote(
    attemptId: string,
    questionId: string,
  ): Promise<{ status: number; versionId?: string }> {
    return putNoteVersion(courseApp, memberCookie, attemptId, questionId);
  }

  /** 加回成员（上一用例可能已移出；幂等——已在册时服务端按集合处理） */
  async function readdMember(): Promise<void> {
    const res = await courseApp.request(
      `/api/teacher/courses/${courseId}/members`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: courseTeacherCookie,
        },
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
        headers: {
          "content-type": "application/json",
          cookie: courseTeacherCookie,
        },
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
    const submitRes = await submitAttemptRequestWithEvidence(
      courseApp,
      memberCookie,
      courseDb,
      attemptId,
    );
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
    // 撤权×已交卷×补图写通道（复审轮⑧）：补图是恢复通道——requireUsableAttempt
    // 对已交卷不再复检课程可见性，放行（实现语义用测试锁定）
    expect(
      (
        await courseApp.request(
          `/api/student/note-versions/${versionId}/images`,
          {
            method: "POST",
            headers: { cookie: memberCookie },
            body: noteImageForm(makeNotePng()),
          },
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
    // 撤权对补图同样是拒写（同一 requireUsableAttempt 门口）
    expect(
      (
        await courseApp.request(
          `/api/student/note-versions/${versionId}/images`,
          {
            method: "POST",
            headers: { cookie: memberCookie },
            body: noteImageForm(makeNotePng()),
          },
        )
      ).status,
    ).toBe(403);
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
        headers: {
          "content-type": "application/json",
          cookie: courseTeacherCookie,
        },
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

  /** note 五路由（PUT/GET head/GET evidence/GET document/POST 补图）逐一请求 */
  async function noteRoutesAssertions(
    attemptId: string,
    versionId: string,
    expectStatus: (status: number, label: string) => void,
  ): Promise<void> {
    expectStatus((await coursePutNote(attemptId, Q.apply)).status, "PUT notes");
    for (const path of [
      `/api/student/attempts/${attemptId}/notes/${Q.solve}`,
      `/api/student/attempts/${attemptId}/evidence/${Q.solve}`,
      `/api/student/note-versions/${versionId}/document`,
    ]) {
      expectStatus(
        (await courseApp.request(path, { headers: { cookie: memberCookie } }))
          .status,
        `GET ${path}`,
      );
    }
    expectStatus(
      (
        await courseApp.request(
          `/api/student/note-versions/${versionId}/images`,
          {
            method: "POST",
            headers: { cookie: memberCookie },
            body: noteImageForm(makeNotePng()),
          },
        )
      ).status,
      "POST images",
    );
  }

  /** 撤销学生归档（上一用例归档了成员；⑨ 系列用例复用同一学生） */
  async function unarchiveMember(): Promise<void> {
    const res = await courseApp.request(
      `/api/teacher/students/${memberStudentId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: courseTeacherCookie,
        },
        body: JSON.stringify({ archived: false }),
      },
    );
    expect(res.status).toBe(200);
  }

  /** 共享课程世界的进行中 attempt 已有两题笔记——直插新冻结行为本用例腾题槽 */
  function seedCourseQuestion(attemptId: string, qid: string): void {
    courseDb.transaction((tx) => {
      insertFrozenResponse(tx, {
        attemptId,
        questionId: qid,
        questionVersion: 1,
        questionSnapshotJson: JSON.stringify({ id: qid }),
        unitId: null,
      });
    });
  }

  it("撤权形态二（复审轮⑨）：条目隐藏 → note 五路由 404 NOT_FOUND", async () => {
    await unarchiveMember();
    await readdMember();
    const attemptId = await startCourseAttempt();
    seedCourseQuestion(attemptId, "revocation-form2-q");
    const { versionId } = await coursePutNote(attemptId, "revocation-form2-q");
    expect(versionId).toBeDefined();
    // 隐藏课程条目（D5 可见性——course draft 读写在可见性门被 404 拦）
    const detail = await courseApp.request(`/api/teacher/courses/${courseId}`, {
      headers: { cookie: courseTeacherCookie },
    });
    const item = (
      (await detail.json()) as {
        data: { items: { id: string; refId: string | null }[] };
      }
    ).data.items.find((entry) => entry.refId === courseUnitId);
    if (!item) throw new Error("课程目录中未找到单元条目");
    const hidden = await courseApp.request(
      `/api/teacher/course-items/${item.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: courseTeacherCookie,
        },
        body: JSON.stringify({ visible: false }),
      },
    );
    expect(hidden.status).toBe(200);
    if (versionId === undefined) throw new Error("缺少 versionId");

    await noteRoutesAssertions(attemptId, versionId, (status, label) => {
      expect(status, label).toBe(404);
    });
  });

  it("撤权形态三（复审轮⑨）：课程归档 → note 五路由 403 COURSE_ACCESS_DENIED", async () => {
    await readdMember();
    // 条目恢复可见（上一用例隐藏了它）
    const detail = await courseApp.request(`/api/teacher/courses/${courseId}`, {
      headers: { cookie: courseTeacherCookie },
    });
    const item = (
      (await detail.json()) as {
        data: { items: { id: string; refId: string | null }[] };
      }
    ).data.items.find((entry) => entry.refId === courseUnitId);
    if (!item) throw new Error("课程目录中未找到单元条目");
    await courseApp.request(`/api/teacher/course-items/${item.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: courseTeacherCookie,
      },
      body: JSON.stringify({ visible: true }),
    });
    const attemptId = await startCourseAttempt();
    seedCourseQuestion(attemptId, "revocation-form3-q");
    const { versionId } = await coursePutNote(attemptId, "revocation-form3-q");
    expect(versionId).toBeDefined();
    // 归档课程（D22——成员仍在但课程整体不可用 → 403）
    const archivedCourse = await courseApp.request(
      `/api/teacher/courses/${courseId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: courseTeacherCookie,
        },
        body: JSON.stringify({ archived: true }),
      },
    );
    expect(archivedCourse.status).toBe(200);
    if (versionId === undefined) throw new Error("缺少 versionId");

    await noteRoutesAssertions(attemptId, versionId, (status, label) => {
      expect(status, label).toBe(403);
    });
  });
});

// ---------- 软删题历史证据（放最后：软删影响共享世界的题目行） ----------

describe("软删题的历史证据可读（不查询当前题库存活）", () => {
  it("交卷+证据行后软删题目 → evidence/head 照常返回冻结证据", async () => {
    const attemptId = await freshAttempt();
    const versionId = await putNote(attemptId, Q.solve);
    await postImage(versionId, makeNotePng());
    // T6R.10：交卷事务自带证据行（frozen→versionId），不再手工 insertEvidence
    const submitRes = await submitAttemptRequestWithEvidence(
      app,
      aCookie,
      db,
      attemptId,
    );
    expect(submitRes.status).toBe(200);

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
        await app.request(
          `/api/student/attempts/${attemptId}/notes/${Q.solve}`,
          {
            headers: { cookie: aCookie },
          },
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
  });
});

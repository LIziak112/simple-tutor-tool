import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ApiErr } from "@tutor/contract";
import {
  annotationBaseImageReceiptSchema,
  annotationBasePreviewDataSchema,
  annotationReceiptSchema,
  annotationSealDataSchema,
  annotationViewDataSchema,
} from "@tutor/contract";
import { stemMdLeaksAnswers } from "@tutor/md-dsl";
import type { Logger } from "pino";
import pino from "pino";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { gzipJson, makeNotePng } from "../test/note-fixtures.ts";
import {
  createStudent,
  extractSessionToken,
  freshNoteAttempt,
  loginStudent,
} from "../test/note-world.ts";
import { submitAttemptRequest } from "../test/submit-revisions";

/**
 * T6R.20 路由层测试：学生端标注族（base 装配/base 图回传/doc PUT/GET 视图/
 * 底图直出/seal）＋教师查看。覆盖：
 * - 鉴权矩阵（401/403/404/题目不在卷）与 phase 参数 400；
 * - 泄露矩阵（AGENTS.md 第 3 条）：装配载荷与视图经 assertNoLeak ＋
 *   stemMdLeaksAnswers ＋ 教师节标记（参考答案/详解/判定/评语）三检，
 *   载荷结构性无 snapshotHash（F1 离线答案 oracle 防线）；错误响应同样过检；
 * - 两阶段 gate：PUT 先于底图 409；宽度不符 400；
 * - CAS/幂等/seal/交卷门槛/correction 另开记录；
 * - 底图直出：本人原字节、no-store、content-type；教师域同。
 * 夹具用 samples/v2/练习样例.md（题目 id：p4-q7）。
 */

const silentLogger: Logger = pino({ enabled: false });
const PRACTICE_MD = readFileSync(
  new URL("../../../../samples/v2/练习样例.md", import.meta.url),
  "utf8",
);
const Q = "p4-q7";

type App = ReturnType<typeof createApp>;

let app: App;
let db: Db;
let teacherCookie: string;
let unitId: string;
let aId: string;
let aCookie: string;
let bCookie: string;

beforeAll(async () => {
  db = createTestDb();
  const dataDir = createTestDir();
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
  unitId = ((await importRes.json()) as { data: { units: { id: string }[] } })
    .data.units[0]?.id as string;
  aId = await createStudent(app, teacherCookie, "张三");
  await createStudent(app, teacherCookie, "李四");
  aCookie = await loginStudent(app, "张三");
  bCookie = await loginStudent(app, "李四");
});

function freshAttempt(): Promise<string> {
  return freshNoteAttempt(app, teacherCookie, unitId, [aId], aCookie);
}

// ---------- 请求组装 ----------

function postBase(
  attemptId: string,
  cookie: string | undefined,
  phase?: string,
): Promise<Response> {
  const query = phase === undefined ? "" : `?phase=${phase}`;
  return Promise.resolve(
    app.request(
      `/api/student/attempts/${attemptId}/questions/${Q}/annotation/base${query}`,
      { method: "POST", headers: cookie === undefined ? {} : { cookie } },
    ),
  );
}

function baseImageForm(
  png: Uint8Array,
  meta: {
    questionRevisionId: string;
    baseRenderVersion?: number;
    phase?: string;
  },
): FormData {
  const form = new FormData();
  form.append("image", new Blob([png], { type: "image/png" }), "base.png");
  form.append("questionRevisionId", meta.questionRevisionId);
  form.append("baseRenderVersion", String(meta.baseRenderVersion ?? 1));
  if (meta.phase !== undefined) form.append("phase", meta.phase);
  return form;
}

function postBaseImage(
  attemptId: string,
  cookie: string | undefined,
  meta: {
    questionRevisionId: string;
    baseRenderVersion?: number;
    phase?: string;
  },
  png: Uint8Array,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/api/student/attempts/${attemptId}/questions/${Q}/annotation/base/image`,
      {
        method: "POST",
        headers: cookie === undefined ? {} : { cookie },
        body: baseImageForm(png, meta),
      },
    ),
  );
}

function annotationDoc(height = 900, strokes = 1) {
  return {
    version: 1,
    baseWidth: 1440,
    baseHeight: height,
    strokes: Array.from({ length: strokes }, (_, i) => ({
      tool: "pen",
      color: "#c0392b",
      weight: 6,
      points: [
        { x: 10 + i, y: 20, p: 0.5, t: 0 },
        { x: 40 + i, y: 60, p: 0.8, t: 25 },
      ],
    })),
  };
}

function putAnnotationForm(
  doc: unknown,
  options: { baseRevision?: number; mutationId?: string; phase?: string },
): FormData {
  const form = new FormData();
  form.append(
    "body",
    new Blob([gzipJson(doc)], { type: "application/gzip" }),
    "annotation.json.gz",
  );
  form.append("baseRevision", String(options.baseRevision ?? 0));
  form.append("mutationId", options.mutationId ?? randomUUID());
  if (options.phase !== undefined) form.append("phase", options.phase);
  return form;
}

function putAnnotation(
  attemptId: string,
  cookie: string | undefined,
  doc: unknown,
  options: { baseRevision?: number; mutationId?: string; phase?: string } = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/api/student/attempts/${attemptId}/questions/${Q}/annotation`,
      {
        method: "PUT",
        headers: cookie === undefined ? {} : { cookie },
        body: putAnnotationForm(doc, options),
      },
    ),
  );
}

function getView(
  attemptId: string,
  cookie: string | undefined,
  phase?: string,
): Promise<Response> {
  const query = phase === undefined ? "" : `?phase=${phase}`;
  return Promise.resolve(
    app.request(
      `/api/student/attempts/${attemptId}/questions/${Q}/annotation${query}`,
      { headers: cookie === undefined ? {} : { cookie } },
    ),
  );
}

function sealAnnotations(
  attemptId: string,
  cookie: string | undefined,
  body?: string,
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/student/attempts/${attemptId}/annotations/seal`, {
      method: "POST",
      headers:
        cookie === undefined
          ? { "content-type": "application/json" }
          : { cookie, "content-type": "application/json" },
      body: body ?? "{}",
    }),
  );
}

/** 取 preview 并回传底图（走完两阶段）；返回 baseId */
async function readyBase(
  attemptId: string,
  png: Uint8Array = makeNotePng(1440, 900),
  phase = "scratch",
): Promise<string> {
  const previewRes = await postBase(attemptId, aCookie, phase);
  expect(previewRes.status).toBe(200);
  const preview = annotationBasePreviewDataSchema.parse(
    ((await previewRes.json()) as { data: unknown }).data,
  );
  const uploadRes = await postBaseImage(
    attemptId,
    aCookie,
    { questionRevisionId: preview.questionRevisionId, phase },
    png,
  );
  expect(uploadRes.status).toBe(200);
  return preview.base.baseId;
}

/** 三检断言：assertNoLeak＋（载荷含题面时）stemMdLeaksAnswers＋教师节标记缺席 */
function assertAnnotationPayloadSafe(payload: object): void {
  assertNoLeak({ ok: true, data: payload });
  const md = (payload as { questionMd?: unknown }).questionMd;
  if (typeof md === "string") {
    expect(stemMdLeaksAnswers(md)).toBe(false);
    for (const marker of [
      "参考答案",
      "详解",
      "**判定**",
      "老师评语",
      "学生答案",
    ]) {
      expect(md).not.toContain(marker);
    }
  }
}

// ---------- 鉴权矩阵与参数校验 ----------

describe("标注族鉴权与参数", () => {
  it("未登录 401（preview/上传/PUT/视图/直出/seal）", async () => {
    const attemptId = await freshAttempt();
    expect((await postBase(attemptId, undefined)).status).toBe(401);
    expect(
      (
        await postBaseImage(
          attemptId,
          undefined,
          {
            questionRevisionId: "x",
          },
          makeNotePng(1440, 900),
        )
      ).status,
    ).toBe(401);
    expect(
      (await putAnnotation(attemptId, undefined, annotationDoc())).status,
    ).toBe(401);
    expect((await getView(attemptId, undefined)).status).toBe(401);
    expect(
      (
        await app.request(
          `/api/student/attempts/${attemptId}/annotation-base/${randomUUID()}/image.png`,
        )
      ).status,
    ).toBe(401);
    expect((await sealAnnotations(attemptId, undefined)).status).toBe(401);
  });

  it("非本人 attempt 403；attempt 不存在 404；题目不在卷 404；phase 非法 400", async () => {
    const attemptId = await freshAttempt();
    expect((await postBase(attemptId, bCookie)).status).toBe(403);
    expect((await postBase(randomUUID(), aCookie)).status).toBe(404);
    expect(
      (
        await app.request(
          `/api/student/attempts/${attemptId}/questions/not-in-paper/annotation/base`,
          { method: "POST", headers: { cookie: aCookie } },
        )
      ).status,
    ).toBe(404);
    expect((await postBase(attemptId, aCookie, "supplement")).status).toBe(400);
    expect((await getView(attemptId, aCookie, "supplement")).status).toBe(400);
  });
});

// ---------- 装配载荷与泄露矩阵 ----------

describe("POST …/annotation/base 装配载荷", () => {
  it("学生 stem 投影：三检通过＋无 snapshotHash＋no-store；错误响应也过检", async () => {
    const attemptId = await freshAttempt();
    const res = await postBase(attemptId, aCookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { data: Record<string, unknown> };
    const preview = annotationBasePreviewDataSchema.parse(body.data);
    expect(preview.base.state).toBe("pending");
    expect(preview.maxWidthPx).toBe(1440);
    expect(preview.questionRevisionId).not.toBe("");
    expect(preview.questionMd.length).toBeGreaterThan(0);
    expect("snapshotHash" in body.data).toBe(false);
    assertAnnotationPayloadSafe(preview);

    // 错误响应（题目不在卷）同样无泄露
    const errRes = await app.request(
      `/api/student/attempts/${attemptId}/questions/not-in-paper/annotation/base`,
      { method: "POST", headers: { cookie: aCookie } },
    );
    expect(errRes.status).toBe(404);
    assertNoLeak(await errRes.json());
  });

  it("幂等：重复 preview 同 baseId；ready 后携带直出 URL", async () => {
    const attemptId = await freshAttempt();
    const first = annotationBasePreviewDataSchema.parse(
      ((await (await postBase(attemptId, aCookie)).json()) as { data: unknown })
        .data,
    );
    const second = annotationBasePreviewDataSchema.parse(
      ((await (await postBase(attemptId, aCookie)).json()) as { data: unknown })
        .data,
    );
    expect(second.base.baseId).toBe(first.base.baseId);
    await readyBase(attemptId);
    const third = annotationBasePreviewDataSchema.parse(
      ((await (await postBase(attemptId, aCookie)).json()) as { data: unknown })
        .data,
    );
    expect(third.base.baseId).toBe(first.base.baseId);
    expect(third.base.state).toBe("ready");
    expect(third.base.downloadUrl).toBe(
      `/api/student/attempts/${attemptId}/annotation-base/${first.base.baseId}/image.png`,
    );
  });
});

// ---------- 两阶段 gate 与直出 ----------

describe("底图回传/直出与两阶段 gate", () => {
  it("宽度不符 400；ready 回执形状；直出原字节＋no-store＋image/png；他学生 404", async () => {
    const attemptId = await freshAttempt();
    const preview = annotationBasePreviewDataSchema.parse(
      ((await (await postBase(attemptId, aCookie)).json()) as { data: unknown })
        .data,
    );
    const wrongWidth = await postBaseImage(
      attemptId,
      aCookie,
      { questionRevisionId: preview.questionRevisionId },
      makeNotePng(720, 900),
    );
    expect(wrongWidth.status).toBe(400);
    const wrongWidthBody = (await wrongWidth.json()) as ApiErr;
    expect(wrongWidthBody.error).toBe("ANNOTATION_BASE_IMAGE_INVALID");
    assertNoLeak(wrongWidthBody);

    const png = makeNotePng(1440, 960);
    const uploadRes = await postBaseImage(
      attemptId,
      aCookie,
      { questionRevisionId: preview.questionRevisionId },
      png,
    );
    expect(uploadRes.status).toBe(200);
    const receipt = annotationBaseImageReceiptSchema.parse(
      ((await uploadRes.json()) as { data: unknown }).data,
    );
    expect(receipt.pixelHeight).toBe(960);
    assertNoLeak({ ok: true, data: receipt });

    const direct = await app.request(
      `/api/student/attempts/${attemptId}/annotation-base/${preview.base.baseId}/image.png`,
      { headers: { cookie: aCookie } },
    );
    expect(direct.status).toBe(200);
    expect(direct.headers.get("content-type")).toBe("image/png");
    expect(direct.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await direct.arrayBuffer())).toEqual(png);

    // 他学生：404（不暴露存在性）
    expect(
      (
        await app.request(
          `/api/student/attempts/${attemptId}/annotation-base/${preview.base.baseId}/image.png`,
          { headers: { cookie: bCookie } },
        )
      ).status,
    ).toBe(403); // requireOwnAttempt：非本人 attempt 403
  });

  it("没有可靠底图不能落墨：base 缺失/pending 时 PUT 409 ANNOTATION_BASE_NOT_READY", async () => {
    const attemptId = await freshAttempt();
    const noBase = await putAnnotation(attemptId, aCookie, annotationDoc());
    expect(noBase.status).toBe(409);
    expect(((await noBase.json()) as ApiErr).error).toBe(
      "ANNOTATION_BASE_NOT_READY",
    );
    await postBase(attemptId, aCookie); // 只 preview（pending）
    const pending = await putAnnotation(attemptId, aCookie, annotationDoc());
    expect(pending.status).toBe(409);
    const pendingBody = (await pending.json()) as ApiErr;
    expect(pendingBody.error).toBe("ANNOTATION_BASE_NOT_READY");
    assertNoLeak(pendingBody);
  });
});

// ---------- 正文写入与回看 ----------

describe("PUT/GET …/annotation 正文与视图", () => {
  it("写入 revision 1 → 视图回读 doc＋meta；几何不符 400；CAS 409 附 _current；mutation 重放原回执", async () => {
    const attemptId = await freshAttempt();
    await readyBase(attemptId, makeNotePng(1440, 960));

    const geometryBad = await putAnnotation(
      attemptId,
      aCookie,
      annotationDoc(900),
    );
    expect(geometryBad.status).toBe(400);

    const mutationId = randomUUID();
    const putRes = await putAnnotation(
      attemptId,
      aCookie,
      annotationDoc(960, 2),
      {
        mutationId,
      },
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { data: unknown };
    const receipt = annotationReceiptSchema.parse(putBody.data);
    expect(receipt.revision).toBe(1);
    assertNoLeak(putBody);

    // CAS：同 baseRevision 再写（新 mutation）→ 409 附 _current
    const conflict = await putAnnotation(
      attemptId,
      aCookie,
      annotationDoc(960, 3),
    );
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as ApiErr & {
      _current?: { revision: number };
    };
    expect(conflictBody.error).toBe("ANNOTATION_REVISION_CONFLICT");
    expect(conflictBody._current?.revision).toBe(1);
    assertNoLeak(conflictBody);

    // mutationId 幂等重放：原回执
    const replay = await putAnnotation(
      attemptId,
      aCookie,
      annotationDoc(960, 2),
      {
        mutationId,
      },
    );
    expect(replay.status).toBe(200);
    expect(
      annotationReceiptSchema.parse(
        ((await replay.json()) as { data: unknown }).data,
      ),
    ).toEqual(receipt);

    // 视图
    const viewRes = await getView(attemptId, aCookie);
    expect(viewRes.status).toBe(200);
    const view = annotationViewDataSchema.parse(
      ((await viewRes.json()) as { data: unknown }).data,
    );
    expect(view.base?.state).toBe("ready");
    expect(view.doc?.baseHeight).toBe(960);
    expect(view.annotation?.revision).toBe(1);
    expect(view.annotation?.strokeCount).toBe(2);
    assertAnnotationPayloadSafe(view);
  });

  it("交卷流程：seal 后 PUT 409 ANNOTATION_SEALED；seal 幂等；交卷后 scratch 新写 ALREADY_SUBMITTED", async () => {
    const attemptId = await freshAttempt();
    await readyBase(attemptId);
    await putAnnotation(attemptId, aCookie, annotationDoc());

    const sealRes = await sealAnnotations(attemptId, aCookie);
    expect(sealRes.status).toBe(200);
    const seal = annotationSealDataSchema.parse(
      ((await sealRes.json()) as { data: unknown }).data,
    );
    expect(seal.sealedCount).toBe(1);
    assertNoLeak({ ok: true, data: seal });
    const reseal = annotationSealDataSchema.parse(
      (
        (await (await sealAnnotations(attemptId, aCookie)).json()) as {
          data: unknown;
        }
      ).data,
    );
    expect(reseal.sealedCount).toBe(0);

    // 交卷（seal 后无笔记冲突——标注不是笔记证据，plain submit 可用）
    const submitRes = await submitAttemptRequest(app, aCookie, attemptId);
    expect(submitRes.status).toBe(200);

    const sealedPut = await putAnnotation(
      attemptId,
      aCookie,
      annotationDoc(900, 5),
      {
        baseRevision: 1,
      },
    );
    expect(sealedPut.status).toBe(409);
    expect(((await sealedPut.json()) as ApiErr).error).toBe(
      "ANNOTATION_SEALED",
    );

    // 已交卷但未 seal 的防御分支：另一卷不 seal 直接交，PUT → ALREADY_SUBMITTED
    const attempt2 = await freshAttempt();
    await readyBase(attempt2);
    await putAnnotation(attempt2, aCookie, annotationDoc());
    expect((await submitAttemptRequest(app, aCookie, attempt2)).status).toBe(
      200,
    );
    const latePut = await putAnnotation(
      attempt2,
      aCookie,
      annotationDoc(900, 2),
      {
        baseRevision: 1,
      },
    );
    expect(latePut.status).toBe(409);
    const latePutBody = (await latePut.json()) as ApiErr;
    expect(latePutBody.error).toBe("ALREADY_SUBMITTED");
    assertNoLeak(latePutBody);
  });

  it("订正另开：交卷后 phase=correction 走全流程，scratch 视图只读可回看", async () => {
    const attemptId = await freshAttempt();
    const baseId = await readyBase(attemptId);
    const scratchReceipt = annotationReceiptSchema.parse(
      (
        (await (
          await putAnnotation(attemptId, aCookie, annotationDoc())
        ).json()) as {
          data: unknown;
        }
      ).data,
    );
    await sealAnnotations(attemptId, aCookie);
    expect((await submitAttemptRequest(app, aCookie, attemptId)).status).toBe(
      200,
    );

    // correction 另开（底图独立、PUT 合法）
    const corrBaseId = await readyBase(
      attemptId,
      makeNotePng(1440, 880),
      "correction",
    );
    expect(corrBaseId).not.toBe(baseId);
    const corrPut = await putAnnotation(
      attemptId,
      aCookie,
      annotationDoc(880),
      {
        phase: "correction",
      },
    );
    expect(corrPut.status).toBe(200);
    expect(
      annotationReceiptSchema.parse(
        ((await corrPut.json()) as { data: unknown }).data,
      ).revision,
    ).toBe(1);

    // scratch 视图照常回看（sealed 只读）
    const scratchView = annotationViewDataSchema.parse(
      ((await (await getView(attemptId, aCookie)).json()) as { data: unknown })
        .data,
    );
    expect(scratchView.annotation?.annotationId).toBe(
      scratchReceipt.annotationId,
    );
    const corrView = annotationViewDataSchema.parse(
      (
        (await (await getView(attemptId, aCookie, "correction")).json()) as {
          data: unknown;
        }
      ).data,
    );
    expect(corrView.doc?.baseHeight).toBe(880);
  });
});

// ---------- 教师侧 ----------

describe("教师查看标注", () => {
  it("教师视图与底图直出（教师域 URL）；教师视图无答案节；域外教师 404", async () => {
    const attemptId = await freshAttempt();
    const baseId = await readyBase(attemptId, makeNotePng(1440, 900));
    await putAnnotation(attemptId, aCookie, annotationDoc(900, 3));

    const viewRes = await app.request(
      `/api/teacher/attempts/${attemptId}/questions/${Q}/annotation`,
      { headers: { cookie: teacherCookie } },
    );
    expect(viewRes.status).toBe(200);
    const view = annotationViewDataSchema.parse(
      ((await viewRes.json()) as { data: unknown }).data,
    );
    expect(view.base?.downloadUrl).toBe(
      `/api/teacher/annotation-bases/${baseId}/image.png`,
    );
    expect(view.doc?.strokes.length).toBe(3);
    // 教师视图同样不含答案节（标注链路只有学生 stem 投影）
    assertAnnotationPayloadSafe(view);

    const direct = await app.request(
      `/api/teacher/annotation-bases/${baseId}/image.png`,
      { headers: { cookie: teacherCookie } },
    );
    expect(direct.status).toBe(200);
    expect(direct.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await direct.arrayBuffer())).toEqual(
      makeNotePng(1440, 900),
    );

    // 未登录教师路由 401
    expect(
      (
        await app.request(
          `/api/teacher/attempts/${attemptId}/questions/${Q}/annotation`,
        )
      ).status,
    ).toBe(401);
  });
});

import { gzipSync } from "node:zlib";
import type { ApiErr, AttemptDraftData, InkDoc } from "@tutor/contract";
import {
  RESPONSE_BODY_MAX_CHARS,
  RESPONSE_TITLE_MAX_CHARS,
} from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { createTestDb, createTestDir } from "../db/test-utils";
import { assertNoLeak } from "../test/assert-no-leak";
import { submitAttemptRequest } from "../test/submit-revisions";

/**
 * QM-09 细项 3/4/6 服务级验收（TT-08b）：response 开放作答的保存与校验、
 * 可靠保存与恢复、三形态（长文字/仅手写/混合）提交并回看。
 * - 保存只校验结构/范围（契约 title/body 防御性上限），不比较参考答案——
 *   与参考范文完全不同的正文照样保存，交卷 autoCorrect 恒 null（判分留 TT-09）；
 * - 幂等回执沿用既有 baseRevision/mutationId 纪律：同 id 同内容重试同回执、
 *   旧客户端无版本覆盖拒绝、冲突体只含本人稿（assertNoLeak）；
 * - word-min/word-max 仅提示：低于下限/超出上限的正文本体均可保存，不截断；
 * - 夹具两题：作文题-1 带 word-min/max + 参考范文（哨兵）、作文题-2 无参考。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

/** 开放作答夹具（导入需发布开关 NEW_CONTENT_ENABLED，见 makeResponseApp） */
const RESPONSE_MD = `---
kind: practice
unit: 开放作答
topic: 书面表达
---

::::question{type=response difficulty=3 knowledge="书面表达" word-min=200 word-max=800}
阅读下面的材料，按要求写一篇短文。

随着城市更新推进，老旧小区的改造成为热议话题。有人认为改造应保留历史记忆，有人认为应优先改善居住条件。

请结合材料，谈谈你的看法，题目自拟。

:::answer
参考范文哨兵：城市更新既要留住记忆，也要改善生活。保留与更新并非对立……
:::

:::hint
提示哨兵：先立论，再举例，最后回扣材料。
:::

:::solution
详解哨兵：立意需兼顾记忆与生活两条线索，结构完整即可。
:::
::::

::::question{type=response difficulty=2 knowledge="书面表达"}
用一段话描述你今天的学习收获，不少于三句。

（本题无参考答案，由教师批改。）
::::`;

/** 夹具题目 id（默认规则：单元名-序号） */
const Q = {
  /** 带字数建议与参考范文的 response 题 */
  composed: "开放作答-1",
  /** 无参考答案的 response 题 */
  free: "开放作答-2",
} as const;

type App = ReturnType<typeof createApp>;

/** 构造最小合法 InkDoc（1 笔）——仅手写/混合形态用（width=逻辑宽 1000 字面量） */
function atramentDoc(): InkDoc {
  return {
    engine: "atrament",
    version: 1,
    data: {
      width: 1000,
      strokes: [
        {
          tool: "pen",
          color: "#1f2328",
          weight: 4,
          points: [
            { x: 10, y: 20, p: 0.5, t: 0 },
            { x: 300, y: 240, p: 0.8, t: 25 },
          ],
        },
      ],
    },
    updatedAt: 1727392800000,
  };
}

function gzipDoc(doc: InkDoc): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(JSON.stringify(doc), "utf8")));
}

/** 最小合法 PNG（1×1 像素） */
const MINIMAL_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
  0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

/** 全套前置：教师 + 导入开放作答夹具（发布开关内）+ 张三开卷 */
async function makeResponseApp(): Promise<{
  app: App;
  db: Db;
  teacherCookie: string;
  aCookie: string;
  assignmentId: string;
  attemptId: string;
}> {
  const db = createTestDb();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    publicUrl: "http://localhost:8787",
    dataDir: createTestDir(),
  });
  const setup = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "teacher", password: TEACHER_PASSWORD }),
  });
  const teacherCookie = `tutor_session=${extractSessionToken(setup)}`;

  // QM 新题型导入需发布开关（§5.8.4）；导入完成后即恢复
  const previous = process.env.NEW_CONTENT_ENABLED;
  process.env.NEW_CONTENT_ENABLED = "true";
  let unitId: string | undefined;
  try {
    const importRes = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ markdown: RESPONSE_MD, filename: "开放作答.md" }),
    });
    if (importRes.status !== 200) {
      throw new Error(
        `夹具导入失败：${JSON.stringify(await importRes.json())}`,
      );
    }
    unitId = ((await importRes.json()) as { data: { units: { id: string }[] } })
      .data.units[0]?.id;
  } finally {
    if (previous === undefined) delete process.env.NEW_CONTENT_ENABLED;
    else process.env.NEW_CONTENT_ENABLED = previous;
  }
  if (!unitId) throw new Error("夹具导入未产出单元");

  const aId = await createStudent(app, teacherCookie, "张三");
  const assignmentId = await createAssignment(app, teacherCookie, unitId, aId);
  const aCookie = await loginStudent(app, "张三");
  const attemptRes = await app.request(
    `/api/student/assignments/${assignmentId}/attempt`,
    { method: "POST", headers: { cookie: aCookie } },
  );
  expect(attemptRes.status).toBe(200);
  const attemptId = ((await attemptRes.json()) as { data: { id: string } }).data
    .id;
  return { app, db, teacherCookie, aCookie, assignmentId, attemptId };
}

function extractSessionToken(res: Response, cookie = "tutor_session"): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith(`${cookie}=`));
  if (!line) throw new Error(`响应中没有 ${cookie} cookie`);
  return line.slice(`${cookie}=`.length).split(";")[0] ?? "";
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
  return `tutor_student_session=${extractSessionToken(res, "tutor_student_session")}`;
}

async function createAssignment(
  app: App,
  teacherCookie: string,
  unitId: string,
  studentId: string,
): Promise<string> {
  const res = await app.request("/api/teacher/assignments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ unitIds: [unitId], studentIds: [studentId] }),
  });
  expect(res.status).toBe(201);
  const id = ((await res.json()) as { data: { assignments: { id: string }[] } })
    .data.assignments[0]?.id;
  if (id === undefined) throw new Error("布置作业响应缺少作业 id");
  return id;
}

/** PUT 草稿答案（无版本字段 = 旧客户端口径） */
function putAnswer(
  app: App,
  cookie: string,
  attemptId: string,
  questionId: string,
  answer: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/api/student/attempts/${attemptId}/answers/${encodeURIComponent(questionId)}`,
      {
        method: "PUT",
        headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      },
    ),
  );
}

/** PUT 草稿答案（带 baseRevision/mutationId） */
function putAnswerVersioned(
  app: App,
  cookie: string,
  attemptId: string,
  questionId: string,
  answer: unknown,
  baseRevision: number,
  mutationId: string,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/api/student/attempts/${attemptId}/answers/${encodeURIComponent(questionId)}`,
      {
        method: "PUT",
        headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ answer, baseRevision, mutationId }),
      },
    ),
  );
}

/** PUT 手写笔迹（multipart：gzip 矢量 + PNG 快照） */
function putInk(
  app: App,
  cookie: string,
  attemptId: string,
  questionId: string,
  doc: InkDoc,
): Promise<Response> {
  const form = new FormData();
  form.append(
    "strokes",
    new Blob([gzipDoc(doc)], { type: "application/gzip" }),
    "strokes.json.gz",
  );
  form.append(
    "snapshot",
    new Blob([MINIMAL_PNG], { type: "image/png" }),
    "snapshot.png",
  );
  return Promise.resolve(
    app.request(
      `/api/student/attempts/${attemptId}/ink/${encodeURIComponent(questionId)}`,
      { method: "PUT", headers: { cookie }, body: form },
    ),
  );
}

/** GET 草稿视图（重进模拟） */
async function getDraft(
  app: App,
  cookie: string,
  attemptId: string,
): Promise<AttemptDraftData> {
  const res = await app.request(`/api/student/attempts/${attemptId}`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: AttemptDraftData };
  return body.data;
}

describe("QM-09 细项3：response 保存只校验结构/范围，不比较参考答案", () => {
  it("长文往返不截断：title+多段正文保存后重进读回一致；字数建议随草稿下发且仅提示", async () => {
    const { app, aCookie, attemptId } = await makeResponseApp();
    const body = [
      "第一段：城市更新不是选择题，而是如何兼顾的问答题。",
      "",
      "第二段：保留历史记忆与改善居住条件并非对立……",
      "长".repeat(3000),
    ].join("\n");
    const answer = { kind: "response", title: "留住记忆，改善生活", body };
    const saved = await putAnswer(app, aCookie, attemptId, Q.composed, answer);
    expect(saved.status).toBe(200);
    assertNoLeak(await saved.json());

    const draft = await getDraft(app, aCookie, attemptId);
    // 重进读回完整长文（不截断）
    expect(draft.drafts[Q.composed]).toEqual(answer);
    expect((draft.drafts[Q.composed] as { body: string }).body.length).toBe(
      body.length,
    );
    expect(draft.draftRevisions?.[Q.composed]).toBe(1);
    // 字数建议随公开投影下发（word-min/max）；防泄露矩阵整卷把关
    const question = draft.units
      .flatMap((unit) => unit.questions)
      .find((item) => item.id === Q.composed);
    expect(question).toMatchObject({ wordMin: 200, wordMax: 800 });
    assertNoLeak(draft);
  });

  it("低于 word-min 或超 word-max 的正文本体均可保存（建议不硬校验）；契约防御上限外整体拒绝", async () => {
    const { app, aCookie, attemptId } = await makeResponseApp();
    // 10 字 << word-min=200：仅提示，不硬校验
    const short = await putAnswer(app, aCookie, attemptId, Q.composed, {
      kind: "response",
      body: "太短但合法。",
    });
    expect(short.status).toBe(200);
    // 1000 字 > word-max=800：同上
    const over = await putAnswer(app, aCookie, attemptId, Q.composed, {
      kind: "response",
      body: "超".repeat(1000),
    });
    expect(over.status).toBe(200);
    // 契约防御性上限（与 word 建议正交）：超限拒绝不截断
    const tooLong = await putAnswer(app, aCookie, attemptId, Q.composed, {
      kind: "response",
      body: "字".repeat(RESPONSE_BODY_MAX_CHARS + 1),
    });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
    const badTitle = await putAnswer(app, aCookie, attemptId, Q.composed, {
      kind: "response",
      title: "题".repeat(RESPONSE_TITLE_MAX_CHARS + 1),
      body: "正文",
    });
    expect(badTitle.status).toBe(400);
    // body 缺失（必填结构）拒绝
    const noBody = await putAnswer(app, aCookie, attemptId, Q.composed, {
      kind: "response",
    });
    expect(noBody.status).toBe(400);
  });

  it("不比较参考答案：与范文完全不同的正文照样保存；body 空串（仅手写）合法", async () => {
    const { app, aCookie, attemptId } = await makeResponseApp();
    const differing = await putAnswer(app, aCookie, attemptId, Q.composed, {
      kind: "response",
      body: "我的观点与参考范文毫无关系，服务端不比较参考答案。",
    });
    expect(differing.status).toBe(200);
    // 空串 = 未写正文（仅手写作答），结构合法
    const emptyBody = await putAnswer(app, aCookie, attemptId, Q.free, {
      kind: "response",
      body: "",
    });
    expect(emptyBody.status).toBe(200);
    const draft = await getDraft(app, aCookie, attemptId);
    expect(draft.drafts[Q.free]).toEqual({ kind: "response", body: "" });
  });
});

describe("QM-09 细项4：可靠保存与恢复（既有逐题版本协议沿用）", () => {
  it("同 mutationId 同内容重试同回执；异内容 409 冲突体只含本人稿；旧客户端无版本覆盖拒绝", async () => {
    const { app, aCookie, attemptId } = await makeResponseApp();
    const answer = {
      kind: "response",
      title: "跨设备初稿",
      body: "第一设备写下的正文。",
    };
    const idA = "11111111-1111-4111-8111-111111111111";
    const idB = "22222222-2222-4222-8222-222222222222";
    const first = await putAnswerVersioned(
      app,
      aCookie,
      attemptId,
      Q.composed,
      answer,
      0,
      idA,
    );
    expect(first.status).toBe(200);
    expect(
      (
        (await first.json()) as {
          data: { revision: number; changeCount: number };
        }
      ).data,
    ).toMatchObject({ revision: 1, changeCount: 1 });

    // 回执丢失后重试：同 mutationId 同内容 → 同回执不重复计数
    const retry = await putAnswerVersioned(
      app,
      aCookie,
      attemptId,
      Q.composed,
      answer,
      0,
      idA,
    );
    expect(retry.status).toBe(200);
    expect(
      (
        (await retry.json()) as {
          data: { revision: number; changeCount: number };
        }
      ).data,
    ).toMatchObject({ revision: 1, changeCount: 1 });

    // 同 mutationId 异内容（载荷被篡改/拼装错误）→ 409，不静默改写
    const tampered = await putAnswerVersioned(
      app,
      aCookie,
      attemptId,
      Q.composed,
      { ...answer, body: "被篡改的正文。" },
      0,
      idA,
    );
    expect(tampered.status).toBe(409);

    // 另一设备陈旧 baseRevision → 409，冲突体只含本人云端稿（无参考答案）
    const stale = await putAnswerVersioned(
      app,
      aCookie,
      attemptId,
      Q.composed,
      { kind: "response", body: "第二设备的陈旧写入。" },
      0,
      idB,
    );
    expect(stale.status).toBe(409);
    const conflict = await stale.json();
    expect(conflict).toMatchObject({
      error: "ANSWER_REVISION_CONFLICT",
      _current: { revision: 1, draft: answer },
    });
    assertNoLeak(conflict);

    // 版本协议接管后，旧客户端（无版本字段）盲写 → 409 拒绝
    const legacy = await putAnswer(app, aCookie, attemptId, Q.composed, {
      kind: "response",
      body: "旧客户端盲写。",
    });
    expect(legacy.status).toBe(409);

    // 恢复面：冲突后重进读回云端版本与版本号
    const draft = await getDraft(app, aCookie, attemptId);
    expect(draft.drafts[Q.composed]).toEqual(answer);
    expect(draft.draftRevisions?.[Q.composed]).toBe(1);
  });

  it("重进恢复：云端长文读回后继续编辑走新 baseRevision，语义与首存一致", async () => {
    const { app, aCookie, attemptId } = await makeResponseApp();
    const firstBody = "初稿正文，包含多个段落。\n\n第二段。";
    const idA = "33333333-3333-4333-8333-333333333333";
    const idB = "44444444-4444-4444-8444-444444444444";
    expect(
      (
        await putAnswerVersioned(
          app,
          aCookie,
          attemptId,
          Q.free,
          { kind: "response", body: firstBody },
          0,
          idA,
        )
      ).status,
    ).toBe(200);
    // 重进（新 GET）取回 baseRevision=1 后续写
    const draft = await getDraft(app, aCookie, attemptId);
    expect(draft.draftRevisions?.[Q.free]).toBe(1);
    const continued = await putAnswerVersioned(
      app,
      aCookie,
      attemptId,
      Q.free,
      { kind: "response", body: `${firstBody}\n\n续写第三段。` },
      1,
      idB,
    );
    expect(continued.status).toBe(200);
    expect(
      ((await continued.json()) as { data: { revision: number } }).data
        .revision,
    ).toBe(2);
    const reread = await getDraft(app, aCookie, attemptId);
    expect(reread.drafts[Q.free]).toEqual({
      kind: "response",
      body: `${firstBody}\n\n续写第三段。`,
    });
  });
});

describe("QM-09 细项6 验收行：长文字/仅手写/混合三形态均能提交并回看", () => {
  it("长文字形态：提交后结果视图完整回看正文，公布后对照参考范文，不自动判对错", async () => {
    const { app, aCookie, attemptId } = await makeResponseApp();
    const answer = {
      kind: "response",
      title: "留住记忆，改善生活",
      body: "城市更新应当在保留与改善之间寻找平衡……".repeat(3),
    };
    expect(
      (await putAnswer(app, aCookie, attemptId, Q.composed, answer)).status,
    ).toBe(200);
    // 第二题不答也可交卷（未答题进卷是常态）
    expect(
      (
        await putAnswer(app, aCookie, attemptId, Q.free, {
          kind: "response",
          body: "只写一句话也合法。",
        })
      ).status,
    ).toBe(200);

    const submit = await submitAttemptRequest(app, aCookie, attemptId);
    expect(submit.status).toBe(200);

    const res = await app.request(`/api/student/attempts/${attemptId}`, {
      headers: { cookie: aCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { attempt: { status: string }; units: { questions: unknown[] }[] };
    };
    expect(body.data.attempt.status).toBe("submitted");
    const questions = body.data.units.flatMap((unit) => unit.questions) as {
      questionId: string;
      answer: unknown;
      answers: unknown;
      autoCorrect: unknown;
      finalCorrect: unknown;
    }[];
    const composed = questions.find((item) => item.questionId === Q.composed);
    // 本人长文完整回看（不截断、不重写）
    expect(composed?.answer).toEqual(answer);
    // 公布后（assignment 默认 on_submit）参考范文可对照；不自动判对错
    expect(composed?.autoCorrect).toBeNull();
    expect(composed?.finalCorrect).toBeNull();
    expect(composed?.answers).toMatchObject({
      kind: "response",
      referenceMd: expect.stringContaining("参考范文哨兵"),
    });
    assertNoLeak(body, { allow: ["answers", "answer", "solutionMd"] });
  });

  it("仅手写形态：不存正文只传笔迹，提交后矢量与 PNG 均可回看", async () => {
    const { app, aCookie, attemptId } = await makeResponseApp();
    const doc = atramentDoc();
    const ink = await putInk(app, aCookie, attemptId, Q.composed, doc);
    expect(ink.status).toBe(200);

    const submit = await submitAttemptRequest(app, aCookie, attemptId);
    expect(submit.status).toBe(200);

    // 结果视图：answer 为 null（未写正文）但笔迹证据可回看
    const res = await app.request(`/api/student/attempts/${attemptId}`, {
      headers: { cookie: aCookie },
    });
    const body = (await res.json()) as {
      data: { units: { questions: unknown[] }[] };
    };
    const questions = body.data.units.flatMap((unit) => unit.questions) as {
      questionId: string;
      answer: unknown;
      autoCorrect: unknown;
    }[];
    const composed = questions.find((item) => item.questionId === Q.composed);
    expect(composed?.answer).toBeNull();
    expect(composed?.autoCorrect).toBeNull();
    assertNoLeak(body, { allow: ["answers", "answer", "solutionMd"] });

    // 矢量文档回读（重进/回看管线取回同一笔迹；serverRevision 为回读基线语义）
    const docRes = await app.request(
      `/api/student/attempts/${attemptId}/ink/${encodeURIComponent(Q.composed)}`,
      { headers: { cookie: aCookie } },
    );
    expect(docRes.status).toBe(200);
    expect(((await docRes.json()) as { data: InkDoc }).data).toEqual({
      ...doc,
      serverRevision: 1,
    });
    // PNG 直出（结果页缩略图同源）
    const pngRes = await app.request(
      `/api/student/attempts/${attemptId}/ink/${encodeURIComponent(Q.composed)}.png`,
      { headers: { cookie: aCookie } },
    );
    expect(pngRes.status).toBe(200);
  });

  it("混合形态：正文与手写并存，提交后两者同时回看", async () => {
    const { app, aCookie, attemptId } = await makeResponseApp();
    const answer = {
      kind: "response",
      title: "文字加手写",
      body: "正文论证先写在这里，补充演算见手写。",
    };
    expect(
      (await putAnswer(app, aCookie, attemptId, Q.composed, answer)).status,
    ).toBe(200);
    const doc = atramentDoc();
    expect(
      (await putInk(app, aCookie, attemptId, Q.composed, doc)).status,
    ).toBe(200);
    // 第二题同形态（无参考答案的开放题也支持并存）
    expect(
      (
        await putAnswer(app, aCookie, attemptId, Q.free, {
          kind: "response",
          body: "第二题也写一点。",
        })
      ).status,
    ).toBe(200);
    expect((await putInk(app, aCookie, attemptId, Q.free, doc)).status).toBe(
      200,
    );

    const submit = await submitAttemptRequest(app, aCookie, attemptId);
    expect(submit.status).toBe(200);

    const res = await app.request(`/api/student/attempts/${attemptId}`, {
      headers: { cookie: aCookie },
    });
    const body = (await res.json()) as {
      data: { units: { questions: unknown[] }[] };
    };
    const questions = body.data.units.flatMap((unit) => unit.questions) as {
      questionId: string;
      answer: unknown;
    }[];
    expect(
      questions.find((item) => item.questionId === Q.composed)?.answer,
    ).toEqual(answer);
    for (const questionId of [Q.composed, Q.free]) {
      const docRes = await app.request(
        `/api/student/attempts/${attemptId}/ink/${encodeURIComponent(questionId)}`,
        { headers: { cookie: aCookie } },
      );
      expect(docRes.status).toBe(200);
    }
    assertNoLeak(body, { allow: ["answers", "answer", "solutionMd"] });
  });
});

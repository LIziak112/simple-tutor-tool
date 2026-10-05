import { readFileSync } from "node:fs";
import {
  type AttemptDraftData,
  type AttemptResultData,
  learningEventBatchDataSchema,
} from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { attempts, events, responses } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { fetchSubmitRevisions } from "../test/submit-revisions";

/**
 * 学习痕迹事件接口集成测试（T2.10，app.request() 直调 + 内存库）：
 * - 批量边界：200 条成功 / 201 条 400 / 空数组 400 / 非法 type 400；
 * - 权限：非本人 attempt 403、未登录 401、attempt 不存在 404、教师会话 401；
 * - 宽松口径：已交卷后仍接收事件（交卷瞬间 flush 可能晚到）；
 * - 讲义端点：lecture_expand 落库 attemptId/questionId=NULL、讲义不存在 404；
 * - 落库形态：type/payloadJson/clientTs/serverTs、payload 只含元信息；
 * - 泄露（AGENTS 第 3 条）：成功与错误响应均 assertNoLeak；
 * - 交卷联动（验收核心）：事件序列 → submit → responses.activeSec/changeCount
 *   与 attempts.activeSec 落库正确；无事件 attempt 保持 activeSec=NULL 且
 *   changeCount 保留草稿 PUT 计数；changeCount=max(草稿, 事件) 口径。
 * 夹具用 samples/v2/练习样例.md（八题）与 讲义样例.md。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

const PRACTICE_MD = readFileSync(
  new URL("../../../../samples/v2/练习样例.md", import.meta.url),
  "utf8",
);
const LECTURE_MD = readFileSync(
  new URL("../../../../samples/v2/讲义样例.md", import.meta.url),
  "utf8",
);

/** 样例题目 id（与 student-attempts.test 一致） */
const Q = {
  judge: "练习四-1",
  choice: "练习四-2",
  fill: "练习四-4",
} as const;

type App = ReturnType<typeof createApp>;

/** 全套前置：教师 + 导入练习与讲义 + 张三（被指派）/李四 + 一份作业 */
async function makeEventsApp(): Promise<{
  app: App;
  db: Db;
  aCookie: string;
  aStudentId: string;
  bCookie: string;
  assignmentId: string;
  lectureId: string;
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
  if (!unitId) throw new Error("练习样例导入未产出单元");

  const lectureRes = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ markdown: LECTURE_MD, filename: "讲义样例.md" }),
  });
  expect(lectureRes.status).toBe(200);
  const lectureImported = (await lectureRes.json()) as {
    data: { lectures: { id: string }[] };
  };
  const lectureId = lectureImported.data.lectures[0]?.id;
  if (!lectureId) throw new Error("讲义样例导入未产出讲义");

  const aId = await createStudent(app, teacherCookie, "张三");
  await createStudent(app, teacherCookie, "李四");
  const assignmentId = await createAssignment(app, teacherCookie, unitId, aId);
  return {
    app,
    db,
    aCookie: await loginStudent(app, "张三"),
    aStudentId: aId,
    bCookie: await loginStudent(app, "李四"),
    assignmentId,
    lectureId,
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
  const body = (await res.json()) as { data: { student: { id: string } } };
  return body.data.student.id;
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
  const body = (await res.json()) as {
    data: { assignments: { id: string }[] };
  };
  const id = body.data.assignments[0]?.id;
  if (id === undefined) throw new Error("布置作业响应缺少作业 id");
  return id;
}

/** POST /attempt 取 attempt id */
async function startAttempt(
  app: App,
  cookie: string,
  assignmentId: string,
): Promise<string> {
  const res = await app.request(
    `/api/student/assignments/${assignmentId}/attempt`,
    { method: "POST", headers: { cookie } },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { id: string } };
  return body.data.id;
}

/** POST 事件批量 */
function postEvents(
  app: App,
  cookie: string | undefined,
  attemptId: string,
  events: unknown[],
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/student/attempts/${attemptId}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify({ events }),
    }),
  );
}

/** POST 讲义事件批量 */
function postLectureEvents(
  app: App,
  cookie: string | undefined,
  events: unknown[],
): Promise<Response> {
  return Promise.resolve(
    app.request("/api/student/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify({ events }),
    }),
  );
}

/** 便捷事件构造（秒偏移基于 base） */
const BASE_TS = 1_769_000_000_000;
function ev(
  type: string,
  atSec: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type, clientTs: BASE_TS + atSec * 1000, ...extra };
}

describe("POST /api/student/attempts/:id/events：批量上报", () => {
  it("正常批量：accepted 计数、events 表逐行落库（元信息形态）", async () => {
    const { app, db, aCookie, assignmentId } = await makeEventsApp();
    const attemptId = await startAttempt(app, aCookie, assignmentId);
    const batch = [
      ev("attempt_start", 0),
      ev("question_view", 1, { questionId: Q.judge }),
      ev("question_focus", 1, { questionId: Q.judge }),
      ev("answer_change", 3, {
        questionId: Q.judge,
        to: { kind: "judge", value: true },
      }),
      ev("ink_stroke_batch", 5, { questionId: Q.judge, strokes: 2 }),
      ev("page_hidden", 6),
      ev("page_visible", 66),
      ev("question_blur", 70, { questionId: Q.judge }),
    ];
    const res = await postEvents(app, aCookie, attemptId, batch);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: unknown };
    expect(body.ok).toBe(true);
    expect(learningEventBatchDataSchema.safeParse(body.data).success).toBe(
      true,
    );
    expect(body.data).toEqual({ accepted: 8 });

    const rows = db.select().from(events).orderBy(events.clientTs).all();
    expect(rows.length).toBe(8);
    expect(rows.every((row) => row.attemptId === attemptId)).toBe(true);
    expect(rows.every((row) => row.serverTs.length > 0)).toBe(true);
    // 带题目语义的事件 questionId 落列；page_*/attempt_start 为 NULL
    const focusRow = rows.find((row) => row.type === "question_focus");
    expect(focusRow?.questionId).toBe(Q.judge);
    const hiddenRow = rows.find((row) => row.type === "page_hidden");
    expect(hiddenRow?.questionId).toBeNull();
    // payloadJson 只含元信息（answer_change 的 to 是学生自己的答案值，不含 answer 键）
    const changeRow = rows.find((row) => row.type === "answer_change");
    const payload = JSON.parse(changeRow?.payloadJson ?? "{}") as Record<
      string,
      unknown
    >;
    expect(payload.questionId).toBe(Q.judge);
    expect(payload.to).toEqual({ kind: "judge", value: true });
    // clientTs 毫秒整数原样落库
    expect(focusRow?.clientTs).toBe(BASE_TS + 1000);
  });

  it("边界：200 条成功、201 条 400、空数组 400", async () => {
    const { app, aCookie, assignmentId } = await makeEventsApp();
    const attemptId = await startAttempt(app, aCookie, assignmentId);
    const twoHundred = Array.from({ length: 200 }, (_, i) =>
      ev("question_view", i, { questionId: Q.judge }),
    );
    const okRes = await postEvents(app, aCookie, attemptId, twoHundred);
    expect(okRes.status).toBe(200);
    const overRes = await postEvents(app, aCookie, attemptId, [
      ...twoHundred,
      ev("submit", 999),
    ]);
    expect(overRes.status).toBe(400);
    const overBody = (await overRes.json()) as {
      ok: boolean;
      error: string;
      message: string;
    };
    expect(overBody.ok).toBe(false);
    expect(overBody.error).toBe("VALIDATION_ERROR");
    const emptyRes = await postEvents(app, aCookie, attemptId, []);
    expect(emptyRes.status).toBe(400);
  });

  it("非法 type / 缺字段 → 400 VALIDATION_ERROR（错误信息无题目侧内容）", async () => {
    const { app, aCookie, assignmentId } = await makeEventsApp();
    const attemptId = await startAttempt(app, aCookie, assignmentId);
    for (const bad of [
      [ev("hacked_type", 0)],
      [{ type: "question_focus", clientTs: BASE_TS }], // 缺 questionId
      [{ type: "page_hidden" }], // 缺 clientTs
      [{ events: "not-array" }], // 请求体形状错误 → schema message
    ] as unknown[][]) {
      const res = await postEvents(app, aCookie, attemptId, bad);
      expect(res.status).toBe(400);
      const body = await res.json();
      assertNoLeak(body);
    }
  });

  it("权限：非本人 403、未登录 401、attempt 不存在 404", async () => {
    const { app, aCookie, bCookie, assignmentId } = await makeEventsApp();
    const attemptId = await startAttempt(app, aCookie, assignmentId);
    const batch = [ev("attempt_start", 0)];

    const bRes = await postEvents(app, bCookie, attemptId, batch);
    expect(bRes.status).toBe(403);
    assertNoLeak(await bRes.json());

    const anonRes = await postEvents(app, undefined, attemptId, batch);
    expect(anonRes.status).toBe(401);

    const notFound = await postEvents(
      app,
      aCookie,
      "00000000-0000-4000-8000-000000000000",
      batch,
    );
    expect(notFound.status).toBe(404);
  });

  it("宽松口径：交卷后仍接收事件（迟到的 flush 不丢）", async () => {
    const { app, aCookie, assignmentId } = await makeEventsApp();
    const attemptId = await startAttempt(app, aCookie, assignmentId);
    await postEvents(app, aCookie, attemptId, [
      ev("question_focus", 0, { questionId: Q.judge }),
      ev("submit", 10),
    ]);
    const submitRes = await app.request(
      `/api/student/attempts/${attemptId}/submit`,
      {
        method: "POST",
        headers: { cookie: aCookie },
        body: JSON.stringify({
          revisions: await fetchSubmitRevisions(app, aCookie, attemptId),
        }),
      },
    );
    expect(submitRes.status).toBe(200);
    // 交卷后迟到事件：仍 200 落库（不影响已计算的 activeSec）
    const late = await postEvents(app, aCookie, attemptId, [
      ev("question_blur", 99, { questionId: Q.judge }),
    ]);
    expect(late.status).toBe(200);
    expect(
      ((await late.json()) as { data: { accepted: number } }).data,
    ).toEqual({ accepted: 1 });
  });

  it("泄露（AGENTS 第 3 条）：成功响应只回 accepted，无题目侧内容", async () => {
    const { app, aCookie, assignmentId } = await makeEventsApp();
    const attemptId = await startAttempt(app, aCookie, assignmentId);
    const res = await postEvents(app, aCookie, attemptId, [
      ev("answer_change", 1, {
        questionId: Q.fill,
        from: { kind: "fill", values: ["4"] },
        to: { kind: "fill", values: ["5"] },
      }),
    ]);
    expect(res.status).toBe(200);
    assertNoLeak(await res.json());
  });
});

describe("POST /api/student/events：讲义展开事件", () => {
  it("lecture_expand 落库：attemptId/questionId 均 NULL，归属在 payload", async () => {
    const { app, db, aCookie, lectureId } = await makeEventsApp();
    const res = await postLectureEvents(app, aCookie, [
      ev("lecture_expand", 0, {
        lectureId,
        directive: "solution",
        index: 1,
      }),
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { accepted: number } };
    expect(body.data).toEqual({ accepted: 1 });
    assertNoLeak(body);

    const rows = db.select().from(events).all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.attemptId).toBeNull();
    expect(rows[0]?.questionId).toBeNull();
    expect(rows[0]?.type).toBe("lecture_expand");
    expect(JSON.parse(rows[0]?.payloadJson ?? "{}")).toEqual({
      type: "lecture_expand",
      clientTs: BASE_TS,
      lectureId,
      directive: "solution",
      index: 1,
    });
  });

  it("讲义不存在 404；attempt 事件类型发到本端点 400", async () => {
    const { app, aCookie } = await makeEventsApp();
    const notFound = await postLectureEvents(app, aCookie, [
      ev("lecture_expand", 0, {
        lectureId: "no-such-lecture",
        directive: "solution",
        index: 0,
      }),
    ]);
    expect(notFound.status).toBe(404);

    const wrongType = await postLectureEvents(app, aCookie, [ev("submit", 0)]);
    expect(wrongType.status).toBe(400);
  });

  it("未登录 401", async () => {
    const { app } = await makeEventsApp();
    const res = await postLectureEvents(app, undefined, [
      ev("lecture_expand", 0, {
        lectureId: "any",
        directive: "solution",
        index: 0,
      }),
    ]);
    expect(res.status).toBe(401);
  });
});

describe("交卷联动：事件序列 → responses.activeSec/changeCount 落库（验收核心）", () => {
  it("构造完整事件序列 → submit → 每题 activeSec/changeCount 与总用时正确", async () => {
    const { app, db, aCookie, assignmentId } = await makeEventsApp();
    const attemptId = await startAttempt(app, aCookie, assignmentId);
    // 序列：q1 聚焦 45s（含一次 hidden 5s 不计时）→ q2 聚焦 30s → 交卷；
    // q1 改答案 2 次、q2 改 1 次
    await postEvents(app, aCookie, attemptId, [
      ev("attempt_start", 0),
      ev("question_view", 0, { questionId: Q.judge }),
      ev("question_focus", 0, { questionId: Q.judge }),
      ev("answer_change", 10, {
        questionId: Q.judge,
        to: { kind: "judge", value: true },
      }),
      ev("page_hidden", 20),
      ev("page_visible", 25),
      ev("answer_change", 40, {
        questionId: Q.judge,
        from: { kind: "judge", value: true },
        to: { kind: "judge", value: false },
      }),
      ev("question_focus", 45, { questionId: Q.choice }), // q1 隐式 blur：45-5=40s
      ev("answer_change", 50, {
        questionId: Q.choice,
        to: { kind: "choice", index: 1 },
      }),
      ev("submit", 75), // q2：45→75 共 30s
    ]);
    const submitRes = await app.request(
      `/api/student/attempts/${attemptId}/submit`,
      {
        method: "POST",
        headers: { cookie: aCookie },
        body: JSON.stringify({
          revisions: await fetchSubmitRevisions(app, aCookie, attemptId),
        }),
      },
    );
    expect(submitRes.status).toBe(200);
    const result = (await submitRes.json()) as {
      data: AttemptResultData;
    };
    expect(result.data.attempt.status).toBe("submitted");

    const rows = db.select().from(responses).all();
    const byQuestion = new Map(rows.map((row) => [row.questionId, row]));
    // q1：focus@0 → focus q2@45，其中 hidden@20→visible@25 的 5s 不计 = 40s
    expect(byQuestion.get(Q.judge)?.activeSec).toBe(40);
    expect(byQuestion.get(Q.judge)?.changeCount).toBe(2);
    // q2：focus@45 → submit@75 = 30s
    expect(byQuestion.get(Q.choice)?.activeSec).toBe(30);
    expect(byQuestion.get(Q.choice)?.changeCount).toBe(1);
    // 未聚焦的题 activeSec 为 NULL
    expect(byQuestion.get(Q.fill)?.activeSec).toBeNull();
    // attempts 总用时 = 40 + 30
    const all = db.select().from(attempts).all();
    expect(all[0]?.activeSec).toBe(70);
  });

  it("changeCount 口径 = max(草稿 PUT 计数, 事件计数)；无事件 attempt 的 activeSec 保持 NULL", async () => {
    const { app, db, aCookie, assignmentId } = await makeEventsApp();
    const attemptId = await startAttempt(app, aCookie, assignmentId);
    // 草稿 PUT 2 次（changeCount=2），事件只报 1 条 → max=2
    for (const answer of [
      { kind: "judge" as const, value: true },
      { kind: "judge" as const, value: false },
    ]) {
      const res = await app.request(
        `/api/student/attempts/${attemptId}/answers/${Q.judge}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json", cookie: aCookie },
          body: JSON.stringify({ answer }),
        },
      );
      expect(res.status).toBe(200);
    }
    // 事件 3 条（> 草稿 2）→ max=3
    await postEvents(app, aCookie, attemptId, [
      ev("answer_change", 1, { questionId: Q.fill }),
      ev("answer_change", 2, { questionId: Q.fill }),
      ev("answer_change", 3, { questionId: Q.fill }),
    ]);
    // Q.choice：只有草稿 1 次、无事件 → max=1
    await app.request(
      `/api/student/attempts/${attemptId}/answers/${Q.choice}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: aCookie },
        body: JSON.stringify({ answer: { kind: "choice", index: 0 } }),
      },
    );
    const submitRes = await app.request(
      `/api/student/attempts/${attemptId}/submit`,
      {
        method: "POST",
        headers: { cookie: aCookie },
        body: JSON.stringify({
          revisions: await fetchSubmitRevisions(app, aCookie, attemptId),
        }),
      },
    );
    expect(submitRes.status).toBe(200);
    const rows = db.select().from(responses).all();
    const byQuestion = new Map(rows.map((row) => [row.questionId, row]));
    expect(byQuestion.get(Q.judge)?.changeCount).toBe(2);
    expect(byQuestion.get(Q.fill)?.changeCount).toBe(3);
    expect(byQuestion.get(Q.choice)?.changeCount).toBe(1);
    // 无 focus 事件：所有题 activeSec=NULL，attempt 总用时 NULL
    expect(byQuestion.get(Q.judge)?.activeSec).toBeNull();
    const all = db.select().from(attempts).all();
    expect(all[0]?.activeSec).toBeNull();
  });

  it("纯事件驱动（无草稿 PUT）：activeSec/changeCount 全部来自事件", async () => {
    const { app, db, aCookie, assignmentId } = await makeEventsApp();
    const attemptId = await startAttempt(app, aCookie, assignmentId);
    await postEvents(app, aCookie, attemptId, [
      ev("question_focus", 0, { questionId: Q.fill }),
      ev("answer_change", 3, { questionId: Q.fill }),
      ev("submit", 8),
    ]);
    const submitRes = await app.request(
      `/api/student/attempts/${attemptId}/submit`,
      {
        method: "POST",
        headers: { cookie: aCookie },
        body: JSON.stringify({
          revisions: await fetchSubmitRevisions(app, aCookie, attemptId),
        }),
      },
    );
    expect(submitRes.status).toBe(200);
    const draft = (await app.request(`/api/student/attempts/${attemptId}`, {
      headers: { cookie: aCookie },
    })) as Response;
    const detail = (await draft.json()) as { data: AttemptDraftData };
    expect(detail.data.attempt.status).toBe("submitted");
    const rows = db.select().from(responses).all();
    const fill = rows.find((row) => row.questionId === Q.fill);
    expect(fill?.activeSec).toBe(8);
    expect(fill?.changeCount).toBe(1);
  });
});

// ---------- T4.0a：新事件落库带归属列（D8）+ 端点扩容 ----------

describe("T4.0a attempt 端点：交互族/ink/环境族新事件 + studentId 会话写入", () => {
  it("新事件落库带 studentId（会话写入，前端伪造无效）；payload 不含伪造键", async () => {
    const { app, db, aCookie, aStudentId, assignmentId } =
      await makeEventsApp();
    const attemptId = await startAttempt(app, aCookie, assignmentId);
    const batch = [
      ev("directive_interact", 1, {
        host: "question",
        questionId: Q.choice,
        name: "hint",
        index: 0,
        action: "open",
        studentId: "forged-student", // 伪造：契约层不收，应被 Zod 剥离
      }),
      ev("directive_interact", 2, {
        host: "result",
        attemptId,
        questionId: Q.choice,
        name: "solution",
        index: 1,
        action: "close",
      }),
      ev("ink_edit_batch", 3, {
        questionId: Q.judge,
        erase: 1,
        undo: 2,
        redo: 0,
        clear: 0,
      }),
      ev("ink_fullscreen", 4, { questionId: Q.judge, on: true }),
      ev("net_offline", 5),
      ev("net_online", 6),
      ev("idle_start", 90),
      ev("idle_end", 100),
    ];
    const res = await postEvents(app, aCookie, attemptId, batch);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { accepted: number } };
    expect(body.data).toEqual({ accepted: 8 });
    assertNoLeak(body);

    const rows = db.select().from(events).all();
    expect(rows.length).toBe(8);
    // 归属列：全部行 studentId=会话学生（伪造无效）；attempt 域无讲义语义 → NULL
    expect(rows.every((row) => row.studentId === aStudentId)).toBe(true);
    expect(rows.every((row) => row.lectureId === null)).toBe(true);
    // 题目语义列照旧提取
    expect(rows.find((row) => row.type === "ink_edit_batch")?.questionId).toBe(
      Q.judge,
    );
    expect(
      rows.find((row) => row.type === "net_offline")?.questionId,
    ).toBeNull();
    // 伪造 studentId 不进 payloadJson（Zod 剥离多余键）
    const forgedRow = rows.find((row) => row.type === "directive_interact");
    expect(JSON.parse(forgedRow?.payloadJson ?? "{}")).toEqual({
      type: "directive_interact",
      clientTs: BASE_TS + 1000,
      host: "question",
      questionId: Q.choice,
      name: "hint",
      index: 0,
      action: "open",
    });
  });

  it("讲义域事件发到 attempt 端点 → 400（端点互斥由契约锁定）", async () => {
    const { app, aCookie, assignmentId } = await makeEventsApp();
    const attemptId = await startAttempt(app, aCookie, assignmentId);
    for (const bad of [
      ev("lecture_visible", 0, { lectureId: "l-1", viewId: "v-1" }),
      ev("lecture_hidden", 0, { lectureId: "l-1", viewId: "v-1" }),
      ev("lecture_section_focus", 0, { lectureId: "l-1", headingIndex: 0 }),
      ev("lecture_toc_jump", 0, { lectureId: "l-1", headingIndex: 1 }),
      ev("directive_interact", 0, {
        host: "lecture",
        lectureId: "l-1",
        name: "solution",
        index: 1,
        action: "open",
      }),
    ]) {
      const res = await postEvents(app, aCookie, attemptId, [bad]);
      expect(res.status, `讲义域事件 ${bad.type} 不应被 attempt 端点接收`).toBe(
        400,
      );
      assertNoLeak(await res.json());
    }
  });

  it("hint_open 服务端直记（POST hints）也带 studentId（§5.0-B7）", async () => {
    const { app, db, aCookie, aStudentId, assignmentId } =
      await makeEventsApp();
    const attemptId = await startAttempt(app, aCookie, assignmentId);
    // 练习四-2 有 1 条提示（与 student-hints.test 同口径）
    const res = await app.request(`/api/student/attempts/${attemptId}/hints`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: aCookie },
      body: JSON.stringify({ questionId: Q.choice, index: 0 }),
    });
    expect(res.status).toBe(200);
    const hintRow = db
      .select()
      .from(events)
      .all()
      .find((row) => row.type === "hint_open");
    expect(hintRow?.studentId).toBe(aStudentId);
    expect(hintRow?.attemptId).toBe(attemptId);
    expect(hintRow?.questionId).toBe(Q.choice);
  });
});

describe("T4.0a 讲义端点：环境/位置/交互族扩容 + 归属列", () => {
  it("讲义域新事件落库：studentId 会话写入、lectureId 从 payload 提取落列", async () => {
    const { app, db, aCookie, aStudentId, lectureId } = await makeEventsApp();
    const res = await postLectureEvents(app, aCookie, [
      ev("lecture_visible", 0, {
        lectureId,
        viewId: "view-abc",
        studentId: "forged-student",
      }),
      ev("lecture_hidden", 30, { lectureId, viewId: "view-abc" }),
      ev("lecture_section_focus", 5, { lectureId, headingIndex: 0 }),
      ev("lecture_toc_jump", 6, { lectureId, headingIndex: 2 }),
      ev("directive_interact", 7, {
        host: "lecture",
        lectureId,
        name: "solution",
        index: 1,
        action: "open",
      }),
      ev("directive_interact", 8, {
        host: "lecture",
        lectureId,
        name: "steps",
        index: 2,
        action: "reveal",
        step: 1,
      }),
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { accepted: number } };
    expect(body.data).toEqual({ accepted: 6 });
    assertNoLeak(body);

    const rows = db.select().from(events).all();
    expect(rows.length).toBe(6);
    // 归属列：studentId=会话学生（伪造无效）、lectureId=payload 提取
    expect(rows.every((row) => row.studentId === aStudentId)).toBe(true);
    expect(rows.every((row) => row.lectureId === lectureId)).toBe(true);
    expect(rows.every((row) => row.attemptId === null)).toBe(true);
    expect(rows.every((row) => row.questionId === null)).toBe(true);
    // reveal 的 step 保真
    const reveal = rows.find(
      (row) =>
        row.type === "directive_interact" &&
        (JSON.parse(row.payloadJson) as { action?: string }).action ===
          "reveal",
    );
    expect(
      (JSON.parse(reveal?.payloadJson ?? "{}") as { step?: number }).step,
    ).toBe(1);
    // 伪造键剥离
    const visible = rows.find((row) => row.type === "lecture_visible");
    expect(JSON.parse(visible?.payloadJson ?? "{}")).toEqual({
      type: "lecture_visible",
      clientTs: BASE_TS,
      lectureId,
      viewId: "view-abc",
    });
  });

  it("net/idle 无讲义语义：可收、lectureId 落 NULL（不做讲义存在性校验）", async () => {
    const { app, db, aCookie, aStudentId } = await makeEventsApp();
    const res = await postLectureEvents(app, aCookie, [
      ev("net_offline", 0),
      ev("net_online", 10),
      ev("idle_start", 300),
      ev("idle_end", 320),
    ]);
    expect(res.status).toBe(200);
    assertNoLeak(await res.json());
    const rows = db.select().from(events).all();
    expect(rows.map((row) => row.type)).toEqual([
      "net_offline",
      "net_online",
      "idle_start",
      "idle_end",
    ]);
    // studentId 照写（学生归属）；lectureId NULL（无讲义语义，聚合按时间关联）
    expect(rows.every((row) => row.studentId === aStudentId)).toBe(true);
    expect(rows.every((row) => row.lectureId === null)).toBe(true);
  });

  it("新讲义事件讲义不存在 404；attempt 域事件发到讲义端点 400", async () => {
    const { app, aCookie } = await makeEventsApp();
    const notFound = await postLectureEvents(app, aCookie, [
      ev("lecture_visible", 0, {
        lectureId: "no-such-lecture",
        viewId: "v",
      }),
    ]);
    expect(notFound.status).toBe(404);
    assertNoLeak(await notFound.json());

    for (const bad of [
      ev("directive_interact", 0, {
        host: "question",
        questionId: "q",
        name: "hint",
        index: 0,
        action: "open",
      }),
      ev("directive_interact", 0, {
        host: "result",
        attemptId: "att-1",
        questionId: "q",
        name: "solution",
        index: 0,
        action: "open",
      }),
      ev("ink_edit_batch", 0, {
        questionId: "q",
        erase: 0,
        undo: 0,
        redo: 0,
        clear: 0,
      }),
      ev("ink_fullscreen", 0, { questionId: "q", on: false }),
    ]) {
      const res = await postLectureEvents(app, aCookie, [bad]);
      expect(res.status, `attempt 域事件 ${bad.type} 不应被讲义端点接收`).toBe(
        400,
      );
      assertNoLeak(await res.json());
    }
  });

  it("旧客户端回归：lecture_expand 照收（SW 缓存兼容）且同样带归属列", async () => {
    const { app, db, aCookie, aStudentId, lectureId } = await makeEventsApp();
    const res = await postLectureEvents(app, aCookie, [
      ev("lecture_expand", 0, {
        lectureId,
        directive: "fold",
        index: 3,
      }),
    ]);
    expect(res.status).toBe(200);
    const row = db.select().from(events).all()[0];
    expect(row?.type).toBe("lecture_expand");
    expect(row?.studentId).toBe(aStudentId);
    expect(row?.lectureId).toBe(lectureId);
  });
});

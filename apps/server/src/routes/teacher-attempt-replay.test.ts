import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { events } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { fetchSubmitRevisions } from "../test/submit-revisions";

/**
 * hall-15077 做题复现接口测试（GET /api/teacher/attempts/:id/replay）：
 * - 形状：events（客户端事件投影）/ inkPoints / submitPoints / noteVersions 与
 *   联合窗口（有事实非空；无事实 null）；
 * - 404：不存在的 attempt（ATTEMPT_NOT_FOUND，不暴露存在性）；
 * - 业务口径：submitPoints 来自 responses 行（整卷交卷逐行写提交时刻）。
 *
 * 夹具：最小链路——setup 教师 → 导入单题练习 → 学生登录 → 建课/成员/目录 →
 * 开卷 → 学生事件批量上报 → 存答案 → 交卷 → 教师取复现载荷。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

const UNIT = "复现练习单元";
const UNIT_MD = `---
kind: practice
unit: ${UNIT}
topic: 有理数
---

# ${UNIT}

::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$1$ 是正数。[[正确]]
::::
`;

type App = ReturnType<typeof createApp>;

function extractSessionToken(res: Response, cookie = "tutor_session"): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith(`${cookie}=`));
  if (!line) throw new Error(`响应中没有 ${cookie} cookie`);
  return line.slice(`${cookie}=`.length).split(";")[0] ?? "";
}

async function request(
  app: App,
  path: string,
  body: unknown,
  cookie?: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE" = "POST",
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cookie) headers.cookie = cookie;
  return app.request(path, { method, headers, body: JSON.stringify(body) });
}

interface Env {
  app: App;
  db: Db;
  teacherCookie: string;
  studentCookie: string;
  attemptId: string;
  questionId: string;
}

async function makeEnv(): Promise<Env> {
  const db = createTestDb();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    publicUrl: "http://localhost:8787",
    dataDir: createTestDir(),
  });
  const setup = await request(app, "/api/public/teacher/setup", {
    loginName: "teacher",
    password: TEACHER_PASSWORD,
  });
  const teacherCookie = `tutor_session=${extractSessionToken(setup)}`;
  expect(
    (
      await request(
        app,
        "/api/teacher/import/commit",
        { markdown: UNIT_MD, filename: "复现练习.md" },
        teacherCookie,
      )
    ).status,
  ).toBe(200);
  const studentRes = await request(
    app,
    "/api/teacher/students",
    { displayName: "小明", loginName: "小明", password: STUDENT_PASSWORD },
    teacherCookie,
  );
  expect(studentRes.status).toBe(201);
  const studentId = (
    (await studentRes.json()) as { data: { student: { id: string } } }
  ).data.student.id;
  const loginRes = await request(app, "/api/public/student/login", {
    loginName: "小明",
    password: STUDENT_PASSWORD,
  });
  const studentCookie = `tutor_student_session=${extractSessionToken(
    loginRes,
    "tutor_student_session",
  )}`;
  const courseRes = await request(
    app,
    "/api/teacher/courses",
    { title: "复现课程" },
    teacherCookie,
  );
  expect(courseRes.status).toBe(201);
  const courseId = ((await courseRes.json()) as { data: { id: string } }).data
    .id;
  expect(
    (
      await request(
        app,
        `/api/teacher/courses/${courseId}/members`,
        { studentIds: [studentId] },
        teacherCookie,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        app,
        `/api/teacher/courses/${courseId}/items`,
        { items: [{ kind: "unit", refId: UNIT }] },
        teacherCookie,
      )
    ).status,
  ).toBe(201);
  const openRes = await request(
    app,
    `/api/student/courses/${courseId}/units/${UNIT}/attempts`,
    {},
    studentCookie,
  );
  expect(openRes.status).toBe(201);
  const attemptId = ((await openRes.json()) as { data: { id: string } }).data
    .id;
  return {
    app,
    db,
    teacherCookie,
    studentCookie,
    attemptId,
    questionId: `${UNIT}-1`,
  };
}

describe("GET /api/teacher/attempts/:id/replay", () => {
  it("返回四类事实与联合窗口（事件 + 逐题提交）", async () => {
    const { app, teacherCookie, studentCookie, attemptId, questionId } =
      await makeEnv();
    const now = Date.now();
    expect(
      (
        await request(
          app,
          `/api/student/attempts/${attemptId}/events`,
          {
            events: [
              {
                type: "question_focus",
                clientTs: now,
                questionId,
              },
              {
                type: "answer_change",
                clientTs: now + 1,
                questionId,
                to: { kind: "judge", value: false },
              },
              { type: "page_hidden", clientTs: now + 2 },
            ],
          },
          studentCookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          app,
          `/api/student/attempts/${attemptId}/answers/${questionId}`,
          { answer: { kind: "judge", value: true } },
          studentCookie,
          "PUT",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          app,
          `/api/student/attempts/${attemptId}/submit`,
          {
            revisions: await fetchSubmitRevisions(
              app,
              studentCookie,
              attemptId,
            ),
          },
          studentCookie,
        )
      ).status,
    ).toBe(200);

    const res = await app.request(`/api/teacher/attempts/${attemptId}/replay`, {
      headers: { cookie: teacherCookie },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.attemptId).toBe(attemptId);
    expect(data.windowStartMs).not.toBeNull();
    // 旧协议整卷链路：responses 行不写提交时刻，交卷时间轴语义在 attempt 级
    expect(data.submittedAt).not.toBeNull();
    const events = data.events as { type: string }[];
    const types = new Set(events.map((event) => event.type));
    expect(types.has("question_focus")).toBe(true);
    expect(types.has("answer_change")).toBe(true);
    expect(types.has("page_hidden")).toBe(true);
    const submitPoints = data.submitPoints as { questionId: string }[];
    expect(submitPoints).toHaveLength(0);
    expect(data.noteVersions).toEqual([]);
  });

  it("空卷（开卷后无任何行为）窗口为 null", async () => {
    const { app, teacherCookie, attemptId } = await makeEnv();
    const res = await app.request(`/api/teacher/attempts/${attemptId}/replay`, {
      headers: { cookie: teacherCookie },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.windowStartMs).toBeNull();
    expect(data.events).toEqual([]);
    expect(data.submitPoints).toEqual([]);
  });

  it("坏行（payloadJson 非法 JSON 或非对象）跳过，不中断其余事件投影", async () => {
    const { app, db, teacherCookie, attemptId, questionId } = await makeEnv();
    const now = Date.now();
    // 直插一条合法行 + 三类坏行（非法 JSON / 数组 / null）——正常链路有契约
    // 校验进不来，只有坏库会出现；坏行应与解析失败同口径跳过
    const rowOf = (id: string, payloadJson: string, clientTs: number) => ({
      id,
      attemptId,
      questionId,
      studentId: null,
      lectureId: null,
      type: "question_focus" as const,
      payloadJson,
      clientTs,
      serverTs: "2026-10-28T00:00:00.000Z",
    });
    db.insert(events)
      .values([
        rowOf("ev-ok", JSON.stringify({ some: "payload" }), now),
        rowOf("ev-bad-json", "不是 JSON", now + 1),
        rowOf("ev-bad-array", "[1,2]", now + 2),
        rowOf("ev-bad-null", "null", now + 3),
      ])
      .run();

    const res = await app.request(`/api/teacher/attempts/${attemptId}/replay`, {
      headers: { cookie: teacherCookie },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    const eventList = data.events as { clientTs: number }[];
    expect(eventList).toHaveLength(1);
    expect(eventList[0]?.clientTs).toBe(now);
  });

  it("不存在的 attempt 返回 404", async () => {
    const { app, teacherCookie } = await makeEnv();
    const res = await app.request(
      "/api/teacher/attempts/00000000-0000-4000-8000-0000000000ab/replay",
      { headers: { cookie: teacherCookie } },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ATTEMPT_NOT_FOUND");
  });
});

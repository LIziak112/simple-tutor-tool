import type { ApiErr } from "@tutor/contract";
import {
  ATTEMPT_TIME_UP_GRACE_SEC,
  attemptDraftOkSchema,
  attemptStartOkSchema,
  studentUnitLandingOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { attempts } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { submitAttemptRequest } from "../test/submit-revisions";

/**
 * 限时测试（个人学习迭代模块 2）路由级测试：
 * - 开卷自选时长 → 服务端算截止并随摘要 / 草稿视图下发（timing 含服务端时刻与阶段）；
 * - 不带时长 → 两列 NULL、timing null（旧行为零变化）；
 * - 取回进行中卷忽略新时长（时钟以首次建卷为准）；
 * - 时长越界 400；
 * - 到时宽限内答案写入仍接受（离线稿追平）；宽限过后 409 ATTEMPT_TIME_UP，交卷仍可；
 * - DSL `practice.timeLimitMinutes` 推荐随落地页下发并随导出写回；
 * - 作业开卷同样支持自选时长（通用，不限课程练习）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

const TIMED_PRACTICE_MD = `---
kind: practice
unit: 限时判断练习
practice:
  timeLimitMinutes: 45
---

::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$1$ 是正数。[[正确]]
::::

::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$-1$ 是正数。[[错误]]
::::
`;

const Q1 = "限时判断练习-1";

type App = ReturnType<typeof createApp>;

interface TestEnv {
  app: App;
  db: Db;
  teacherCookie: string;
  studentCookie: string;
  studentId: string;
  courseId: string;
  unitId: string;
}

function cookieOf(res: Response, name: string): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith(`${name}=`));
  if (!line) throw new Error(`响应中没有 ${name} cookie`);
  return `${name}=${line.slice(`${name}=`.length).split(";")[0] ?? ""}`;
}

async function makeEnv(): Promise<TestEnv> {
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
  const teacherCookie = cookieOf(setup, "tutor_session");
  const json = (cookie: string) => ({
    "content-type": "application/json",
    cookie,
  });

  const created = await app.request("/api/teacher/courses", {
    method: "POST",
    headers: json(teacherCookie),
    body: JSON.stringify({ title: "行测冲刺" }),
  });
  const courseId = ((await created.json()) as { data: { id: string } }).data.id;
  const imported = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: json(teacherCookie),
    body: JSON.stringify({
      markdown: TIMED_PRACTICE_MD,
      filename: "限时判断练习.md",
      courseId,
    }),
  });
  expect(imported.status).toBe(200);
  const unitId = (
    (await imported.json()) as { data: { units: { id: string }[] } }
  ).data.units[0]?.id;
  if (!unitId) throw new Error("导入未产出单元");
  const detail = await app.request(`/api/teacher/courses/${courseId}`, {
    headers: { cookie: teacherCookie },
  });
  const item = (
    (await detail.json()) as {
      data: { items: { id: string; refId: string | null }[] };
    }
  ).data.items.find((entry) => entry.refId === unitId);
  if (!item) throw new Error("课程目录中未找到单元条目");
  await app.request(`/api/teacher/course-items/${item.id}`, {
    method: "PATCH",
    headers: json(teacherCookie),
    body: JSON.stringify({ visible: true }),
  });

  const createStudent = await app.request("/api/teacher/students", {
    method: "POST",
    headers: json(teacherCookie),
    body: JSON.stringify({
      displayName: "考生甲",
      loginName: "考生甲",
      password: STUDENT_PASSWORD,
    }),
  });
  expect(createStudent.status).toBe(201);
  const studentId = (
    (await createStudent.json()) as { data: { student: { id: string } } }
  ).data.student.id;
  await app.request(`/api/teacher/courses/${courseId}/members`, {
    method: "POST",
    headers: json(teacherCookie),
    body: JSON.stringify({ studentIds: [studentId] }),
  });
  const login = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "考生甲", password: STUDENT_PASSWORD }),
  });
  expect(login.status).toBe(200);
  return {
    app,
    db,
    teacherCookie,
    studentCookie: cookieOf(login, "tutor_student_session"),
    studentId,
    courseId,
    unitId,
  };
}

async function startCourse(
  env: TestEnv,
  body?: Record<string, unknown>,
): Promise<Response> {
  return env.app.request(
    `/api/student/courses/${env.courseId}/units/${env.unitId}/attempts`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: env.studentCookie,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
  );
}

async function startTimed(env: TestEnv, minutes: number) {
  const res = await startCourse(env, { timeLimitMinutes: minutes });
  expect(res.status).toBe(201);
  return attemptStartOkSchema.parse(await res.json()).data;
}

async function saveAnswer(
  env: TestEnv,
  attemptId: string,
  value: boolean,
): Promise<Response> {
  return env.app.request(`/api/student/attempts/${attemptId}/answers/${Q1}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: env.studentCookie },
    body: JSON.stringify({ answer: { kind: "judge", value } }),
  });
}

async function detailOf(env: TestEnv, attemptId: string) {
  const res = await env.app.request(`/api/student/attempts/${attemptId}`, {
    headers: { cookie: env.studentCookie },
  });
  expect(res.status).toBe(200);
  return attemptDraftOkSchema.parse(await res.json()).data;
}

/** 把截止时刻改到相对现在的偏移（秒，负数 = 已过去），模拟时间流逝 */
function shiftDeadline(env: TestEnv, attemptId: string, offsetSec: number) {
  env.db
    .update(attempts)
    .set({ deadlineAt: new Date(Date.now() + offsetSec * 1000).toISOString() })
    .where(eq(attempts.id, attemptId))
    .run();
}

describe("限时测试 · 开卷自选时长", () => {
  it("带 timeLimitMinutes 开卷：摘要含时长与截止（= startedAt + 时长），草稿视图 timing 为 running", async () => {
    const env = await makeEnv();
    const attempt = await startTimed(env, 30);
    expect(attempt.timeLimitSec).toBe(1800);
    expect(attempt.deadlineAt).toBe(
      new Date(Date.parse(attempt.startedAt) + 1800 * 1000).toISOString(),
    );
    const detail = await detailOf(env, attempt.id);
    expect(detail.timing).toEqual({
      timeLimitSec: 1800,
      deadlineAt: attempt.deadlineAt,
      serverNow: expect.any(String),
      graceSec: ATTEMPT_TIME_UP_GRACE_SEC,
      phase: "running",
    });
    expect(
      Math.abs(Date.parse(detail.timing?.serverNow ?? "") - Date.now()),
    ).toBeLessThan(5_000);
  });

  it("不带时长：两列 null、timing null（旧行为零变化）", async () => {
    const env = await makeEnv();
    const res = await startCourse(env);
    expect(res.status).toBe(201);
    const attempt = attemptStartOkSchema.parse(await res.json()).data;
    expect(attempt.timeLimitSec).toBeNull();
    expect(attempt.deadlineAt).toBeNull();
    expect((await detailOf(env, attempt.id)).timing).toBeNull();
  });

  it("取回进行中卷时忽略新时长：时钟以首次建卷为准", async () => {
    const env = await makeEnv();
    const first = await startTimed(env, 30);
    const again = await startCourse(env, { timeLimitMinutes: 5 });
    expect(again.status).toBe(201);
    const same = attemptStartOkSchema.parse(await again.json()).data;
    expect(same.id).toBe(first.id);
    expect(same.timeLimitSec).toBe(1800);
    expect(same.deadlineAt).toBe(first.deadlineAt);
  });

  it("时长越界 / 非整数 → 400 VALIDATION_ERROR", async () => {
    const env = await makeEnv();
    for (const bad of [0, 601, 1.5, "30"]) {
      const res = await startCourse(env, { timeLimitMinutes: bad });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
    }
  });

  it("DSL practice.timeLimitMinutes：落地页推荐下发、导出写回", async () => {
    const env = await makeEnv();
    const landing = await env.app.request(
      `/api/student/courses/${env.courseId}/units/${env.unitId}`,
      { headers: { cookie: env.studentCookie } },
    );
    expect(landing.status).toBe(200);
    expect(
      studentUnitLandingOkSchema.parse(await landing.json()).data
        .practiceRecommendation,
    ).toEqual({ timeLimitMinutes: 45 });
    const exported = await env.app.request(
      `/api/teacher/units/${env.unitId}/export.md`,
      { headers: { cookie: env.teacherCookie } },
    );
    expect(exported.status).toBe(200);
    expect(await exported.text()).toContain("practice: {timeLimitMinutes: 45}");
  });
});

describe("限时测试 · 到时后的写闸门", () => {
  it("宽限内：答案写入仍接受（离线稿追平），timing.phase = grace", async () => {
    const env = await makeEnv();
    const attempt = await startTimed(env, 30);
    shiftDeadline(env, attempt.id, -60);
    expect((await saveAnswer(env, attempt.id, true)).status).toBe(200);
    expect((await detailOf(env, attempt.id)).timing?.phase).toBe("grace");
  });

  it("宽限过后：答案写入 409 ATTEMPT_TIME_UP，timing.phase = locked，交卷仍可并按已存答案判分", async () => {
    const env = await makeEnv();
    const attempt = await startTimed(env, 30);
    expect((await saveAnswer(env, attempt.id, true)).status).toBe(200);
    shiftDeadline(env, attempt.id, -(ATTEMPT_TIME_UP_GRACE_SEC + 30));
    const rejected = await saveAnswer(env, attempt.id, false);
    expect(rejected.status).toBe(409);
    expect(((await rejected.json()) as ApiErr).error).toBe("ATTEMPT_TIME_UP");
    expect((await detailOf(env, attempt.id)).timing?.phase).toBe("locked");
    const submitted = await submitAttemptRequest(
      env.app,
      env.studentCookie,
      attempt.id,
    );
    expect(submitted.status).toBe(200);
    const result = (await submitted.json()) as {
      data: { attempt: { status: string; scoreAuto: number | null } };
    };
    // 全客观题卷交卷即 graded；两题判断：第一题答对（true），第二题未答 → 50
    expect(result.data.attempt.status).toBe("graded");
    expect(result.data.attempt.scoreAuto).toBe(50);
  });

  it("非限时卷永不触发写闸门", async () => {
    const env = await makeEnv();
    const res = await startCourse(env);
    const attempt = attemptStartOkSchema.parse(await res.json()).data;
    expect((await saveAnswer(env, attempt.id, true)).status).toBe(200);
  });
});

describe("限时测试 · 作业开卷同样支持自选时长", () => {
  it("POST /assignments/:id/attempt 带 timeLimitMinutes → 摘要含截止", async () => {
    const env = await makeEnv();
    const created = await env.app.request("/api/teacher/assignments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: env.teacherCookie,
      },
      body: JSON.stringify({
        courseId: env.courseId,
        unitIds: [env.unitId],
        studentIds: [env.studentId],
      }),
    });
    const createdBody = await created.text();
    expect(created.status, createdBody).toBe(201);
    const assignmentId = (
      JSON.parse(createdBody) as { data: { assignments: { id: string }[] } }
    ).data.assignments[0]?.id;
    if (assignmentId === undefined) throw new Error("未返回作业 id");
    const started = await env.app.request(
      `/api/student/assignments/${assignmentId}/attempt`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: env.studentCookie,
        },
        body: JSON.stringify({ timeLimitMinutes: 90 }),
      },
    );
    expect(started.status).toBe(200);
    const attempt = attemptStartOkSchema.parse(await started.json()).data;
    expect(attempt.timeLimitSec).toBe(5400);
    expect(attempt.deadlineAt).toBe(
      new Date(Date.parse(attempt.startedAt) + 5400 * 1000).toISOString(),
    );
  });
});

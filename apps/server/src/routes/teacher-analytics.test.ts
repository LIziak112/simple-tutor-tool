import type { ApiErr } from "@tutor/contract";
import {
  analyticsOverviewOkSchema,
  analyticsQuestionsOkSchema,
  analyticsStudentOkSchema,
} from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTeacherSession } from "../auth/session.ts";
import type { Db } from "../db/client.ts";
import { teachers } from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { type SeedDemoResult, seedDemoData } from "../services/seed-demo.ts";

/**
 * T4.1 学情三接口路由测试（app.request() 直调 + 内存库 + 种子数据）：
 * - 鉴权：未登录 401；教师会话正常；
 * - 参数：days 非法 → 400 VALIDATION_ERROR；courseId/days/focusDays 合法组合 200；
 * - 契约：三个响应体经 analytics*OkSchema 校验（统一 { ok, data } 壳）；
 * - 域隔离（D7 红线）：教师乙的 overview/questions 只见空集（不泄露计数）、
 *   乙访问甲的学生 id → 404 STUDENT_NOT_FOUND。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
/** 固定时间基准（与 analytics-service.test.ts 同款） */
const SEED_NOW = "2026-10-01T04:00:00.000Z";
const TEACHER_B_ID = "teacher-b-analytics-route";

interface AnalyticsEnv {
  app: ReturnType<typeof createApp>;
  db: Db;
  cookieA: string;
  cookieB: string;
  seed: SeedDemoResult;
}

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

async function makeEnv(): Promise<AnalyticsEnv> {
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
  const cookieA = `tutor_session=${extractSessionToken(setup)}`;
  const seed = await seedDemoData(db, TEST_TEACHER_ID, { now: SEED_NOW });
  // 教师乙：直插行 + 伪造会话（域隔离夹具，teacher-domain-isolation 同款）
  db.insert(teachers)
    .values({
      id: TEACHER_B_ID,
      loginName: "teacher-b-analytics-route",
      isAdmin: false,
      disabledAt: null,
      // passwordHash 非空即可过守卫（不经过登录流程，isolation 夹具同款）
      passwordHash: "scrypt$analytics-route-fixture",
      apiToken: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  const { token: tokenB } = createTeacherSession(db, TEACHER_B_ID);
  return { app, db, cookieA, cookieB: `tutor_session=${tokenB}`, seed };
}

describe("GET /api/teacher/analytics/*（T4.1 路由层）", () => {
  it("未登录 → 401", async () => {
    const { app } = await makeEnv();
    for (const path of [
      "/api/teacher/analytics/overview",
      `/api/teacher/analytics/student/0199aaaa-1111-4222-8333-444455556666`,
      "/api/teacher/analytics/questions",
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(401);
      const body = (await res.json()) as ApiErr;
      expect(body.ok).toBe(false);
    }
  });

  it("非法查询参数 → 400 VALIDATION_ERROR", async () => {
    const { app, cookieA } = await makeEnv();
    for (const query of [
      "days=abc",
      "days=0",
      "focusDays=-1",
      "courseId=not-uuid",
    ]) {
      const res = await app.request(
        `/api/teacher/analytics/overview?${query}`,
        { headers: { cookie: cookieA } },
      );
      expect(res.status, query).toBe(400);
      const body = (await res.json()) as ApiErr;
      expect(body.error).toBe("VALIDATION_ERROR");
    }
  });

  it("合法查询（days=30 默认 / days=all / courseId / focusDays）→ 200 且过契约", async () => {
    const { app, cookieA, seed } = await makeEnv();
    const overview = await app.request("/api/teacher/analytics/overview", {
      headers: { cookie: cookieA },
    });
    expect(overview.status).toBe(200);
    expect(analyticsOverviewOkSchema.parse(await overview.json())).toBeTruthy();

    const student = await app.request(
      `/api/teacher/analytics/student/${seed.students.s1.id}?days=all&focusDays=7`,
      { headers: { cookie: cookieA } },
    );
    expect(student.status).toBe(200);
    const studentBody = analyticsStudentOkSchema.parse(await student.json());
    expect(studentBody.data.studentName).toBe("陈小明");
    expect(studentBody.data.range.days).toBe("all");

    const questions = await app.request(
      `/api/teacher/analytics/questions?courseId=${seed.courses.b.id}&days=30`,
      { headers: { cookie: cookieA } },
    );
    expect(questions.status).toBe(200);
    const questionsBody = analyticsQuestionsOkSchema.parse(
      await questions.json(),
    );
    // 课程 B 只有数轴练习 3 题
    expect(questionsBody.data.questions).toHaveLength(3);
  });

  it("教师乙查甲的学情 → 空集且不泄露计数；乙访问甲学生 → 404（D7 红线）", async () => {
    const { app, cookieB, seed } = await makeEnv();
    const overview = await app.request("/api/teacher/analytics/overview", {
      headers: { cookie: cookieB },
    });
    expect(overview.status).toBe(200);
    const body = analyticsOverviewOkSchema.parse(await overview.json());
    expect(body.data.matrix.students).toEqual([]);
    expect(body.data.matrix.cells).toEqual([]);
    expect(body.data.trend).toEqual([]);
    expect(body.data.pendingMarkCount).toBe(0);
    expect(body.data.studentCount).toBe(0);
    expect(body.data.focus.points).toEqual([]);

    const questions = await app.request("/api/teacher/analytics/questions", {
      headers: { cookie: cookieB },
    });
    expect(questions.status).toBe(200);
    expect(
      analyticsQuestionsOkSchema.parse(await questions.json()).data.questions,
    ).toEqual([]);

    const student = await app.request(
      `/api/teacher/analytics/student/${seed.students.s2.id}`,
      { headers: { cookie: cookieB } },
    );
    expect(student.status).toBe(404);
    const errBody = (await student.json()) as ApiErr;
    expect(errBody.error).toBe("STUDENT_NOT_FOUND");
  });

  it("不存在的学生 id → 404（不暴露存在性）", async () => {
    const { app, cookieA } = await makeEnv();
    const res = await app.request(
      "/api/teacher/analytics/student/0199aaaa-1111-4222-8333-444455556666",
      { headers: { cookie: cookieA } },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErr).error).toBe("STUDENT_NOT_FOUND");
  });
});

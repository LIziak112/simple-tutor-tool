import type { ApiErr, ReportListData } from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTeacherSession } from "../auth/session.ts";
import type { Db } from "../db/client";
import { teachers } from "../db/schema.ts";
import { createTestDb, createTestDir, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { createReport } from "../services/report-service.ts";
import { seedDemoData } from "../services/seed-demo.ts";

/**
 * T4.6 学情报告教师接口测试（D24）：
 * - 列表倒序（最新在前）与统一壳结构（reportListDataSchema 契约校验）；
 * - 删除成功与再查为空；
 * - 域隔离红线：教师乙查甲学生的报告 → 404；乙删甲写的报告 → 404（不暴露存在性）；
 * - 未登录 401。
 * （save_report 写入经 MCP 工具测试覆盖；这里直调 service 夹具造数据。）
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const SEED_NOW = "2026-10-01T04:00:00.000Z";
const TEACHER_B_ID = "teacher-b-t46-report";

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

interface ReportEnv {
  app: ReturnType<typeof createApp>;
  db: Db;
  cookieA: string;
  cookieB: string;
  studentId: string;
}

async function makeEnv(): Promise<ReportEnv> {
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
      loginName: "teacher-b-t46-report",
      isAdmin: false,
      disabledAt: null,
      passwordHash: "scrypt$t46-report-fixture",
      apiToken: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  const { token: tokenB } = createTeacherSession(db, TEACHER_B_ID);
  return {
    app,
    db,
    cookieA,
    cookieB: `tutor_session=${tokenB}`,
    studentId: seed.students.s1.id,
  };
}

describe("GET /api/teacher/students/:id/reports 与 DELETE /api/teacher/reports/:id（T4.6 D24）", () => {
  it("未登录 → 401（列表与删除）", async () => {
    const { app, studentId } = await makeEnv();
    const list = await app.request(
      `/api/teacher/students/${studentId}/reports`,
    );
    expect(list.status).toBe(401);
    expect(((await list.json()) as ApiErr).error).toBe("UNAUTHORIZED");
    const del = await app.request("/api/teacher/reports/00000000-0000-4000-8000-000000000000", {
      method: "DELETE",
    });
    expect(del.status).toBe(401);
  });

  it("列表倒序 + 契约壳校验；删除成功后列表为空", async () => {
    const { app, db, cookieA, studentId } = await makeEnv();
    const first = createReport(
      db,
      TEST_TEACHER_ID,
      { studentId, title: "第一份报告", markdown: "# 一" },
      "mcp",
      new Date("2026-10-01T08:00:00.000Z"),
    );
    const second = createReport(
      db,
      TEST_TEACHER_ID,
      { studentId, title: "第二份报告", markdown: "# 二" },
      "manual",
      new Date("2026-10-02T08:00:00.000Z"),
    );

    const res = await app.request(
      `/api/teacher/students/${studentId}/reports`,
      { headers: { cookie: cookieA } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: ReportListData };
    expect(body.data.reports.map((r) => r.title)).toEqual([
      "第二份报告",
      "第一份报告",
    ]);
    expect(body.data.reports.map((r) => r.source)).toEqual(["manual", "mcp"]);

    const del = await app.request(`/api/teacher/reports/${first.id}`, {
      method: "DELETE",
      headers: { cookie: cookieA },
    });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { ok: boolean }).ok).toBe(true);

    const after = await app.request(
      `/api/teacher/students/${studentId}/reports`,
      { headers: { cookie: cookieA } },
    );
    expect(
      ((await after.json()) as { data: ReportListData }).data.reports,
    ).toEqual([expect.objectContaining({ id: second.id })]);
  });

  it("域隔离：乙查甲学生的报告 → 404；乙删甲的报告 → 404（不暴露存在性）", async () => {
    const { app, db, cookieA, cookieB, studentId } = await makeEnv();
    const report = createReport(
      db,
      TEST_TEACHER_ID,
      { studentId, title: "甲的报告", markdown: "# 甲" },
      "mcp",
    );

    const listB = await app.request(
      `/api/teacher/students/${studentId}/reports`,
      { headers: { cookie: cookieB } },
    );
    expect(listB.status).toBe(404);
    expect(((await listB.json()) as ApiErr).error).toBe("STUDENT_NOT_FOUND");

    const delB = await app.request(`/api/teacher/reports/${report.id}`, {
      method: "DELETE",
      headers: { cookie: cookieB },
    });
    expect(delB.status).toBe(404);
    expect(((await delB.json()) as ApiErr).error).toBe("REPORT_NOT_FOUND");

    // 甲的报告未被乙的删除影响
    const listA = await app.request(
      `/api/teacher/students/${studentId}/reports`,
      { headers: { cookie: cookieA } },
    );
    expect(
      ((await listA.json()) as { data: ReportListData }).data.reports.length,
    ).toBe(1);
  });

  it("学生不存在 → 404 STUDENT_NOT_FOUND；报告不存在 → 404 REPORT_NOT_FOUND", async () => {
    const { app, cookieA } = await makeEnv();
    const list = await app.request(
      "/api/teacher/students/01234567-89ab-4cde-8f01-234567890abc/reports",
      { headers: { cookie: cookieA } },
    );
    expect(list.status).toBe(404);
    expect(((await list.json()) as ApiErr).error).toBe("STUDENT_NOT_FOUND");

    const del = await app.request(
      "/api/teacher/reports/01234567-89ab-4cde-8f01-234567890abd",
      { method: "DELETE", headers: { cookie: cookieA } },
    );
    expect(del.status).toBe(404);
    expect(((await del.json()) as ApiErr).error).toBe("REPORT_NOT_FOUND");
  });
});

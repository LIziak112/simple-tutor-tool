import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession, createTeacherSession } from "../auth/session.ts";
import {
  aiFacts,
  aiPolicyOverrides,
  aiShareTickets,
  aiTasks,
  students,
  teachers,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import {
  insertAiConnectionFixture,
  insertAttempt,
  insertResponse,
} from "../test/ai-companion-fixtures.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";

/**
 * SAI-28 分享票据路由测试（B15）：POST/DELETE /api/student/ai/tasks/:id/share。
 *
 * 路由面逐条（服务层生命周期语义已由 student-ai-share.test 锁定）：
 * - 四态鉴权：无会话 / 教师 Cookie / 跨学生 404 同文案 / 本人正常；
 * - 响应契约：aiTaskShareOkSchema（ticketUrl/snapshotAt/expiresAt），
 *   ticketUrl = publicUrl + /api/public/ai/share/ + 43 字符 token；
 * - token 只随生成响应出现一次：库内哈希行、撤销响应、列表响应都不含明文；
 * - 撤销端点：revokedCount、幂等；
 * - 学生可读响应过 assertNoLeak；错误壳不回显 token/路径。
 */

const active: ReturnType<typeof createTestDb>[] = [];
function world() {
  const db = createTestDb();
  active.push(db);
  db.update(teachers)
    .set({ passwordHash: "scrypt$fixture" })
    .where(eq(teachers.id, TEST_TEACHER_ID))
    .run();
  for (const id of ["s-a", "s-b"])
    db.insert(students)
      .values({
        id,
        teacherId: TEST_TEACHER_ID,
        displayName: id,
        loginName: id,
        linkToken: id,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
  const attemptId = insertAttempt(db, { studentId: "s-a" });
  insertResponse(db, attemptId, "q-alpha");
  for (const studentId of ["s-a", "s-b"])
    insertAiConnectionFixture(db, studentId);
  const app = createApp({
    db,
    dataDir: createTestDir(),
    publicUrl: "https://tutor.example.com/",
    isProduction: false,
    logger: pino({ enabled: false }),
  });
  const cookie = (id: string) =>
    `tutor_student_session=${createStudentSession(db, id).token}`;
  return {
    app,
    db,
    attemptId,
    a: cookie("s-a"),
    b: cookie("s-b"),
    teacher: `tutor_session=${createTeacherSession(db, TEST_TEACHER_ID).token}`,
  };
}
afterEach(() => {
  for (const db of active.splice(0)) db.$client.close();
});

async function req(
  app: ReturnType<typeof createApp>,
  method: "GET" | "POST" | "DELETE",
  path: string,
  cookie: string | undefined,
  body?: unknown,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createLinkTask(w: ReturnType<typeof world>): Promise<string> {
  const res = await req(w.app, "POST", "/api/student/ai/tasks", w.a, {
    attemptId: w.attemptId,
    questionId: "q-alpha",
    question: "这道题的思路是什么？",
    channel: "link",
    materials: { annotation: false, draft: false, formalInk: false },
    mutationId: randomUUID(),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { id: string } };
  return body.data.id;
}

describe("SAI-28 分享票据路由", () => {
  it("四态鉴权：无会话 401 / 教师 Cookie 401 / 跨学生 404 同文案 / 本人 200", async () => {
    const w = world();
    const taskId = await createLinkTask(w);
    const path = `/api/student/ai/tasks/${taskId}/share`;
    const noSession = await req(w.app, "POST", path, undefined, {});
    expect(noSession.status).toBe(401);
    const teacherCookie = await req(w.app, "POST", path, w.teacher, {});
    expect(teacherCookie.status).toBe(401);
    const cross = await req(w.app, "POST", path, w.b, {});
    expect(cross.status).toBe(404);
    const crossBody = (await cross.json()) as {
      error: string;
      message: string;
    };
    expect(crossBody.error).toBe("NOT_FOUND");
    const missing = await req(
      w.app,
      "POST",
      `/api/student/ai/tasks/${randomUUID()}/share`,
      w.a,
      {},
    );
    expect(missing.status).toBe(404);
    const missingBody = (await missing.json()) as { message: string };
    expect(missingBody.message).toBe(
      crossBody.message, // 同文案防枚举
    );
    const ok = await req(w.app, "POST", path, w.a, {});
    expect(ok.status).toBe(200);
  });

  it("生成响应契约：ticketUrl 指向公开读端点且带 43 字符 token；库内只存哈希；响应过 assertNoLeak", async () => {
    const w = world();
    const taskId = await createLinkTask(w);
    const res = await req(
      w.app,
      "POST",
      `/api/student/ai/tasks/${taskId}/share`,
      w.a,
      { validHours: 2 },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { ticketUrl: string; snapshotAt: string; expiresAt: string };
    };
    assertNoLeak(body);
    const match =
      /^https:\/\/tutor\.example\.com\/api\/public\/ai\/share\/([A-Za-z0-9_-]{43})$/.exec(
        body.data.ticketUrl,
      );
    expect(match).not.toBeNull();
    const token = match?.[1] ?? "";
    expect(body.data.expiresAt).toBeTruthy();
    // 库内行不含明文（哈希域隔离在服务层测试锁定，此处再证路由链路无泄漏）
    const rows = w.db.select().from(aiShareTickets).all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows).includes(token)).toBe(false);
  });

  it("撤销端点：revokedCount 只计有效票据；幂等；撤销后读取侧由服务层拒绝（此处验行状态）", async () => {
    const w = world();
    const taskId = await createLinkTask(w);
    await req(w.app, "POST", `/api/student/ai/tasks/${taskId}/share`, w.a, {});
    await req(w.app, "POST", `/api/student/ai/tasks/${taskId}/share`, w.a, {});
    const first = await req(
      w.app,
      "DELETE",
      `/api/student/ai/tasks/${taskId}/share`,
      w.a,
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data: { revokedCount: number };
    };
    expect(firstBody.data.revokedCount).toBe(2);
    const rows = w.db.select().from(aiShareTickets).all();
    for (const row of rows) expect(row.revokedAt).not.toBeNull();
    const second = await req(
      w.app,
      "DELETE",
      `/api/student/ai/tasks/${taskId}/share`,
      w.a,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      data: { revokedCount: number };
    };
    expect(secondBody.data.revokedCount).toBe(0);
    // 撤销响应不含 token 明文
    const revokeText = JSON.stringify(secondBody);
    expect(revokeText.includes("ticketUrl")).toBe(false);
  });

  it("禁用态生成拒绝：post_submit_only → 403 且零票据行零 link_generated 事实", async () => {
    const w = world();
    const taskId = await createLinkTask(w);
    w.db
      .insert(aiPolicyOverrides)
      .values({
        subjectType: "student",
        subjectId: "s-a",
        mode: "post_submit_only",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
    const res = await req(
      w.app,
      "POST",
      `/api/student/ai/tasks/${taskId}/share`,
      w.a,
      {},
    );
    expect(res.status).toBe(403);
    const denied = (await res.json()) as { error: string };
    expect(denied.error).toBe("AI_POLICY_DISABLED");
    expect(w.db.select().from(aiShareTickets).all()).toHaveLength(0);
    const facts = w.db.select().from(aiFacts).all();
    expect(facts.map((row) => row.type)).not.toContain("link_generated");
  });

  it("生成事实落库：link_generated 与 task_created 分开（访问事实归公开读端点，SAI-29）", async () => {
    const w = world();
    const taskId = await createLinkTask(w);
    await req(w.app, "POST", `/api/student/ai/tasks/${taskId}/share`, w.a, {});
    const facts = w.db
      .select()
      .from(aiFacts)
      .where(eq(aiFacts.taskId, taskId))
      .all()
      .map((row) => row.type);
    expect(facts).toEqual(["task_created", "link_generated"]);
    // 任务状态不被票据生成改动
    const task = w.db.select().from(aiTasks).all().at(0);
    expect(task?.status).toBe("created");
  });

  it("先测④路由侧：share token 不能充当学生会话 Cookie 或 MCP Bearer 列任务", async () => {
    const w = world();
    const taskId = await createLinkTask(w);
    const res = await req(
      w.app,
      "POST",
      `/api/student/ai/tasks/${taskId}/share`,
      w.a,
      {},
    );
    const token = ((
      (await res.json()) as {
        data: { ticketUrl: string };
      }
    ).data.ticketUrl.match(/([A-Za-z0-9_-]{43})$/) ?? ["", ""])[1];
    expect(token).toBeTruthy();
    // 充当学生会话 Cookie → 401（哈希域与登录 Token 物理隔离）
    const asSession = await req(
      w.app,
      "GET",
      "/api/student/ai/tasks?limit=10",
      `tutor_student_session=${token}`,
    );
    expect(asSession.status).toBe(401);
    // 充当 MCP Bearer → 401（share 域哈希在 MCP 连接域查不到）
    const asMcp = await w.app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "mcp-session-id": randomUUID(),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    expect(asMcp.status).toBe(401);
  });
});

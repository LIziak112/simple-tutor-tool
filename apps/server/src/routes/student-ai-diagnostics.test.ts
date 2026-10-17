import { randomUUID } from "node:crypto";
import {
  aiConnectionModelsOkSchema,
  aiConnectionProbeOkSchema,
} from "@tutor/contract";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession } from "../auth/session.ts";
import { students } from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { requestWithTargetGuard } from "../services/ai-companion/outbound-target.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";

vi.mock(
  "../services/ai-companion/outbound-target.ts",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../services/ai-companion/outbound-target.ts")
    >()),
    requestWithTargetGuard: vi.fn(),
  }),
);
const outbound = vi.mocked(requestWithTargetGuard);
const active: ReturnType<typeof createTestDb>[] = [];
function world() {
  const db = createTestDb();
  active.push(db);
  const studentId = randomUUID();
  db.insert(students)
    .values({
      id: studentId,
      teacherId: TEST_TEACHER_ID,
      displayName: "诊断学生",
      loginName: studentId,
      linkToken: studentId,
      createdAt: new Date().toISOString(),
    })
    .run();
  return {
    app: createApp({
      db,
      dataDir: createTestDir(),
      publicUrl: "https://tutor.example.com",
      isProduction: false,
      logger: pino({ enabled: false }),
    }),
    cookie: `tutor_student_session=${createStudentSession(db, studentId).token}`,
  };
}
beforeEach(() => {
  outbound.mockReset();
});
afterEach(() => {
  for (const db of active.splice(0)) db.$client.close();
});
const draft = {
  baseUrl: "https://ai.example.com/v1",
  apiKey: "sk-PRIVATE-SENTINEL",
};
describe("连接诊断路由", () => {
  it.each(["models", "probe"])(
    "%s 需要学生会话，无会话不出站",
    async (action) => {
      const { app } = world();
      const res = await app.request(`/api/student/ai/connections/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...draft, model: "chat-a" }),
      });
      expect(res.status).toBe(401);
      expect(outbound).not.toHaveBeenCalled();
    },
  );
  it("模型列表与探针通过真实路由契约往返，响应无密钥或题目内容，不创建连接", async () => {
    const { app, cookie } = world();
    for (const action of ["models", "probe"] as const) {
      outbound.mockResolvedValueOnce({
        status: 200,
        headers: {},
        bodyText:
          action === "models"
            ? '{"data":[{"id":"chat-a"}]}'
            : '{"choices":[{"message":{"content":"ok"}}]}',
      });
      const res = await app.request(`/api/student/ai/connections/${action}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(
          action === "models" ? draft : { ...draft, model: "chat-a" },
        ),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = await res.text();
      expect(text).not.toContain(draft.apiKey);
      const body = JSON.parse(text) as unknown;
      assertNoLeak(body);
      if (action === "models")
        expect(aiConnectionModelsOkSchema.parse(body).data.models).toEqual([
          "chat-a",
        ]);
      else
        expect(aiConnectionProbeOkSchema.parse(body).data.verifyStatus).toBe(
          "verified",
        );
    }
    const list = await app.request("/api/student/ai/connections", {
      headers: { cookie },
    });
    expect(await list.json()).toMatchObject({ data: { connections: [] } });
  });
  it("非法请求不出站；供应商错误不泄露原文且禁止缓存", async () => {
    const { app, cookie } = world();
    const request = (body: unknown) =>
      app.request("/api/student/ai/connections/models", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(
      (await request({ ...draft, teacherComment: "PRIVATE" })).status,
    ).toBe(400);
    expect(outbound).not.toHaveBeenCalled();
    outbound.mockResolvedValueOnce({
      status: 401,
      headers: {},
      bodyText: draft.apiKey,
    });
    const res = await request(draft);
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(draft.apiKey);
    assertNoLeak(body);
  });
});

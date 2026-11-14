import { randomUUID } from "node:crypto";
import {
  DEVICE_ID_HEADER,
  DEVICE_INFO_HEADER,
  deviceListDataSchema,
  deviceSchema,
  MEMO_OUTBOX_ACCOUNT_HEADER,
  memoSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession, createTeacherSession } from "../auth/session.ts";
import {
  aiConnections,
  attempts,
  events,
  sessions,
  students,
  teachers,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import {
  frozenDraftAttempt,
  snapshotJsonOf,
} from "../test/evidence-fixtures.ts";
import { makeStudent } from "../test/note-fixtures.ts";

function setup() {
  const db = createTestDb();
  db.update(teachers)
    .set({ passwordHash: "测试用已设密码" })
    .where(eq(teachers.id, TEST_TEACHER_ID))
    .run();
  const studentId = makeStudent(db);
  const token = createStudentSession(db, studentId).token;
  const app = createApp({
    db,
    dataDir: createTestDir(),
    publicUrl: "http://localhost",
    logger: pino({ enabled: false }),
    isProduction: false,
  });
  const cookie = `tutor_student_session=${token}`;
  const json = (method: string, body: unknown, auth = cookie) => ({
    method,
    headers: { cookie: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { app, db, cookie, json, studentId };
}

describe("本人设备接口", () => {
  it("撤销真实远端浏览器登录，保留当前subject以外会话及MCP凭证事实", async () => {
    const { app, db, cookie, studentId, json } = setup();
    const local = randomUUID();
    const remote = randomUUID();
    await app.request(
      "/api/student/devices/register",
      json("POST", { deviceId: local, type: "desktop" }),
    );
    const remoteCookie = `tutor_student_session=${createStudentSession(db, studentId).token}`;
    await app.request(
      "/api/student/devices/register",
      json("POST", { deviceId: remote, type: "agent" }, remoteCookie),
    );
    db.update(teachers)
      .set({
        accountKind: "personal",
        personalStudentId: studentId,
        loginName: "device-personal-fixture",
      })
      .where(eq(teachers.id, TEST_TEACHER_ID))
      .run();
    db.update(students)
      .set({ linkEnabled: false, passwordEnabled: false })
      .where(eq(students.id, studentId))
      .run();
    const teacherToken = createTeacherSession(db, TEST_TEACHER_ID).token;
    await app.request(
      "/api/teacher/devices/register",
      json(
        "POST",
        { deviceId: local, type: "desktop" },
        `tutor_session=${teacherToken}`,
      ),
    );
    const studentMe = await app.request("/api/student/me", {
      headers: { cookie },
    });
    expect(studentMe.status).toBe(200);
    expect(
      ((await studentMe.json()) as { data: { accountKind: string } }).data
        .accountKind,
    ).toBe("personal");
    const connectionId = randomUUID();
    const configJson = JSON.stringify({ tokenHash: "隔离夹具凭证哨兵" });
    db.insert(aiConnections)
      .values({
        id: connectionId,
        studentId,
        channel: "mcp",
        configJson,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
    const result = await app.request(
      `/api/student/devices/${remote}/revoke-sessions`,
      json("POST", {}),
    );
    expect(await result.json()).toEqual({ ok: true, data: { revoked: 1 } });
    expect(
      (
        await app.request("/api/student/me", {
          headers: { cookie: remoteCookie },
        })
      ).status,
    ).toBe(401);
    expect(
      (await app.request("/api/student/me", { headers: { cookie } })).status,
    ).toBe(200);
    expect(
      (
        await app.request("/api/teacher/me", {
          headers: { cookie: `tutor_session=${teacherToken}` },
        })
      ).status,
    ).toBe(200);
    expect(
      db
        .select()
        .from(aiConnections)
        .where(eq(aiConnections.id, connectionId))
        .get()?.configJson,
    ).toBe(configJson);
    const current = await app.request(
      `/api/student/devices/${local}/revoke-sessions`,
      json("POST", {}),
    );
    expect(await current.json()).toEqual({ ok: true, data: { revoked: 1 } });
    expect(
      (await app.request("/api/student/me", { headers: { cookie } })).status,
    ).toBe(401);
    expect(
      db.select().from(sessions).where(eq(sessions.id, teacherToken)).get(),
    ).toBeDefined();
  });
  it("当前设备从本人会话解析合并别名，不信请求的当前设备参数", async () => {
    const { app, db, cookie, studentId, json } = setup();
    const source = randomUUID();
    const target = randomUUID();
    await app.request(
      "/api/student/devices/register",
      json("POST", { deviceId: source, type: "desktop" }),
    );
    const secondCookie = `tutor_student_session=${createStudentSession(db, studentId).token}`;
    await app.request(
      "/api/student/devices/register",
      json("POST", { deviceId: target, type: "tablet" }, secondCookie),
    );
    await app.request(
      `/api/student/devices/${source}/merge`,
      json("POST", { targetDeviceId: target }),
    );
    const listed = await app.request(
      `/api/student/devices?currentDeviceId=${randomUUID()}`,
      { headers: { cookie } },
    );
    const body = (await listed.json()) as { data: unknown };
    assertNoLeak(body);
    expect(deviceListDataSchema.parse(body.data).currentDeviceId).toBe(target);
    const unknownCookie = `tutor_student_session=${createStudentSession(db, studentId).token}`;
    const unknown = await app.request("/api/student/devices", {
      headers: { cookie: unknownCookie },
    });
    expect(
      deviceListDataSchema.parse(
        ((await unknown.json()) as { data: unknown }).data,
      ).currentDeviceId,
    ).toBeNull();
  });
  it("真实请求登记并绑定当前会话，随笔、事件与任意来源作答引用同一设备", async () => {
    const { app, db, cookie, studentId, json } = setup();
    const device = {
      deviceId: randomUUID(),
      type: "tablet",
      os: "iPad",
      browser: "Safari",
    };
    const headers = {
      cookie,
      "content-type": "application/json",
      [DEVICE_ID_HEADER]: device.deviceId,
      [DEVICE_INFO_HEADER]: JSON.stringify(device),
      [MEMO_OUTBOX_ACCOUNT_HEADER]: studentId,
    };
    const memoResponse = await app.request("/api/student/memos", {
      method: "POST",
      headers,
      body: JSON.stringify({ clientId: randomUUID(), text: "设备来源" }),
    });
    expect(memoResponse.status).toBe(201);
    const memoBody = (await memoResponse.json()) as { data: unknown };
    assertNoLeak(memoBody);
    expect(memoSchema.parse(memoBody.data).deviceId).toBe(device.deviceId);
    expect(
      db
        .select()
        .from(sessions)
        .where(eq(sessions.id, cookie.split("=")[1] ?? ""))
        .get()?.deviceId,
    ).toBe(device.deviceId);
    const { attemptId } = frozenDraftAttempt(db, studentId, [
      { questionId: "q1", snapshotJson: snapshotJsonOf({ id: "q1" }) },
    ]);
    const response = await app.request(
      `/api/student/attempts/${attemptId}/events`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          events: [{ type: "page_visible", clientTs: Date.now() }],
        }),
      },
    );
    expect(response.status).toBe(200);
    assertNoLeak(await response.json());
    expect(
      db.select().from(events).where(eq(events.attemptId, attemptId)).get()
        ?.deviceId,
    ).toBe(device.deviceId);
    expect(
      db.select().from(attempts).where(eq(attempts.id, attemptId)).get()
        ?.device,
    ).toBe(device.deviceId);
    const strangerCookie = `tutor_student_session=${createStudentSession(db, makeStudent(db)).token}`;
    const stranger = await app.request(
      `/api/student/attempts/${attemptId}/events`,
      json(
        "POST",
        {
          deviceId: device.deviceId,
          events: [{ type: "page_visible", clientTs: Date.now() }],
        },
        strangerCookie,
      ),
    );
    expect(stranger.status).toBe(403);
    expect(
      db.select().from(attempts).where(eq(attempts.id, attemptId)).get()
        ?.device,
    ).toBe(device.deviceId);
  });
  it("学生端认证、参数校验、设备登记与列表契约及防泄露", async () => {
    const { app, json } = setup();
    expect((await app.request("/api/student/devices")).status).toBe(401);
    expect(
      (
        await app.request(
          "/api/student/devices/register",
          json("POST", { deviceId: "错", type: "tablet" }),
        )
      ).status,
    ).toBe(400);
    const response = await app.request(
      "/api/student/devices/register",
      json("POST", {
        deviceId: randomUUID(),
        type: "tablet",
        os: "iPad",
        browser: "Safari",
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown };
    assertNoLeak(body);
    expect(deviceSchema.parse(body.data).automaticName).toBe("iPad · Safari");
    expect(deviceSchema.parse(body.data).activeSessionCount).toBe(1);
    const list = await app.request("/api/student/devices", {
      headers: json("POST", {}).headers,
    });
    const listed = (await list.json()) as { data: unknown };
    assertNoLeak(listed);
    expect(
      deviceListDataSchema.parse(listed.data).devices[0]?.activeSessionCount,
    ).toBe(1);
  });
  it("别人的设备不可改名、合并、下线；教师Cookie不能访问学生设备", async () => {
    const { app, db, json } = setup();
    const id = randomUUID();
    await app.request(
      "/api/student/devices/register",
      json("POST", { deviceId: id, type: "desktop" }),
    );
    const other = `tutor_student_session=${createStudentSession(db, makeStudent(db)).token}`;
    for (const [path, method, body] of [
      [id, "PATCH", { name: "冒用" }],
      [`${id}/merge`, "POST", { targetDeviceId: randomUUID() }],
      [`${id}/revoke-sessions`, "POST", {}],
    ] as const) {
      const response = await app.request(
        `/api/student/devices/${path}`,
        json(method, body, other),
      );
      expect(response.status).toBe(404);
      assertNoLeak(await response.json());
    }
    const teacher = `tutor_session=${createTeacherSession(db, TEST_TEACHER_ID).token}`;
    expect(
      (
        await app.request("/api/student/devices", {
          headers: { cookie: teacher },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/api/teacher/devices", {
          headers: { cookie: teacher },
        })
      ).status,
    ).toBe(200);
  });
  it("改名、合并、下线和旧会话清理走实际路由", async () => {
    const { app, db, json, cookie } = setup();
    const first = randomUUID();
    const second = randomUUID();
    for (const deviceId of [first, second])
      expect(
        (
          await app.request(
            "/api/student/devices/register",
            json("POST", { deviceId, type: "desktop" }),
          )
        ).status,
      ).toBe(200);
    const renamed = await app.request(
      `/api/student/devices/${first}`,
      json("PATCH", { name: "书桌电脑" }),
    );
    expect(
      deviceSchema.parse(((await renamed.json()) as { data: unknown }).data)
        .displayName,
    ).toBe("书桌电脑");
    expect(
      (
        await app.request(
          `/api/student/devices/${first}/merge`,
          json("POST", { targetDeviceId: second }),
        )
      ).status,
    ).toBe(200);
    const studentId = db.$client
      .prepare("select subject_id from sessions where id = ?")
      .get(cookie.split("=")[1]) as { subject_id: string };
    createStudentSession(db, studentId.subject_id);
    const cleanup = await app.request(
      "/api/student/devices/unassigned-sessions/revoke",
      json("POST", {}),
    );
    expect(
      ((await cleanup.json()) as { data: { revoked: number } }).data.revoked,
    ).toBe(1);
    const revoke = await app.request(
      `/api/student/devices/${second}/revoke-sessions`,
      json("POST", {}),
    );
    expect(
      ((await revoke.json()) as { data: { revoked: number } }).data.revoked,
    ).toBe(1);
    expect(
      (await app.request("/api/student/devices", { headers: { cookie } }))
        .status,
    ).toBe(401);
  });
});

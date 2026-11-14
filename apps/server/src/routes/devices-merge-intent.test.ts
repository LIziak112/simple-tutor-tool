import { randomUUID } from "node:crypto";
import type { LearningContext } from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession, createTeacherSession } from "../auth/session.ts";
import { devices, memos, sessions, students, teachers } from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { mergeDevices, registerDevice } from "../services/device-service.ts";
import { createTextMemo } from "../services/memo-service.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { makeStudent } from "../test/note-fixtures.ts";

function setup() {
  const db = createTestDb();
  const studentId = makeStudent(db);
  const owner = { type: "student" as const, id: studentId };
  const token = createStudentSession(db, studentId).token;
  const app = createApp({
    db,
    dataDir: createTestDir(),
    publicUrl: "http://localhost",
    logger: pino({ enabled: false }),
    isProduction: false,
  });
  const cookie = `tutor_student_session=${token}`;
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()] as const;
  for (const deviceId of ids)
    registerDevice(db, owner, { deviceId, type: "desktop" });
  const [source, target, third, fourth] = ids;
  const intent = {
    sourceDeviceId: source,
    targetDeviceId: target,
    allowActiveSource: false,
  };
  const request = (
    sourceId = source,
    targetId = target,
    confirmation: typeof intent | undefined = intent,
    auth = cookie,
    role = "student",
  ) =>
    app.request(`/api/${role}/devices/${sourceId}/merge`, {
      method: "POST",
      headers: { cookie: auth, "content-type": "application/json" },
      body: JSON.stringify({
        targetDeviceId: targetId,
        ...(confirmation === undefined ? {} : { intent: confirmation }),
      }),
    });
  const addSession = (deviceId: string, expired = false) => {
    const id = createStudentSession(db, studentId).token;
    db.update(sessions)
      .set({
        deviceId,
        ...(expired ? { expiresAt: "2000-01-01T00:00:00.000Z" } : {}),
      })
      .where(eq(sessions.id, id))
      .run();
    return id;
  };
  const context: LearningContext = {
    schemaVersion: 1,
    content: {
      courseId: null,
      unitId: null,
      lectureId: null,
      sectionId: null,
      questionId: null,
      titles: { course: null, unit: null, lecture: null },
    },
    session: null,
    view: null,
    deviceId: source,
  };
  const memo = createTextMemo(db, {
    studentId,
    clientId: randomUUID(),
    text: "隔离夹具",
    deviceId: source,
    context,
  }).memo;
  // 认证守卫可刷新过期时间；合并不应改变这些身份、引用、正文或别名原值。
  const snapshot = () => ({
    devices: db.select().from(devices).all(),
    sessions: db
      .select({
        id: sessions.id,
        subjectType: sessions.subjectType,
        subjectId: sessions.subjectId,
        deviceId: sessions.deviceId,
      })
      .from(sessions)
      .all(),
    memos: db.select().from(memos).all(),
  });
  const totalChanges = () =>
    db.$client.prepare("select total_changes() as count").get() as {
      count: number;
    };
  return {
    db,
    app,
    owner,
    studentId,
    cookie,
    source,
    target,
    third,
    fourth,
    intent,
    request,
    addSession,
    memo,
    snapshot,
    totalChanges,
  };
}

async function stale(response: Response) {
  expect(response.status).toBe(409);
  const body: unknown = await response.json();
  assertNoLeak(body);
  expect(body).toEqual({
    ok: false,
    error: "DEVICE_MERGE_STALE",
    message: "设备记录或登录状态已变化，请刷新后重新确认合并",
  });
}

describe("设备合并确认的服务端原子前置条件", () => {
  it("确认后目标被另一窗口归并：409，不迁移到未确认第三台", async () => {
    const f = setup();
    f.addSession(f.source);
    const listed = await f.app.request("/api/student/devices", {
      headers: { cookie: f.cookie },
    });
    expect(listed.status).toBe(200);
    mergeDevices(f.db, f.owner, f.target, f.third);
    const before = f.snapshot();
    await stale(
      await f.request(f.source, f.target, {
        ...f.intent,
        allowActiveSource: true,
      }),
    );
    expect(f.snapshot()).toEqual(before);
  });
  it("确认后来源已归并到别处：409，保留原引用和目标", async () => {
    const f = setup();
    mergeDevices(f.db, f.owner, f.source, f.third);
    const before = f.snapshot();
    await stale(await f.request());
    expect(f.snapshot()).toEqual(before);
  });
  it("默认不合并活跃来源，确认后新增有效登录必须409", async () => {
    const f = setup();
    f.addSession(f.source);
    const before = f.snapshot();
    await stale(await f.request());
    expect(f.snapshot()).toEqual(before);
  });
  it("过期来源登录不算活跃，默认合并仍迁移旧记录", async () => {
    const f = setup();
    const expired = f.addSession(f.source, true);
    expect((await f.request()).status).toBe(200);
    expect(
      f.db.select().from(sessions).where(eq(sessions.id, expired)).get()
        ?.deviceId,
    ).toBe(f.target);
  });
  it("无效确认返回400，未登录返回401，均不改变引用", async () => {
    const f = setup();
    const before = f.snapshot();
    const body = {
      targetDeviceId: f.target,
      intent: { sourceDeviceId: f.source, targetDeviceId: f.target },
    };
    const invalid = await f.app.request(
      `/api/student/devices/${f.source}/merge`,
      {
        method: "POST",
        headers: { cookie: f.cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    expect(invalid.status).toBe(400);
    expect((await f.request(f.source, f.target, f.intent, "")).status).toBe(
      401,
    );
    expect(f.snapshot()).toEqual(before);
  });
  it("迁移中途失败必须回滚会话、随笔、目标时间和来源别名", () => {
    const f = setup();
    f.addSession(f.source);
    f.db.$client.exec(
      "create trigger stop_memo_merge before update of device_id on memos begin select raise(abort, 'fixture rollback'); end",
    );
    const before = f.snapshot();
    expect(() =>
      mergeDevices(f.db, f.owner, f.source, f.target, {
        ...f.intent,
        allowActiveSource: true,
      }),
    ).toThrow("fixture rollback");
    expect(f.snapshot()).toEqual(before);
  });
  it("明确允许活跃来源时迁移全部本人会话、随笔和上下文，保留会话数", async () => {
    const f = setup();
    const active = f.addSession(f.source);
    const expired = f.addSession(f.source, true);
    const response = await f.request(f.source, f.target, {
      ...f.intent,
      allowActiveSource: true,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { deviceId: string; activeSessionCount: number };
    };
    assertNoLeak(body);
    expect(body.data.deviceId).toBe(f.target);
    expect(body.data.activeSessionCount).toBe(1);
    for (const id of [active, expired])
      expect(
        f.db.select().from(sessions).where(eq(sessions.id, id)).get()?.deviceId,
      ).toBe(f.target);
    const row = f.db.select().from(memos).where(eq(memos.id, f.memo.id)).get();
    expect(row?.deviceId).toBe(f.target);
    expect(JSON.parse(row?.contextJson ?? "null")).toHaveProperty(
      "deviceId",
      f.target,
    );
  });
  it("旧别名仍可读、登记和改名，规范记录不被重建或改成自报类型", async () => {
    const f = setup();
    expect((await f.request()).status).toBe(200);
    const registered = await f.app.request("/api/student/devices/register", {
      method: "POST",
      headers: { cookie: f.cookie, "content-type": "application/json" },
      body: JSON.stringify({ deviceId: f.source, type: "agent" }),
    });
    expect(registered.status).toBe(200);
    expect(
      (
        (await registered.json()) as {
          data: { deviceId: string; type: string };
        }
      ).data,
    ).toEqual(expect.objectContaining({ deviceId: f.target, type: "desktop" }));
    const renamed = await f.app.request(`/api/student/devices/${f.source}`, {
      method: "PATCH",
      headers: { cookie: f.cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "保留目标新名称" }),
    });
    expect(renamed.status).toBe(200);
    expect(
      (
        (await renamed.json()) as {
          data: { deviceId: string; displayName: string };
        }
      ).data,
    ).toEqual(
      expect.objectContaining({
        deviceId: f.target,
        displayName: "保留目标新名称",
      }),
    );
    const listed = await f.app.request("/api/student/devices", {
      headers: { cookie: f.cookie },
    });
    const body: unknown = await listed.json();
    assertNoLeak(body);
    expect(body).toHaveProperty("data.currentDeviceId", f.target);
    expect(f.db.select().from(devices).all()).toHaveLength(4);
  });
  it("同一次直接S到T重放只读，T当前活跃也不迁移或删除会话", async () => {
    const f = setup();
    expect((await f.request()).status).toBe(200);
    f.addSession(f.target);
    f.addSession(f.target, true);
    const before = f.snapshot();
    const changes = f.totalChanges();
    const dto = mergeDevices(f.db, f.owner, f.source, f.target, f.intent);
    expect(dto.deviceId).toBe(f.target);
    expect(dto.activeSessionCount).toBe(1);
    expect(f.totalChanges()).toEqual(changes);
    expect(f.snapshot()).toEqual(before);
    expect((await f.request()).status).toBe(200);
    expect(f.snapshot()).toEqual(before);
  });
  it("成功后T再归并C不能通过旧确认重放跟随C；旧调用仍兼容别名", async () => {
    const f = setup();
    expect((await f.request()).status).toBe(200);
    mergeDevices(f.db, f.owner, f.target, f.third);
    const before = f.snapshot();
    await stale(await f.request());
    expect(f.snapshot()).toEqual(before);
    const legacy = await f.app.request(
      `/api/student/devices/${f.source}/merge`,
      {
        method: "POST",
        headers: { cookie: f.cookie, "content-type": "application/json" },
        body: JSON.stringify({ targetDeviceId: f.target }),
      },
    );
    expect(legacy.status).toBe(200);
    expect(
      ((await legacy.json()) as { data: { deviceId: string } }).data.deviceId,
    ).toBe(f.third);
  });
  it("S经X才到T不冒充同一次直接合并的安全重放", async () => {
    const f = setup();
    mergeDevices(f.db, f.owner, f.source, f.third);
    mergeDevices(f.db, f.owner, f.third, f.target);
    const before = f.snapshot();
    await stale(await f.request());
    expect(f.snapshot()).toEqual(before);
  });
  it("路径或目标与确认身份不同必须409，不能借intent转移别名", async () => {
    const f = setup();
    const before = f.snapshot();
    await stale(await f.request(f.source, f.third));
    await stale(await f.request(f.fourth, f.target));
    expect(f.snapshot()).toEqual(before);
  });
  it("他人设备/未知设备同404、角色Cookie不互认，确认值不提供授权", async () => {
    const f = setup();
    const other = { type: "student" as const, id: makeStudent(f.db) };
    const otherId = randomUUID();
    registerDevice(f.db, other, { deviceId: otherId, type: "agent" });
    for (const id of [otherId, randomUUID()])
      expect((await f.request(id)).status).toBe(404);
    expect((await f.request(f.source, otherId)).status).toBe(404);
    const teacherCookie = `tutor_session=${createTeacherSession(f.db, TEST_TEACHER_ID).token}`;
    expect(
      (await f.request(f.source, f.target, f.intent, teacherCookie)).status,
    ).toBe(401);
    const before = f.snapshot();
    await stale(
      await f.request(f.source, f.target, {
        ...f.intent,
        targetDeviceId: otherId,
      }),
    );
    expect(f.snapshot()).toEqual(before);
  });
  it("个人账号同raw设备ID的学生/教师subject互不迁移，活跃判断按本人域", async () => {
    const f = setup();
    f.db
      .update(teachers)
      .set({
        accountKind: "personal",
        personalStudentId: f.studentId,
        loginName: "merge-personal",
        passwordHash: "测试已设密码",
      })
      .where(eq(teachers.id, TEST_TEACHER_ID))
      .run();
    f.db
      .update(students)
      .set({ linkEnabled: false, passwordEnabled: false })
      .where(eq(students.id, f.studentId))
      .run();
    const teacherOwner = { type: "teacher" as const, id: TEST_TEACHER_ID };
    for (const deviceId of [f.source, f.target])
      registerDevice(f.db, teacherOwner, { deviceId, type: "agent" });
    const teacherToken = createTeacherSession(f.db, TEST_TEACHER_ID).token;
    f.db
      .update(sessions)
      .set({ deviceId: f.source })
      .where(eq(sessions.id, teacherToken))
      .run();
    expect((await f.request()).status).toBe(200);
    expect(
      f.db.select().from(sessions).where(eq(sessions.id, teacherToken)).get()
        ?.deviceId,
    ).toBe(f.source);
    const teacherCookie = `tutor_session=${teacherToken}`;
    const before = f.snapshot();
    await stale(
      await f.request(f.source, f.target, f.intent, teacherCookie, "teacher"),
    );
    expect(f.snapshot()).toEqual(before);
    expect(
      (
        await f.request(
          f.source,
          f.target,
          { ...f.intent, allowActiveSource: true },
          teacherCookie,
          "teacher",
        )
      ).status,
    ).toBe(200);
    expect(
      f.db.select().from(sessions).where(eq(sessions.id, teacherToken)).get()
        ?.deviceId,
    ).toBe(f.target);
    expect(
      f.db.select().from(memos).where(eq(memos.id, f.memo.id)).get()?.deviceId,
    ).toBe(f.target);
  });
});

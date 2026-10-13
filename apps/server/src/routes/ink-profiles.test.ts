import { inkProfileListOkSchema, inkProfileOkSchema } from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../app";
import { createStudentSession, createTeacherSession } from "../auth/session";
import { students, teachers } from "../db/schema";
import { createTestDb, createTestDir, TEST_TEACHER_ID } from "../db/test-utils";
import { assertNoLeak } from "../test/assert-no-leak";

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
        createdAt: new Date().toISOString(),
      })
      .run();
  const app = createApp({
    db,
    dataDir: createTestDir(),
    publicUrl: "http://localhost",
    isProduction: false,
    logger: pino({ enabled: false }),
  });
  const cookie = (id: string) =>
    `tutor_student_session=${createStudentSession(db, id).token}`;
  return {
    app,
    a: cookie("s-a"),
    b: cookie("s-b"),
    teacher: `tutor_session=${createTeacherSession(db, TEST_TEACHER_ID).token}`,
  };
}
afterEach(() => {
  for (const db of active.splice(0)) db.$client.close();
});
it("未登录拒绝；命名配置跨会话读取且师生与账号隔离", async () => {
  const { app, a, b, teacher } = world();
  expect((await app.request("/api/student/ink-profiles")).status).toBe(401);
  const created = await app.request("/api/student/ink-profiles", {
    method: "POST",
    headers: { cookie: a, "content-type": "application/json" },
    body: JSON.stringify({ name: "平板硬笔", config: {} }),
  });
  expect(created.status).toBe(200);
  const body = inkProfileOkSchema.parse(await created.json());
  assertNoLeak(body);
  const result = await app.request("/api/student/ink-profiles", {
    headers: { cookie: a },
  });
  const list = inkProfileListOkSchema.parse(await result.json());
  assertNoLeak(list);
  expect(list.data.profiles).toHaveLength(1);
  expect(
    inkProfileListOkSchema.parse(
      await (
        await app.request("/api/student/ink-profiles", {
          headers: { cookie: b },
        })
      ).json(),
    ).data.profiles,
  ).toHaveLength(0);
  expect(
    inkProfileListOkSchema.parse(
      await (
        await app.request("/api/teacher/ink-profiles", {
          headers: { cookie: teacher },
        })
      ).json(),
    ).data.profiles,
  ).toHaveLength(0);
  expect(
    (
      await app.request(`/api/student/ink-profiles/${body.data.id}`, {
        method: "DELETE",
        headers: { cookie: b },
      })
    ).status,
  ).toBe(404);
});
it("另存为独立记录，修改陈旧版本报冲突，删除按归属执行", async () => {
  const { app, a } = world();
  const headers = { cookie: a, "content-type": "application/json" };
  const create = async (name: string) =>
    inkProfileOkSchema.parse(
      await (
        await app.request("/api/student/ink-profiles", {
          method: "POST",
          headers,
          body: JSON.stringify({ name, config: {} }),
        })
      ).json(),
    ).data;
  const original = await create("平板");
  const another = await create("手机");
  expect(original.id).not.toBe(another.id);
  const update = () =>
    app.request(`/api/student/ink-profiles/${original.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: "平板",
        config: { smoothing: 0.2 },
        revision: 1,
      }),
    });
  expect((await update()).status).toBe(200);
  expect((await update()).status).toBe(409);
  expect(
    (
      await app.request(`/api/student/ink-profiles/${another.id}`, {
        method: "DELETE",
        headers,
      })
    ).status,
  ).toBe(200);
});

it("校验名称与参数、拒绝同名和超额配置，教师可以独立保存修改", async () => {
  const { app, a, teacher } = world();
  const post = (name: string, config: unknown = {}) =>
    app.request("/api/student/ink-profiles", {
      method: "POST",
      headers: { cookie: a, "content-type": "application/json" },
      body: JSON.stringify({ name, config }),
    });
  expect((await post(" ")).status).toBe(400);
  expect((await post("错误参数", { smoothing: 99 })).status).toBe(400);
  expect((await post("平板")).status).toBe(200);
  expect((await post(" 平板 ")).status).toBe(409);
  for (let i = 1; i < 20; i++)
    expect((await post(`设备 ${i}`)).status).toBe(200);
  expect((await post("超额")).status).toBe(409);
  const headers = { cookie: teacher, "content-type": "application/json" };
  const created = inkProfileOkSchema.parse(
    await (
      await app.request("/api/teacher/ink-profiles", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "平板",
          config: { renderer: "freehand" },
        }),
      })
    ).json(),
  ).data;
  const updated = inkProfileOkSchema.parse(
    await (
      await app.request(`/api/teacher/ink-profiles/${created.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          name: "平板",
          config: { smoothing: 0.7 },
          revision: created.revision,
        }),
      })
    ).json(),
  ).data;
  expect(updated.revision).toBe(2);
  expect(updated.config.smoothing).toBe(0.7);
});

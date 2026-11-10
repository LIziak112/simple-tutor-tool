import type { ApiErr } from "@tutor/contract";
import {
  adminSettingsOkSchema,
  personalLogoutOkSchema,
  personalSessionCheckOkSchema,
  personalSessionOkSchema,
  studentMeOkSchema,
  teacherInfoOkSchema,
  teacherLoginOkSchema,
  teacherStatusOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { hashPassword } from "../auth/password.ts";
import type { Db } from "../db/client.ts";
import { sessions, students, teachers } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";

/**
 * 个人账号（模块 0）集成测试：app.request() 直调路由 + 内存库。
 * - status.personalRegistrationOpen 随管理员邀请码联动（未配置 = 关）；
 * - 注册：未首启 409 TEACHER_NOT_EXISTS / 未配置邀请码 403 PERSONAL_REGISTRATION_DISABLED /
 *   邀请码错 403 INVITE_CODE_INVALID / 重名（含与班级教师同名）409 TEACHER_LOGIN_EXISTS /
 *   成功 = teachers(personal) + students 绑定行 + 两枚会话 Cookie，响应给出两侧身份；
 * - 双视角：同一套 Cookie 同时过 /api/teacher/me 与 /api/student/me（accountKind=personal，
 *   学生侧 loginName 展示账号登录名）；
 * - 班级能力闸门：个人账号添加学生 409 PERSONAL_ACCOUNT_RESTRICTED、教师 API token 入口 409；
 * - 登录：/personal/login 成功双 Cookie；班级教师凭证 403 ACCOUNT_KIND_MISMATCH 且不留会话；
 *   /teacher/login 对个人账号同样补发学生 Cookie；学习者行不能走学生密码登录（401）；
 * - 管理端：教师列表带 accountKind；邀请码置 null 即关闭个人注册；
 * - IP 限流 reg:ip:<IP> 与教师注册共用（错邀请码也计数，第 6 次 429 LOCKED）。
 */

const silentLogger: Logger = pino({ enabled: false });
const ADMIN_PASSWORD = "admin-pass-888";
const PERSONAL_PASSWORD = "personal-pass-8";
const INVITE_CODE = "GONGKAO-2026";

function makeApp(): { app: ReturnType<typeof createApp>; db: Db } {
  const db = createTestDb();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    dataDir: createTestDir(),
    publicUrl: "http://localhost:8787",
  });
  return { app, db };
}

async function req(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

/** 响应里的全部 Set-Cookie → 「name=value」拼成一枚可回传的 Cookie 头 */
function cookieHeaderOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .filter((pair) => pair.length > 0)
    .join("; ");
}

/** 首启建管理员并登录（Cookie 头），再配置个人邀请码（缺省 INVITE_CODE） */
async function setupAdmin(
  app: ReturnType<typeof createApp>,
  inviteCode: string | null = INVITE_CODE,
): Promise<{ cookie: string }> {
  const setup = await req(app, "POST", "/api/public/teacher/setup", {
    loginName: "teacher",
    password: ADMIN_PASSWORD,
  });
  expect(setup.status).toBe(200);
  const cookie = cookieHeaderOf(setup);
  if (inviteCode !== null) {
    const patch = await req(
      app,
      "PATCH",
      "/api/admin/settings",
      { personalInviteCode: inviteCode },
      { cookie },
    );
    expect(patch.status).toBe(200);
  }
  return { cookie };
}

async function registerPersonal(
  app: ReturnType<typeof createApp>,
  body: unknown,
  ip = "10.9.0.1",
): Promise<Response> {
  return req(app, "POST", "/api/public/personal/register", body, {
    "x-forwarded-for": ip,
  });
}

const VALID_REGISTER = {
  loginName: "kaosheng",
  password: PERSONAL_PASSWORD,
  inviteCode: INVITE_CODE,
} as const;

describe("绑定学习者与个人注册回归", () => {
  it("绑定学习者不能归档、改内部登录名或开启独立登录", async () => {
    const { app, db } = makeApp();
    await setupAdmin(app);
    const registered = await registerPersonal(app, VALID_REGISTER);
    const { data } = personalSessionOkSchema.parse(await registered.json());
    const cookie = cookieHeaderOf(registered);
    const path = `/api/teacher/students/${data.student.id}`;
    const changes = [
      ["PATCH", path, { archived: true }],
      ["PATCH", path, { loginName: "unbound" }],
      ["PATCH", path, { passwordEnabled: true }],
      ["PATCH", path, { linkEnabled: true }],
      ["POST", `${path}/reset-password`, undefined],
      ["POST", `${path}/reset-link`, undefined],
    ] as const;
    for (const [method, url, body] of changes) {
      const denied = await req(app, method, url, body, { cookie });
      expect(denied.status).toBe(409);
      expect(await denied.json()).toMatchObject({
        error: "PERSONAL_ACCOUNT_RESTRICTED",
      });
    }
    expect(
      (await req(app, "GET", "/api/student/me", undefined, { cookie })).status,
    ).toBe(200);
    db.$client.close();
  });

  it("拒绝历史独立凭证，验证个人密码后恢复错误归档的学习者", async () => {
    const { app, db } = makeApp();
    await setupAdmin(app);
    const registered = await registerPersonal(app, VALID_REGISTER);
    const { data } = personalSessionOkSchema.parse(await registered.json());
    const legacy = db
      .update(students)
      .set({
        loginName: "personal:kaosheng",
        passwordHash: await hashPassword("legacy-pass"),
        passwordEnabled: true,
        linkEnabled: true,
      })
      .where(eq(students.id, data.student.id))
      .returning({ linkToken: students.linkToken })
      .get();
    const oldCookie = cookieHeaderOf(registered);
    expect(
      (
        await req(app, "POST", "/api/public/student/login", {
          loginName: "personal:kaosheng",
          password: "legacy-pass",
        })
      ).status,
    ).toBe(401);
    expect(
      (await app.request(`/api/public/s/${legacy.linkToken}`)).status,
    ).toBe(401);

    db.update(students)
      .set({ archivedAt: "2026-10-01T00:00:00.000Z" })
      .where(eq(students.id, data.student.id))
      .run();
    const relogged = await req(app, "POST", "/api/public/personal/login", {
      loginName: VALID_REGISTER.loginName,
      password: VALID_REGISTER.password,
    });
    expect(relogged.status).toBe(200);
    const { data: restored } = personalSessionOkSchema.parse(
      await relogged.json(),
    );
    expect(restored.student).toMatchObject({
      id: data.student.id,
      linkEnabled: false,
      passwordEnabled: false,
    });
    expect(
      (
        await req(app, "GET", "/api/student/me", undefined, {
          cookie: oldCookie,
        })
      ).status,
    ).toBe(401);
    db.$client.close();
  });

  it("旧个人账号改名后原登录名可注册，原学习者绑定保留", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    const registered = await registerPersonal(app, VALID_REGISTER);
    const { data } = personalSessionOkSchema.parse(await registered.json());
    db.update(students)
      .set({ loginName: "personal:kaosheng" })
      .where(eq(students.id, data.student.id))
      .run();
    const renamed = await req(
      app,
      "PATCH",
      `/api/admin/teachers/${data.teacher.id}`,
      {
        loginName: "renamed",
      },
      { cookie: admin.cookie },
    );
    expect(renamed.status).toBe(200);
    const another = await registerPersonal(app, VALID_REGISTER);
    expect(another.status).toBe(200);
    const { data: newAccount } = personalSessionOkSchema.parse(
      await another.json(),
    );
    expect(newAccount.student.id).not.toBe(data.student.id);
    const relogged = await req(app, "POST", "/api/public/personal/login", {
      loginName: "renamed",
      password: PERSONAL_PASSWORD,
    });
    const { data: oldAccount } = personalSessionOkSchema.parse(
      await relogged.json(),
    );
    expect(oldAccount.student).toMatchObject({
      id: data.student.id,
      loginName: "renamed",
    });
    db.$client.close();
  });

  it("并发同名注册一次成功、一次返回 409，只有一组绑定", async () => {
    const { app, db } = makeApp();
    await setupAdmin(app);
    const responses = await Promise.all([
      registerPersonal(app, VALID_REGISTER, "10.9.0.2"),
      registerPersonal(app, VALID_REGISTER, "10.9.0.3"),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const conflict = responses.find((response) => response.status === 409);
    expect(await conflict?.json()).toMatchObject({
      error: "TEACHER_LOGIN_EXISTS",
    });
    const accounts = db
      .select()
      .from(teachers)
      .where(eq(teachers.accountKind, "personal"))
      .all();
    const learners = db.select().from(students).all();
    expect(accounts).toHaveLength(1);
    expect(learners).toHaveLength(1);
    expect(learners[0]?.id).toBe(accounts[0]?.personalStudentId);
    db.$client.close();
  });
});

describe("个人会话配对", () => {
  it.each(["student", "teacher"] as const)(
    "%s 视角只切换和结束本人双侧会话",
    async (role) => {
      const { app, db } = makeApp();
      await setupAdmin(app);
      const registered = await registerPersonal(app, VALID_REGISTER);
      const { data } = personalSessionOkSchema.parse(await registered.json());
      const cookie = cookieHeaderOf(registered);
      const check = await req(
        app,
        "POST",
        "/api/public/personal/session/check",
        { role },
        { cookie },
      );
      expect(check.status).toBe(200);
      const body = await check.json();
      assertNoLeak(body);
      expect(personalSessionCheckOkSchema.parse(body).data).toEqual(data);

      const logout = await req(
        app,
        "POST",
        "/api/public/personal/session/logout",
        { role },
        { cookie },
      );
      expect(logout.status).toBe(200);
      expect(
        personalLogoutOkSchema.parse(await logout.json()).data.paired,
      ).toBe(true);
      expect(logout.headers.getSetCookie()).toHaveLength(2);
      for (const side of ["student", "teacher"]) {
        expect(
          (await req(app, "GET", `/api/${side}/me`, undefined, { cookie }))
            .status,
        ).toBe(401);
      }
      db.$client.close();
    },
  );

  it("另一侧是班级会话时拒绝切换，并只结束个人学习会话", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    const registered = await registerPersonal(app, VALID_REGISTER);
    const student = cookieHeaderOf(registered)
      .split("; ")
      .find((entry) => entry.startsWith("tutor_student_session="));
    expect(student).toBeDefined();
    const cookie = `${admin.cookie}; ${student}`;
    for (const action of ["check", "logout"]) {
      const response = await req(
        app,
        "POST",
        `/api/public/personal/session/${action}`,
        { role: "student" },
        { cookie },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      assertNoLeak(body);
      expect(body).toEqual({
        ok: true,
        data: action === "check" ? null : { paired: false },
      });
      const cleared = response.headers.getSetCookie();
      expect(cleared).toHaveLength(action === "check" ? 0 : 1);
      if (action === "logout") {
        expect(cleared[0]).toMatch(/^tutor_student_session=/);
      }
    }
    expect(
      (await req(app, "GET", "/api/teacher/me", undefined, { cookie })).status,
    ).toBe(200);
    expect(
      (await req(app, "GET", "/api/student/me", undefined, { cookie })).status,
    ).toBe(401);
    db.$client.close();
  });

  it("拒绝无当前个人会话和无效视角", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    for (const action of ["check", "logout"]) {
      const path = `/api/public/personal/session/${action}`;
      expect((await req(app, "POST", path, { role: "student" })).status).toBe(
        401,
      );
      expect(
        (
          await req(
            app,
            "POST",
            path,
            { role: "teacher" },
            { cookie: admin.cookie },
          )
        ).status,
      ).toBe(401);
      expect((await req(app, "POST", path, { role: "admin" })).status).toBe(
        400,
      );
    }
    db.$client.close();
  });

  it("另一侧会话过期时引导重登，当前侧仍可单独退出", async () => {
    const { app, db } = makeApp();
    await setupAdmin(app);
    const registered = await registerPersonal(app, VALID_REGISTER);
    const { data } = personalSessionOkSchema.parse(await registered.json());
    const cookie = cookieHeaderOf(registered);
    db.update(sessions)
      .set({ expiresAt: "2020-01-01T00:00:00.000Z" })
      .where(eq(sessions.subjectId, data.teacher.id))
      .run();
    const check = await req(
      app,
      "POST",
      "/api/public/personal/session/check",
      {
        role: "student",
      },
      { cookie },
    );
    expect(
      personalSessionCheckOkSchema.parse(await check.json()).data,
    ).toBeNull();
    const logout = await req(
      app,
      "POST",
      "/api/public/personal/session/logout",
      {
        role: "student",
      },
      { cookie },
    );
    expect(personalLogoutOkSchema.parse(await logout.json()).data.paired).toBe(
      false,
    );
    expect(logout.headers.getSetCookie()).toHaveLength(1);
    expect(
      (await req(app, "GET", "/api/student/me", undefined, { cookie })).status,
    ).toBe(401);
    db.$client.close();
  });
});

it("停用个人账号后两侧会话均失效，学习侧不会续期", async () => {
  const { app, db } = makeApp();
  const admin = await setupAdmin(app);
  const registered = await registerPersonal(app, VALID_REGISTER);
  const { data } = personalSessionOkSchema.parse(await registered.json());
  const cookie = cookieHeaderOf(registered);

  const disabled = await req(
    app,
    "POST",
    `/api/admin/teachers/${data.teacher.id}/disable`,
    undefined,
    { cookie: admin.cookie },
  );
  expect(disabled.status).toBe(200);
  for (const role of ["student", "teacher"]) {
    const me = await req(app, "GET", `/api/${role}/me`, undefined, { cookie });
    expect(me.status).toBe(401);
    expect(me.headers.getSetCookie()).toEqual([]);
  }
  const media = await req(
    app,
    "GET",
    `/blobs/media/${"a".repeat(64)}.png`,
    undefined,
    { cookie },
  );
  expect(media.status).toBe(401);
  db.$client.close();
});

describe("status.personalRegistrationOpen（模块 0）", () => {
  it("未首启 false；首启后未配置邀请码仍 false；配置后 true；置 null 回到 false", async () => {
    const { app, db } = makeApp();
    const before = (await (
      await app.request("/api/public/teacher/status")
    ).json()) as unknown;
    expect(teacherStatusOkSchema.safeParse(before).success).toBe(true);
    expect(before).toMatchObject({
      data: { hasTeacher: false, personalRegistrationOpen: false },
    });

    const admin = await setupAdmin(app, null);
    const noCode = (await (
      await app.request("/api/public/teacher/status")
    ).json()) as { data: { personalRegistrationOpen: boolean } };
    expect(noCode.data.personalRegistrationOpen).toBe(false);

    const patch = await req(
      app,
      "PATCH",
      "/api/admin/settings",
      { personalInviteCode: ` ${INVITE_CODE} ` },
      { cookie: admin.cookie },
    );
    const patched = (await patch.json()) as unknown;
    expect(adminSettingsOkSchema.safeParse(patched).success).toBe(true);
    expect(patched).toMatchObject({
      data: { allowRegistration: true, personalInviteCode: INVITE_CODE },
    });
    const opened = (await (
      await app.request("/api/public/teacher/status")
    ).json()) as { data: { personalRegistrationOpen: boolean } };
    expect(opened.data.personalRegistrationOpen).toBe(true);

    const closed = await req(
      app,
      "PATCH",
      "/api/admin/settings",
      { personalInviteCode: null },
      { cookie: admin.cookie },
    );
    expect(closed.status).toBe(200);
    expect(
      ((await closed.json()) as { data: { personalInviteCode: string | null } })
        .data.personalInviteCode,
    ).toBeNull();
    const reclosed = (await (
      await app.request("/api/public/teacher/status")
    ).json()) as { data: { personalRegistrationOpen: boolean } };
    expect(reclosed.data.personalRegistrationOpen).toBe(false);

    // 空对象 PATCH → 400（契约 refine：至少一项）
    const empty = await req(
      app,
      "PATCH",
      "/api/admin/settings",
      {},
      { cookie: admin.cookie },
    );
    expect(empty.status).toBe(400);
    db.$client.close();
  });
});

describe("POST /api/public/personal/register（模块 0，Q7 定案 b）", () => {
  it("未首启 → 409 TEACHER_NOT_EXISTS", async () => {
    const { app, db } = makeApp();
    const res = await registerPersonal(app, VALID_REGISTER);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErr).error).toBe("TEACHER_NOT_EXISTS");
    db.$client.close();
  });

  it("未配置邀请码 → 403 PERSONAL_REGISTRATION_DISABLED；邀请码错 → 403 INVITE_CODE_INVALID", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app, null);
    const disabled = await registerPersonal(app, VALID_REGISTER);
    expect(disabled.status).toBe(403);
    expect(((await disabled.json()) as ApiErr).error).toBe(
      "PERSONAL_REGISTRATION_DISABLED",
    );

    await req(
      app,
      "PATCH",
      "/api/admin/settings",
      { personalInviteCode: INVITE_CODE },
      { cookie: admin.cookie },
    );
    const wrong = await registerPersonal(app, {
      ...VALID_REGISTER,
      inviteCode: "wrong-code",
    });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as ApiErr).error).toBe("INVITE_CODE_INVALID");
    // 失败不留账号
    expect(
      db
        .select()
        .from(teachers)
        .where(eq(teachers.loginName, VALID_REGISTER.loginName))
        .get(),
    ).toBeUndefined();
    db.$client.close();
  });

  it("成功：teachers(personal)+students 绑定行、两枚 Cookie、双侧身份；重名 409", async () => {
    const { app, db } = makeApp();
    await setupAdmin(app);
    const res = await registerPersonal(app, {
      ...VALID_REGISTER,
      displayName: "小考",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(personalSessionOkSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      data: {
        teacher: {
          loginName: "kaosheng",
          isAdmin: false,
          accountKind: "personal",
        },
        student: {
          loginName: "kaosheng",
          displayName: "小考",
          accountKind: "personal",
          linkEnabled: false,
          passwordEnabled: false,
        },
      },
    });
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith("tutor_session="))).toBe(true);
    expect(setCookies.some((c) => c.startsWith("tutor_student_session="))).toBe(
      true,
    );

    // 库内形态：teachers.personalStudentId 指回 students 行；学习者行两种登录都关
    const teacherRow = db
      .select()
      .from(teachers)
      .where(eq(teachers.loginName, "kaosheng"))
      .get();
    expect(teacherRow?.accountKind).toBe("personal");
    expect(teacherRow?.isAdmin).toBe(false);
    expect(teacherRow?.personalStudentId).toBeTruthy();
    const studentRow = db
      .select()
      .from(students)
      .where(eq(students.id, teacherRow?.personalStudentId ?? ""))
      .get();
    expect(studentRow?.teacherId).toBe(teacherRow?.id);
    expect(studentRow?.loginName).toBe(`personal:${studentRow?.id}`);
    expect(studentRow?.passwordEnabled).toBe(false);
    expect(studentRow?.linkEnabled).toBe(false);
    expect(studentRow?.passwordHash).toBeNull();

    // 双视角：同一套 Cookie 过教师 me 与学生 me
    const cookie = cookieHeaderOf(res);
    const teacherMe = await req(app, "GET", "/api/teacher/me", undefined, {
      cookie,
    });
    expect(teacherMe.status).toBe(200);
    const teacherMeBody = (await teacherMe.json()) as unknown;
    expect(teacherInfoOkSchema.safeParse(teacherMeBody).success).toBe(true);
    expect(teacherMeBody).toMatchObject({
      data: { accountKind: "personal", loginName: "kaosheng" },
    });
    const studentMe = await req(app, "GET", "/api/student/me", undefined, {
      cookie,
    });
    expect(studentMe.status).toBe(200);
    const studentMeBody = (await studentMe.json()) as unknown;
    expect(studentMeOkSchema.safeParse(studentMeBody).success).toBe(true);
    expect(studentMeBody).toMatchObject({
      data: { accountKind: "personal", loginName: "kaosheng" },
    });

    // 班级能力闸门：添加学生 / 教师 API token 入口
    const addStudent = await req(
      app,
      "POST",
      "/api/teacher/students",
      { displayName: "别人", loginName: "someone" },
      { cookie },
    );
    expect(addStudent.status).toBe(409);
    expect(((await addStudent.json()) as ApiErr).error).toBe(
      "PERSONAL_ACCOUNT_RESTRICTED",
    );
    const apiToken = await req(
      app,
      "GET",
      "/api/teacher/api-token",
      undefined,
      {
        cookie,
      },
    );
    expect(apiToken.status).toBe(409);
    const apiTokenPost = await req(
      app,
      "POST",
      "/api/teacher/api-token",
      undefined,
      { cookie },
    );
    expect(apiTokenPost.status).toBe(409);

    // 重名：与个人账号同名 / 与班级教师同名 都 409 TEACHER_LOGIN_EXISTS
    const dup = await registerPersonal(app, VALID_REGISTER, "10.9.0.2");
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as ApiErr).error).toBe("TEACHER_LOGIN_EXISTS");
    const dupTeacher = await registerPersonal(
      app,
      { ...VALID_REGISTER, loginName: "teacher" },
      "10.9.0.3",
    );
    expect(dupTeacher.status).toBe(409);
    expect(((await dupTeacher.json()) as ApiErr).error).toBe(
      "TEACHER_LOGIN_EXISTS",
    );
    db.$client.close();
  });

  it("学习者行不能走学生密码登录（personal:<name> 一律 401）", async () => {
    const { app, db } = makeApp();
    await setupAdmin(app);
    expect((await registerPersonal(app, VALID_REGISTER)).status).toBe(200);
    for (const loginName of ["personal:kaosheng", "kaosheng"]) {
      const res = await req(app, "POST", "/api/public/student/login", {
        loginName,
        password: PERSONAL_PASSWORD,
      });
      expect(res.status).toBe(401);
    }
    db.$client.close();
  });

  it("IP 限流与教师注册共用：错邀请码也计数，第 6 次 429 LOCKED；换 IP 不受影响", async () => {
    const { app, db } = makeApp();
    await setupAdmin(app);
    for (let i = 0; i < 5; i++) {
      const res = await registerPersonal(
        app,
        { ...VALID_REGISTER, loginName: `u${i}`, inviteCode: "bad" },
        "10.9.9.9",
      );
      expect(res.status).toBe(403);
    }
    const locked = await registerPersonal(app, VALID_REGISTER, "10.9.9.9");
    expect(locked.status).toBe(429);
    expect(((await locked.json()) as ApiErr).error).toBe("LOCKED");
    const other = await registerPersonal(app, VALID_REGISTER, "10.9.9.10");
    expect(other.status).toBe(200);
    db.$client.close();
  });

  it("契约校验：缺邀请码 / 登录名不合法 → 400 VALIDATION_ERROR", async () => {
    const { app, db } = makeApp();
    await setupAdmin(app);
    const noCode = await registerPersonal(app, {
      loginName: "abc",
      password: PERSONAL_PASSWORD,
    });
    expect(noCode.status).toBe(400);
    expect(((await noCode.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
    db.$client.close();
  });
});

describe("个人账号登录（模块 0）", () => {
  it("/personal/login 成功双 Cookie；/teacher/login 对个人账号也补发学生 Cookie", async () => {
    const { app, db } = makeApp();
    await setupAdmin(app);
    expect((await registerPersonal(app, VALID_REGISTER)).status).toBe(200);

    const login = await req(app, "POST", "/api/public/personal/login", {
      loginName: "kaosheng",
      password: PERSONAL_PASSWORD,
    });
    expect(login.status).toBe(200);
    expect(personalSessionOkSchema.safeParse(await login.json()).success).toBe(
      true,
    );
    const names = login.headers
      .getSetCookie()
      .map((c) => c.split("=")[0] ?? "");
    expect(names).toEqual(
      expect.arrayContaining(["tutor_session", "tutor_student_session"]),
    );

    const viaTeacher = await req(app, "POST", "/api/public/teacher/login", {
      loginName: "kaosheng",
      password: PERSONAL_PASSWORD,
    });
    expect(viaTeacher.status).toBe(200);
    const teacherLogin = teacherLoginOkSchema.parse(await viaTeacher.json());
    expect(teacherLogin.data.accountKind).toBe("personal");
    expect(teacherLogin.data.student?.accountKind).toBe("personal");
    assertNoLeak(teacherLogin);
    const viaTeacherNames = viaTeacher.headers
      .getSetCookie()
      .map((c) => c.split("=")[0] ?? "");
    expect(viaTeacherNames).toEqual(
      expect.arrayContaining(["tutor_session", "tutor_student_session"]),
    );
    const studentMe = await req(app, "GET", "/api/student/me", undefined, {
      cookie: cookieHeaderOf(viaTeacher),
    });
    expect(studentMe.status).toBe(200);
    expect(teacherLogin.data.student).toEqual(
      studentMeOkSchema.parse(await studentMe.json()).data,
    );
    db.$client.close();
  });

  it("班级教师凭证走 /personal/login → 403 ACCOUNT_KIND_MISMATCH，且不留任何会话", async () => {
    const { app, db } = makeApp();
    await setupAdmin(app);
    const before = db.select().from(sessions).all().length;
    const res = await req(app, "POST", "/api/public/personal/login", {
      loginName: "teacher",
      password: ADMIN_PASSWORD,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ApiErr).error).toBe("ACCOUNT_KIND_MISMATCH");
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(db.select().from(sessions).all().length).toBe(before);

    // 班级教师从教师入口登录：不带学生 Cookie（行为不变）
    const classLogin = await req(app, "POST", "/api/public/teacher/login", {
      loginName: "teacher",
      password: ADMIN_PASSWORD,
    });
    expect(classLogin.status).toBe(200);
    expect(
      classLogin.headers
        .getSetCookie()
        .some((c) => c.startsWith("tutor_student_session=")),
    ).toBe(false);
    db.$client.close();
  });

  it("密码错 → 401 INVALID_CREDENTIALS（与教师登录同口径）", async () => {
    const { app, db } = makeApp();
    await setupAdmin(app);
    expect((await registerPersonal(app, VALID_REGISTER)).status).toBe(200);
    const res = await req(app, "POST", "/api/public/personal/login", {
      loginName: "kaosheng",
      password: "wrong-password-1",
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ApiErr).error).toBe("INVALID_CREDENTIALS");
    db.$client.close();
  });
});

describe("管理端对个人账号的可见性（模块 0）", () => {
  it("教师列表带 accountKind；个人账号 studentCount=1（自身学习者行）", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    expect((await registerPersonal(app, VALID_REGISTER)).status).toBe(200);
    const list = await req(app, "GET", "/api/admin/teachers", undefined, {
      cookie: admin.cookie,
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: {
        teachers: {
          loginName: string;
          accountKind: string;
          studentCount: number;
        }[];
      };
    };
    const personal = body.data.teachers.find((t) => t.loginName === "kaosheng");
    expect(personal).toMatchObject({
      accountKind: "personal",
      studentCount: 1,
    });
    const cls = body.data.teachers.find((t) => t.loginName === "teacher");
    expect(cls).toMatchObject({ accountKind: "class" });
    db.$client.close();
  });
});

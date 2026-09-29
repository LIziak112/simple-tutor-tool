import type { ApiErr } from "@tutor/contract";
import {
  adminOverviewOkSchema,
  adminSettingsOkSchema,
  adminTeacherCreateOkSchema,
  adminTeacherUpdateOkSchema,
  apiErrSchema,
} from "@tutor/contract";
import { mkdirSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { hashPassword } from "../auth/password.ts";
import type { Db } from "../db/client.ts";
import { students, teachers } from "../db/schema.ts";
import { createTestDb, createTestDir, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { disableTeacher } from "../services/admin-service.ts";

/**
 * 管理端接口集成测试（T2B.6 验收项）：app.request() 直调路由 + 内存库。
 * 覆盖：requireAdmin 守卫（未登录 401 / 非管理员 403 ADMIN_ONLY）；管理员创建
 * （随机/自备密码、重名 409）；改登录名；授予撤销 isAdmin；重置密码；禁用
 * （会话立即 401、学生不受影响）/ 启用全流程；LAST_ADMIN 三分支；列表（学生数、
 * 状态筛选）；注册开关读写与 status 联动；概览计数。
 */

const silentLogger: Logger = pino({ enabled: false });
const ADMIN_PASSWORD = "admin-pass-888";
const YI_PASSWORD = "teacher-yi-888";

/** 组装被测应用：内存库 + 临时数据目录 */
function makeApp(): {
  app: ReturnType<typeof createApp>;
  db: Db;
  dataDir: string;
} {
  const db = createTestDb();
  const dataDir = createTestDir();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    dataDir,
    publicUrl: "http://localhost:8787",
  });
  return { app, db, dataDir };
}

/** JSON 请求助手（可带 Cookie / XFF） */
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

/** 首启建管理员（teacher，即种子占位行升级）并登录，返回 Cookie 头 */
async function setupAdmin(
  app: ReturnType<typeof createApp>,
): Promise<{ cookie: string }> {
  const res = await req(app, "POST", "/api/public/teacher/setup", {
    loginName: "teacher",
    password: ADMIN_PASSWORD,
  });
  expect(res.status).toBe(200);
  const token = res.headers
    .getSetCookie()
    .find((line) => line.toLowerCase().startsWith("tutor_session="))
    ?.split(";")[0];
  return { cookie: token ?? "" };
}

/** 经注册接口造一位普通教师并登录（独立 IP 避免限流计数叠加），返回 Cookie 头 */
async function registerAndLogin(
  app: ReturnType<typeof createApp>,
  loginName: string,
  ip: string,
): Promise<{ cookie: string }> {
  const res = await req(
    app,
    "POST",
    "/api/public/teacher/register",
    { loginName, password: YI_PASSWORD },
    { "x-forwarded-for": ip },
  );
  expect(res.status).toBe(200);
  const token = res.headers
    .getSetCookie()
    .find((line) => line.toLowerCase().startsWith("tutor_session="))
    ?.split(";")[0];
  return { cookie: token ?? "" };
}

/** 直写库造一位教师（绕过注册限流；LAST_ADMIN 服务级分支等用） */
async function seedTeacher(
  db: Db,
  row: {
    id: string;
    loginName: string;
    isAdmin: boolean;
    disabledAt?: string | null;
  },
  password: string,
): Promise<void> {
  db.insert(teachers)
    .values({
      id: row.id,
      loginName: row.loginName,
      isAdmin: row.isAdmin,
      disabledAt: row.disabledAt ?? null,
      passwordHash: await hashPassword(password),
      apiToken: null,
      createdAt: new Date().toISOString(),
    })
    .run();
}

describe("requireAdmin 守卫（挂载在 /api/admin/*，D7）", () => {
  it("未登录 → 401 UNAUTHORIZED", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/admin/teachers");
    expect(res.status).toBe(401);
    expect(((await res.json()) as ApiErr).error).toBe("UNAUTHORIZED");
  });

  it("非管理员教师（注册而来）访问全部管理接口 → 403 ADMIN_ONLY", async () => {
    const { app } = makeApp();
    await setupAdmin(app);
    const yi = await registerAndLogin(app, "李老师", "10.1.1.2");

    for (const [method, path, body] of [
      ["GET", "/api/admin/teachers", undefined],
      ["POST", "/api/admin/teachers", { loginName: "x老师", password: "x-pass-888" }],
      ["GET", "/api/admin/settings", undefined],
      ["PATCH", "/api/admin/settings", { allowRegistration: false }],
      ["GET", "/api/admin/overview", undefined],
      ["POST", "/api/admin/teachers/some-id/disable", undefined],
    ] as const) {
      const res = await req(app, method, path, body, { cookie: yi.cookie });
      expect(res.status, `${method} ${path}`).toBe(403);
      const body_ = (await res.json()) as ApiErr;
      expect(body_.error, `${method} ${path}`).toBe("ADMIN_ONLY");
    }
  });
});

describe("GET /api/admin/teachers（列表）", () => {
  it("返回 loginName/isAdmin/disabledAt/createdAt/学生数；按状态筛选", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    const yi = await registerAndLogin(app, "李老师", "10.1.1.2");
    // 乙建两名学生（其一归档也计入总数）
    for (const name of ["张三", "李四"]) {
      const res = await req(app, "POST", "/api/teacher/students", {
        displayName: name,
        loginName: name,
      }, { cookie: yi.cookie });
      expect(res.status).toBe(201);
    }

    // 甲禁用乙
    const yiRow = db
      .select()
      .from(teachers)
      .where(eq(teachers.loginName, "李老师"))
      .get();
    expect(yiRow).toBeDefined();
    const disabled = await req(
      app,
      "POST",
      `/api/admin/teachers/${yiRow?.id}/disable`,
      undefined,
      { cookie: admin.cookie },
    );
    expect(disabled.status).toBe(200);

    const all = await req(app, "GET", "/api/admin/teachers", undefined, {
      cookie: admin.cookie,
    });
    expect(all.status).toBe(200);
    const body = (await all.json()) as {
      data: { teachers: Array<Record<string, unknown>> };
    };
    expect(body.data.teachers).toHaveLength(2);
    const adminRow = body.data.teachers.find((t) => t.loginName === "teacher");
    const yiListed = body.data.teachers.find((t) => t.loginName === "李老师");
    expect(adminRow).toMatchObject({
      isAdmin: true,
      disabledAt: null,
      studentCount: 0,
    });
    expect(yiListed).toMatchObject({
      isAdmin: false,
      studentCount: 2,
    });
    expect(yiListed?.disabledAt).not.toBeNull();
    // 无内部凭证泄露
    expect(JSON.stringify(body)).not.toContain("scrypt$");
    expect(JSON.stringify(body)).not.toContain("passwordHash");

    // 状态筛选
    const active = await req(
      app,
      "GET",
      "/api/admin/teachers?status=active",
      undefined,
      { cookie: admin.cookie },
    );
    const activeBody = (await active.json()) as {
      data: { teachers: { loginName: string }[] };
    };
    expect(activeBody.data.teachers.map((t) => t.loginName)).toEqual(["teacher"]);
    const disabledList = await req(
      app,
      "GET",
      "/api/admin/teachers?status=disabled",
      undefined,
      { cookie: admin.cookie },
    );
    const disabledBody = (await disabledList.json()) as {
      data: { teachers: { loginName: string }[] };
    };
    expect(disabledBody.data.teachers.map((t) => t.loginName)).toEqual(["李老师"]);
    db.$client.close();
  });

  it("status 非法 → 400 VALIDATION_ERROR", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    const res = await req(
      app,
      "GET",
      "/api/admin/teachers?status=bogus",
      undefined,
      { cookie: admin.cookie },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
    db.$client.close();
  });
});

describe("POST /api/admin/teachers（管理员创建，D3 来源二）", () => {
  it("未提供密码：创建 isAdmin=false 教师，initialPassword 一次性返回（12 位满足策略）", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);

    const res = await req(app, "POST", "/api/admin/teachers", {
      loginName: "新老师",
    }, { cookie: admin.cookie });
    expect(res.status).toBe(201);
    const body = (await res.json()) as unknown;
    expect(adminTeacherCreateOkSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      data: {
        teacher: { loginName: "新老师", isAdmin: false, studentCount: 0 },
        initialPassword: expect.stringMatching(/^.{12}$/),
      },
    });
    // 生成的新密码能登录
    const password = (body as { data: { initialPassword: string } }).data
      .initialPassword;
    const login = await req(app, "POST", "/api/public/teacher/login", {
      loginName: "新老师",
      password,
    }, { "x-forwarded-for": "10.2.2.2" });
    expect(login.status).toBe(200);
    db.$client.close();
  });

  it("自备密码：initialPassword 为 null（管理员已知）；教师可用该密码登录", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    const res = await req(app, "POST", "/api/admin/teachers", {
      loginName: "自备密码老师",
      password: "given-pass-888",
    }, { cookie: admin.cookie });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { initialPassword: string | null } };
    expect(body.data.initialPassword).toBeNull();

    const login = await req(app, "POST", "/api/public/teacher/login", {
      loginName: "自备密码老师",
      password: "given-pass-888",
    }, { "x-forwarded-for": "10.2.2.3" });
    expect(login.status).toBe(200);
    db.$client.close();
  });

  it("重名 → 409 TEACHER_LOGIN_EXISTS，不落库", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    const res = await req(app, "POST", "/api/admin/teachers", {
      loginName: "teacher",
    }, { cookie: admin.cookie });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErr).error).toBe("TEACHER_LOGIN_EXISTS");
    expect(db.select().from(teachers).all()).toHaveLength(1);
    db.$client.close();
  });

  it("不受注册开关影响：开关关闭时管理员照常创建", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    await req(app, "PATCH", "/api/admin/settings", { allowRegistration: false }, {
      cookie: admin.cookie,
    });
    const res = await req(app, "POST", "/api/admin/teachers", {
      loginName: "关开关也能建",
    }, { cookie: admin.cookie });
    expect(res.status).toBe(201);
    db.$client.close();
  });
});

describe("PATCH /api/admin/teachers/:id（改登录名 / 授予撤销 isAdmin）", () => {
  it("改登录名成功且新名可登录；与他人重名 → 409", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    await registerAndLogin(app, "李老师", "10.3.1.2");
    const yiRow = db
      .select()
      .from(teachers)
      .where(eq(teachers.loginName, "李老师"))
      .get();

    const rename = await req(
      app,
      "PATCH",
      `/api/admin/teachers/${yiRow?.id}`,
      { loginName: "李老师改名" },
      { cookie: admin.cookie },
    );
    expect(rename.status).toBe(200);
    const body = (await rename.json()) as unknown;
    expect(adminTeacherUpdateOkSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ data: { loginName: "李老师改名" } });
    // 改名后用新登录名登录成功（旧名 401）
    const loginNew = await req(app, "POST", "/api/public/teacher/login", {
      loginName: "李老师改名",
      password: YI_PASSWORD,
    }, { "x-forwarded-for": "10.3.1.3" });
    expect(loginNew.status).toBe(200);
    const loginOld = await req(app, "POST", "/api/public/teacher/login", {
      loginName: "李老师",
      password: YI_PASSWORD,
    }, { "x-forwarded-for": "10.3.1.4" });
    expect(loginOld.status).toBe(401);

    // 重名冲突
    const conflict = await req(
      app,
      "PATCH",
      `/api/admin/teachers/${yiRow?.id}`,
      { loginName: "teacher" },
      { cookie: admin.cookie },
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as ApiErr).error).toBe(
      "TEACHER_LOGIN_EXISTS",
    );
    db.$client.close();
  });

  it("授予 isAdmin：普通教师升管理员后能访问 /api/admin/*", async () => {
    const { app, db } = makeApp();
    await setupAdmin(app);
    const yi = await registerAndLogin(app, "李老师", "10.3.2.2");
    const yiRow = db
      .select()
      .from(teachers)
      .where(eq(teachers.loginName, "李老师"))
      .get();

    const grant = await req(
      app,
      "PATCH",
      `/api/admin/teachers/${yiRow?.id}`,
      { isAdmin: true },
      { cookie: (await setupAdminAlready(app)) },
    );
    expect(grant.status).toBe(200);
    expect(((await grant.json()) as { data: { isAdmin: boolean } }).data.isAdmin)
      .toBe(true);

    // 乙现在能过 requireAdmin
    const probe = await app.request("/api/admin/overview", {
      headers: { cookie: yi.cookie },
    });
    expect(probe.status).toBe(200);
    db.$client.close();
  });

  it("撤销最后一位活跃管理员的 isAdmin → 409 LAST_ADMIN（自撤即失管理入口）", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    const res = await req(
      app,
      "PATCH",
      `/api/admin/teachers/${TEST_TEACHER_ID}`,
      { isAdmin: false },
      { cookie: admin.cookie },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("LAST_ADMIN");
    expect(apiErrSchema.safeParse(body).success).toBe(true);
    // isAdmin 未变
    expect(
      db.select().from(teachers).where(eq(teachers.id, TEST_TEACHER_ID)).get()
        ?.isAdmin,
    ).toBe(true);
    db.$client.close();
  });

  it("有另一位活跃管理员时撤销合法；空 PATCH（缺省字段）原样返回", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    await registerAndLogin(app, "李老师", "10.3.3.2");
    const yiRow = db
      .select()
      .from(teachers)
      .where(eq(teachers.loginName, "李老师"))
      .get();

    // 授予乙（此时有两名活跃管理员）再撤销乙 → 合法
    await req(app, "PATCH", `/api/admin/teachers/${yiRow?.id}`, { isAdmin: true }, {
      cookie: admin.cookie,
    });
    const revoke = await req(
      app,
      "PATCH",
      `/api/admin/teachers/${yiRow?.id}`,
      { isAdmin: false },
      { cookie: admin.cookie },
    );
    expect(revoke.status).toBe(200);
    expect(((await revoke.json()) as { data: { isAdmin: boolean } }).data.isAdmin)
      .toBe(false);

    // 空 body：字段缺省 = 不改
    const noop = await req(app, "PATCH", `/api/admin/teachers/${yiRow?.id}`, {}, {
      cookie: admin.cookie,
    });
    expect(noop.status).toBe(200);
    expect(((await noop.json()) as { data: { loginName: string } }).data.loginName)
      .toBe("李老师");
    db.$client.close();
  });

  it("目标不存在 → 404 TEACHER_NOT_FOUND", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    const res = await req(app, "PATCH", "/api/admin/teachers/no-such-id", {
      loginName: "改名",
    }, { cookie: admin.cookie });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErr).error).toBe("TEACHER_NOT_FOUND");
    db.$client.close();
  });
});

describe("POST /api/admin/teachers/:id/disable 与 enable（D5 全流程）", () => {
  it("禁自己 → 409 LAST_ADMIN（验收三分支之一）", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    const res = await req(
      app,
      "POST",
      `/api/admin/teachers/${TEST_TEACHER_ID}/disable`,
      undefined,
      { cookie: admin.cookie },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErr).error).toBe("LAST_ADMIN");
    db.$client.close();
  });

  it("禁最后一位活跃管理员 → 409 LAST_ADMIN（服务级分支：操作者是已禁用的管理员）", async () => {
    const { app, db } = makeApp();
    await setupAdmin(app);
    // 造两位管理员：甲活跃、乙已禁用（活跃管理员只剩甲）
    await seedTeacher(
      db,
      {
        id: "admin-off",
        loginName: "停用的管理员",
        isAdmin: true,
        disabledAt: new Date().toISOString(),
      },
      "off-pass-888",
    );
    // 乙（已禁用）尝试禁甲：甲是最后一位活跃管理员 → 409
    expect(() => disableTeacher(db, TEST_TEACHER_ID, "admin-off")).toThrowError(
      /至少需要一位/,
    );
    db.$client.close();
  });

  it("禁用乙：乙会话立即 401、乙学生照常登录；启用后完全恢复", async () => {
    const { app, db } = makeApp();
    // 两名管理员：甲 + 丙（保证禁乙不受 LAST_ADMIN 限制——乙本身非管理员）
    const admin = await setupAdmin(app);
    await seedTeacher(db, { id: "admin-bing", loginName: "丙管理员", isAdmin: true }, "bing-pass-888");
    const yi = await registerAndLogin(app, "李老师", "10.4.3.2");

    // 乙建一名带密码学生
    const stu = await req(app, "POST", "/api/teacher/students", {
      displayName: "张三",
      loginName: "张三",
      password: "stu-pass-666",
    }, { cookie: yi.cookie });
    expect(stu.status).toBe(201);

    const yiRow = db
      .select()
      .from(teachers)
      .where(eq(teachers.loginName, "李老师"))
      .get();

    // 禁用前乙会话有效
    const before = await app.request("/api/teacher/me", {
      headers: { cookie: yi.cookie },
    });
    expect(before.status).toBe(200);

    const disable = await req(
      app,
      "POST",
      `/api/admin/teachers/${yiRow?.id}/disable`,
      undefined,
      { cookie: admin.cookie },
    );
    expect(disable.status).toBe(200);
    expect(
      ((await disable.json()) as { data: { disabledAt: string | null } }).data
        .disabledAt,
    ).not.toBeNull();

    // 禁用即吊销存量会话（D5）：乙的旧 Cookie 下一请求 401
    const after = await app.request("/api/teacher/me", {
      headers: { cookie: yi.cookie },
    });
    expect(after.status).toBe(401);

    // 乙本人密码登录 → 403 ACCOUNT_DISABLED
    const loginDisabled = await req(app, "POST", "/api/public/teacher/login", {
      loginName: "李老师",
      password: YI_PASSWORD,
    }, { "x-forwarded-for": "10.4.3.9" });
    expect(loginDisabled.status).toBe(403);
    expect(((await loginDisabled.json()) as ApiErr).error).toBe(
      "ACCOUNT_DISABLED",
    );

    // 乙的学生不受影响：照常密码登录
    const studentLogin = await req(
      app,
      "POST",
      "/api/public/student/login",
      { loginName: "张三", password: "stu-pass-666" },
      { "x-forwarded-for": "10.4.3.10" },
    );
    expect(studentLogin.status).toBe(200);
    // 学生行与数据全保留（D5：禁用不是删除）
    expect(
      db.select().from(students).where(eq(students.loginName, "张三")).all(),
    ).toHaveLength(1);

    // 重复禁用幂等（已禁用再禁：状态原样返回）
    const disableAgain = await req(
      app,
      "POST",
      `/api/admin/teachers/${yiRow?.id}/disable`,
      undefined,
      { cookie: admin.cookie },
    );
    expect(disableAgain.status).toBe(200);

    // 启用：完全恢复（原密码可登录、会话可用）
    const enable = await req(
      app,
      "POST",
      `/api/admin/teachers/${yiRow?.id}/enable`,
      undefined,
      { cookie: admin.cookie },
    );
    expect(enable.status).toBe(200);
    expect(
      ((await enable.json()) as { data: { disabledAt: string | null } }).data
        .disabledAt,
    ).toBeNull();
    const loginBack = await req(app, "POST", "/api/public/teacher/login", {
      loginName: "李老师",
      password: YI_PASSWORD,
    }, { "x-forwarded-for": "10.4.3.11" });
    expect(loginBack.status).toBe(200);
    db.$client.close();
  });

  it("禁/启用目标不存在 → 404 TEACHER_NOT_FOUND", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    for (const action of ["disable", "enable"]) {
      const res = await req(
        app,
        "POST",
        `/api/admin/teachers/no-such-id/${action}`,
        undefined,
        { cookie: admin.cookie },
      );
      expect(res.status).toBe(404);
      expect(((await res.json()) as ApiErr).error).toBe("TEACHER_NOT_FOUND");
    }
    db.$client.close();
  });
});

describe("POST /api/admin/teachers/:id/reset-password", () => {
  it("未提供密码：返回一次性随机新密码，旧密码失效、新密码可登录", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    await registerAndLogin(app, "李老师", "10.5.1.2");
    const yiRow = db
      .select()
      .from(teachers)
      .where(eq(teachers.loginName, "李老师"))
      .get();

    const res = await req(
      app,
      "POST",
      `/api/admin/teachers/${yiRow?.id}/reset-password`,
      {},
      { cookie: admin.cookie },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { password: string } };
    expect(body.data.password).toMatch(/^.{12}$/);

    const oldLogin = await req(app, "POST", "/api/public/teacher/login", {
      loginName: "李老师",
      password: YI_PASSWORD,
    }, { "x-forwarded-for": "10.5.1.3" });
    expect(oldLogin.status).toBe(401);
    const newLogin = await req(app, "POST", "/api/public/teacher/login", {
      loginName: "李老师",
      password: body.data.password,
    }, { "x-forwarded-for": "10.5.1.4" });
    expect(newLogin.status).toBe(200);
    db.$client.close();
  });

  it("自备密码按提供值重置", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    await registerAndLogin(app, "李老师", "10.5.2.2");
    const yiRow = db
      .select()
      .from(teachers)
      .where(eq(teachers.loginName, "李老师"))
      .get();
    const res = await req(
      app,
      "POST",
      `/api/admin/teachers/${yiRow?.id}/reset-password`,
      { password: "reset-given-888" },
      { cookie: admin.cookie },
    );
    expect(res.status).toBe(200);
    const login = await req(app, "POST", "/api/public/teacher/login", {
      loginName: "李老师",
      password: "reset-given-888",
    }, { "x-forwarded-for": "10.5.2.3" });
    expect(login.status).toBe(200);
    db.$client.close();
  });

  it("目标不存在 → 404", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    const res = await req(
      app,
      "POST",
      "/api/admin/teachers/no-such-id/reset-password",
      {},
      { cookie: admin.cookie },
    );
    expect(res.status).toBe(404);
    db.$client.close();
  });
});

describe("GET/PATCH /api/admin/settings（注册开关，D8）", () => {
  it("默认开；PATCH false → 关（响应回显），status 与注册接口联动", async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);

    const before = await req(app, "GET", "/api/admin/settings", undefined, {
      cookie: admin.cookie,
    });
    const beforeBody = (await before.json()) as unknown;
    expect(adminSettingsOkSchema.safeParse(beforeBody).success).toBe(true);
    expect(beforeBody).toMatchObject({ data: { allowRegistration: true } });

    const patch = await req(
      app,
      "PATCH",
      "/api/admin/settings",
      { allowRegistration: false },
      { cookie: admin.cookie },
    );
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { data: { allowRegistration: boolean } }).data)
      .toMatchObject({ allowRegistration: false });

    // status 联动（关态）+ 注册被拒
    const status = await app.request("/api/public/teacher/status");
    expect(((await status.json()) as { data: { registrationOpen: boolean } }).data)
      .toMatchObject({ registrationOpen: false });
    const register = await req(
      app,
      "POST",
      "/api/public/teacher/register",
      { loginName: "被拒的老师", password: "some-pass-888" },
      { "x-forwarded-for": "10.6.1.5" },
    );
    expect(register.status).toBe(403);
    expect(((await register.json()) as ApiErr).error).toBe(
      "REGISTRATION_DISABLED",
    );

    // 再开回来
    const reopen = await req(
      app,
      "PATCH",
      "/api/admin/settings",
      { allowRegistration: true },
      { cookie: admin.cookie },
    );
    expect(((await reopen.json()) as { data: { allowRegistration: boolean } }).data)
      .toMatchObject({ allowRegistration: true });
    db.$client.close();
  });
});

describe("GET /api/admin/overview（D20：聚合计数，无明细）", () => {
  it("返回六项计数/布尔；共享目录计数随 DATA_DIR/shared 的 .md 文件数", async () => {
    const { app, db, dataDir } = makeApp();
    const admin = await setupAdmin(app);
    await registerAndLogin(app, "李老师", "10.7.1.2");

    const empty = await req(app, "GET", "/api/admin/overview", undefined, {
      cookie: admin.cookie,
    });
    const emptyBody = (await empty.json()) as unknown;
    expect(adminOverviewOkSchema.safeParse(emptyBody).success).toBe(true);
    expect(emptyBody).toMatchObject({
      data: {
        teacherCount: 2,
        activeTeacherCount: 2,
        studentCount: 0,
        attemptCount: 0,
        sharedFileCount: 0,
        registrationOpen: true,
      },
    });

    // 放两个文件进共享目录（含一个非 .md）：只数 .md
    mkdirSync(`${dataDir}/shared`, { recursive: true });
    writeFileSync(`${dataDir}/shared/单元-a.md`, "# a");
    writeFileSync(`${dataDir}/shared/单元-b.md`, "# b");
    writeFileSync(`${dataDir}/shared/meta.json`, "{}");

    const after = await req(app, "GET", "/api/admin/overview", undefined, {
      cookie: admin.cookie,
    });
    expect(((await after.json()) as { data: { sharedFileCount: number } }).data)
      .toMatchObject({ sharedFileCount: 2 });
    db.$client.close();
  });
});

/** setupAdmin 的重入包装（授予用例里再次取管理员 Cookie） */
async function setupAdminAlready(
  app: ReturnType<typeof createApp>,
): Promise<string> {
  const res = await req(app, "POST", "/api/public/teacher/login", {
    loginName: "teacher",
    password: ADMIN_PASSWORD,
  }, { "x-forwarded-for": "10.3.2.9" });
  expect(res.status).toBe(200);
  return (
    res.headers
      .getSetCookie()
      .find((line) => line.toLowerCase().startsWith("tutor_session="))
      ?.split(";")[0] ?? ""
  );
}

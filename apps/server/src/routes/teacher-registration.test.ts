import type { ApiErr } from "@tutor/contract";
import {
  apiErrSchema,
  teacherInfoOkSchema,
  teacherStatusOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTeacherSession } from "../auth/session.ts";
import type { Db } from "../db/client.ts";
import { appSettings, loginFailures, teachers } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";

/**
 * 教师自助注册接口集成测试（T2B.6 验收项）：app.request() 直调路由 + 内存库。
 * - 成功注册：isAdmin=false + 自动登录（Cookie 直接可用）+ 名下无资源（内容树为空）；
 * - 开关关 → 403 REGISTRATION_DISABLED，且 status.registrationOpen 联动两态；
 * - 无教师行（未 setup）→ 409 TEACHER_NOT_EXISTS；
 * - 重名 → 409 TEACHER_LOGIN_EXISTS；
 * - IP 限流 reg:ip:<IP>：第 6 次 → 429 LOCKED，换 IP 不受影响；
 * - 密码/登录名不满足契约 → 400 VALIDATION_ERROR。
 */

const silentLogger: Logger = pino({ enabled: false });
const ADMIN_PASSWORD = "admin-pass-888";
const NEW_PASSWORD = "self-reg-pass-8";

/** 组装被测应用：内存库（种子是无密码占位教师行 = 首启未做，与全新库一致） */
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

/** 发 JSON POST（可带额外请求头：X-Forwarded-For 模拟不同 IP） */
async function register(
  app: ReturnType<typeof createApp>,
  body: unknown,
  ip = "10.0.0.1",
): Promise<Response> {
  return app.request("/api/public/teacher/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

/** 首启 setup 建首位教师（必然管理员），返回其 id */
async function setupFirstTeacher(
  app: ReturnType<typeof createApp>,
): Promise<string> {
  const res = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "teacher", password: ADMIN_PASSWORD }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { id: string } };
  return body.data.id;
}

/** 关闭/打开注册开关（直写库，等价于管理员经 /api/admin/settings 的最终落库形态） */
function setSwitch(db: Db, open: boolean): void {
  const value = open ? "true" : "false";
  db.update(appSettings)
    .set({ value })
    .where(eq(appSettings.key, "allowRegistration"))
    .run();
}

describe("POST /api/public/teacher/register（T2B.6，D3 来源一）", () => {
  it("成功：isAdmin=false + 写会话 Cookie（自动登录）+ 库中教师行正确，响应无哈希/密码", async () => {
    const { app, db } = makeApp();
    await setupFirstTeacher(app);

    const res = await register(app, {
      loginName: "王老师",
      password: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(teacherInfoOkSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      ok: true,
      data: { loginName: "王老师", isAdmin: false },
    });
    expect(JSON.stringify(body)).not.toContain("scrypt$");
    expect(JSON.stringify(body)).not.toContain(NEW_PASSWORD);
    // Cookie 下发（自动登录）
    expect(
      res.headers
        .getSetCookie()
        .some((line) => line.toLowerCase().startsWith("tutor_session=")),
    ).toBe(true);

    // 库中：两位教师，第二位 isAdmin=false
    const rows = db.select().from(teachers).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.loginName === "王老师")).toMatchObject({
      isAdmin: false,
      disabledAt: null,
    });
    db.$client.close();
  });

  it("注册成功即自动登录：返回的 Cookie 能直接访问 me 与内容树（名下无任何资源）", async () => {
    const { app, db } = makeApp();
    await setupFirstTeacher(app);
    const res = await register(app, {
      loginName: "李老师",
      password: NEW_PASSWORD,
    });
    const token = res.headers
      .getSetCookie()
      .find((line) => line.toLowerCase().startsWith("tutor_session="))
      ?.split(";")[0];
    expect(token).toBeDefined();
    const cookie = { cookie: token ?? "" };

    const me = await app.request("/api/teacher/me", { headers: cookie });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as {
      data: { loginName: string; isAdmin: boolean };
    };
    expect(meBody.data).toMatchObject({ loginName: "李老师", isAdmin: false });

    // 新教师名下无资源：内容树为空（域隔离下与首位教师完全隔离）
    const tree = await app.request("/api/teacher/content", {
      headers: cookie,
    });
    expect(tree.status).toBe(200);
    const treeBody = (await tree.json()) as {
      data: { courses: unknown[] };
    };
    expect(treeBody.data.courses).toEqual([]);
    db.$client.close();
  });

  it("注册开关关闭 → 403 REGISTRATION_DISABLED（文案明示联系管理员）", async () => {
    const { app, db } = makeApp();
    await setupFirstTeacher(app);
    setSwitch(db, false);

    const res = await register(app, {
      loginName: "赵老师",
      password: NEW_PASSWORD,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("REGISTRATION_DISABLED");
    expect(body.message).toContain("注册已关闭");
    expect(apiErrSchema.safeParse(body).success).toBe(true);
    // 不落库
    expect(db.select().from(teachers).all()).toHaveLength(1);
    db.$client.close();
  });

  it("无教师行（首启未做）→ 409 TEACHER_NOT_EXISTS，引导走 setup", async () => {
    const { app, db } = makeApp();
    // 种子库只有无密码占位行：hasTeacher=false（与全新部署一致）
    const res = await register(app, {
      loginName: "钱老师",
      password: NEW_PASSWORD,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("TEACHER_NOT_EXISTS");
    // 不落库（占位行原样，没有新增教师）
    expect(db.select().from(teachers).all()).toHaveLength(1);
    db.$client.close();
  });

  it("登录名冲突 → 409 TEACHER_LOGIN_EXISTS（与存量教师重名）", async () => {
    const { app, db } = makeApp();
    await setupFirstTeacher(app);

    const res = await register(app, {
      loginName: "teacher",
      password: NEW_PASSWORD,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErr).error).toBe("TEACHER_LOGIN_EXISTS");
    expect(db.select().from(teachers).all()).toHaveLength(1);
    db.$client.close();
  });

  it("IP 限流：同 IP 第 6 次 → 429 LOCKED（前 5 次含成功均计额）；换 IP 不受影响", async () => {
    const { app, db } = makeApp();
    await setupFirstTeacher(app);

    // 前 5 次：注册 + 重名拒绝混计（额度按尝试计，不分成败）
    for (let i = 1; i <= 4; i++) {
      const res = await register(app, {
        loginName: `老师${i}号`,
        password: NEW_PASSWORD,
      });
      expect(res.status).toBe(200);
    }
    const duplicate = await register(app, {
      loginName: "老师1号", // 重名 → 409，也消耗额度
      password: NEW_PASSWORD,
    });
    expect(duplicate.status).toBe(409);

    // 第 6 次（同 IP，密码登录名均合法）→ 429
    const locked = await register(app, {
      loginName: "老师6号",
      password: NEW_PASSWORD,
    });
    expect(locked.status).toBe(429);
    const body = (await locked.json()) as ApiErr;
    expect(body.error).toBe("LOCKED");
    // 不泄露限流维度
    expect(body.message).not.toMatch(/ip/i);

    // 限流表：reg:ip: 键计数为 5 且锁定；与登录 key（ip:/name:）互不污染
    const rows = db.select().from(loginFailures).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "reg:ip:10.0.0.1", count: 5 });

    // 换 IP 不受影响：正常注册成功
    const other = await register(
      app,
      { loginName: "换个IP的老师", password: NEW_PASSWORD },
      "10.0.0.2",
    );
    expect(other.status).toBe(200);
    db.$client.close();
  });

  it("登录名/密码不满足契约 → 400 VALIDATION_ERROR（不消耗限流额度）", async () => {
    const { app, db } = makeApp();
    await setupFirstTeacher(app);

    for (const bad of [
      { loginName: "a", password: NEW_PASSWORD }, // 登录名过短
      { loginName: "a/b", password: NEW_PASSWORD }, // 登录名非法字符
      { loginName: "合法名", password: "short" }, // 密码过短
    ]) {
      const res = await register(app, bad);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
    }
    // 契约拦截在 parseJsonBody，未进入 service：限流表无记录
    expect(db.select().from(loginFailures).all()).toHaveLength(0);
    db.$client.close();
  });

  it("开关两态与 status 联动（D8）：有教师 + 开关开 → registrationOpen=true；关 → false", async () => {
    const { app, db } = makeApp();
    await setupFirstTeacher(app);

    const open = await app.request("/api/public/teacher/status");
    const openBody = (await open.json()) as { data: unknown };
    expect(teacherStatusOkSchema.safeParse(openBody).success).toBe(true);
    expect(openBody.data).toEqual({ hasTeacher: true, registrationOpen: true });

    setSwitch(db, false);
    const closed = await app.request("/api/public/teacher/status");
    const closedBody = (await closed.json()) as { data: unknown };
    expect(closedBody.data).toEqual({
      hasTeacher: true,
      registrationOpen: false,
    });
    db.$client.close();
  });

  it("无教师行时 status：hasTeacher=false 且 registrationOpen 恒 false（即使开关行缺失/为 true）", async () => {
    const { app, db } = makeApp();
    // 全新库（app_settings 由回填写入 'true'，但无教师 → 恒 false）
    const res = await app.request("/api/public/teacher/status");
    const body = (await res.json()) as { data: unknown };
    expect(body.data).toEqual({ hasTeacher: false, registrationOpen: false });
    db.$client.close();
  });

  it("注册的教师用密码正常登录（登录链路与注册互验）", async () => {
    const { app, db } = makeApp();
    await setupFirstTeacher(app);
    await register(app, { loginName: "孙老师", password: NEW_PASSWORD });

    const login = await app.request("/api/public/teacher/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "10.0.0.9",
      },
      body: JSON.stringify({ loginName: "孙老师", password: NEW_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const body = (await login.json()) as { data: { isAdmin: boolean } };
    expect(body.data.isAdmin).toBe(false);
    db.$client.close();
  });
});

describe("注册与既有会话互不干扰", () => {
  it("注册第二位教师不影响首位教师的存量会话", async () => {
    const { app, db } = makeApp();
    const adminId = await setupFirstTeacher(app);
    const { token } = createTeacherSession(db, adminId);

    await register(app, { loginName: "周老师", password: NEW_PASSWORD });

    const me = await app.request("/api/teacher/me", {
      headers: { cookie: `tutor_session=${token}` },
    });
    expect(me.status).toBe(200);
    db.$client.close();
  });
});

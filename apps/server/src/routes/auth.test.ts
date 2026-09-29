import type { ApiErr } from "@tutor/contract";
import {
  apiErrSchema,
  teacherInfoOkSchema,
  teacherStatusOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { hashPassword } from "../auth/password.ts";
import {
  createRequireAdmin,
  type TeacherEnv,
} from "../auth/require-teacher.ts";
import { createTeacherSession } from "../auth/session.ts";
import type { Db } from "../db/client.ts";
import { loginFailures, sessions, teachers } from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";

/**
 * 教师鉴权接口集成测试（T1.9 验收项；T2B.2 起覆盖登录名登录、管理员角色、
 * 禁用语义与管理员守卫），app.request() 直调路由 + 内存库：
 * 重复 setup 被拒；错误登录名/密码统一 401 防枚举；正确凭证但被禁用 403；
 * 禁用即吊销存量会话；错误密码 5 次后锁定（按登录名与 IP 双 key 计数）；
 * 未登录访问 /api/teacher/* 返回 401；会话过期 401；Cookie 属性
 * （httpOnly / SameSite=Lax / Path=/ / Secure 随 PUBLIC_URL）；
 * logout 后 me 401；status 探测；学生/伪造会话不能过教师守卫。
 */

const silentLogger: Logger = pino({ enabled: false });
const PASSWORD = "teacher-pass-8";
const WRONG_PASSWORD = "wrong-pass-8";
/** 与 createTestDb 种子行一致的登录名（T2B.1 回填后存量教师即此名） */
const LOGIN_NAME = "teacher";

/** 组装被测应用：内存库 + 可指定 PUBLIC_URL（Cookie Secure 断言用） */
function makeApp(publicUrl = "http://localhost:8787"): {
  app: ReturnType<typeof createApp>;
  db: Db;
} {
  const db = createTestDb();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    dataDir: createTestDir(),
    publicUrl,
  });
  return { app, db };
}

/** 从响应头拼出 set-cookie 串（兼容多 cookie） */
function setCookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((line) => line.toLowerCase())
    .join("\n");
}

/** 从 set-cookie 里取出 tutor_session 的值（token） */
function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) {
    throw new Error("响应中没有 tutor_session cookie");
  }
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

/** 在指定 app 上发 JSON POST（可带额外请求头：Cookie、X-Forwarded-For 等） */
async function jsonRequestOn(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** 造一位教师行（T2B.6 前无第二个创建入口，测试直写库；限流/守卫分支用） */
async function seedTeacher(
  db: Db,
  row: {
    id: string;
    loginName: string;
    isAdmin?: boolean;
    disabledAt?: string | null;
  },
  password: string,
): Promise<void> {
  db.insert(teachers)
    .values({
      id: row.id,
      loginName: row.loginName,
      isAdmin: row.isAdmin ?? false,
      disabledAt: row.disabledAt ?? null,
      passwordHash: await hashPassword(password),
      apiToken: null,
      createdAt: new Date().toISOString(),
    })
    .run();
}

describe("GET /api/public/teacher/status", () => {
  it("初始 hasTeacher=false 且 registrationOpen 恒 false；设置后 hasTeacher=true 且开关联动真值", async () => {
    const { app } = makeApp();
    const before = await app.request("/api/public/teacher/status");
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as { ok: boolean; data: unknown };
    expect(teacherStatusOkSchema.safeParse(beforeBody).success).toBe(true);
    expect(beforeBody.data).toEqual({
      hasTeacher: false,
      // 无教师行时恒 false（D8，即使 app_settings 开关为 true）
      registrationOpen: false,
    });

    await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });

    const after = await app.request("/api/public/teacher/status");
    const afterBody = (await after.json()) as { data: unknown };
    expect(afterBody.data).toEqual({
      hasTeacher: true,
      // T2B.6 起 registrationOpen 接 app_settings 真值（初始键默认开）
      registrationOpen: true,
    });
    // 无泄露：响应只含布尔，不出现哈希等内部信息
    expect(JSON.stringify(afterBody)).not.toContain("scrypt$");
  });
});

describe("POST /api/public/teacher/setup", () => {
  it("成功：200 + 教师信息（loginName/isAdmin）+ 写入会话 Cookie，响应不含密码哈希", async () => {
    const { app } = makeApp();
    const res = await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(teacherInfoOkSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      ok: true,
      data: {
        id: TEST_TEACHER_ID,
        loginName: LOGIN_NAME,
        isAdmin: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(JSON.stringify(body)).not.toContain("scrypt$");
    expect(JSON.stringify(body)).not.toContain(PASSWORD);

    // Cookie：httpOnly + SameSite=Lax + Path=/；http 环境不加 Secure；
    // Max-Age=7 天（604800 秒）——必须是持久化 Cookie，否则浏览器一关登录态就丢
    const cookie = setCookieHeader(res);
    expect(cookie).toContain("tutor_session=");
    expect(cookie).toContain("httponly");
    expect(cookie).toContain("samesite=lax");
    expect(cookie).toContain("path=/");
    expect(cookie).toContain("max-age=604800");
    expect(cookie).not.toContain("secure");
  });

  it("setup 后用返回的 Cookie 能直接访问 me（自动登录，me 返回完整账号信息）", async () => {
    const { app } = makeApp();
    const setup = await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });
    const token = extractSessionToken(setup);

    const me = await app.request("/api/teacher/me", {
      headers: { cookie: `tutor_session=${token}` },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as {
      data: { id: string; loginName: string; isAdmin: boolean };
    };
    expect(meBody.data.id).toBe(TEST_TEACHER_ID);
    expect(meBody.data.loginName).toBe(LOGIN_NAME);
    expect(meBody.data.isAdmin).toBe(true);
  });

  it("重复 setup 返回 409 TEACHER_EXISTS（验收项）", async () => {
    const { app } = makeApp();
    await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });
    const again = await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: "别的老师",
      password: "another-pass-8",
    });

    expect(again.status).toBe(409);
    const body = (await again.json()) as ApiErr;
    expect(body.error).toBe("TEACHER_EXISTS");
    expect(apiErrSchema.safeParse(body).success).toBe(true);
  });

  it("登录名与其他教师行冲突 → 409 TEACHER_LOGIN_EXISTS（D3 口径，T2B.6 注册沿用）", async () => {
    const { app, db } = makeApp();
    // 首行仍是种子的无密码占位行（setup 可用）；另造一位已设密码的教师撞名
    await seedTeacher(
      db,
      { id: "teacher-other", loginName: "王老师" },
      "other-pass-8",
    );

    const res = await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: "王老师",
      password: PASSWORD,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErr).error).toBe("TEACHER_LOGIN_EXISTS");
  });

  it("登录名不满足策略（含空格 / 过短）返回 400 VALIDATION_ERROR", async () => {
    const { app } = makeApp();
    for (const loginName of ["张 三", "a"]) {
      const res = await jsonRequestOn(app, "/api/public/teacher/setup", {
        loginName,
        password: PASSWORD,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
    }
  });

  it("密码不满足策略（<8 字符）返回 400 VALIDATION_ERROR", async () => {
    const { app } = makeApp();
    const res = await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: "short",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toContain("8");
  });

  it("请求体不是 JSON 返回 400 VALIDATION_ERROR", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/public/teacher/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json{{{",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/public/teacher/login（登录名 + 密码，D6）", () => {
  it("未设置教师时登录返回 401 INVALID_CREDENTIALS（与密码错误同码，防枚举）", async () => {
    const { app } = makeApp();
    const res = await jsonRequestOn(app, "/api/public/teacher/login", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ApiErr).error).toBe("INVALID_CREDENTIALS");
  });

  it("正确登录名+密码：200 + 新会话 Cookie + me 可用 + 返回 isAdmin", async () => {
    const { app } = makeApp();
    await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });

    const res = await jsonRequestOn(app, "/api/public/teacher/login", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { loginName: string; isAdmin: boolean };
    };
    expect(teacherInfoOkSchema.safeParse(body).success).toBe(true);
    expect(body.data.loginName).toBe(LOGIN_NAME);
    expect(body.data.isAdmin).toBe(true);

    const token = extractSessionToken(res);
    const me = await app.request("/api/teacher/me", {
      headers: { cookie: `tutor_session=${token}` },
    });
    expect(me.status).toBe(200);
  });

  it("存量教师迁移后凭 teacher + 原密码直接登录（T2B.1 回填形态的服务级固化）", async () => {
    const { app, db } = makeApp();
    // 模拟 T2B.1 迁移后的唯一教师行：loginName='teacher'、isAdmin=true、
    // 密码哈希仍是部署者原密码的哈希（迁移不动 passwordHash）
    db.update(teachers)
      .set({ passwordHash: await hashPassword(PASSWORD) })
      .where(eq(teachers.id, TEST_TEACHER_ID))
      .run();

    const res = await jsonRequestOn(app, "/api/public/teacher/login", {
      loginName: "teacher",
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { loginName: string; isAdmin: boolean };
    };
    expect(body.data.loginName).toBe("teacher");
    expect(body.data.isAdmin).toBe(true);
  });

  it("错误登录名与错误密码均 401 INVALID_CREDENTIALS，错误码与文案一致（防枚举）", async () => {
    const { app } = makeApp();
    await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });

    const wrongName = await jsonRequestOn(
      app,
      "/api/public/teacher/login",
      { loginName: "不存在的老师", password: PASSWORD },
      { "x-forwarded-for": "10.0.0.1" },
    );
    const wrongPassword = await jsonRequestOn(
      app,
      "/api/public/teacher/login",
      { loginName: LOGIN_NAME, password: WRONG_PASSWORD },
      { "x-forwarded-for": "10.0.0.2" },
    );

    expect(wrongName.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    const errName = (await wrongName.json()) as ApiErr;
    const errPassword = (await wrongPassword.json()) as ApiErr;
    expect(errName.error).toBe("INVALID_CREDENTIALS");
    expect(errPassword.error).toBe("INVALID_CREDENTIALS");
    expect(errName.message).toBe(errPassword.message);
  });

  it("正确凭证但教师已禁用 → 403 ACCOUNT_DISABLED；验密失败仍 401 且不计入禁用分支", async () => {
    const { app, db } = makeApp();
    await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });
    db.update(teachers)
      .set({ disabledAt: new Date().toISOString() })
      .where(eq(teachers.id, TEST_TEACHER_ID))
      .run();

    const disabled = await jsonRequestOn(app, "/api/public/teacher/login", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });
    expect(disabled.status).toBe(403);
    const body = (await disabled.json()) as ApiErr;
    expect(body.error).toBe("ACCOUNT_DISABLED");
    expect(body.message).toContain("停用");

    // 验密失败优先于禁用判断：仍是 401 统一口径（防枚举）
    const wrongPassword = await jsonRequestOn(
      app,
      "/api/public/teacher/login",
      {
        loginName: LOGIN_NAME,
        password: WRONG_PASSWORD,
      },
    );
    expect(wrongPassword.status).toBe(401);
    expect(((await wrongPassword.json()) as ApiErr).error).toBe(
      "INVALID_CREDENTIALS",
    );
    // 正确凭证 + 禁用不计失败限流（只有错误密码这一次计了 name/ip 两个 key）
    const rows = db.select().from(loginFailures).all();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.count).toBe(1);
      expect(row.lockedUntil).toBeNull();
    }
  });

  it("错误密码 5 次后锁定：第 6 次即使密码正确也返回 429 LOCKED（验收项）", async () => {
    const { app, db } = makeApp();
    await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });

    for (let i = 0; i < 5; i++) {
      const res = await jsonRequestOn(app, "/api/public/teacher/login", {
        loginName: LOGIN_NAME,
        password: WRONG_PASSWORD,
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as ApiErr).error).toBe("INVALID_CREDENTIALS");
    }

    const locked = await jsonRequestOn(app, "/api/public/teacher/login", {
      loginName: LOGIN_NAME,
      password: PASSWORD, // 正确密码也被锁
    });
    expect(locked.status).toBe(429);
    const body = (await locked.json()) as ApiErr;
    expect(body.error).toBe("LOCKED");
    // 不泄露锁定维度（name/ip）与教师存在性等额外信息
    expect(body.message).not.toMatch(/ip|登录名/i);

    // 双 key（name + ip）都已计数到 5
    const rows = db.select().from(loginFailures).all();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.count).toBe(5);
      expect(row.lockedUntil).not.toBeNull();
    }
  });

  it("限流按登录名计数：甲失败 5 次锁定不影响乙正常登录（D6：key=name:<loginName>）", async () => {
    const { app, db } = makeApp();
    await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });
    // 造第二位教师乙（T2B.6 前无创建入口，直写库）
    const YI_PASSWORD = "teacher-b-pass-8";
    await seedTeacher(
      db,
      { id: "teacher-yi", loginName: "李老师", isAdmin: false },
      YI_PASSWORD,
    );

    // 甲（teacher）连续失败 5 次（独立 IP，避免 ip key 污染乙）→ 锁定
    for (let i = 0; i < 5; i++) {
      const res = await jsonRequestOn(
        app,
        "/api/public/teacher/login",
        { loginName: LOGIN_NAME, password: WRONG_PASSWORD },
        { "x-forwarded-for": "10.1.0.1" },
      );
      expect(res.status).toBe(401);
    }
    const locked = await jsonRequestOn(
      app,
      "/api/public/teacher/login",
      { loginName: LOGIN_NAME, password: PASSWORD },
      { "x-forwarded-for": "10.1.0.1" },
    );
    expect(locked.status).toBe(429);

    // 乙不受甲影响：name key 独立，正确凭证照常登录并返回 isAdmin=false
    const yi = await jsonRequestOn(
      app,
      "/api/public/teacher/login",
      { loginName: "李老师", password: YI_PASSWORD },
      { "x-forwarded-for": "10.1.0.2" },
    );
    expect(yi.status).toBe(200);
    const yiBody = (await yi.json()) as {
      data: { loginName: string; isAdmin: boolean };
    };
    expect(yiBody.data.loginName).toBe("李老师");
    expect(yiBody.data.isAdmin).toBe(false);
  });

  it("锁过期后能重新登录，且成功清零失败记录", async () => {
    const { app, db } = makeApp();
    await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });
    for (let i = 0; i < 5; i++) {
      await jsonRequestOn(app, "/api/public/teacher/login", {
        loginName: LOGIN_NAME,
        password: WRONG_PASSWORD,
      });
    }

    // 把两条记录的锁拨回过去，模拟等了 10 分钟
    db.update(loginFailures)
      .set({ lockedUntil: new Date(Date.now() - 1000).toISOString() })
      .run();

    const res = await jsonRequestOn(app, "/api/public/teacher/login", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    // 成功登录清零：login_failures 表被清空
    expect(db.select().from(loginFailures).all()).toHaveLength(0);
  });

  it("部分失败后成功登录也会清零：再失败从 0 计数", async () => {
    const { app, db } = makeApp();
    await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });
    for (let i = 0; i < 3; i++) {
      await jsonRequestOn(app, "/api/public/teacher/login", {
        loginName: LOGIN_NAME,
        password: WRONG_PASSWORD,
      });
    }
    const ok = await jsonRequestOn(app, "/api/public/teacher/login", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });
    expect(ok.status).toBe(200);
    expect(db.select().from(loginFailures).all()).toHaveLength(0);

    // 再错 4 次不会锁（若未清零，第 2 次就到 5 了）
    for (let i = 0; i < 4; i++) {
      const res = await jsonRequestOn(app, "/api/public/teacher/login", {
        loginName: LOGIN_NAME,
        password: WRONG_PASSWORD,
      });
      expect(res.status).toBe(401);
    }
  });
});

describe("GET /api/teacher/me 守卫（验收项：未登录 401）", () => {
  it("未带 Cookie 访问返回 401 统一错误壳", async () => {
    const { app } = makeApp();
    await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });
    const res = await app.request("/api/teacher/me");
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("UNAUTHORIZED");
    expect(apiErrSchema.safeParse(body).success).toBe(true);
  });

  it("伪造的 Cookie token 返回 401", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/teacher/me", {
      headers: { cookie: "tutor_session=AAAAforgedAAAA" },
    });
    expect(res.status).toBe(401);
  });

  it("学生会话（subjectType=student）不能访问教师接口", async () => {
    const { app, db } = makeApp();
    await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });
    // 手工插入一条学生会话行（T2.1 前的占位学生主体）
    db.insert(sessions)
      .values({
        id: "student-session-token",
        subjectType: "student",
        subjectId: "student-1",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        createdAt: new Date().toISOString(),
      })
      .run();
    const res = await app.request("/api/teacher/me", {
      headers: { cookie: "tutor_session=student-session-token" },
    });
    expect(res.status).toBe(401);
  });

  it("会话过期后 me 返回 401", async () => {
    const { app, db } = makeApp();
    const setup = await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });
    const token = extractSessionToken(setup);

    // 会话先有效
    const before = await app.request("/api/teacher/me", {
      headers: { cookie: `tutor_session=${token}` },
    });
    expect(before.status).toBe(200);

    // 把会话过期时间改到过去
    db.update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(sessions.id, token))
      .run();

    const after = await app.request("/api/teacher/me", {
      headers: { cookie: `tutor_session=${token}` },
    });
    expect(after.status).toBe(401);
    expect(((await after.json()) as ApiErr).error).toBe("UNAUTHORIZED");
  });

  it("禁用教师的既有会话：禁用后下一请求即 401（D5 会话立即吊销）", async () => {
    const { app, db } = makeApp();
    const setup = await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });
    const token = extractSessionToken(setup);
    const cookie = `tutor_session=${token}`;

    // 会话先有效
    const before = await app.request("/api/teacher/me", {
      headers: { cookie },
    });
    expect(before.status).toBe(200);

    // 禁用（D5：disabledAt 置值即禁用）
    db.update(teachers)
      .set({ disabledAt: new Date().toISOString() })
      .where(eq(teachers.id, TEST_TEACHER_ID))
      .run();

    const after = await app.request("/api/teacher/me", {
      headers: { cookie },
    });
    expect(after.status).toBe(401);
    expect(((await after.json()) as ApiErr).error).toBe("UNAUTHORIZED");
  });
});

describe("requireAdmin 守卫（D7：T2B.2 定义，/api/admin/* 路由 T2B.6 挂载）", () => {
  /** 只挂 requireAdmin 的探针应用：放行时回显 c.var.teacher.loginName */
  function makeAdminApp(): { app: Hono<TeacherEnv>; db: Db } {
    const db = createTestDb();
    const app = new Hono<TeacherEnv>()
      .use("*", createRequireAdmin(db, "http://localhost:8787"))
      .get("/probe", (c) =>
        c.json({ ok: true, data: c.var.teacher.loginName }),
      );
    return { app, db };
  }

  it("未登录 → 401（与教师守卫同一路径）", async () => {
    const { app } = makeAdminApp();
    const res = await app.request("/probe");
    expect(res.status).toBe(401);
    expect(((await res.json()) as ApiErr).error).toBe("UNAUTHORIZED");
  });

  it("非管理员教师的会话 → 403 ADMIN_ONLY", async () => {
    const { app, db } = makeAdminApp();
    await seedTeacher(
      db,
      { id: "teacher-plain", loginName: "普通老师", isAdmin: false },
      "plain-pass-8",
    );
    const { token } = createTeacherSession(db, "teacher-plain");

    const res = await app.request("/probe", {
      headers: { cookie: `tutor_session=${token}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("ADMIN_ONLY");
  });

  it("管理员教师的会话 → 放行（c.var.teacher 可用）", async () => {
    const { app, db } = makeAdminApp();
    await seedTeacher(
      db,
      { id: "teacher-admin", loginName: "管理员老师", isAdmin: true },
      "admin-pass-8",
    );
    const { token } = createTeacherSession(db, "teacher-admin");

    const res = await app.request("/probe", {
      headers: { cookie: `tutor_session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: string }).data).toBe("管理员老师");
  });

  it("被禁用的管理员会话 → 401（禁用优先于 isAdmin 判断）", async () => {
    const { app, db } = makeAdminApp();
    await seedTeacher(
      db,
      {
        id: "teacher-admin-off",
        loginName: "停用管理员",
        isAdmin: true,
        disabledAt: new Date().toISOString(),
      },
      "admin-pass-8",
    );
    const { token } = createTeacherSession(db, "teacher-admin-off");

    const res = await app.request("/probe", {
      headers: { cookie: `tutor_session=${token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("会话持久化与滑动续期（7 天内使用不掉线）", () => {
  it("教师守卫通过即续期：DB expiresAt 重置为 ~7 天后，Cookie Max-Age 同步重置", async () => {
    const { app, db } = makeApp();
    const setup = await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });
    const token = extractSessionToken(setup);

    // 把会话拨到「1 分钟后过期」，模拟临近过期仍在线使用的场景
    db.update(sessions)
      .set({ expiresAt: new Date(Date.now() + 60_000).toISOString() })
      .where(eq(sessions.id, token))
      .run();

    const me = await app.request("/api/teacher/me", {
      headers: { cookie: `tutor_session=${token}` },
    });
    expect(me.status).toBe(200);

    // DB 侧：expiresAt 被推回 ~7 天（最后一次活动 + 7 天的滑动语义）
    const row = db.select().from(sessions).where(eq(sessions.id, token)).get();
    const remainMs = new Date(row?.expiresAt ?? 0).getTime() - Date.now();
    expect(remainMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(remainMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);

    // 浏览器侧：Cookie Max-Age 同步重置——只续 DB 不续 Cookie 的话，
    // 浏览器到期即停发 Cookie，续期等于白做
    expect(setCookieHeader(me)).toContain("max-age=604800");
  });

  it("续期不改变 token：前后仍是同一会话行（不换发新会话）", async () => {
    const { app, db } = makeApp();
    const setup = await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });
    const token = extractSessionToken(setup);

    await app.request("/api/teacher/me", {
      headers: { cookie: `tutor_session=${token}` },
    });

    // 只有一条会话行且 id 未变（续期是 UPDATE，不是删旧建新）
    const rows = db.select().from(sessions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(token);
  });
});

describe("POST /api/teacher/logout", () => {
  it("未登录调用 logout 返回 401", async () => {
    const { app } = makeApp();
    const res = await jsonRequestOn(app, "/api/teacher/logout", {});
    expect(res.status).toBe(401);
  });

  it("登出成功：删会话行 + 清 Cookie，之后 me 401（验收项：logout 后 me 401）", async () => {
    const { app, db } = makeApp();
    const setup = await jsonRequestOn(app, "/api/public/teacher/setup", {
      loginName: LOGIN_NAME,
      password: PASSWORD,
    });
    const token = extractSessionToken(setup);
    const cookie = `tutor_session=${token}`;

    const logout = await jsonRequestOn(
      app,
      "/api/teacher/logout",
      {},
      {
        cookie,
      },
    );
    expect(logout.status).toBe(200);
    expect(((await logout.json()) as { ok: boolean }).ok).toBe(true);
    // 清除 Cookie：Max-Age=0 / 过期 + 属性与写入时一致
    const cookieStr = setCookieHeader(logout);
    expect(cookieStr).toContain("tutor_session=");
    expect(cookieStr).toMatch(/max-age=0|expires=thu, 01 jan 1970/);
    expect(cookieStr).toContain("path=/");

    // 会话行已删
    expect(
      db.select().from(sessions).where(eq(sessions.id, token)).get(),
    ).toBeUndefined();

    // 旧 Cookie 再访问 me → 401
    const me = await app.request("/api/teacher/me", {
      headers: { cookie },
    });
    expect(me.status).toBe(401);
  });
});

describe("Cookie Secure 属性随 PUBLIC_URL 变化（验收项）", () => {
  it("PUBLIC_URL 为 https 时 setup/login 的 Cookie 带 Secure；http 时不带", async () => {
    const httpsApp = makeApp("https://tutor.example.com");
    const setupHttps = await jsonRequestOn(
      httpsApp.app,
      "/api/public/teacher/setup",
      { loginName: LOGIN_NAME, password: PASSWORD },
    );
    expect(setCookieHeader(setupHttps)).toContain("secure");

    const loginHttps = await jsonRequestOn(
      httpsApp.app,
      "/api/public/teacher/login",
      { loginName: LOGIN_NAME, password: PASSWORD },
    );
    expect(setCookieHeader(loginHttps)).toContain("secure");
    expect(setCookieHeader(loginHttps)).toContain("httponly");
    expect(setCookieHeader(loginHttps)).toContain("samesite=lax");

    const httpApp = makeApp("http://192.168.1.10:8787");
    const loginHttp = await jsonRequestOn(
      httpApp.app,
      "/api/public/teacher/login",
      {
        loginName: LOGIN_NAME,
        password: WRONG_PASSWORD,
      },
    );
    // 未设置教师：401，无 Cookie 下发
    expect(loginHttp.status).toBe(401);
    expect(loginHttp.headers.getSetCookie()).toHaveLength(0);
    httpsApp.db.$client.close();
    httpApp.db.$client.close();
  });
});

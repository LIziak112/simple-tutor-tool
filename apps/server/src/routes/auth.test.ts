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
import type { Db } from "../db/client.ts";
import { loginFailures, sessions } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";

/**
 * 教师鉴权接口集成测试（T1.9 验收项，app.request() 直调路由 + 内存库）：
 * 重复 setup 被拒；错误密码 5 次后锁定；未登录访问 /api/teacher/* 返回 401；
 * 会话过期 401；Cookie 属性（httpOnly / SameSite=Lax / Path=/ / Secure 随 PUBLIC_URL）；
 * logout 后 me 401；status 探测；学生/伪造会话不能过教师守卫。
 */

const silentLogger: Logger = pino({ enabled: false });
const PASSWORD = "teacher-pass-8";
const WRONG_PASSWORD = "wrong-pass-8";

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

describe("GET /api/public/teacher/status", () => {
  it("初始 hasTeacher=false；设置后 hasTeacher=true（只回布尔值）", async () => {
    const { app } = makeApp();
    const before = await app.request("/api/public/teacher/status");
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as { ok: boolean; data: unknown };
    expect(teacherStatusOkSchema.safeParse(beforeBody).success).toBe(true);
    expect((beforeBody.data as { hasTeacher: boolean }).hasTeacher).toBe(false);

    await jsonRequestOn(app, "/api/public/teacher/setup", {
      password: PASSWORD,
    });

    const after = await app.request("/api/public/teacher/status");
    const afterBody = (await after.json()) as { data: unknown };
    expect((afterBody.data as { hasTeacher: boolean }).hasTeacher).toBe(true);
    // 无泄露：响应只含布尔，不出现哈希等内部信息
    expect(JSON.stringify(afterBody)).not.toContain("scrypt$");
  });
});

/** 在指定 app 上发 JSON POST */
async function jsonRequestOn(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cookie) {
    headers.cookie = cookie;
  }
  return app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/public/teacher/setup", () => {
  it("成功：200 + 教师信息 + 写入会话 Cookie，响应不含密码哈希", async () => {
    const { app } = makeApp();
    const res = await jsonRequestOn(app, "/api/public/teacher/setup", {
      password: PASSWORD,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(teacherInfoOkSchema.safeParse(body).success).toBe(true);
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

  it("setup 后用返回的 Cookie 能直接访问 me（自动登录）", async () => {
    const { app } = makeApp();
    const setup = await jsonRequestOn(app, "/api/public/teacher/setup", {
      password: PASSWORD,
    });
    const token = extractSessionToken(setup);

    const me = await app.request("/api/teacher/me", {
      headers: { cookie: `tutor_session=${token}` },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { data: { id: string } };
    const setupBody = (await setup.json()) as { data: { id: string } };
    expect(meBody.data.id).toBe(setupBody.data.id);
  });

  it("重复 setup 返回 409 TEACHER_EXISTS（验收项）", async () => {
    const { app } = makeApp();
    await jsonRequestOn(app, "/api/public/teacher/setup", {
      password: PASSWORD,
    });
    const again = await jsonRequestOn(app, "/api/public/teacher/setup", {
      password: "another-pass-8",
    });

    expect(again.status).toBe(409);
    const body = (await again.json()) as ApiErr;
    expect(body.error).toBe("TEACHER_EXISTS");
    expect(apiErrSchema.safeParse(body).success).toBe(true);
  });

  it("密码不满足策略（<8 字符）返回 400 VALIDATION_ERROR", async () => {
    const { app } = makeApp();
    const res = await jsonRequestOn(app, "/api/public/teacher/setup", {
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

describe("POST /api/public/teacher/login", () => {
  it("未设置教师时登录返回 401 INVALID_CREDENTIALS（与密码错误同码，防枚举）", async () => {
    const { app } = makeApp();
    const res = await jsonRequestOn(app, "/api/public/teacher/login", {
      password: PASSWORD,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ApiErr).error).toBe("INVALID_CREDENTIALS");
  });

  it("正确密码：200 + 新会话 Cookie + me 可用", async () => {
    const { app } = makeApp();
    await jsonRequestOn(app, "/api/public/teacher/setup", {
      password: PASSWORD,
    });

    const res = await jsonRequestOn(app, "/api/public/teacher/login", {
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(teacherInfoOkSchema.safeParse(await res.json()).success).toBe(true);

    const token = extractSessionToken(res);
    const me = await app.request("/api/teacher/me", {
      headers: { cookie: `tutor_session=${token}` },
    });
    expect(me.status).toBe(200);
  });

  it("错误密码 5 次后锁定：第 6 次即使密码正确也返回 429 LOCKED（验收项）", async () => {
    const { app, db } = makeApp();
    await jsonRequestOn(app, "/api/public/teacher/setup", {
      password: PASSWORD,
    });

    for (let i = 0; i < 5; i++) {
      const res = await jsonRequestOn(app, "/api/public/teacher/login", {
        password: WRONG_PASSWORD,
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as ApiErr).error).toBe("INVALID_CREDENTIALS");
    }

    const locked = await jsonRequestOn(app, "/api/public/teacher/login", {
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

  it("锁过期后能重新登录，且成功清零失败记录", async () => {
    const { app, db } = makeApp();
    await jsonRequestOn(app, "/api/public/teacher/setup", {
      password: PASSWORD,
    });
    for (let i = 0; i < 5; i++) {
      await jsonRequestOn(app, "/api/public/teacher/login", {
        password: WRONG_PASSWORD,
      });
    }

    // 把两条记录的锁拨回过去，模拟等了 10 分钟
    db.update(loginFailures)
      .set({ lockedUntil: new Date(Date.now() - 1000).toISOString() })
      .run();

    const res = await jsonRequestOn(app, "/api/public/teacher/login", {
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    // 成功登录清零：login_failures 表被清空
    expect(db.select().from(loginFailures).all()).toHaveLength(0);
  });

  it("部分失败后成功登录也会清零：再失败从 0 计数", async () => {
    const { app, db } = makeApp();
    await jsonRequestOn(app, "/api/public/teacher/setup", {
      password: PASSWORD,
    });
    for (let i = 0; i < 3; i++) {
      await jsonRequestOn(app, "/api/public/teacher/login", {
        password: WRONG_PASSWORD,
      });
    }
    const ok = await jsonRequestOn(app, "/api/public/teacher/login", {
      password: PASSWORD,
    });
    expect(ok.status).toBe(200);
    expect(db.select().from(loginFailures).all()).toHaveLength(0);

    // 再错 4 次不会锁（若未清零，第 2 次就到 5 了）
    for (let i = 0; i < 4; i++) {
      const res = await jsonRequestOn(app, "/api/public/teacher/login", {
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
});

describe("会话持久化与滑动续期（7 天内使用不掉线）", () => {
  it("教师守卫通过即续期：DB expiresAt 重置为 ~7 天后，Cookie Max-Age 同步重置", async () => {
    const { app, db } = makeApp();
    const setup = await jsonRequestOn(app, "/api/public/teacher/setup", {
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
      password: PASSWORD,
    });
    const token = extractSessionToken(setup);
    const cookie = `tutor_session=${token}`;

    const logout = await jsonRequestOn(app, "/api/teacher/logout", {}, cookie);
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
      { password: PASSWORD },
    );
    expect(setCookieHeader(setupHttps)).toContain("secure");

    const loginHttps = await jsonRequestOn(
      httpsApp.app,
      "/api/public/teacher/login",
      { password: PASSWORD },
    );
    expect(setCookieHeader(loginHttps)).toContain("secure");
    expect(setCookieHeader(loginHttps)).toContain("httponly");
    expect(setCookieHeader(loginHttps)).toContain("samesite=lax");

    const httpApp = makeApp("http://192.168.1.10:8787");
    const loginHttp = await jsonRequestOn(
      httpApp.app,
      "/api/public/teacher/login",
      {
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

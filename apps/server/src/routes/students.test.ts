import type { ApiErr } from "@tutor/contract";
import {
  apiErrSchema,
  studentCreateOkSchema,
  studentListOkSchema,
  studentMeOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client.ts";
import { loginFailures, sessions } from "../db/schema.ts";
import { createTestDb } from "../db/test-utils.ts";

/**
 * 学生账号与两种登录集成测试（T2.1 验收项，app.request() 直调路由 + 内存库）：
 * loginName 唯一；关闭链接方式后链接登录失败；重置链接后旧链接失效；
 * 学生会话无法访问教师接口（对称：教师会话进不了学生接口）；密码登录 5 次失败锁定；
 * 归档学生两种登录都拒绝；reset-password 明文只返回一次；自助改密旧密码错则拒。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

/** 组装被测应用：内存库 + 教师 Cookie（每条用例独立实例） */
async function makeApp(): Promise<{
  app: ReturnType<typeof createApp>;
  db: Db;
  teacherCookie: string;
}> {
  const db = createTestDb();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    publicUrl: "http://localhost:8787",
  });
  const setup = await jsonRequest(app, "/api/public/teacher/setup", {
    password: TEACHER_PASSWORD,
  });
  return {
    app,
    db,
    teacherCookie: `tutor_session=${extractSessionToken(setup)}`,
  };
}

/** 发 JSON 请求（可带 Cookie） */
async function jsonRequest(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  cookie?: string,
  method: "POST" | "PATCH" = "POST",
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cookie) {
    headers.cookie = cookie;
  }
  return app.request(path, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

/** 从 set-cookie 里取出 tutor_session 的值 */
function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) {
    throw new Error("响应中没有 tutor_session cookie");
  }
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

/** 教师创建一个学生（缺省姓名/登录名「张三」），返回响应体与初始密码 */
async function createStudent(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
  overrides: Record<string, unknown> = {},
): Promise<{ body: Record<string, unknown>; initialPassword: string | null }> {
  const res = await jsonRequest(
    app,
    "/api/teacher/students",
    {
      displayName: "张三",
      loginName: "张三",
      ...overrides,
    },
    teacherCookie,
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as Record<string, unknown>;
  return {
    body,
    initialPassword:
      ((body.data as Record<string, unknown>).initialPassword as string) ??
      null,
  };
}

/** 学生列表（教师） */
async function listStudents(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
  includeArchived = false,
): Promise<Record<string, unknown>[]> {
  const res = await app.request(
    includeArchived
      ? "/api/teacher/students?includeArchived=true"
      : "/api/teacher/students",
    { headers: { cookie: teacherCookie } },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { students: Record<string, unknown>[] };
  };
  return body.data.students;
}

describe("教师端学生 CRUD", () => {
  it("未登录访问学生接口返回 401（POST / GET / PATCH 都被守卫拦截）", async () => {
    const { app } = await makeApp();
    const post = await jsonRequest(app, "/api/teacher/students", {
      displayName: "张三",
      loginName: "张三",
    });
    expect(post.status).toBe(401);
    const list = await app.request("/api/teacher/students");
    expect(list.status).toBe(401);
    const patch = await jsonRequest(
      app,
      "/api/teacher/students/xxx",
      { archived: true },
      undefined,
      "PATCH",
    );
    expect(patch.status).toBe(401);
  });

  it("创建成功：201 + 摘要 + 随机初始密码一次性明文；linkEnabled/passwordEnabled 默认全开", async () => {
    const { app, teacherCookie } = await makeApp();
    const res = await jsonRequest(
      app,
      "/api/teacher/students",
      { displayName: "张三", loginName: "张三" },
      teacherCookie,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as unknown;
    expect(studentCreateOkSchema.safeParse(body).success).toBe(true);
    const data = (body as { data: Record<string, unknown> }).data;
    expect((data.student as Record<string, unknown>).linkEnabled).toBe(true);
    expect((data.student as Record<string, unknown>).passwordEnabled).toBe(
      true,
    );
    expect(typeof data.initialPassword).toBe("string");
    // 响应不含密码哈希
    expect(JSON.stringify(body)).not.toContain("scrypt$");
  });

  it("教师自带密码创建：initialPassword 为 null（不回显）", async () => {
    const { app, teacherCookie } = await makeApp();
    const res = await jsonRequest(
      app,
      "/api/teacher/students",
      {
        displayName: "张三",
        loginName: "张三",
        password: STUDENT_PASSWORD,
      },
      teacherCookie,
    );
    const body = (await res.json()) as { data: { initialPassword: unknown } };
    expect(body.data.initialPassword).toBeNull();
  });

  it("loginName 重复返回 409 LOGIN_NAME_TAKEN（验收项：唯一性）", async () => {
    const { app, teacherCookie } = await makeApp();
    await createStudent(app, teacherCookie);
    const dup = await jsonRequest(
      app,
      "/api/teacher/students",
      { displayName: "张三2", loginName: "张三" },
      teacherCookie,
    );
    expect(dup.status).toBe(409);
    const body = (await dup.json()) as ApiErr;
    expect(body.error).toBe("LOGIN_NAME_TAKEN");
    expect(apiErrSchema.safeParse(body).success).toBe(true);
  });

  it("PATCH 改登录名撞已有学生 → 409；改成自己的原名 → 允许（no-op）", async () => {
    const { app, teacherCookie } = await makeApp();
    await createStudent(app, teacherCookie, {
      displayName: "李四",
      loginName: "李四",
    });
    const zhang = await createStudent(app, teacherCookie);
    const zhangId = (
      (zhang.body.data as Record<string, unknown>).student as Record<
        string,
        unknown
      >
    ).id as string;

    const conflict = await jsonRequest(
      app,
      `/api/teacher/students/${zhangId}`,
      { loginName: "李四" },
      teacherCookie,
      "PATCH",
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as ApiErr).error).toBe("LOGIN_NAME_TAKEN");

    const self = await jsonRequest(
      app,
      `/api/teacher/students/${zhangId}`,
      { loginName: "张三" },
      teacherCookie,
      "PATCH",
    );
    expect(self.status).toBe(200);
  });

  it("非法 body（空姓名 / 密码过短）返回 400 VALIDATION_ERROR", async () => {
    const { app, teacherCookie } = await makeApp();
    const res = await jsonRequest(
      app,
      "/api/teacher/students",
      { displayName: "  ", loginName: "张三" },
      teacherCookie,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErr).error).toBe("VALIDATION_ERROR");

    const short = await jsonRequest(
      app,
      "/api/teacher/students",
      { displayName: "张三", loginName: "张三", password: "12345" },
      teacherCookie,
    );
    expect(short.status).toBe(400);
  });

  it("默认列表只列未归档；includeArchived=true 含归档并带标记", async () => {
    const { app, teacherCookie } = await makeApp();
    const zhang = await createStudent(app, teacherCookie);
    const zhangId = (
      (zhang.body.data as Record<string, unknown>).student as Record<
        string,
        unknown
      >
    ).id as string;
    await createStudent(app, teacherCookie, {
      displayName: "王五",
      loginName: "王五",
    });

    expect((await listStudents(app, teacherCookie)).length).toBe(2);

    const archive = await jsonRequest(
      app,
      `/api/teacher/students/${zhangId}`,
      { archived: true },
      teacherCookie,
      "PATCH",
    );
    expect(archive.status).toBe(200);

    const active = await listStudents(app, teacherCookie);
    expect(active.length).toBe(1);
    expect(active[0]?.loginName).toBe("王五");

    const all = await listStudents(app, teacherCookie, true);
    expect(all.length).toBe(2);
    const archivedRow = all.find((s) => s.loginName === "张三");
    expect(archivedRow?.archived).toBe(true);
  });

  it("查询参数非法（includeArchived=abc）返回 400", async () => {
    const { app, teacherCookie } = await makeApp();
    const res = await app.request("/api/teacher/students?includeArchived=abc", {
      headers: { cookie: teacherCookie },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
  });

  it("PATCH 目标不存在返回 404 STUDENT_NOT_FOUND", async () => {
    const { app, teacherCookie } = await makeApp();
    const res = await jsonRequest(
      app,
      "/api/teacher/students/not-exist",
      { displayName: "新名" },
      teacherCookie,
      "PATCH",
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErr).error).toBe("STUDENT_NOT_FOUND");
  });
});

describe("专属链接登录（GET /api/public/s/:token）", () => {
  it("有效 token：200 + 写学生 Cookie + 返回 displayName，Cookie 可访问 /api/student/me", async () => {
    const { app, teacherCookie } = await makeApp();
    const zhang = await createStudent(app, teacherCookie);
    const student = (zhang.body.data as Record<string, unknown>)
      .student as Record<string, unknown>;

    const res = await app.request(
      `/api/public/s/${student.linkToken as string}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(studentMeOkSchema.safeParse(body).success).toBe(true);
    expect((body as { data: { displayName: string } }).data.displayName).toBe(
      "张三",
    );

    // Cookie 属性：httpOnly + SameSite=Lax + Path=/（http 环境无 Secure）
    const cookieLines = res.headers
      .getSetCookie()
      .map((l) => l.toLowerCase())
      .join("\n");
    expect(cookieLines).toContain("httponly");
    expect(cookieLines).toContain("samesite=lax");
    expect(cookieLines).toContain("path=/");

    // 学生 Cookie 能访问 me
    const me = await app.request("/api/student/me", {
      headers: { cookie: `tutor_session=${extractSessionToken(res)}` },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as {
      data: { displayName: string; loginName: string };
    };
    expect(meBody.data.displayName).toBe("张三");
    // 学生端信息不含 linkToken（无泄露约束）
    expect(JSON.stringify(meBody)).not.toContain("linkToken");
  });

  it("关闭链接方式后链接登录失败（验收项）", async () => {
    const { app, teacherCookie } = await makeApp();
    const zhang = await createStudent(app, teacherCookie);
    const student = (zhang.body.data as Record<string, unknown>)
      .student as Record<string, unknown>;

    const off = await jsonRequest(
      app,
      `/api/teacher/students/${student.id as string}`,
      { linkEnabled: false },
      teacherCookie,
      "PATCH",
    );
    expect(off.status).toBe(200);

    const res = await app.request(
      `/api/public/s/${student.linkToken as string}`,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("LINK_INVALID");
  });

  it("重置链接后旧链接失效、新链接可用（验收项）", async () => {
    const { app, teacherCookie } = await makeApp();
    const zhang = await createStudent(app, teacherCookie);
    const student = (zhang.body.data as Record<string, unknown>)
      .student as Record<string, unknown>;
    const oldToken = student.linkToken as string;

    const reset = await jsonRequest(
      app,
      `/api/teacher/students/${student.id as string}/reset-link`,
      {},
      teacherCookie,
    );
    expect(reset.status).toBe(200);
    const newToken = ((await reset.json()) as { data: { linkToken: string } })
      .data.linkToken;
    expect(newToken).not.toBe(oldToken);

    // 旧 token 立即失效
    const oldRes = await app.request(`/api/public/s/${oldToken}`);
    expect(oldRes.status).toBe(401);
    expect(((await oldRes.json()) as ApiErr).error).toBe("LINK_INVALID");

    // 新 token 可登录
    const newRes = await app.request(`/api/public/s/${newToken}`);
    expect(newRes.status).toBe(200);
  });

  it("归档学生链接登录失败；无效 token 同样 401 LINK_INVALID", async () => {
    const { app, teacherCookie } = await makeApp();
    const zhang = await createStudent(app, teacherCookie);
    const student = (zhang.body.data as Record<string, unknown>)
      .student as Record<string, unknown>;

    await jsonRequest(
      app,
      `/api/teacher/students/${student.id as string}`,
      { archived: true },
      teacherCookie,
      "PATCH",
    );
    const archived = await app.request(
      `/api/public/s/${student.linkToken as string}`,
    );
    expect(archived.status).toBe(401);
    expect(((await archived.json()) as ApiErr).error).toBe("LINK_INVALID");

    const forged = await app.request("/api/public/s/not-a-real-token");
    expect(forged.status).toBe(401);
    expect(((await forged.json()) as ApiErr).error).toBe("LINK_INVALID");
  });
});

describe("密码登录（POST /api/public/student/login）", () => {
  it("创建返回的初始密码可登录；写 90 天学生会话（验收项：两种登录之密码方式）", async () => {
    const { app, teacherCookie, db } = await makeApp();
    const zhang = await createStudent(app, teacherCookie, {
      password: STUDENT_PASSWORD,
    });
    const studentId = (
      (zhang.body.data as Record<string, unknown>).student as Record<
        string,
        unknown
      >
    ).id as string;

    const res = await jsonRequest(app, "/api/public/student/login", {
      loginName: "张三",
      password: STUDENT_PASSWORD,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(studentMeOkSchema.safeParse(body).success).toBe(true);

    // 会话：subjectType=student，有效期 90 天（> 89 天）
    const token = extractSessionToken(res);
    const row = db.select().from(sessions).where(eq(sessions.id, token)).get();
    expect(row?.subjectType).toBe("student");
    expect(row?.subjectId).toBe(studentId);
    const ttl =
      new Date(row?.expiresAt ?? 0).getTime() -
      new Date(row?.createdAt ?? 0).getTime();
    expect(ttl).toBeGreaterThan(89 * 24 * 60 * 60 * 1000);
  });

  it("密码错误 / 登录名不存在统一 401 INVALID_CREDENTIALS（防枚举）", async () => {
    const { app, teacherCookie } = await makeApp();
    await createStudent(app, teacherCookie, {
      password: STUDENT_PASSWORD,
    });
    const wrong = await jsonRequest(app, "/api/public/student/login", {
      loginName: "张三",
      password: "wrong-pass",
    });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as ApiErr).error).toBe("INVALID_CREDENTIALS");

    const unknown = await jsonRequest(app, "/api/public/student/login", {
      loginName: "不存在的人",
      password: "whatever",
    });
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as ApiErr).error).toBe(
      "INVALID_CREDENTIALS",
    );
  });

  it("关闭密码方式后密码登录失败（passwordEnabled=false → 401）", async () => {
    const { app, teacherCookie } = await makeApp();
    const zhang = await createStudent(app, teacherCookie, {
      password: STUDENT_PASSWORD,
    });
    const studentId = (
      (zhang.body.data as Record<string, unknown>).student as Record<
        string,
        unknown
      >
    ).id as string;
    await jsonRequest(
      app,
      `/api/teacher/students/${studentId}`,
      { passwordEnabled: false },
      teacherCookie,
      "PATCH",
    );

    const res = await jsonRequest(app, "/api/public/student/login", {
      loginName: "张三",
      password: STUDENT_PASSWORD,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ApiErr).error).toBe("INVALID_CREDENTIALS");
  });

  it("归档学生密码登录失败", async () => {
    const { app, teacherCookie } = await makeApp();
    const zhang = await createStudent(app, teacherCookie, {
      password: STUDENT_PASSWORD,
    });
    const studentId = (
      (zhang.body.data as Record<string, unknown>).student as Record<
        string,
        unknown
      >
    ).id as string;
    await jsonRequest(
      app,
      `/api/teacher/students/${studentId}`,
      { archived: true },
      teacherCookie,
      "PATCH",
    );

    const res = await jsonRequest(app, "/api/public/student/login", {
      loginName: "张三",
      password: STUDENT_PASSWORD,
    });
    expect(res.status).toBe(401);
  });

  it("连续失败 5 次锁定：第 6 次正确密码也 429 LOCKED；限流 key 与教师命名空间隔离", async () => {
    const { app, teacherCookie, db } = await makeApp();
    await createStudent(app, teacherCookie, {
      password: STUDENT_PASSWORD,
    });

    for (let i = 0; i < 5; i++) {
      const res = await jsonRequest(app, "/api/public/student/login", {
        loginName: "张三",
        password: "bad-pass-1",
      });
      expect(res.status).toBe(401);
    }

    const locked = await jsonRequest(app, "/api/public/student/login", {
      loginName: "张三",
      password: STUDENT_PASSWORD,
    });
    expect(locked.status).toBe(429);
    const body = (await locked.json()) as ApiErr;
    expect(body.error).toBe("LOCKED");

    // 学生限流 key 带命名空间前缀（与教师 name:/ip: 隔离），双 key 都计到 5
    const keys = db
      .select()
      .from(loginFailures)
      .all()
      .map((row) => row.key)
      .sort();
    expect(keys).toEqual(["student:ip:unknown", "student:name:张三"]);

    // 教师登录不受学生锁定影响（命名空间隔离）
    const teacherLogin = await jsonRequest(app, "/api/public/teacher/login", {
      password: TEACHER_PASSWORD,
    });
    expect(teacherLogin.status).toBe(200);
  });

  it("请求体非法（空登录名）返回 400", async () => {
    const { app } = await makeApp();
    const res = await jsonRequest(app, "/api/public/student/login", {
      loginName: " ",
      password: "123456",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
  });
});

describe("会话隔离（验收项：学生会话无法访问教师接口）", () => {
  it("学生 Cookie 访问 /api/teacher/me 与 /api/teacher/students → 401", async () => {
    const { app, teacherCookie } = await makeApp();
    await createStudent(app, teacherCookie, {
      password: STUDENT_PASSWORD,
    });
    const login = await jsonRequest(app, "/api/public/student/login", {
      loginName: "张三",
      password: STUDENT_PASSWORD,
    });
    const cookie = `tutor_session=${extractSessionToken(login)}`;

    const me = await app.request("/api/teacher/me", { headers: { cookie } });
    expect(me.status).toBe(401);
    expect(((await me.json()) as ApiErr).error).toBe("UNAUTHORIZED");

    const list = await app.request("/api/teacher/students", {
      headers: { cookie },
    });
    expect(list.status).toBe(401);
  });

  it("教师 Cookie 访问 /api/student/me → 401（对称隔离）", async () => {
    const { app, teacherCookie } = await makeApp();
    const res = await app.request("/api/student/me", {
      headers: { cookie: teacherCookie },
    });
    expect(res.status).toBe(401);
  });

  it("归档后学生会话立即失效：/api/student/me → 401", async () => {
    const { app, teacherCookie } = await makeApp();
    const zhang = await createStudent(app, teacherCookie, {
      password: STUDENT_PASSWORD,
    });
    const studentId = (
      (zhang.body.data as Record<string, unknown>).student as Record<
        string,
        unknown
      >
    ).id as string;
    const login = await jsonRequest(app, "/api/public/student/login", {
      loginName: "张三",
      password: STUDENT_PASSWORD,
    });
    const cookie = `tutor_session=${extractSessionToken(login)}`;

    const before = await app.request("/api/student/me", {
      headers: { cookie },
    });
    expect(before.status).toBe(200);

    await jsonRequest(
      app,
      `/api/teacher/students/${studentId}`,
      { archived: true },
      teacherCookie,
      "PATCH",
    );
    const after = await app.request("/api/student/me", { headers: { cookie } });
    expect(after.status).toBe(401);
  });
});

describe("重置密码（POST /api/teacher/students/:id/reset-password）", () => {
  it("返回一次性明文：旧密码立即失效、新密码可登录；列表等后续接口不再出现明文", async () => {
    const { app, teacherCookie } = await makeApp();
    const zhang = await createStudent(app, teacherCookie, {
      password: STUDENT_PASSWORD,
    });
    const studentId = (
      (zhang.body.data as Record<string, unknown>).student as Record<
        string,
        unknown
      >
    ).id as string;

    const reset = await jsonRequest(
      app,
      `/api/teacher/students/${studentId}/reset-password`,
      {},
      teacherCookie,
    );
    expect(reset.status).toBe(200);
    const newPassword = ((await reset.json()) as { data: { password: string } })
      .data.password;
    expect(newPassword.length).toBeGreaterThanOrEqual(6);

    // 旧密码失效
    const old = await jsonRequest(app, "/api/public/student/login", {
      loginName: "张三",
      password: STUDENT_PASSWORD,
    });
    expect(old.status).toBe(401);

    // 新密码可登录
    const fresh = await jsonRequest(app, "/api/public/student/login", {
      loginName: "张三",
      password: newPassword,
    });
    expect(fresh.status).toBe(200);

    // 明文只出现一次：列表接口不含该明文（也不含哈希）
    const listBody = JSON.stringify(
      await listStudents(app, teacherCookie, true),
    );
    expect(listBody).not.toContain(newPassword);
    expect(listBody).not.toContain("scrypt$");
  });

  it("重置后顺带开启 passwordEnabled（关闭状态下重置 → 立即可用密码登录）", async () => {
    const { app, teacherCookie } = await makeApp();
    const zhang = await createStudent(app, teacherCookie, {
      password: STUDENT_PASSWORD,
    });
    const studentId = (
      (zhang.body.data as Record<string, unknown>).student as Record<
        string,
        unknown
      >
    ).id as string;
    await jsonRequest(
      app,
      `/api/teacher/students/${studentId}`,
      { passwordEnabled: false },
      teacherCookie,
      "PATCH",
    );

    const reset = await jsonRequest(
      app,
      `/api/teacher/students/${studentId}/reset-password`,
      {},
      teacherCookie,
    );
    expect(reset.status).toBe(200);
    const newPassword = ((await reset.json()) as { data: { password: string } })
      .data.password;

    const login = await jsonRequest(app, "/api/public/student/login", {
      loginName: "张三",
      password: newPassword,
    });
    expect(login.status).toBe(200);
  });

  it("重置不存在的学生返回 404", async () => {
    const { app, teacherCookie } = await makeApp();
    const res = await jsonRequest(
      app,
      "/api/teacher/students/not-exist/reset-password",
      {},
      teacherCookie,
    );
    expect(res.status).toBe(404);
  });
});

describe("学生自助改密码（POST /api/student/password）", () => {
  async function loginStudent(
    app: ReturnType<typeof createApp>,
  ): Promise<string> {
    const res = await jsonRequest(app, "/api/public/student/login", {
      loginName: "张三",
      password: STUDENT_PASSWORD,
    });
    expect(res.status).toBe(200);
    return `tutor_session=${extractSessionToken(res)}`;
  }

  it("未登录返回 401", async () => {
    const { app } = await makeApp();
    const res = await jsonRequest(app, "/api/student/password", {
      oldPassword: "old123",
      newPassword: "new1234",
    });
    expect(res.status).toBe(401);
  });

  it("旧密码错则拒（401）；正确后新密码可登录且旧密码失效", async () => {
    const { app, teacherCookie } = await makeApp();
    await createStudent(app, teacherCookie, {
      password: STUDENT_PASSWORD,
    });
    const cookie = await loginStudent(app);

    const wrong = await jsonRequest(
      app,
      "/api/student/password",
      { oldPassword: "bad-old", newPassword: "new-pass-8" },
      cookie,
    );
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as ApiErr).error).toBe("INVALID_CREDENTIALS");

    const ok = await jsonRequest(
      app,
      "/api/student/password",
      { oldPassword: STUDENT_PASSWORD, newPassword: "new-pass-8" },
      cookie,
    );
    expect(ok.status).toBe(200);
    // 无泄露：改密响应不含新密码明文、不含密码哈希（AGENTS.md 学生端接口口径）
    const okBody = JSON.stringify(await ok.json());
    expect(okBody).not.toContain("new-pass-8");
    expect(okBody).not.toContain("scrypt$");

    const oldLogin = await jsonRequest(app, "/api/public/student/login", {
      loginName: "张三",
      password: STUDENT_PASSWORD,
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await jsonRequest(app, "/api/public/student/login", {
      loginName: "张三",
      password: "new-pass-8",
    });
    expect(newLogin.status).toBe(200);
  });

  it("新密码不满足策略（<6 位）返回 400", async () => {
    const { app, teacherCookie } = await makeApp();
    await createStudent(app, teacherCookie, {
      password: STUDENT_PASSWORD,
    });
    const cookie = await loginStudent(app);
    const res = await jsonRequest(
      app,
      "/api/student/password",
      { oldPassword: STUDENT_PASSWORD, newPassword: "abc" },
      cookie,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/student/me 响应契约", () => {
  it("返回列表结构符合 studentListOkSchema；学生 me 无 linkToken/哈希", async () => {
    const { app, teacherCookie } = await makeApp();
    await createStudent(app, teacherCookie);
    const list = await app.request("/api/teacher/students", {
      headers: { cookie: teacherCookie },
    });
    const body = (await list.json()) as unknown;
    expect(studentListOkSchema.safeParse(body).success).toBe(true);
  });
});

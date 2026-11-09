import { PERSONAL_TEACHER_TOOL_NAMES } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession } from "../auth/session.ts";
import type { Db } from "../db/client.ts";
import { students, teachers } from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import {
  callToolJson,
  connectMcpClientViaApp,
} from "../test/mcp-test-utils.ts";
import { PERSONAL_MCP_TOOL_NAMES } from "./personal-server.ts";
import { STUDENT_MCP_TOOL_NAMES } from "./student-server.ts";

/**
 * 个人账号 MCP（模块 0「一枚 token」）：SDK Streamable HTTP 全链路真实、fetch 桥接
 * app.request，不监听端口。
 * - /mcp/personal 的 tools/list = 教师白名单 ∪ 学生全部（PERSONAL_MCP_TOOL_NAMES
 *   单源）；班级管理类教师工具结构上不存在（伪造 tools/call 协议层被拒）；
 * - 教师白名单工具以个人账号的教师行为域（list_courses 空表可调），学生工具以
 *   绑定学习者为域（list_my_ai_tasks 可调）；
 * - 端点 × 账号类型互斥：个人 token 到 /mcp/student 401、班级学生 token 到
 *   /mcp/personal 401、教师 apiToken 到 /mcp/personal 401（同文案防探测）；
 * - Origin 门：白名单外 403；
 * - /mcp/student 对班级学生行为不变（回归）。
 */

const silentLogger: Logger = pino({ enabled: false });
const PUBLIC_URL = "http://localhost:8787";
const ADMIN_PASSWORD = "admin-pass-888";
const PERSONAL_PASSWORD = "personal-pass-8";
const INVITE_CODE = "GONGKAO-2026";
const TEACHER_API_TOKEN = "m0-teacher-api-token";
const CLASS_STUDENT_ID = "s-m0-class-student";

interface PersonalMcpTestEnv {
  app: ReturnType<typeof createApp>;
  db: Db;
  /** 个人账号学习者的 mcp 明文 token */
  personalToken: string;
  /** 班级学生的 mcp 明文 token（对照组） */
  classToken: string;
}

function cookieHeaderOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .filter((pair) => pair.length > 0)
    .join("; ");
}

async function postJson(
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

/** 用学生 Cookie 建 mcp 连接，返回一次性明文 token */
async function createMcpToken(
  app: ReturnType<typeof createApp>,
  studentCookie: string,
): Promise<string> {
  const created = await postJson(
    app,
    "/api/student/ai/connections",
    { channel: "mcp" },
    { cookie: studentCookie },
  );
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`mcp 连接创建失败：HTTP ${created.status}`);
  }
  const body = (await created.json()) as {
    data: { credential: { token: string } | null };
  };
  if (body.data.credential === null) {
    throw new Error("mcp 连接创建响应缺少一次性 token");
  }
  return body.data.credential.token;
}

/** 首启管理员（带 apiToken）+ 配邀请码 + 注册个人账号 + 一名班级学生；两边各建 mcp 连接 */
async function makeEnv(): Promise<PersonalMcpTestEnv> {
  const db = createTestDb();
  const dataDir = createTestDir();
  const app = createApp({
    db,
    dataDir,
    publicUrl: PUBLIC_URL,
    isProduction: false,
    logger: silentLogger,
  });
  const setup = await postJson(app, "/api/public/teacher/setup", {
    loginName: "teacher",
    password: ADMIN_PASSWORD,
  });
  expect(setup.status).toBe(200);
  const adminCookie = cookieHeaderOf(setup);
  db.update(teachers)
    .set({ apiToken: TEACHER_API_TOKEN })
    .where(eq(teachers.id, TEST_TEACHER_ID))
    .run();
  const patch = await app.request("/api/admin/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ personalInviteCode: INVITE_CODE }),
  });
  expect(patch.status).toBe(200);

  const registered = await postJson(
    app,
    "/api/public/personal/register",
    {
      loginName: "kaosheng",
      password: PERSONAL_PASSWORD,
      inviteCode: INVITE_CODE,
    },
    { "x-forwarded-for": "10.9.0.1" },
  );
  expect(registered.status).toBe(200);
  const personalCookie = cookieHeaderOf(registered);

  db.insert(students)
    .values({
      id: CLASS_STUDENT_ID,
      teacherId: TEST_TEACHER_ID,
      displayName: "班级学生",
      loginName: "class-student",
      linkToken: "m0-class-link-token",
      createdAt: new Date().toISOString(),
    })
    .run();
  const classCookie = `tutor_student_session=${
    createStudentSession(db, CLASS_STUDENT_ID).token
  }`;

  return {
    app,
    db,
    personalToken: await createMcpToken(app, personalCookie),
    classToken: await createMcpToken(app, classCookie),
  };
}

const INIT_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "m0-test", version: "1.0.0" },
} as const;

function postRpc(
  env: PersonalMcpTestEnv,
  path: string,
  token: string | null,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    env.app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: INIT_PARAMS,
      }),
    }),
  );
}

describe("/mcp/personal 工具面（模块 0）", () => {
  it("tools/list = 教师白名单 ∪ 学生全部；班级管理类教师工具结构上不存在", async () => {
    const env = await makeEnv();
    const client = await connectMcpClientViaApp(
      env.app,
      "/mcp/personal",
      env.personalToken,
      "m0-personal",
    );
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...PERSONAL_MCP_TOOL_NAMES].sort());
    // 单源自洽：白名单 + 学生清单无重名、合并即全集
    expect(new Set(PERSONAL_MCP_TOOL_NAMES).size).toBe(
      PERSONAL_TEACHER_TOOL_NAMES.length + STUDENT_MCP_TOOL_NAMES.length,
    );
    for (const forbidden of [
      "list_students",
      "create_assignment",
      "delete_assignment",
      "list_assignments",
      "get_report",
      "save_report",
      "get_question_stats",
      "update_response_answer",
      "update_response_snapshot",
    ]) {
      expect(names).not.toContain(forbidden);
    }
    // 伪造 tools/call：协议层 -32602「Tool … not found」（未注册即不可调用，
    // 不是 guard 的业务错误 JSON；SDK 客户端以 isError 结果交付）
    const forged = await client.callTool({
      name: "list_students",
      arguments: {},
    });
    expect(forged.isError).toBe(true);
    const forgedText = (forged.content as { type: string; text?: string }[])
      .map((block) => block.text ?? "")
      .join("\n");
    expect(forgedText).toContain("not found");
    expect(forgedText).toContain("-32602");
    await client.close();
    env.db.$client.close();
  });

  it("教师白名单工具以个人教师行为域、学生工具以绑定学习者为域，均可调", async () => {
    const env = await makeEnv();
    const client = await connectMcpClientViaApp(
      env.app,
      "/mcp/personal",
      env.personalToken,
      "m0-personal",
    );
    const courses = await callToolJson(client, "list_courses", {});
    expect(courses.isError).toBe(false);
    expect(courses.data).toMatchObject({ courses: [] });

    const tasks = await callToolJson(client, "list_my_ai_tasks", {});
    expect(tasks.isError).toBe(false);
    expect(Array.isArray(tasks.data.items ?? tasks.data.tasks)).toBe(true);

    const capabilities = await client.callTool({
      name: "describe_capabilities",
      arguments: {},
    });
    expect(capabilities.isError).not.toBe(true);
    await client.close();
    env.db.$client.close();
  });
});

describe("/mcp/personal 鉴权：端点 × 账号类型互斥（同文案 401）", () => {
  it("个人 token 到 /mcp/student、班级 token / 教师 apiToken / 无 token 到 /mcp/personal 都 401", async () => {
    const env = await makeEnv();
    const cases: [string, string | null][] = [
      ["/mcp/student", env.personalToken],
      ["/mcp/personal", env.classToken],
      ["/mcp/personal", TEACHER_API_TOKEN],
      ["/mcp/personal", null],
      ["/mcp/personal", "not-a-token"],
    ];
    const bodies = new Set<string>();
    for (const [path, token] of cases) {
      const res = await postRpc(env, path, token);
      expect(res.status, `${path} with ${token ?? "no token"}`).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
      bodies.add(await res.text());
    }
    // 防探测：全部同一份文案
    expect(bodies.size).toBe(1);

    // 正向对照：各回各家
    expect(
      (await postRpc(env, "/mcp/personal", env.personalToken)).status,
    ).toBe(200);
    expect((await postRpc(env, "/mcp/student", env.classToken)).status).toBe(
      200,
    );
    env.db.$client.close();
  });

  it("Origin 白名单外 → 403，不带 CORS 头；部署源 Origin 放行", async () => {
    const env = await makeEnv();
    const foreign = await postRpc(env, "/mcp/personal", env.personalToken, {
      origin: "https://evil.example",
    });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    const own = await postRpc(env, "/mcp/personal", env.personalToken, {
      origin: PUBLIC_URL,
    });
    expect(own.status).toBe(200);
    env.db.$client.close();
  });

  it("个人账号的教师行不持有 apiToken：教师 /mcp 对其无入口", async () => {
    const env = await makeEnv();
    const personalTeacher = env.db
      .select({ apiToken: teachers.apiToken })
      .from(teachers)
      .where(eq(teachers.loginName, "kaosheng"))
      .get();
    expect(personalTeacher?.apiToken).toBeNull();
    // 即便被手工写入 apiToken，鉴权也按账号类型排除
    env.db
      .update(teachers)
      .set({ apiToken: "forced-personal-api-token" })
      .where(eq(teachers.loginName, "kaosheng"))
      .run();
    const res = await postRpc(env, "/mcp", "forced-personal-api-token");
    expect(res.status).toBe(401);
    env.db.$client.close();
  });
});

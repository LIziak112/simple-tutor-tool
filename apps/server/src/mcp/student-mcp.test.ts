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
import { connectMcpClientViaApp } from "../test/mcp-test-utils.ts";

/**
 * SAI-25 学生 MCP 鉴权测试（B14 先测 5 组；SDK Streamable HTTP 全链路真实、
 * fetch 桥接 app.request，不监听端口）：
 * - 鉴权防探测：无 / 错 / 重置（撤销）/ 删除 / 学生归档 / 教师禁用 → 401 同一
 *   文案（不区分「token 不存在 / 错误 / 已撤销 / 域不可用」）；
 * - 跨域凭证：教师 API token 到学生端点、学生 mcp token 到教师端点都拒绝；
 *   学生浏览器 Cookie 不等同外部认证（无 Bearer 一律 401，Cookie 救不了）；
 * - tools/list 无教师工具；伪造教师 tools/call 在协议层被拒（未注册即不可调用）；
 * - Origin 不在白名单 → 403（不允许时拒绝；不添加任何 CORS 头）；
 * - 多请求 / 异常请求后 transport/server 逐请求创建关闭（stateless），教师
 *   /mcp 冒烟不回归。
 *
 * 注：mcp token 无有效期字段（SAI-16 定案：撤销即失效，无到期形态）——
 * 「到期」由重置（旧哈希被覆盖）与删除（archivedAt）两态覆盖。
 */

const silentLogger: Logger = pino({ enabled: false });
const PUBLIC_URL = "http://localhost:8787";
const TEACHER_API_TOKEN = "sai25-teacher-api-token";
const STUDENT_ID = "s-sai25-mcp-0001";
const INIT_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "sai25-test", version: "1.0.0" },
} as const;

/** 学生 MCP 测试环境 */
interface StudentMcpEnv {
  app: ReturnType<typeof createApp>;
  db: Db;
  /** 学生的 mcp 连接明文 token（创建响应的一次性凭证） */
  token: string;
  /** mcp 连接 id（重置 / 删除用） */
  connectionId: string;
  /** 学生会话 Cookie（浏览器身份 ≠ 外部凭证 对照组） */
  studentCookie: string;
}

/** 直插一名学生 + HTTP 建 mcp 连接（明文 token 只在本函数响应出现一次） */
async function makeEnv(): Promise<StudentMcpEnv> {
  const db = createTestDb();
  const dataDir = createTestDir();
  db.update(teachers)
    .set({ passwordHash: "scrypt$fixture", apiToken: TEACHER_API_TOKEN })
    .where(eq(teachers.id, TEST_TEACHER_ID))
    .run();
  db.insert(students)
    .values({
      id: STUDENT_ID,
      teacherId: TEST_TEACHER_ID,
      displayName: "sai25学生",
      loginName: "sai25-student",
      linkToken: "sai25-link-token",
      createdAt: new Date().toISOString(),
    })
    .run();
  const app = createApp({
    db,
    dataDir,
    publicUrl: PUBLIC_URL,
    isProduction: false,
    logger: silentLogger,
  });
  const studentCookie = `tutor_student_session=${
    createStudentSession(db, STUDENT_ID).token
  }`;
  const created = await app.request("/api/student/ai/connections", {
    method: "POST",
    headers: { cookie: studentCookie, "content-type": "application/json" },
    body: JSON.stringify({ channel: "mcp" }),
  });
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`mcp 连接创建失败：HTTP ${created.status}`);
  }
  const body = (await created.json()) as {
    data: {
      connection: { id: string };
      credential: { token: string } | null;
    };
  };
  if (body.data.credential === null) {
    throw new Error("mcp 连接创建响应缺少一次性 token");
  }
  return {
    app,
    db,
    token: body.data.credential.token,
    connectionId: body.data.connection.id,
    studentCookie,
  };
}

/** 建立学生 MCP 的 SDK 客户端连接（Streamable HTTP + Bearer token；样板见 test/mcp-test-utils.ts） */
const connectStudentClient = (env: StudentMcpEnv, token: string) =>
  connectMcpClientViaApp(env.app, "/mcp/student", token, "sai25-mcp-test");

/** 裸 JSON-RPC POST（鉴权 / Origin / 协议格式断言用） */
function postStudentRpc(
  env: StudentMcpEnv,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    env.app.request("/mcp/student", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const INIT_REQUEST = { jsonrpc: "2.0", id: 1, method: "initialize" } as const;

// ---------- 先测①：鉴权防探测四态 + 撤销 / 归档 / 教师域实时失效 ----------

describe("SAI-25 学生 MCP 鉴权（防探测 + 实时失效）", () => {
  it("无 / 错 token → 401 同一文案；本人连接设置可再次查看 Token", async () => {
    const env = await makeEnv();
    const none = await postStudentRpc(env, {
      ...INIT_REQUEST,
      params: INIT_PARAMS,
    });
    expect(none.status).toBe(401);
    const wrong = await postStudentRpc(
      env,
      { ...INIT_REQUEST, params: INIT_PARAMS },
      { authorization: "Bearer wrong-token-sai25" },
    );
    expect(wrong.status).toBe(401);
    const noneBody = (await none.json()) as { message: string };
    const wrongBody = (await wrong.json()) as { message: string };
    expect(noneBody.message).toBe(wrongBody.message);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    // 日志与错误不带 Token：401 响应体无任何 token 形态
    const text = JSON.stringify(noneBody);
    expect(text).not.toContain(env.token);
    expect(text).not.toContain(env.token.slice(0, 12));
    // 本人连接设置是经授权的 Token 查看入口，不改变 MCP 鉴权边界。
    const list = await env.app.request("/api/student/ai/connections", {
      headers: { cookie: env.studentCookie },
    });
    const listText = await list.text();
    expect(listText).toContain(env.token);
    expect(listText).toContain("tokenFingerprint");
    // 有效 token 经真实 SDK 客户端可完成 initialize
    const client = await connectStudentClient(env, env.token);
    await client.close();
  });

  it("重置（撤销）后旧 token 立即 401 同文案；删除连接同样立即失效", async () => {
    const env = await makeEnv();
    const messageOf = async (res: Response): Promise<string> => {
      const body = (await res.json()) as { message: string };
      return body.message;
    };
    const baseline = await messageOf(
      await postStudentRpc(env, {
        ...INIT_REQUEST,
        params: INIT_PARAMS,
      }),
    );
    // 重置：旧哈希被覆盖
    const reset = await env.app.request(
      `/api/student/ai/connections/${env.connectionId}`,
      {
        method: "PATCH",
        headers: {
          cookie: env.studentCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ channel: "mcp", resetToken: true }),
      },
    );
    expect(reset.status).toBe(200);
    const afterReset = await postStudentRpc(env, {
      ...INIT_REQUEST,
      params: INIT_PARAMS,
    });
    // 撤销路径的 URL 是学生自己的连接 id（非 token、非私密 path）
    expect(afterReset.status).toBe(401);
    expect(await messageOf(afterReset)).toBe(baseline);
    await expect(connectStudentClient(env, env.token)).rejects.toThrow();
    // 删除（archivedAt）：同文案 401
    const del = await env.app.request(
      `/api/student/ai/connections/${env.connectionId}`,
      { method: "DELETE", headers: { cookie: env.studentCookie } },
    );
    expect(del.status).toBe(200);
    const afterDelete = await postStudentRpc(env, {
      ...INIT_REQUEST,
      params: INIT_PARAMS,
    });
    expect(afterDelete.status).toBe(401);
    expect(await messageOf(afterDelete)).toBe(baseline);
  });

  it("学生归档 / 所属教师禁用 → token 立即 401 同文案（实时核对）", async () => {
    const env = await makeEnv();
    const baseline = (await (
      (await postStudentRpc(env, {
        ...INIT_REQUEST,
        params: INIT_PARAMS,
      })) as Response
    ).json()) as { message: string };
    // 学生归档：连接行仍 active，但账号不可用 → 401
    env.db
      .update(students)
      .set({ archivedAt: "2026-10-02T00:00:00.000Z" })
      .where(eq(students.id, STUDENT_ID))
      .run();
    const archived = await postStudentRpc(
      env,
      { ...INIT_REQUEST, params: INIT_PARAMS },
      { authorization: `Bearer ${env.token}` },
    );
    expect(archived.status).toBe(401);
    expect(((await archived.json()) as { message: string }).message).toBe(
      baseline.message,
    );
    // 恢复学生 → 教师禁用：教师域可用性实时核对 → 401
    env.db
      .update(students)
      .set({ archivedAt: null })
      .where(eq(students.id, STUDENT_ID))
      .run();
    env.db
      .update(teachers)
      .set({ disabledAt: "2026-10-02T00:00:00.000Z" })
      .where(eq(teachers.id, TEST_TEACHER_ID))
      .run();
    const teacherDown = await postStudentRpc(
      env,
      { ...INIT_REQUEST, params: INIT_PARAMS },
      { authorization: `Bearer ${env.token}` },
    );
    expect(teacherDown.status).toBe(401);
    expect(((await teacherDown.json()) as { message: string }).message).toBe(
      baseline.message,
    );
    // 教师恢复 → token 立即可用（可用性恢复同样实时）
    env.db
      .update(teachers)
      .set({ disabledAt: null })
      .where(eq(teachers.id, TEST_TEACHER_ID))
      .run();
    const recovered = await postStudentRpc(
      env,
      { ...INIT_REQUEST, params: INIT_PARAMS },
      { authorization: `Bearer ${env.token}` },
    );
    expect(recovered.status).toBe(200);
  });
});

// ---------- 先测②：跨域凭证与学生 Cookie ----------

describe("SAI-25 跨域凭证与学生 Cookie", () => {
  it("教师 API token 到学生端点 → 401；学生 mcp token 到教师端点 → 401", async () => {
    const env = await makeEnv();
    const teacherAtStudent = await postStudentRpc(
      env,
      { ...INIT_REQUEST, params: INIT_PARAMS },
      { authorization: `Bearer ${TEACHER_API_TOKEN}` },
    );
    expect(teacherAtStudent.status).toBe(401);
    const studentAtTeacher = await env.app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${env.token}`,
      },
      body: JSON.stringify({ ...INIT_REQUEST, params: INIT_PARAMS }),
    });
    expect(studentAtTeacher.status).toBe(401);
  });

  it("学生浏览器 Cookie 不等同外部认证：无 Bearer / 配错 Bearer 一律 401", async () => {
    const env = await makeEnv();
    const cookieOnly = await postStudentRpc(
      env,
      { ...INIT_REQUEST, params: INIT_PARAMS },
      { cookie: env.studentCookie },
    );
    expect(cookieOnly.status).toBe(401);
    const cookiePlusBad = await postStudentRpc(
      env,
      { ...INIT_REQUEST, params: INIT_PARAMS },
      { cookie: env.studentCookie, authorization: "Bearer wrong-token" },
    );
    expect(cookiePlusBad.status).toBe(401);
    // 对照：Cookie + 正确 Bearer 可用（Bearer 是唯一凭证，Cookie 无害）
    const cookiePlusGood = await postStudentRpc(
      env,
      { ...INIT_REQUEST, params: INIT_PARAMS },
      { cookie: env.studentCookie, authorization: `Bearer ${env.token}` },
    );
    expect(cookiePlusGood.status).toBe(200);
  });
});

// ---------- 先测③：tools/list 与伪造 tools/call ----------

describe("SAI-25 学生工具实例独立构建（教师工具不可见 / 不可伪造调用）", () => {
  const TEACHER_TOOL_NAMES = [
    "get_dsl_spec",
    "lint_markdown",
    "import_markdown",
    "list_students",
    "list_assignments",
    "list_courses",
    "get_lecture",
    "get_unit",
    "get_student_learning_pack",
    "get_question_stats",
    "save_report",
    "upload_image",
    "import_zip",
    "describe_capabilities",
  ];

  it("tools/list 精确等于学生八工具（四逐题 + 四整体复盘；学生实例独立构建，非注册后隐藏）", async () => {
    const env = await makeEnv();
    const client = await connectStudentClient(env, env.token);
    // SAI-25 首发学生实例为零工具（tools 处理器随首个工具注册）；SAI-26
    // 注册四类任务工具、任务 1ef854c7 增四类整体复盘工具后收紧为精确
    // 清单——教师 14 工具一个都不在。
    const list = await client.listTools().catch(() => null);
    const names = (
      list === null ? [] : list.tools.map((tool) => tool.name)
    ).sort();
    expect(names).toEqual(
      [
        "claim_ai_task",
        "claim_attempt_review",
        "list_my_ai_tasks",
        "list_my_attempt_reviews",
        "renew_ai_lease",
        "renew_attempt_review_lease",
        "submit_ai_reply",
        "submit_attempt_review_result",
      ].sort(),
    );
    for (const name of TEACHER_TOOL_NAMES) {
      expect(names).not.toContain(name);
    }
    await client.close();
  });

  it("伪造教师 tools/call 在协议层被拒（未注册即不可调用）", async () => {
    const env = await makeEnv();
    const client = await connectStudentClient(env, env.token);
    // SAI-26 注册工具后：未注册工具名 → 协议层 -32602（Invalid params，
    // "Tool ... not found"），SDK 客户端以 isError 结果交付——零工具时代
    // （SAI-25 首发形态）是 -32601 reject；两种形态都是不可调用，这里按
    // 当前四工具形态断言 isError + 协议错误文本，不成功执行任何教师动作。
    const rejected = await client.callTool({
      name: "list_students",
      arguments: {},
    });
    expect(rejected.isError).toBe(true);
    expect(
      (rejected.content as { type: string; text?: string }[]).find(
        (c) => c.type === "text",
      )?.text,
    ).toContain("not found");
    const rejectedImport = await client.callTool({
      name: "import_markdown",
      arguments: { markdown: "#" },
    });
    expect(rejectedImport.isError).toBe(true);
    expect(
      (rejectedImport.content as { type: string; text?: string }[]).find(
        (c) => c.type === "text",
      )?.text,
    ).toContain("not found");
    await client.close();
  });
});

// ---------- 先测④：Origin 拒绝与无全开放 CORS ----------

describe("SAI-25 Origin 校验（不允许时拒绝；无全开放 CORS）", () => {
  it("白名单外 Origin → 403；本站 Origin / 无 Origin 放行", async () => {
    const env = await makeEnv();
    const auth = { authorization: `Bearer ${env.token}` };
    const evil = await postStudentRpc(
      env,
      { ...INIT_REQUEST, params: INIT_PARAMS },
      { ...auth, origin: "https://evil.example" },
    );
    expect(evil.status).toBe(403);
    const evilBody = (await evil.json()) as { error: string; message: string };
    expect(evilBody.error).toContain("ORIGIN");
    // 错误体不带 Token / 私密 path
    expect(JSON.stringify(evilBody)).not.toContain(env.token);

    // 本站 Origin（publicUrl 源）放行
    const sameOrigin = await postStudentRpc(
      env,
      { ...INIT_REQUEST, params: INIT_PARAMS },
      { ...auth, origin: PUBLIC_URL },
    );
    expect(sameOrigin.status).toBe(200);

    // 与请求 Host 同源的 Origin 放行（直连 IP / 自定义端口场景）
    const hostMatch = await env.app.request("/mcp/student", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...auth,
        host: "127.0.0.1:9973",
        origin: "http://127.0.0.1:9973",
      },
      body: JSON.stringify({ ...INIT_REQUEST, params: INIT_PARAMS }),
    });
    expect(hostMatch.status).toBe(200);

    // 无 Origin（SDK / CLI 等非浏览器客户端）放行
    const noOrigin = await postStudentRpc(
      env,
      {
        ...INIT_REQUEST,
        params: INIT_PARAMS,
      },
      auth,
    );
    expect(noOrigin.status).toBe(200);
  });

  it("任何响应都不携带全开放 CORS 头", async () => {
    const env = await makeEnv();
    const responses = [
      await postStudentRpc(env, { ...INIT_REQUEST, params: INIT_PARAMS }),
      await postStudentRpc(
        env,
        { ...INIT_REQUEST, params: INIT_PARAMS },
        { authorization: `Bearer ${env.token}`, origin: PUBLIC_URL },
      ),
      await postStudentRpc(
        env,
        { ...INIT_REQUEST, params: INIT_PARAMS },
        {
          authorization: `Bearer ${env.token}`,
          origin: "https://evil.example",
        },
      ),
    ];
    for (const res of responses) {
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("access-control-allow-headers")).toBeNull();
    }
  });
});

// ---------- 先测⑤：transport/server 生命周期与教师 MCP 冒烟 ----------

describe("SAI-25 传输生命周期与教师 MCP 冒烟", () => {
  it("多请求 / 异常请求后端点仍稳定（stateless 逐请求创建并关闭 transport/server）", async () => {
    const env = await makeEnv();
    // ① 多个独立客户端连接（每次连接 = 独立 initialize + ping + 关闭；
    //    ping 不依赖工具注册，SAI-26 前零工具形态下同样走通协议往返）
    for (let i = 0; i < 3; i += 1) {
      const client = await connectStudentClient(env, env.token);
      await client.ping();
      await client.close();
    }
    // ② 损坏 JSON 体（异常请求）：传输层按协议报错，不崩端点
    const broken = await postStudentRpc(env, "not-json{{", {
      authorization: `Bearer ${env.token}`,
    });
    expect([400, 406, 500]).toContain(broken.status);
    // ③ 异常请求之后正常请求照常
    const ok = await postStudentRpc(
      env,
      { ...INIT_REQUEST, params: INIT_PARAMS },
      { authorization: `Bearer ${env.token}` },
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      result: { serverInfo: { name: string } };
    };
    expect(body.result.serverInfo.name).toContain("student");
    // ④ SDK 客户端在异常请求后仍可完整工作
    const client = await connectStudentClient(env, env.token);
    await client.ping();
    await client.close();
  });

  it("教师 /mcp 冒烟不回归（initialize 200 + 既有 14 件仍在）", async () => {
    const env = await makeEnv();
    const init = await env.app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TEACHER_API_TOKEN}`,
      },
      body: JSON.stringify({ ...INIT_REQUEST, params: INIT_PARAMS }),
    });
    expect(init.status).toBe(200);
    const list = await env.app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TEACHER_API_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      result: { tools: { name: string }[] };
    };
    // 冒烟只锁「既有 14 件仍在」，断名单不定长——后续 PR 增工具不再破这条
    expect(body.result.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "get_dsl_spec",
        "lint_markdown",
        "import_markdown",
        "list_students",
        "list_assignments",
        "list_courses",
        "get_lecture",
        "get_unit",
        "get_student_learning_pack",
        "get_question_stats",
        "save_report",
        "upload_image",
        "import_zip",
        "describe_capabilities",
      ]),
    );
  });
});

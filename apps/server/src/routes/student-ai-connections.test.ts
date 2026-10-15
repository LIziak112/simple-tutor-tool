import type { ApiErr } from "@tutor/contract";
import {
  aiConnectionCreateOkSchema,
  aiConnectionDeleteOkSchema,
  aiConnectionListOkSchema,
  aiConnectionPatchOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession, createTeacherSession } from "../auth/session.ts";
import { aiConnections, students, teachers } from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { findActiveMcpConnectionByToken } from "../services/ai-companion/connection-service.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";

/**
 * SAI-16 连接管理路由测试（B08 攻击用例表「鉴权」行 + 「secret」行的路由级
 * 可指认测试 + 五端点 happy path）：
 * - 鉴权四态：未登录 401 / 教师 Cookie 401（subjectType 隔离）/ 教师 API
 *   token（Authorization Bearer）401（学生路由不认外部凭证）/ 跨学生 404
 *   同文案防枚举（B 操作 A 的连接与访问随机 UUID 的 message 全等）；
 * - secret 行：inapp 明文 Key 只进请求，任何响应（list/create/patch/delete/
 *   错误壳）无明文 Key、无 configJson/keyCiphertext/tokenHash 列形态；
 *   mcp token 仅创建/重置响应一次性返回，list 永不回显，重置与删除后
 *   旧 token 认证立即 null（findActiveMcpConnectionByToken 复核）；
 * - 错误壳恒 { ok, error, message } 三键，message 无堆栈特征、不透传
 *   供应商响应头/原文；
 * - 全部学生可读响应过 assertNoLeak（硬规则 3；连接视图另加 forbid 哨兵：
 *   密文列形态与明文凭证键不允许出现在任何读响应）；
 * - 测试连接（POST /:id/test）路由级只走不出站分支（link/mcp → 400
 *   AI_CONNECTION_INVALID、跨学生 404）；真实出站成败与探针无题面断言
 *   在 connection-service.test（fake transport），本文件零真实外呼。
 */

const BASE = "/api/student/ai/connections";
/** inapp 明文 Key 哨兵：任何响应字符串中出现即泄露 */
const PLAIN_KEY = "sk-live-sai16-route-sentinel";

const active: ReturnType<typeof createTestDb>[] = [];
function world() {
  const db = createTestDb();
  active.push(db);
  db.update(teachers)
    .set({ passwordHash: "scrypt$fixture", apiToken: "t46-teacher-api-token" })
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
    db,
    a: cookie("s-a"),
    b: cookie("s-b"),
    teacher: `tutor_session=${createTeacherSession(db, TEST_TEACHER_ID).token}`,
  };
}
afterEach(() => {
  for (const db of active.splice(0)) db.$client.close();
});

/** 统一请求块：method 任意；headers 用于教师 Cookie / API token 覆盖 */
async function req(
  app: ReturnType<typeof createApp>,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** 断言错误壳三键 + 无堆栈/供应商头特征（secret 行：异常不透传） */
async function expectErrShell(res: Response): Promise<ApiErr> {
  const body = (await res.json()) as ApiErr;
  expect(Object.keys(body).sort()).toEqual(["error", "message", "ok"]);
  expect(body.ok).toBe(false);
  expect(body.message).not.toMatch(/\bat\b\s+\S+\(/); // 无 "at fn (file)" 堆栈特征
  expect(body.message).not.toMatch(/x-request-id|via:|server:/i);
  return body;
}

/** 列表响应：契约解析 + assertNoLeak + 连接视图 forbid 哨兵 + 明文 Key 扫描 */
async function listAs(
  app: ReturnType<typeof createApp>,
  cookie: string,
): Promise<string> {
  const res = await req(app, "GET", BASE, { cookie });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain(PLAIN_KEY); // 明文 Key 不出现在任何读响应
  const body = aiConnectionListOkSchema.parse(JSON.parse(text));
  assertNoLeak(body, {
    // 连接视图额外禁键：密文列形态与任何明文凭证（mcp token 只在一次性响应出现）
    forbid: [
      "configJson",
      "keyCiphertext",
      "keyIv",
      "keyTag",
      "tokenHash",
      "apiKey",
      "token",
    ],
  });
  return text;
}

/** 创建 inapp 连接（A 学生），返回连接 id */
async function createInapp(
  app: ReturnType<typeof createApp>,
  cookie: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await req(
    app,
    "POST",
    BASE,
    { cookie },
    {
      channel: "inapp",
      baseUrl: "https://api.example-openai.test/v1",
      model: "gpt-sai16",
      apiKey: PLAIN_KEY,
      ...overrides,
    },
  );
  expect(res.status).toBe(201);
  const text = await res.text();
  expect(text).not.toContain(PLAIN_KEY); // 创建响应只回指纹，不回显明文 Key
  const body = aiConnectionCreateOkSchema.parse(JSON.parse(text));
  assertNoLeak(body);
  expect(body.data.credential).toBeNull(); // inapp 无一次性凭证
  expect(body.data.connection.channel).toBe("inapp");
  if (body.data.connection.channel === "inapp") {
    expect(body.data.connection.verifyStatus).toBe("unverified");
  }
  return body.data.connection.id;
}

it("鉴权四态：未登录/教师 Cookie/教师 API token 全 401；跨学生 404 同文案防枚举", async () => {
  const { app, a, b, teacher } = world();
  const connectionId = await createInapp(app, a);

  // ① 未登录：读与写全 401
  for (const [method, path] of [
    ["GET", BASE] as const,
    ["POST", BASE] as const,
    ["PATCH", `${BASE}/${connectionId}`] as const,
    ["DELETE", `${BASE}/${connectionId}`] as const,
    ["POST", `${BASE}/${connectionId}/test`] as const,
  ]) {
    const res = await req(app, method, path);
    expect(res.status, `${method} 未登录`).toBe(401);
    expect(((await res.json()) as ApiErr).error).toBe("UNAUTHORIZED");
  }

  // ② 教师 Cookie（subjectType 隔离）→ 401
  const asTeacher = await req(app, "GET", BASE, { cookie: teacher });
  expect(asTeacher.status).toBe(401);

  // ③ 教师 API token（外部凭证混用）→ 401：学生路由不读 Authorization
  const withApiToken = await req(app, "GET", BASE, {
    authorization: "Bearer t46-teacher-api-token",
  });
  expect(withApiToken.status).toBe(401);
  expect(((await withApiToken.json()) as ApiErr).error).toBe("UNAUTHORIZED");
  const apiTokenWrite = await req(
    app,
    "PATCH",
    `${BASE}/${connectionId}`,
    { authorization: "Bearer t46-teacher-api-token" },
    { channel: "inapp", model: "hijack" },
  );
  expect(apiTokenWrite.status).toBe(401);

  // ④ 跨学生：B 操作 A 的连接 → 404，与随机 UUID 同文案（防枚举）
  for (const [method, path, body] of [
    [
      "PATCH",
      `${BASE}/${connectionId}`,
      { channel: "inapp", model: "x" },
    ] as const,
    ["DELETE", `${BASE}/${connectionId}`, undefined] as const,
    ["POST", `${BASE}/${connectionId}/test`, undefined] as const,
  ]) {
    const cross = await req(app, method, path, { cookie: b }, body);
    expect(cross.status, `B ${method} A 的连接`).toBe(404);
    // 全零 UUID 会落 Hono notFound 壳（路由失配边角），用真实形态随机 UUID 对照
    const randomId = crypto.randomUUID();
    const random = await req(
      app,
      method,
      `${BASE}/${randomId}${method === "POST" ? "/test" : ""}`,
      { cookie: b },
      body,
    );
    expect(random.status).toBe(404);
    expect((await cross.json()) as ApiErr).toEqual(
      (await random.json()) as ApiErr,
    );
  }
  // B 的列表不见 A 的连接（归属恒取会话）
  const bList = await listAs(app, b);
  expect(bList).toBe('{"ok":true,"data":{"connections":[]}}');
});

it("inapp 全链：创建 201 → 列表只回指纹 → 更新不动 Key 不降验证态 → 删除 200 只回 id", async () => {
  const { app, a, db } = world();
  const connectionId = await createInapp(app, a);

  // 列表：契约 + 泄露断言（含明文 Key 扫描，见 listAs）
  const listText = await listAs(app, a);
  expect(listText).toContain("keyFingerprint");
  expect(JSON.parse(listText).data.connections).toHaveLength(1);

  // 库内只存密文（secret 行）：configJson 无明文 Key
  const row = db
    .select()
    .from(aiConnections)
    .where(eq(aiConnections.id, connectionId))
    .get();
  expect(row?.configJson).not.toContain(PLAIN_KEY);
  expect(row?.configJson).toContain("keyCiphertext");

  // PATCH：改 model + 设默认；不带 apiKey → verifyStatus 保持、不回显 Key
  const patchRes = await req(
    app,
    "PATCH",
    `${BASE}/${connectionId}`,
    { cookie: a },
    { channel: "inapp", model: "gpt-sai16-v2", isDefault: true },
  );
  expect(patchRes.status).toBe(200);
  const patchText = await patchRes.text();
  expect(patchText).not.toContain(PLAIN_KEY);
  const patchBody = aiConnectionPatchOkSchema.parse(JSON.parse(patchText));
  assertNoLeak(patchBody);
  expect(patchBody.data.connection.channel).toBe("inapp");
  if (patchBody.data.connection.channel === "inapp") {
    expect(patchBody.data.connection.model).toBe("gpt-sai16-v2");
    expect(patchBody.data.connection.isDefault).toBe(true);
    expect(patchBody.data.connection.verifyStatus).toBe("unverified");
  }
  expect(patchBody.data.credential).toBeNull();

  // DELETE：200 只回 id；此后读 404、列表空；错误壳三键断言
  const delRes = await req(app, "DELETE", `${BASE}/${connectionId}`, {
    cookie: a,
  });
  expect(delRes.status).toBe(200);
  const delText = await delRes.text();
  const delBody = aiConnectionDeleteOkSchema.parse(JSON.parse(delText));
  assertNoLeak(delBody);
  expect(delBody.data.id).toBe(connectionId);
  expect(Object.keys(JSON.parse(delText).data)).toEqual(["id"]); // 无凭证回显

  const gone = await req(
    app,
    "PATCH",
    `${BASE}/${connectionId}`,
    { cookie: a },
    {
      channel: "inapp",
      model: "late",
    },
  );
  expect(gone.status).toBe(404);
  await expectErrShell(gone);
  expect(JSON.parse(await listAs(app, a)).data.connections).toHaveLength(0);
});

it("mcp：token 一次性返回，list 永不回显，重置/删除后旧 token 认证立即 null", async () => {
  const { app, db, a } = world();
  // 创建：credential.token 只在本响应出现一次
  const createRes = await req(
    app,
    "POST",
    BASE,
    { cookie: a },
    {
      channel: "mcp",
      isDefault: true,
    },
  );
  expect(createRes.status).toBe(201);
  const createBody = aiConnectionCreateOkSchema.parse(await createRes.json());
  assertNoLeak(createBody);
  const firstToken = createBody.data.credential?.token ?? "";
  expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32B base64url
  if (createBody.data.connection.channel === "mcp") {
    expect(createBody.data.connection.tokenFingerprint).toMatch(
      /^[0-9a-f]{8}$/,
    );
    // 旧 token 可认证（SAI-18 共用入口复核）
    expect(findActiveMcpConnectionByToken(db, firstToken)).toEqual({
      id: createBody.data.connection.id,
      studentId: "s-a",
    });
  }

  // list：无 token/tokenHash 键形态（forbid 哨兵在 listAs），无明文 token
  const listText = await listAs(app, a);
  expect(listText).not.toContain(firstToken);

  // PATCH resetToken：新 token ≠ 旧 token；旧 token 认证 null、新 token 命中
  const patchRes = await req(
    app,
    "PATCH",
    `${BASE}/${createBody.data.connection.id}`,
    { cookie: a },
    { channel: "mcp", resetToken: true },
  );
  expect(patchRes.status).toBe(200);
  const patchBody = aiConnectionPatchOkSchema.parse(await patchRes.json());
  assertNoLeak(patchBody);
  const secondToken = patchBody.data.credential?.token ?? "";
  expect(secondToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(secondToken).not.toBe(firstToken);
  expect(findActiveMcpConnectionByToken(db, firstToken)).toBeNull(); // 旧 token 立即失效
  expect(findActiveMcpConnectionByToken(db, secondToken)?.id).toBe(
    createBody.data.connection.id,
  );
  const listAfter = await listAs(app, a);
  expect(listAfter).not.toContain(secondToken);

  // DELETE：mcp token 随连接失效（restore/revoke 行）
  const delRes = await req(
    app,
    "DELETE",
    `${BASE}/${createBody.data.connection.id}`,
    {
      cookie: a,
    },
  );
  expect(delRes.status).toBe(200);
  await delRes.text();
  expect(findActiveMcpConnectionByToken(db, secondToken)).toBeNull();
});

it("通道约束：同通道重复 409；PATCH 判别不符 400；strict 未知键 400；SSRF 字面量内网 IP 拒绝", async () => {
  const { app, a } = world();

  // SSRF 保存期：字面量内网 IP baseUrl → 400 AI_CONNECTION_INVALID（先于建连接，避免撞 409）
  const ssrf = await req(
    app,
    "POST",
    BASE,
    { cookie: a },
    {
      channel: "inapp",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "m",
      apiKey: PLAIN_KEY,
    },
  );
  expect(ssrf.status).toBe(400);
  expect((await expectErrShell(ssrf)).error).toBe("AI_CONNECTION_INVALID");

  const inappId = await createInapp(app, a);

  // 同通道重复 → 409 AI_STATE_CONFLICT（错误壳三键）
  const dup = await req(
    app,
    "POST",
    BASE,
    { cookie: a },
    {
      channel: "inapp",
      baseUrl: "https://api.example-openai.test/v1",
      model: "another",
      apiKey: PLAIN_KEY,
    },
  );
  expect(dup.status).toBe(409);
  const dupErr = await expectErrShell(dup);
  expect(dupErr.error).toBe("AI_STATE_CONFLICT");
  expect(dupErr.message).not.toContain(PLAIN_KEY);

  // PATCH 判别不符：inapp 行收 mcp 字段 → 400 AI_CONNECTION_INVALID
  const wrongChannel = await req(
    app,
    "PATCH",
    `${BASE}/${inappId}`,
    { cookie: a },
    {
      channel: "mcp",
      resetToken: true,
    },
  );
  expect(wrongChannel.status).toBe(400);
  expect((await expectErrShell(wrongChannel)).error).toBe(
    "AI_CONNECTION_INVALID",
  );

  // strict 未知键（越权字段 teacherId）→ 400 VALIDATION_ERROR 整体拒绝
  const smuggled = await req(
    app,
    "POST",
    BASE,
    { cookie: a },
    {
      channel: "link",
      teacherId: "t-evil",
    },
  );
  expect(smuggled.status).toBe(400);
  expect((await expectErrShell(smuggled)).error).toBe("VALIDATION_ERROR");
});

it("测试连接路由级：link/mcp 通道 400 不出站；跨学生 404；默认互斥跨通道先清后设", async () => {
  const { app, a, b } = world();
  // link 连接：无出站目标 → 400（路由级不出网；真实出站归 service 测试）
  const linkRes = await req(
    app,
    "POST",
    BASE,
    { cookie: a },
    {
      channel: "link",
      defaultValidHours: 24,
      isDefault: true,
    },
  );
  expect(linkRes.status).toBe(201);
  const link = aiConnectionCreateOkSchema.parse(await linkRes.json());
  const linkId = link.data.connection.id;

  const testRes = await req(app, "POST", `${BASE}/${linkId}/test`, {
    cookie: a,
  });
  expect(testRes.status).toBe(400);
  expect((await expectErrShell(testRes)).error).toBe("AI_CONNECTION_INVALID");

  // 跨学生 test → 404
  const cross = await req(app, "POST", `${BASE}/${linkId}/test`, { cookie: b });
  expect(cross.status).toBe(404);

  // 默认互斥：inapp 设默认后 link 失去默认（学生维度跨通道唯一）
  await createInapp(app, a, { isDefault: true });
  const listText = await listAs(app, a);
  const conns = JSON.parse(listText).data.connections as Array<{
    channel: string;
    isDefault: boolean;
  }>;
  expect(conns.find((c) => c.channel === "link")?.isDefault).toBe(false);
  expect(conns.find((c) => c.channel === "inapp")?.isDefault).toBe(true);
});

import type { ApiErr, TeacherApiTokenData } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { teachers } from "../db/schema.ts";
import { createTestDb, createTestDir, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { authenticateApiToken } from "../services/api-token-service.ts";

/**
 * T4.6 API Token 教师接口测试（D22）：
 * - 查看：未生成时 token=null；生成后随时可查（不做「只显示一次」）；
 * - 生成 / 重置：POST 返回新 token 并落库；重置覆盖列值（旧 token 立即无主，
 *   服务层 authenticateApiToken 命不中）；
 * - 鉴权解析：错 token / 禁用教师 token → null（401 口径由 MCP 挂载层测试覆盖）；
 * - 未登录两接口 401。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const TEACHER_B_ID = "teacher-b-t46-token";

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

interface TokenEnv {
  app: ReturnType<typeof createApp>;
  db: Db;
  cookie: string;
}

async function makeEnv(): Promise<TokenEnv> {
  const db = createTestDb();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    publicUrl: "http://localhost:8787",
    dataDir: createTestDir(),
  });
  const setup = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "teacher", password: TEACHER_PASSWORD }),
  });
  return {
    app,
    db,
    cookie: `tutor_session=${extractSessionToken(setup)}`,
  };
}

describe("GET/POST /api/teacher/api-token（T4.6 D22）", () => {
  it("未登录 → 401（查看与生成）", async () => {
    const { app } = await makeEnv();
    const get = await app.request("/api/teacher/api-token");
    expect(get.status).toBe(401);
    expect(((await get.json()) as ApiErr).error).toBe("UNAUTHORIZED");
    const post = await app.request("/api/teacher/api-token", { method: "POST" });
    expect(post.status).toBe(401);
  });

  it("首次查看 token=null；生成后可随时再查看（不做只显示一次）", async () => {
    const { app, db, cookie } = await makeEnv();
    const before = await app.request("/api/teacher/api-token", {
      headers: { cookie },
    });
    expect(before.status).toBe(200);
    expect(((await before.json()) as { data: TeacherApiTokenData }).data).toEqual(
      { token: null },
    );

    const created = await app.request("/api/teacher/api-token", {
      method: "POST",
      headers: { cookie },
    });
    expect(created.status).toBe(200);
    const token1 = ((await created.json()) as { data: { token: string } }).data
      .token;
    // randomBytes(32) base64url → 43 字符（D22 格式）
    expect(token1).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const after = await app.request("/api/teacher/api-token", {
      headers: { cookie },
    });
    expect(((await after.json()) as { data: TeacherApiTokenData }).data).toEqual({
      token: token1,
    });
    expect(db.select().from(teachers).get()?.apiToken).toBe(token1);
  });

  it("重置覆盖列值：旧 token 鉴权立即失效，新 token 可用", async () => {
    const { app, db, cookie } = await makeEnv();
    const first = await app.request("/api/teacher/api-token", {
      method: "POST",
      headers: { cookie },
    });
    const token1 = ((await first.json()) as { data: { token: string } }).data
      .token;
    expect(authenticateApiToken(db, token1)?.id).toBe(TEST_TEACHER_ID);

    const second = await app.request("/api/teacher/api-token", {
      method: "POST",
      headers: { cookie },
    });
    const token2 = ((await second.json()) as { data: { token: string } }).data
      .token;
    expect(token2).not.toBe(token1);
    // 旧 token 立即无主（唯一索引下不可能仍命中他行）
    expect(authenticateApiToken(db, token1)).toBeNull();
    expect(authenticateApiToken(db, token2)?.id).toBe(TEST_TEACHER_ID);
  });

  it("错 token / 禁用教师 token → 鉴权解析 null（同一结果，防探测）", async () => {
    const { app, db, cookie } = await makeEnv();
    const created = await app.request("/api/teacher/api-token", {
      method: "POST",
      headers: { cookie },
    });
    const token = ((await created.json()) as { data: { token: string } }).data
      .token;
    // 错 token（同长度随机串）
    expect(authenticateApiToken(db, `${token.slice(0, -1)}0`)).toBeNull();
    // 乙教师生成 token 后被禁用 → token 立即失效（requireTeacher 同口径）
    db.insert(teachers)
      .values({
        id: TEACHER_B_ID,
        loginName: "teacher-b-t46-token",
        isAdmin: false,
        disabledAt: null,
        passwordHash: "scrypt$t46-fixture",
        apiToken: "b-token-t46-fixed-value",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
    expect(authenticateApiToken(db, "b-token-t46-fixed-value")?.id).toBe(
      TEACHER_B_ID,
    );
    db.update(teachers)
      .set({ disabledAt: "2026-10-02T00:00:00.000Z" })
      .where(eq(teachers.id, TEACHER_B_ID))
      .run();
    expect(authenticateApiToken(db, "b-token-t46-fixed-value")).toBeNull();
  });
});

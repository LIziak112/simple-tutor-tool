import type { ApiErr, CapabilityProfile } from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTeacherSession } from "../auth/session.ts";
import type { Db } from "../db/client";
import { createTestDb, createTestDir } from "../db/test-utils";
import { teachers } from "../db/schema";

/**
 * T7.7 教师能力启用集路由测试（GET/PUT /api/teacher/settings/capability-profile）：
 * - 未登录 401（读写同口径）；
 * - GET 未配置 → 全启用（缺省语义）；PUT 空数组 → 显式全关读回；
 * - 非法入参 400（未知开关名 / 重复项 / 拼错键）；
 * - 两教师配置互不影响（域隔离基础）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-t77";
const TEACHER_B_ID = "teacher-b-t77-settings";

const PROFILE_PATH = "/api/teacher/settings/capability-profile";

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

interface ProfileEnv {
  app: ReturnType<typeof createApp>;
  cookieA: string;
  cookieB: string;
}

/** 建 app：甲经 setup（真实登录流），乙直插教师行 + 伪造会话（域隔离测试既有惯例） */
async function makeEnv(): Promise<ProfileEnv> {
  const db: Db = createTestDb();
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
  db.insert(teachers)
    .values({
      id: TEACHER_B_ID,
      loginName: "teacher-b",
      isAdmin: false,
      disabledAt: null,
      passwordHash: "scrypt$t77-fixture",
      apiToken: null,
      createdAt: "2026-01-02T00:00:00.000Z",
    })
    .run();
  return {
    app,
    cookieA: `tutor_session=${extractSessionToken(setup)}`,
    cookieB: `tutor_session=${createTeacherSession(db, TEACHER_B_ID).token}`,
  };
}

describe("GET/PUT /api/teacher/settings/capability-profile（T7.7）", () => {
  it("未登录 → 401（读与写）", async () => {
    const { app } = await makeEnv();
    const get = await app.request(PROFILE_PATH);
    expect(get.status).toBe(401);
    expect(((await get.json()) as ApiErr).error).toBe("UNAUTHORIZED");
    const put = await app.request(PROFILE_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabledCapabilities: [] }),
    });
    expect(put.status).toBe(401);
  });

  it("GET 未配置 → 全启用；PUT 空数组 → 显式全关；再 GET 读回", async () => {
    const { app, cookieA } = await makeEnv();
    const initial = await app.request(PROFILE_PATH, {
      headers: { cookie: cookieA },
    });
    expect(initial.status).toBe(200);
    expect(
      ((await initial.json()) as { data: CapabilityProfile }).data,
    ).toEqual({ enabledCapabilities: ["steps", "ink"] });

    const saved = await app.request(PROFILE_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: cookieA },
      body: JSON.stringify({ enabledCapabilities: [] }),
    });
    expect(saved.status).toBe(200);
    expect(
      ((await saved.json()) as { data: CapabilityProfile }).data,
    ).toEqual({ enabledCapabilities: [] });

    const after = await app.request(PROFILE_PATH, {
      headers: { cookie: cookieA },
    });
    expect(
      ((await after.json()) as { data: CapabilityProfile }).data,
    ).toEqual({ enabledCapabilities: [] });
  });

  it("PUT 非法入参 → 400（未知开关名 / 重复项 / 拼错键）", async () => {
    const { app, cookieA } = await makeEnv();
    for (const body of [
      { enabledCapabilities: ["choice"] },
      { enabledCapabilities: ["steps", "steps"] },
      { enabledcapabilities: [] },
    ]) {
      const res = await app.request(PROFILE_PATH, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: cookieA },
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
    }
  });

  it("两教师互不影响：甲全关后乙仍是全启用", async () => {
    const { app, cookieA, cookieB } = await makeEnv();
    const saved = await app.request(PROFILE_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: cookieA },
      body: JSON.stringify({ enabledCapabilities: [] }),
    });
    expect(saved.status).toBe(200);

    const b = await app.request(PROFILE_PATH, { headers: { cookie: cookieB } });
    expect(b.status).toBe(200);
    expect(((await b.json()) as { data: CapabilityProfile }).data).toEqual({
      enabledCapabilities: ["steps", "ink"],
    });
  });
});

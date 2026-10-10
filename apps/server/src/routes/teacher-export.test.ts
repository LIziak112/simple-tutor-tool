import type { ApiErr } from "@tutor/contract";
import { learningPackPreviewOkSchema } from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTeacherSession } from "../auth/session.ts";
import type { Db } from "../db/client";
import { teachers } from "../db/schema";
import { createTestDb, createTestDir, TEST_TEACHER_ID } from "../db/test-utils";
import { type SeedDemoResult, seedDemoData } from "../services/seed-demo";
import { unzipEntries } from "../test/unzip";

/**
 * T4.3 学情数据包导出路由测试（app.request() 直调 + 内存库 + 种子数据）：
 * - 鉴权：未登录两接口 401；
 * - 请求校验：非法 JSON / 全空模块勾选 → 400 VALIDATION_ERROR；
 * - preview：{ ok, data } 统一壳经契约校验（文件清单 + 预估字节 + 超限标志）；
 * - zip 直出：application/zip + Content-Disposition 附件名 + no-store；
 *   解包断言 pack.json / 映射.txt 在包内（413/化名/历次等口径在服务层测试）；
 * - 域隔离（D7 红线）：教师乙勾甲的学生 → 404 STUDENT_NOT_FOUND。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const SEED_NOW = "2026-10-01T04:00:00.000Z";
const TEACHER_B_ID = "teacher-b-t43-route";

interface ExportEnv {
  app: ReturnType<typeof createApp>;
  db: Db;
  cookieA: string;
  cookieB: string;
  seed: SeedDemoResult;
}

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

async function makeEnv(): Promise<ExportEnv> {
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
  const cookieA = `tutor_session=${extractSessionToken(setup)}`;
  const seed = await seedDemoData(db, TEST_TEACHER_ID, { now: SEED_NOW });
  // 教师乙：直插行 + 伪造会话（域隔离夹具，teacher-domain-isolation 同款）
  db.insert(teachers)
    .values({
      id: TEACHER_B_ID,
      loginName: "teacher-b-t43-route",
      isAdmin: false,
      disabledAt: null,
      passwordHash: "scrypt$t43-route-fixture",
      apiToken: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  const { token: tokenB } = createTeacherSession(db, TEACHER_B_ID);
  return { app, db, cookieA, cookieB: `tutor_session=${tokenB}`, seed };
}

/** 合法请求体（全勾模块，仅讲义大纲） */
function requestBody(
  seed: SeedDemoResult,
  overrides: Record<string, unknown> = {},
) {
  return {
    scope: { studentIds: [seed.students.s1.id, seed.students.s2.id] },
    modules: {
      lectures: [{ lectureId: seed.lectures.l1.id }],
      questions: "solution",
      responses: true,
      summaries: true,
      traces: true,
    },
    goal: "period-summary",
    ...overrides,
  };
}

/** POST 请求（带 Cookie） */
async function post(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cookie !== undefined) headers.cookie = cookie;
  return app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/teacher/export/learning-pack*（T4.3 路由层）", () => {
  it("未登录 → 401（preview 与生成）", async () => {
    const { app, seed } = await makeEnv();
    for (const path of [
      "/api/teacher/export/learning-pack/preview",
      "/api/teacher/export/learning-pack",
    ]) {
      const res = await post(app, path, requestBody(seed));
      expect(res.status).toBe(401);
      const body = (await res.json()) as ApiErr;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("UNAUTHORIZED");
    }
  });

  it("非法 JSON 与全空模块勾选 → 400 VALIDATION_ERROR", async () => {
    const { app, cookieA, seed } = await makeEnv();
    const badJson = await app.request(
      "/api/teacher/export/learning-pack/preview",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieA },
        body: "不是 JSON",
      },
    );
    expect(badJson.status).toBe(400);
    const noModule = await post(
      app,
      "/api/teacher/export/learning-pack/preview",
      requestBody(seed, { modules: {} }),
      cookieA,
    );
    expect(noModule.status).toBe(400);
    const body = (await noModule.json()) as ApiErr;
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toContain("至少勾选一个内容模块");
  });

  it("v2 路由（T6R.12 复审 B11）：packVersion+evidence 透传成功；两条模块依赖拒绝", async () => {
    const { app, cookieA, seed } = await makeEnv();
    // 成功路径：显式 v2 + evidence → 200（服务层 v2 装配透传，manifest 恒在）
    const okRes = await post(
      app,
      "/api/teacher/export/learning-pack/preview",
      requestBody(seed, {
        packVersion: 2,
        modules: {
          questions: "solution",
          responses: true,
          summaries: false,
          traces: false,
          evidence: true,
        },
      }),
      cookieA,
    );
    expect(okRes.status).toBe(200);
    const parsed = learningPackPreviewOkSchema.parse(await okRes.json());
    expect(parsed.data.files.map((file) => file.path)).toContain("pack.json");
    // T6R.16：preview 透传 asOf（毫秒精度 UTC ISO）与 evidenceImages 清单
    // （种子世界无证据 → 空数组；形状由 learningPackPreviewOkSchema 锁定）
    expect(parsed.data.asOf).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(parsed.data.evidenceImages).toEqual([]);
    // 拒绝①：evidence 勾选但 packVersion 缺省（v1 请求）
    const noV2 = await post(
      app,
      "/api/teacher/export/learning-pack/preview",
      requestBody(seed, {
        modules: { questions: "stem", responses: true, evidence: true },
      }),
      cookieA,
    );
    expect(noV2.status).toBe(400);
    const err1 = (await noV2.json()) as ApiErr;
    expect(err1.error).toBe("VALIDATION_ERROR");
    expect(err1.message).toContain("packVersion=2");
    // 拒绝②：evidence 勾选但 responses 未勾（经真实路由 parseJsonBody）
    const noResponses = await post(
      app,
      "/api/teacher/export/learning-pack/preview",
      requestBody(seed, {
        packVersion: 2,
        modules: { questions: "stem", evidence: true },
      }),
      cookieA,
    );
    expect(noResponses.status).toBe(400);
    const err2 = (await noResponses.json()) as ApiErr;
    expect(err2.error).toBe("VALIDATION_ERROR");
    expect(err2.message).toContain("responses");
  });

  it("asOf 固定选择透传（T6R.16）：preview 回传 asOf；download 带 asOf 钉住收录范围", async () => {
    const { app, cookieA, seed } = await makeEnv();
    // asOf 早于全部种子交卷时间：preview 原样回传；download 收录范围为空
    const early = "2020-01-01T00:00:00.000Z";
    const prev = await post(
      app,
      "/api/teacher/export/learning-pack/preview",
      requestBody(seed, { asOf: early, modules: { summaries: true } }),
      cookieA,
    );
    expect(prev.status).toBe(200);
    const parsed = learningPackPreviewOkSchema.parse(await prev.json());
    expect(parsed.data.asOf).toBe(early);
    expect(parsed.data.evidenceImages).toEqual([]);
    const zipRes = await post(
      app,
      "/api/teacher/export/learning-pack",
      requestBody(seed, { asOf: early, modules: { summaries: true } }),
      cookieA,
    );
    expect(zipRes.status).toBe(200);
    // 解包断言：meta.to=asOf（窗口上界回显）；作答汇总为空（窗口外零收录）
    const entries = unzipEntries(new Uint8Array(await zipRes.arrayBuffer()));
    const pack = JSON.parse(entries.get("pack.json")?.toString("utf8") ?? "{}");
    expect(pack.meta.to).toBe(early);
    expect(pack.attempts.summaries).toEqual([]);
  });

  it("preview：统一壳 + 文件清单（含映射.txt，不含 ink）", async () => {
    const { app, cookieA, seed } = await makeEnv();
    const res = await post(
      app,
      "/api/teacher/export/learning-pack/preview",
      requestBody(seed),
      cookieA,
    );
    expect(res.status).toBe(200);
    const parsed = learningPackPreviewOkSchema.parse(await res.json());
    const paths = parsed.data.files.map((file) => file.path);
    expect(paths).toContain("pack.json");
    expect(paths).toContain("summary.md");
    expect(paths).toContain("prompt.md");
    expect(paths).toContain("schema.json");
    expect(paths).toContain("映射.txt");
    expect(paths.some((path) => path.startsWith("ink/"))).toBe(false);
    expect(parsed.data.overLimit).toBe(false);
    expect(parsed.data.totalEstimatedBytes).toBeGreaterThan(0);
  });

  it("生成：zip 直出（附件头 + no-store），包内含 pack.json 与 映射.txt", async () => {
    const { app, cookieA, seed } = await makeEnv();
    const res = await post(
      app,
      "/api/teacher/export/learning-pack",
      requestBody(seed),
      cookieA,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(
      // T7.8 起 attachmentDisposition 恒成对输出 ASCII 兜底段 + filename* 段
      /^attachment; filename="learning-pack-\d{8}-\d{6}\.zip"; filename\*=UTF-8''learning-pack-\d{8}-\d{6}\.zip$/,
    );
    // 解包前的轻量断言：zip 魔数 + 条目名（CD/本地头里的名字是 UTF-8 字节，
    // 整体按 utf8 解码时二进制段变 U+FFFD，但连续的合法 UTF-8 名字原样浮现）
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString("utf8");
    expect(text).toContain("pack.json");
    expect(text).toContain("summary.md");
    expect(text).toContain("prompt.md");
    expect(text).toContain("schema.json");
    expect(text).toContain("映射.txt");
    expect(
      bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
    ).toBe(true);
  });

  it("域隔离：乙勾甲的学生 → 404 STUDENT_NOT_FOUND", async () => {
    const { app, cookieB, seed } = await makeEnv();
    for (const path of [
      "/api/teacher/export/learning-pack/preview",
      "/api/teacher/export/learning-pack",
    ]) {
      const res = await post(
        app,
        path,
        requestBody(seed, {
          scope: { studentIds: [seed.students.s1.id] },
          modules: { summaries: true },
        }),
        cookieB,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as ApiErr;
      expect(body.error).toBe("STUDENT_NOT_FOUND");
    }
  });
});

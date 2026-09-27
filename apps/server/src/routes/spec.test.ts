import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiErr } from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";

/**
 * /api/public/spec/:file 接口测试（T1.13，app.request() 直调路由）：
 * - 四个文件 200 + Content-Type 正确 + 关键内容标记（规范含"指令"、样例含
 *   "::::question"、schema 含 questionPublic 且为合法 JSON、模板非空）；
 * - 公开接口：不带任何 Cookie 直接请求 200；
 * - 未知文件名 → 404 统一错误壳；
 * - spec 目录解析：注入覆盖优先（缺失时 500 SPEC_UNAVAILABLE 中文提示）、
 *   SPEC_DIR 环境变量次之、缺省回退仓库根 docs/dsl。
 */

const silentLogger: Logger = pino({ enabled: false });

function makeApp(specDir?: string | undefined): ReturnType<typeof createApp> {
  return createApp({
    isProduction: false,
    logger: silentLogger,
    db: createTestDb(),
    publicUrl: "http://localhost:8787",
    dataDir: createTestDir(),
    specDir,
  });
}

/** 保存/恢复 SPEC_DIR，避免测试间环境变量串扰 */
const savedSpecDir = process.env.SPEC_DIR;
afterEach(() => {
  if (savedSpecDir === undefined) {
    delete process.env.SPEC_DIR;
  } else {
    process.env.SPEC_DIR = savedSpecDir;
  }
});

describe("GET /api/public/spec/:file（T1.13）", () => {
  it("四个文件全部 200，Content-Type 与关键内容正确（无 Cookie 公开访问）", async () => {
    const app = makeApp();

    const rules = await app.request("/api/public/spec/rules.md");
    expect(rules.status).toBe(200);
    expect(rules.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    const rulesText = await rules.text();
    expect(rulesText).toContain("指令");
    expect(rulesText.length).toBeGreaterThan(0);

    const example = await app.request("/api/public/spec/example.md");
    expect(example.status).toBe(200);
    expect(example.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(await example.text()).toContain("::::question");

    const prompt = await app.request("/api/public/spec/prompt.md");
    expect(prompt.status).toBe(200);
    expect(prompt.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    const promptText = await prompt.text();
    expect(promptText.trim().length).toBeGreaterThan(0);
    expect(promptText).toContain("DSL");

    const schema = await app.request("/api/public/spec/schema.json");
    expect(schema.status).toBe(200);
    expect(schema.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    const schemaText = await schema.text();
    expect(schemaText).toContain("questionPublic");
    // body 必须是合法 JSON（AI 客户端会原样解析）
    expect(() => JSON.parse(schemaText)).not.toThrow();
  });

  it("未知文件名 → 404 统一错误壳", async () => {
    const app = makeApp();
    for (const bad of ["unknown.md", "rules", "schema", "..%2Fpackage.json"]) {
      const res = await app.request(`/api/public/spec/${bad}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as ApiErr;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("NOT_FOUND");
      expect(body.message).toContain("spec 文件不存在");
    }
  });

  it("注入 specDir 指向的目录被使用；目录不存在时 500 SPEC_UNAVAILABLE（中文提示）", async () => {
    const app = makeApp(join(tmpdir(), "t113-missing-dir"));
    const res = await app.request("/api/public/spec/rules.md");
    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiErr;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("SPEC_UNAVAILABLE");
    expect(body.message).toContain("规范文档缺失");
  });

  it("SPEC_DIR 环境变量优先生效（覆盖缺省仓库根 docs/dsl）", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "t113-spec-"));
    try {
      writeFileSync(join(tmp, "规范.md"), "# 测试规范 TEST-RULES", "utf8");
      process.env.SPEC_DIR = tmp;

      const app = makeApp();
      const res = await app.request("/api/public/spec/rules.md");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("TEST-RULES");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("缺省解析：开发环境从仓库根 docs/dsl 读取（含 schema/content.json）", async () => {
    const app = makeApp();
    const res = await app.request("/api/public/spec/schema.json");
    expect(res.status).toBe(200);
    const parsed: unknown = JSON.parse(await res.text());
    expect(parsed).toBeTypeOf("object");
  });
});

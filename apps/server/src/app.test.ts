import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiErr, ApiOk } from "@tutor/contract";
import { apiErrSchema, apiOkSchema } from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createTestDb } from "./db/test-utils";

/** 静音日志器：默认测试不向 stdout 刷日志 */
const silentLogger: Logger = pino({ enabled: false });

/**
 * 测试用组装：注入内存库与固定 http PUBLIC_URL（会话 Cookie 不加 Secure 的默认形态）。
 * 本文件只测壳与静态托管，auth 路由的完整行为在 routes/auth.test.ts。
 */
function makeApp(options: {
  isProduction: boolean;
  logger: Logger;
  webDistDir?: string;
}) {
  return createApp({
    db: createTestDb(),
    publicUrl: "http://localhost:8787",
    ...options,
  });
}

/** 捕获输出的日志器：断言「同时用 pino 记录」时使用 */
function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = pino(
    { level: "info" },
    {
      write: (line: string) => {
        lines.push(line);
      },
    },
  );
  return { logger, lines };
}

describe("GET /api/public/health", () => {
  it("返回 200 与 { ok:true, data:{ time } }，time 是可解析的 ISO 字符串，壳结构符合共享契约", async () => {
    const app = makeApp({ isProduction: false, logger: silentLogger });
    const res = await app.request("/api/public/health");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as ApiOk;
    expect(body.ok).toBe(true);
    // 用共享契约校验响应壳，避免测试与实现各自手写同一结构
    expect(apiOkSchema.safeParse(body).success).toBe(true);
    expect(typeof body.data).toBe("object");

    const time = (body.data as { time: string }).time;
    expect(typeof time).toBe("string");
    expect(Number.isNaN(Date.parse(time))).toBe(false);
  });
});

describe("统一错误格式（§0.3）", () => {
  it("未知 /api 路径返回 404 { ok:false, error:'NOT_FOUND', message:'接口不存在' }", async () => {
    const app = makeApp({ isProduction: false, logger: silentLogger });
    const res = await app.request("/api/does-not-exist");

    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiErr;
    expect(body).toEqual({
      ok: false,
      error: "NOT_FOUND",
      message: "接口不存在",
    });
    expect(apiErrSchema.safeParse(body).success).toBe(true);
  });

  it("应用内抛错返回 500 { ok:false, error:'INTERNAL', ... }，同时用 pino 记录异常", async () => {
    const { logger, lines } = captureLogger();
    const app = makeApp({ isProduction: false, logger });
    // 模拟业务代码抛错（正式路由不会这样写），验证统一错误中间件
    app.get("/api/public/__boom", () => {
      throw new Error("boom-测试异常");
    });

    const res = await app.request("/api/public/__boom");
    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiErr;
    expect(body).toEqual({
      ok: false,
      error: "INTERNAL",
      message: "服务器内部错误",
    });

    // 客户端拿不到堆栈，但日志里要有：error 级别（50）+ 异常对象
    const entries = lines.map(
      (line) =>
        JSON.parse(line) as {
          level: number;
          msg: string;
          err?: { message: string };
        },
    );
    expect(
      entries.some((e) => e.level === 50 && e.msg === "未处理的服务器异常"),
    ).toBe(true);
    expect(entries.some((e) => e.err?.message === "boom-测试异常")).toBe(true);
  });

  it("开发模式下未知非 /api 路径返回纯文本 404（不托管静态资源）", async () => {
    const app = makeApp({ isProduction: false, logger: silentLogger });
    const res = await app.request("/some/page");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });
});

describe("生产模式静态托管与 SPA 回退", () => {
  /** 构造一个临时「前端构建产物」目录：index.html + assets/ 带哈希 JS */
  async function makeFakeDist(): Promise<string> {
    const dist = await mkdtemp(join(tmpdir(), "tutor-web-dist-"));
    await writeFile(
      join(dist, "index.html"),
      "<!doctype html><html><body>web-dist-index</body></html>",
      "utf8",
    );
    await mkdir(join(dist, "assets"), { recursive: true });
    await writeFile(
      join(dist, "assets", "app-abc123.js"),
      "console.log('app')",
      "utf8",
    );
    return dist;
  }

  it("未命中的非 /api GET 回退 index.html（SPA fallback），index 协商缓存", async () => {
    const dist = await makeFakeDist();
    try {
      const app = makeApp({
        isProduction: true,
        logger: silentLogger,
        webDistDir: dist,
      });
      const res = await app.request("/s/student/home");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toContain("web-dist-index");
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });

  it("命中的静态文件按扩展名返回 Content-Type，assets/ 哈希资源长缓存", async () => {
    const dist = await makeFakeDist();
    try {
      const app = makeApp({
        isProduction: true,
        logger: silentLogger,
        webDistDir: dist,
      });
      const res = await app.request("/assets/app-abc123.js");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/javascript");
      expect(res.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(await res.text()).toBe("console.log('app')");
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });

  it("根路径返回 index.html；/api 不受静态托管影响（health 正常、未知 /api 仍是统一 404）", async () => {
    const dist = await makeFakeDist();
    try {
      const app = makeApp({
        isProduction: true,
        logger: silentLogger,
        webDistDir: dist,
      });

      const root = await app.request("/");
      expect(root.status).toBe(200);
      expect(await root.text()).toContain("web-dist-index");

      const health = await app.request("/api/public/health");
      expect(health.status).toBe(200);
      expect(((await health.json()) as ApiOk).ok).toBe(true);

      // SPA 回退不能吞掉未知 /api 请求的统一错误格式
      const unknown = await app.request("/api/unknown");
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({
        ok: false,
        error: "NOT_FOUND",
        message: "接口不存在",
      });
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });

  it("非 GET/HEAD 不回退：POST 未匹配路径仍是 404", async () => {
    const dist = await makeFakeDist();
    try {
      const app = makeApp({
        isProduction: true,
        logger: silentLogger,
        webDistDir: dist,
      });
      const res = await app.request("/some/page", { method: "POST" });
      expect(res.status).toBe(404);
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });

  it("dist 目录不存在时优雅跳过（请求 404），并用 warn 日志提示", async () => {
    const { logger, lines } = captureLogger();
    // 不存在的目录（用时间戳避免与并行测试撞名）
    const missing = join(tmpdir(), `tutor-missing-dist-${Date.now()}`);
    const app = makeApp({ isProduction: true, logger, webDistDir: missing });

    const res = await app.request("/");
    expect(res.status).toBe(404);
    expect(lines.some((line) => line.includes("跳过静态托管"))).toBe(true);
  });
});

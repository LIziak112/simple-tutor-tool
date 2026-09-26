import type { ApiErr, ApiOk } from "@tutor/contract";
import { apiErrSchema, apiOkSchema } from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

/** 静音日志器：默认测试不向 stdout 刷日志 */
const silentLogger: Logger = pino({ enabled: false });

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
    const app = createApp({ isProduction: false, logger: silentLogger });
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
    const app = createApp({ isProduction: false, logger: silentLogger });
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
    const app = createApp({ isProduction: false, logger });
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
    const app = createApp({ isProduction: false, logger: silentLogger });
    const res = await app.request("/some/page");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });
});

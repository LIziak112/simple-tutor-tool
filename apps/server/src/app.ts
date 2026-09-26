import type { ApiErr } from "@tutor/contract";
import { Hono } from "hono";
import type { Logger } from "pino";
import pino from "pino";

/**
 * 组装 Hono 应用。纯定义、无副作用（不监听端口、不读环境变量、不落盘）：
 * - 启动副作用（serve）在 src/index.ts；
 * - 测试用 app.request() 直接调用，不会真的监听端口。
 */

/** createApp 的可注入选项 */
export interface CreateAppOptions {
  /** 生产模式：托管 apps/web/dist 并对未命中的非 /api 路径回退 index.html */
  isProduction: boolean;
  /** 日志器；缺省用 pino 默认实例（info 级别、stdout）。测试可注入捕获实例 */
  logger?: Logger | undefined;
  /** 静态资源目录覆盖；缺省解析到仓库内 apps/web/dist（见 static.ts）。测试注入临时目录用 */
  webDistDir?: string | undefined;
}

export function createApp(options: CreateAppOptions) {
  const logger = options.logger ?? pino({ level: "info" });
  const app = new Hono();

  // —— 统一错误处理（响应格式见 §0.3：{ ok:false, error:"UPPER_SNAKE_CODE", message:"中文说明" }）——

  // 应用内抛出的异常：pino 记录完整异常，对外只返回统一 500 壳，不泄漏堆栈
  app.onError((err, c) => {
    logger.error(
      { err, method: c.req.method, path: c.req.path },
      "未处理的服务器异常",
    );
    const body: ApiErr = {
      ok: false,
      error: "INTERNAL",
      message: "服务器内部错误",
    };
    return c.json(body, 500);
  });

  // 未匹配路由：/api/* 一律返回统一 404 壳；非 /api 路径在生产模式下由 SPA 回退接管，这里兜底纯文本
  app.notFound((c) => {
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
      const body: ApiErr = {
        ok: false,
        error: "NOT_FOUND",
        message: "接口不存在",
      };
      return c.json(body, 404);
    }
    return c.text("Not Found", 404);
  });

  // —— 公开接口（无需登录）——
  app.get("/api/public/health", (c) => {
    // time 为 UTC ISO 字符串（§0.3 时间约定）
    return c.json({ ok: true, data: { time: new Date().toISOString() } });
  });

  return app;
}

/** 应用完整类型（含全部路由签名）。T0.4 前端用 Hono hc 客户端做端到端类型：hc<AppType> */
export type AppType = ReturnType<typeof createApp>;

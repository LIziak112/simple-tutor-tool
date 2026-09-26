import { existsSync } from "node:fs";
import type { ApiErr } from "@tutor/contract";
import { Hono } from "hono";
import type { Logger } from "pino";
import pino from "pino";
import type { Db } from "./db/client";
import { HttpError } from "./lib/http-error";
import { createPublicRoutes } from "./routes/public";
import { createTeacherRoutes } from "./routes/teacher";
import { createSpaStatic, defaultWebDistDir } from "./static";

/**
 * 组装 Hono 应用。纯定义、无副作用（不监听端口、不读环境变量、不落盘）：
 * - 启动副作用（serve）在 src/index.ts；
 * - 测试用 app.request() 直接调用，不会真的监听端口。
 *
 * 类型注意：路由/中间件用链式注册（.onError().notFound().get()…），
 * 让 Hono 泛型把路由签名累积进返回值类型——语句式 app.get() 赋值会丢掉路由类型，
 * 导致 AppType 里没有路由、前端 hc<AppType> 全部退化成 unknown。
 */

/** createApp 的可注入选项 */
export interface CreateAppOptions {
  /** 生产模式：托管 apps/web/dist 并对未命中的非 /api 路径回退 index.html */
  isProduction: boolean;
  /** 数据库实例（教师鉴权等业务路由使用；测试注入 createTestDb() 内存库） */
  db: Db;
  /** 对外基础 URL（会话 Cookie 在 https 下加 Secure，见 auth/session.ts） */
  publicUrl: string;
  /** 日志器；缺省用 pino 默认实例（info 级别、stdout）。测试可注入捕获实例 */
  logger?: Logger | undefined;
  /** 静态资源目录覆盖；缺省解析到仓库内 apps/web/dist（见 static.ts）。测试注入临时目录用 */
  webDistDir?: string | undefined;
}

export function createApp(options: CreateAppOptions) {
  const logger = options.logger ?? pino({ level: "info" });

  // —— 统一错误处理（响应格式见 §0.3：{ ok:false, error:"UPPER_SNAKE_CODE", message:"中文说明" }）——

  let app = new Hono()
    // 业务错误（HttpError）：按自带状态码返回统一壳；info 级记录（不含请求体，密码绝不进日志）
    .onError((err, c) => {
      if (err instanceof HttpError) {
        logger.info(
          {
            code: err.code,
            status: err.status,
            method: c.req.method,
            path: c.req.path,
          },
          "业务错误",
        );
        // 统一壳 + 可选附加字段（如 LINT_ERROR 的 _issues，见 lib/http-error.ts）
        const body: ApiErr & Record<string, unknown> = {
          ok: false,
          error: err.code,
          message: err.message,
          ...(err.extra ?? {}),
        };
        return c.json(body, err.status);
      }
      // 应用内抛出的异常：pino 记录完整异常，对外只返回统一 500 壳，不泄漏堆栈
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
    })
    // 未匹配路由：/api/* 一律返回统一 404 壳；非 /api 路径在生产模式下由 SPA 回退接管，这里兜底纯文本
    .notFound((c) => {
      if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
        const body: ApiErr = {
          ok: false,
          error: "NOT_FOUND",
          message: "接口不存在",
        };
        return c.json(body, 404);
      }
      return c.text("Not Found", 404);
    })
    // —— 公开接口（无需登录）——
    .get("/api/public/health", (c) => {
      // time 为 UTC ISO 字符串（§0.3 时间约定）
      return c.json({ ok: true, data: { time: new Date().toISOString() } });
    })
    // —— 业务路由：/api/public（教师 status/setup/login 等）与 /api/teacher（守卫后的教师接口）——
    .route("/api/public", createPublicRoutes(options.db, options.publicUrl))
    .route("/api/teacher", createTeacherRoutes(options.db, options.publicUrl));

  // —— 生产模式：托管 apps/web/dist ——
  // 注册在 API 路由之后：API 请求命中路由后不再经过静态；未命中的 /api 请求被静态中间件放行到统一 404
  if (options.isProduction) {
    const distDir = options.webDistDir ?? defaultWebDistDir;
    if (existsSync(distDir)) {
      app = app.use("*", createSpaStatic({ distDir }));
    } else {
      // 前端尚未构建：优雅跳过并提示，不报错退出
      logger.warn(
        { distDir },
        "生产模式但前端构建产物目录不存在，跳过静态托管",
      );
    }
  }

  return app;
}

/** 应用完整类型（含全部路由签名）。前端（apps/web）用 Hono hc 客户端做端到端类型：hc<AppType> */
export type AppType = ReturnType<typeof createApp>;

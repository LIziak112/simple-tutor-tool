import { existsSync } from "node:fs";
import type { ApiErr } from "@tutor/contract";
import {
  BACKUP_UPLOAD_BODY_LIMIT,
  IMPORT_BATCH_BODY_LIMIT,
  INK_MAX_UPLOAD_BYTES,
  NOTE_BODY_GZIP_MAX_BYTES,
  NOTE_IMAGE_PNG_MAX_BYTES,
} from "@tutor/contract";
import { type Context, Hono, type Next } from "hono";
import type { Logger } from "pino";
import pino from "pino";
import { createRequireAnySession } from "./auth/require-any-session";
import type { Db, DbHandle } from "./db/client";
import { HttpError } from "./lib/http-error";
import { createMcpRoutes } from "./mcp/mount";
import { createAdminRoutes } from "./routes/admin";
import { createPublicRoutes } from "./routes/public";
import { createStudentRoutes } from "./routes/student";
import { createTeacherRoutes } from "./routes/teacher";
import {
  MEDIA_BLOB_URL_TAIL_PATTERN,
  readMediaBlob,
} from "./services/media-service";
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
  /**
   * 可重启数据连接（T4.5 备份恢复）：恢复替换 DATA_DIR 后经它重启连接。
   * 缺省时备份路由用静态句柄兜底（恢复会干净失败，见 client.ts）；
   * 生产入口（index.ts）必传，恢复行为的测试须传文件库句柄。
   */
  dbHandle?: DbHandle;
  /**
   * 运行数据目录（§0.3）：T2.8 起笔迹文件落 DATA_DIR/blobs/ink/…，
   * 与数据库同源（生产传 config.dataDir；测试注入临时目录）。
   */
  dataDir: string;
  /** 对外基础 URL（会话 Cookie 在 https 下加 Secure，见 auth/session.ts） */
  publicUrl: string;
  /** 日志器；缺省用 pino 默认实例（info 级别、stdout）。测试可注入捕获实例 */
  logger?: Logger | undefined;
  /** 静态资源目录覆盖；缺省解析到仓库内 apps/web/dist（见 static.ts）。测试注入临时目录用 */
  webDistDir?: string | undefined;
  /** DSL 规范文档目录覆盖（T1.13 /spec 接口数据源）；缺省按候选顺序解析（见 spec-files.ts）。测试注入临时目录用 */
  specDir?: string | undefined;
}

/**
 * 笔迹上传路由的 body 预检上限：两文件合计 ≤2MB（契约）+ multipart
 * boundary/头部开销余量。超限在 parseBody（整包进内存）之前就拒绝，
 * 不落盘不缓冲（任务要点：超限尽早拒绝）。
 */
export const INK_UPLOAD_BODY_LIMIT = INK_MAX_UPLOAD_BYTES + 64 * 1024;

/**
 * 草稿正文上传路由的 body 预检上限（T6R.4）：正文 gzip 后 ≤2MiB（契约
 * NOTE_BODY_GZIP_MAX_BYTES）+ multipart boundary/头部编码开销余量，取整
 * 2MiB+64KiB。超限在 parseBody（整包进内存）之前就拒绝（413
 * NOTE_LIMIT_EXCEEDED，不落盘不缓冲）；精确限额由 note-service 按文件实际
 * 字节校验（chunked 传输无 content-length 时兜底，与 ink 两级防线同款）。
 */
export const NOTE_UPLOAD_BODY_LIMIT = NOTE_BODY_GZIP_MAX_BYTES + 64 * 1024;

/**
 * 补图上传路由的 body 预检上限（T6R.5）：单图 PNG ≤2MiB（契约
 * NOTE_IMAGE_PNG_MAX_BYTES）+ multipart boundary/头部/元信息字段开销余量，
 * 取整 2MiB+64KiB。学生（⑤）与教师（⑧）两个入口同一限额；精确限额与
 * 版本聚合限额由 note-service.attachNoteImage 按实际字节校验。
 */
const NOTE_IMAGE_UPLOAD_BODY_LIMIT = NOTE_IMAGE_PNG_MAX_BYTES + 64 * 1024;

/** 补图上传两个入口（学生/教师）共用的预检守卫配置（复审⑦提常量） */
const NOTE_IMAGE_UPLOAD_GUARD = {
  method: "POST",
  limit: NOTE_IMAGE_UPLOAD_BODY_LIMIT,
  code: "NOTE_LIMIT_EXCEEDED",
  message: "上传数据过大（超过派生图上传上限），请降低分辨率后重试",
} as const;

/**
 * content-length 入口预检中间件工厂（T6R.4 复审②：五段同构守卫收敛）。
 * 指定 method 的请求若 content-length 超过 limit，直接 413 {code}——不进入
 * parseBody（整包进内存）、不落盘不缓冲；精确限额由各 service 按文件实际
 * 字节校验（chunked 传输无 content-length 时 Number("") 不 Finite，自然放行
 * 给 service 兜底）。
 */
function guardBodyLimit(config: {
  method: "PUT" | "POST";
  limit: number;
  code: string;
  message: string;
}) {
  return async (c: Context, next: Next) => {
    if (c.req.method === config.method) {
      const length = Number(c.req.header("content-length") ?? "0");
      if (Number.isFinite(length) && length > config.limit) {
        const body: ApiErr = {
          ok: false,
          error: config.code,
          message: config.message,
        };
        return c.json(body, 413);
      }
    }
    return next();
  };
}

/**
 * 图片上传路由的 body 预检上限（媒体管线第二单）：图片本身 ≤5MB（契约口径，
 * media-service 的 MEDIA_MAX_UPLOAD_BYTES）+ multipart boundary/头部编码开销余量，
 * 取整 6MB。超限在 parseBody（整包进内存）之前就拒绝，不落盘不缓冲；
 * 精确的 5MB 限额由 media-service 按文件实际字节数校验（chunked 传输无
 * content-length 时兜底，同 ink 的两级防线设计）。
 */
export const MEDIA_UPLOAD_BODY_LIMIT = 6 * 1024 * 1024;

export function createApp(options: CreateAppOptions) {
  const logger = options.logger ?? pino({ level: "info" });
  const requireAnySession = createRequireAnySession(options.db);
  const serveMediaBlob = createServeMediaBlob(options.dataDir);

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
    // —— 业务路由：/api/public（教师 status/setup/login、学生两种登录）与
    //    /api/teacher（守卫后的教师接口）、/api/student（守卫后的学生接口，T2.1）——
    .route(
      "/api/public",
      createPublicRoutes(options.db, options.publicUrl, options.specDir),
    )
    // —— 上传接口的 content-length 入口预检（T6R.4 复审②收敛为 guardBodyLimit
    //    工厂，五处一行注册）：超限在 parseBody（整包进内存）之前就 413，
    //    不落盘不缓冲；精确限额由各 service 按文件实际字节校验（chunked
    //    传输无 content-length 时兜底）。各路由粗防线取值与理由见常量注释。 ——
    // T2.8 笔迹上传（ink-service 精确校验两文件合计 ≤2MB）
    .use(
      "/api/student/attempts/:id/ink/:questionId",
      guardBodyLimit({
        method: "PUT",
        limit: INK_UPLOAD_BODY_LIMIT,
        code: "INK_TOO_LARGE",
        message: "上传数据过大（超过笔迹上传上限），请精简后重试",
      }),
    )
    // T6R.4 草稿正文上传（note-service 精确校验 gzip 后 ≤2MiB）
    .use(
      "/api/student/attempts/:id/notes/:questionId",
      guardBodyLimit({
        method: "PUT",
        limit: NOTE_UPLOAD_BODY_LIMIT,
        code: "NOTE_LIMIT_EXCEEDED",
        message: "上传数据过大（超过草稿上传上限），请精简后重试",
      }),
    )
    // T6R.5 补图上传（学生 ⑤ / 教师 ⑧ 同一限额：note-service 精确校验
    // 单图 ≤2MiB + 版本聚合 ≤8MiB）——两入口同配置，提常量双注册（复审⑦）
    .use(
      "/api/student/note-versions/:versionId/images",
      guardBodyLimit(NOTE_IMAGE_UPLOAD_GUARD),
    )
    .use(
      "/api/teacher/note-versions/:versionId/images",
      guardBodyLimit(NOTE_IMAGE_UPLOAD_GUARD),
    )
    // T2A.3 批量导入预览（preview-batch 单个 JSON 传全部文件，转义后 body
    // 约为 markdown 原文 1.5–2 倍，粗防线取 30MB=D20；精确限额在 content-service）
    .use(
      "/api/teacher/import/preview-batch",
      guardBodyLimit({
        method: "POST",
        limit: IMPORT_BATCH_BODY_LIMIT,
        code: "IMPORT_TOO_LARGE",
        message: "批量导入请求过大，请减少文件数量或分批导入",
      }),
    )
    // T4.5 备份恢复上传（zip ≤256MB 由 teacher-backup 按实际大小兜底）
    .use(
      "/api/teacher/backup/restore",
      guardBodyLimit({
        method: "POST",
        limit: BACKUP_UPLOAD_BODY_LIMIT,
        code: "BACKUP_TOO_LARGE",
        message: "备份文件超过 256 MB 上限，请检查是否选错了文件",
      }),
    )
    // 媒体管线：图片上传（5MB 契约限额 + multipart 开销余量取整 6MB）
    .use(
      "/api/teacher/media",
      guardBodyLimit({
        method: "POST",
        limit: MEDIA_UPLOAD_BODY_LIMIT,
        code: "MEDIA_TOO_LARGE",
        message: "图片超过 5MB 上传上限，请压缩后重试",
      }),
    )
    .route(
      "/api/teacher",
      createTeacherRoutes(
        options.db,
        options.publicUrl,
        options.dataDir,
        options.dbHandle,
      ),
    )
    .route(
      "/api/student",
      createStudentRoutes(options.db, options.publicUrl, options.dataDir),
    )
    // —— 管理端（T2B.6，D7/D19）：整组 requireAdmin（非管理员 403 ADMIN_ONLY） ——
    .route(
      "/api/admin",
      createAdminRoutes(options.db, options.publicUrl, options.dataDir),
    )
    // —— MCP Server（T4.6）：/mcp 挂 SDK Streamable HTTP（stateless + JSON），
    //    不走统一壳、不走 /api 前缀（SDK 协议格式原样）；Bearer apiToken 鉴权
    //    （无/错 token/禁用教师 401 同文案防探测，D22），全部工具按 token 绑定
    //    教师域隔离（13 工具见 src/mcp/server.ts，D23 清单 + upload_image/import_zip）——
    //    挂在 API 路由之后、静态托管之前（/mcp 不参与 SPA 回退）。
    .route(
      "/mcp",
      createMcpRoutes({
        db: options.db,
        dataDir: options.dataDir,
        specDir: options.specDir,
      }),
    )
    // —— 媒体图片伺服（媒体管线第二单）：GET/HEAD /blobs/media/<hash>.<ext> ——
    // 注册在全部 /api/* 与 /mcp 之后、createSpaStatic 之前：/blobs/* 命中
    // handler 后必返回（200/401/404），永不落入 SPA 回退；鉴权是任意有效
    // 会话（教师或学生，见 auth/require-any-session.ts）。
    // HEAD 用 .on 注册：链式对象不暴露 .head；handler 内按方法回空体。
    .use("/blobs/*", requireAnySession)
    .get("/blobs/*", serveMediaBlob)
    .on("HEAD", "/blobs/*", serveMediaBlob);

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

/**
 * /blobs/* 图片的缓存头：内容寻址（文件名即 sha256）永不变化，可长缓存到
 * 一年且 immutable；private——图片仅在会话内可见，不经共享缓存/CDN 存副本。
 */
const MEDIA_BLOB_CACHE_CONTROL = "private, max-age=31536000, immutable";

/**
 * /blobs/media/<hash>.<ext> 图片伺服 handler（鉴权已由前置的 requireAnySession 完成）：
 * - 不变量：契约 src（blobs/media/<hash>.<ext>）前加 / 即根相对伺服 URL，
 *   二者一一对应——前端把 ::image 的 src 归一化为根相对路径即可直接请求；
 * - 取 c.req.path 去掉 /blobs/ 前缀，剩余尾段必须整体匹配
 *   ^media/([0-9a-f]{64}\.(png|jpe?g|webp|gif))$（MEDIA_BLOB_URL_TAIL_PATTERN），
 *   捕获组即单段文件名，其余一律 404——media 是唯一合法前缀段：缺它
 *   （/blobs/<名>）、别的子目录（/blobs/ink/… 即笔迹）、`..` 穿越、大写 hash、
 *   未知扩展名均不匹配正则天然不可达；文件名再经 readMediaBlob 的单段正则
 *   复核，join 落点永远在 blobs/media/ 内（纵深防御，测试锁定）；
 * - 文件读 DATA_DIR/blobs/media/<文件名>（saveMedia 的内容寻址落点），miss 404；
 * - Content-Type 按扩展名（png/jpg|jpeg/webp/gif）；Cache-Control 见
 *   MEDIA_BLOB_CACHE_CONTROL；HEAD 只回响应头不带体。
 */
function createServeMediaBlob(dataDir: string) {
  return async (c: Context): Promise<Response> => {
    const tail = c.req.path.startsWith("/blobs/")
      ? c.req.path.slice("/blobs/".length)
      : "";
    const name = MEDIA_BLOB_URL_TAIL_PATTERN.exec(tail)?.[1] ?? null;
    const blob = name === null ? null : readMediaBlob(dataDir, name);
    if (blob === null) {
      const body: ApiErr = {
        ok: false,
        error: "NOT_FOUND",
        message: "图片不存在",
      };
      return c.json(body, 404);
    }
    return new Response(c.req.method === "HEAD" ? null : blob.bytes, {
      status: 200,
      headers: {
        "content-type": blob.contentType,
        "cache-control": MEDIA_BLOB_CACHE_CONTROL,
      },
    });
  };
}

/** 应用完整类型（含全部路由签名）。前端（apps/web）用 Hono hc 客户端做端到端类型：hc<AppType> */
export type AppType = ReturnType<typeof createApp>;

import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { MiddlewareHandler } from "hono";

/**
 * 生产模式静态托管：apps/web/dist + SPA 回退。
 *
 * 不用 @hono/node-server 的 serveStatic：其 root 按进程 cwd 解析，
 * dev（apps/server）、vitest（仓库根）、systemen 容器的 cwd 各不相同；
 * 这里改为 import.meta.url 相对解析，三种场景结果一致：
 * - dev（tsx）本文件位于 apps/server/src/，上溯两级是 apps/；
 * - esbuild 产物 apps/server/dist/index.js 与 src/ 同深，上溯两级同样是 apps/。
 */
export const defaultWebDistDir = fileURLToPath(
  new URL("../../web/dist", import.meta.url),
);

/** 扩展名 → Content-Type（覆盖 Vite 前端构建产物的常见类型） */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".webmanifest": "application/manifest+json",
};

/** 命中的静态文件 */
interface StaticFile {
  body: Uint8Array;
  contentType: string;
  cacheControl: string;
}

export interface SpaStaticOptions {
  /** 前端构建产物根目录（绝对路径） */
  distDir: string;
}

/**
 * 生成「静态托管 + SPA 回退」中间件：
 * 非 /api 的 GET/HEAD 请求先按文件查找，未命中一律回退 index.html（由前端路由接管）。
 * 注意须注册在 API 路由之后：API 请求命中路由后不再进入这里，未命中的 /api 请求被放行到统一 404。
 */
export function createSpaStatic(options: SpaStaticOptions): MiddlewareHandler {
  const distRoot = resolve(options.distDir);
  return async (c, next) => {
    const path = c.req.path;
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return next();
    }
    if (path === "/api" || path.startsWith("/api/")) {
      return next(); // 防御：/api 永不落到静态
    }

    // 未命中文件（含目录请求）时回退 index.html；连 index.html 都没有则交给 404
    const file =
      (await lookupFile(distRoot, path)) ??
      (await lookupFile(distRoot, "/index.html"));
    if (!file) {
      return next();
    }
    return new Response(c.req.method === "HEAD" ? null : file.body, {
      status: 200,
      headers: {
        "Content-Type": file.contentType,
        "Cache-Control": file.cacheControl,
      },
    });
  };
}

/**
 * 在 distRoot 下安全查找 urlPath 对应的文件；不存在、是目录或类型未知时返回 null。
 * 防路径穿越：resolve 后的绝对路径必须仍位于 distRoot 内
 * （正常请求经 URL 规范化已不含「..」，此处属纵深防御兜底）。
 */
async function lookupFile(
  distRoot: string,
  urlPath: string,
): Promise<StaticFile | null> {
  const relative = urlPath.replace(/^\/+/, "");
  if (relative.includes("\0")) {
    return null;
  }
  const absolute = resolve(distRoot, relative);
  if (absolute !== distRoot && !absolute.startsWith(`${distRoot}${sep}`)) {
    return null;
  }

  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile()) {
    return null;
  }

  const contentType = CONTENT_TYPES[extname(absolute).toLowerCase()];
  if (!contentType) {
    // 未知扩展名按未命中处理，避免以错误类型下发（并落入 SPA 回退）
    return null;
  }

  // 拷贝为普通 Uint8Array：Buffer 是 Node 类型，直接给 Response 会引入类型/运行时耦合
  const body = new Uint8Array(await readFile(absolute));
  return {
    body,
    contentType,
    // 缓存策略：index.html 必须协商（保证发版后拿到新哈希资源名）；
    // Vite 带 内容哈希 的产物在 assets/ 下，可永久缓存；其余（favicon、字体等）短缓存
    cacheControl:
      relative === "index.html"
        ? "no-cache"
        : relative.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600",
  };
}

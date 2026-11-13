import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  type AiFactType,
  type ApiErr,
  BUILD_VERSION_HEADER,
  parseBuildVersion,
  REQUEST_ID_HEADER,
} from "@tutor/contract";
import type { Context, ErrorHandler, MiddlewareHandler } from "hono";
import { matchedRoutes, routePath } from "hono/route";
import type { Logger } from "pino";
import type { AiAttemptReviewFactType } from "../db/schema.ts";
import { HttpError } from "./http-error.ts";

type RequestContext = {
  startedAt: number;
  logger: Logger;
  aiFacts: Array<{
    taskId: string;
    reason: AiFactType | AiAttemptReviewFactType;
    committed: () => boolean;
  }>;
};
const context = new AsyncLocalStorage<RequestContext>();
const diagnosticWrite =
  /^\/api\/student\/(?:attempts\/:id\/(?:submit|questions\/:questionId\/(?:submit|annotation)|answers\/|ink\/|notes\/|note-heads|annotations\/)|note-versions\/|ai\/)/;

export function normalizeBuildVersion(value?: string): string {
  return parseBuildVersion(value) ?? "development";
}

export function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

export function observeRequestAiFact(
  taskId: string,
  reason: AiFactType | AiAttemptReviewFactType,
  committed: () => boolean,
): void {
  context.getStore()?.aiFacts.push({ taskId, reason, committed });
}

function logCommittedAiFacts(request: RequestContext): void {
  for (const { taskId, reason, committed } of request.aiFacts) {
    try {
      if (!committed()) continue;
      request.logger.info(
        {
          event: "ai_request_decision",
          taskId,
          reason,
          durationMs: elapsedMs(request.startedAt),
        },
        "AI 请求裁决",
      );
    } catch {
      request.logger.warn(
        { event: "ai_fact_diagnostics_unavailable", taskId },
        "AI 事实诊断读取失败",
      );
    }
  }
}

/** 日志只使用注册的路由模板，避免路径参数、凭证和查询值进入日志。 */
function requestLogFields(c: Context) {
  const request = context.getStore();
  const activePath = routePath(c);
  const endpoint = matchedRoutes(c).findLast(
    (route) =>
      (route.method === c.req.method || route.method === "ALL") &&
      !route.path.endsWith("*"),
  );
  return {
    durationMs:
      request === undefined ? undefined : elapsedMs(request.startedAt),
    method: c.req.method,
    route: endpoint?.path ?? (activePath || "unmatched"),
  };
}

export function requestDiagnostics(
  logger: Logger,
  configuredVersion?: string,
): MiddlewareHandler {
  const buildVersion = normalizeBuildVersion(configuredVersion);
  return (c, next) => {
    const requestId = randomUUID();
    const request: RequestContext = {
      startedAt: performance.now(),
      logger: logger.child({ requestId, buildVersion }),
      aiFacts: [],
    };
    return context.run(request, async () => {
      await next();
      c.header(REQUEST_ID_HEADER, requestId);
      c.header(BUILD_VERSION_HEADER, buildVersion);
      logCommittedAiFacts(request);
      const fields = requestLogFields(c);
      const status = c.res.status;
      const isApi =
        c.req.path === "/api" ||
        c.req.path.startsWith("/api/") ||
        c.req.path.startsWith("/mcp");
      const isWrite = c.req.method !== "GET" && c.req.method !== "HEAD";
      if (
        !c.error &&
        ((isApi && status >= 400) ||
          (isWrite && diagnosticWrite.test(fields.route)))
      ) {
        request.logger.info(
          { ...fields, status, code: status >= 400 ? `HTTP_${status}` : "OK" },
          "HTTP 请求完成",
        );
      }
    });
  };
}

export function requestErrorHandler(logger: Logger): ErrorHandler {
  return (err, c) => {
    const log = context.getStore()?.logger ?? logger;
    if (err instanceof HttpError) {
      log.info(
        { ...requestLogFields(c), code: err.code, status: err.status },
        "业务错误",
      );
      const body: ApiErr & Record<string, unknown> = {
        ok: false,
        error: err.code,
        message: err.message,
        ...(err.extra ?? {}),
      };
      return c.json(body, err.status);
    }
    log.error(
      { ...requestLogFields(c), code: "INTERNAL", status: 500 },
      "未处理的服务器异常",
    );
    return c.json(
      {
        ok: false,
        error: "INTERNAL",
        message: "服务器内部错误",
      } satisfies ApiErr,
      500,
    );
  };
}

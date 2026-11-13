import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { aiMcpWaitTaskSchema } from "@tutor/contract";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Context, Next } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { loadOrCreateSecretKey } from "../config";
import type { Db } from "../db/client";
import { aiTasks } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { sqliteAiPolicyConfigSource } from "../services/ai-companion/ai-policy-config-source";
import { isMcpLiveContextEnabled } from "../services/ai-companion/connection-service";
import { resolveAttemptQuestionAiPolicy } from "../services/ai-companion/teaching-policy-service";
import {
  authenticateStudentMcp,
  createRequireStudentMcpToken,
  type StudentMcpEnv,
  studentMcpUnauthorized,
} from "./student-auth";
import { createStudentMcpServer } from "./student-server";

/**
 * /mcp/student 挂载（SAI-25，B14）——SDK Streamable HTTP 传输，**不走统一壳、
 * 不走 /api 前缀**（SDK 协议格式原样；app.ts 挂在 /api 与 /mcp 路由之后、
 * 静态托管/SPA 回退之前）。
 *
 * 与教师 mount.ts 同形态（Hono 子应用桥接 SDK Web 标准 RequestHandler：
 * c.req.raw → transport.handleRequest → 原生 Response 原样返回），
 * stateless 模式（sessionIdGenerator 缺省 = 无会话）：每个 HTTP 请求独立成套
 * （新建学生 McpServer 实例 + transport，请求结束即关），无跨请求会话状态。
 *
 * 学生端点新增两道防线：
 * - **Origin 校验**（MCP 规范建议，B14 执行步骤 5）：浏览器请求的 Origin
 *   必须是部署源（publicUrl）或与请求 Host 同源；非浏览器客户端（SDK/CLI，
 *   不发送 Origin）放行。白名单外 → 403（简单 JSON，同 401 风格）。
 *   **不添加任何 CORS 头**——不允许的来源既过不了 Origin 门也读不到响应，
 *   绝不用全开放 CORS 修客户端连接；
 * - 错误响应（401/403）是 HTTP 层简单 JSON（同教师 /mcp 风格），
 *   协议层响应（initialize/tools 等）由 SDK 原样生成，不套普通 API 响应壳。
 *
 * 日志纪律：本层不记录任何请求体/Header（Token、私密 path 不进日志）。
 */

/** 挂载选项（app.ts 注入面） */
export interface StudentMcpMountOptions {
  readonly db: Db;
  /** DATA_DIR（材料 PNG 读取） */
  readonly dataDir: string;
  /** 对外基础 URL（Origin 白名单的部署源） */
  readonly publicUrl: string;
}

/** 403 响应体（HTTP 层简单 JSON；不带 Token / 私密 path） */
const FORBIDDEN_ORIGIN_BODY = {
  error: "FORBIDDEN_ORIGIN",
  message: "不允许的来源：该 MCP 端点仅限本站客户端访问",
} as const;

/** URL 解析失败 / 非标准形态的兜底值 */
const NULL_ORIGIN = null;

/** 提取 origin 的完整 host（hostname:port；无端口即裸主机名） */
function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return NULL_ORIGIN;
  }
}

/**
 * Origin 门：无 Origin（SDK/CLI 等非浏览器客户端）放行；有 Origin 则必须
 * 与部署源（publicUrl）或请求 Host 同源（直连 IP / 自定义端口场景）。
 */
function createRejectForeignOrigin(publicUrl: string) {
  const publicHost = hostOf(publicUrl);
  return async (
    c: Context<StudentMcpEnv>,
    next: Next,
  ): Promise<Response | undefined> => {
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      const originHost = hostOf(origin);
      const requestHost = c.req.header("host") ?? "";
      // 部署源（publicUrl）匹配优先；Host 同源兜底直连 IP / 自定义端口场景
      // （app.request 等无 Host 环境只认 publicUrl）
      const allowed =
        originHost !== null &&
        (originHost === publicHost ||
          (requestHost.length > 0 && originHost === requestHost));
      if (!allowed) {
        return c.json(FORBIDDEN_ORIGIN_BODY, 403);
      }
    }
    await next();
    return;
  };
}

function readLiveAccess(db: Db, c: Context<StudentMcpEnv>) {
  const student = c.var.mcpStudent;
  const current = authenticateStudentMcp(db, c.req.header("authorization"));
  if (
    current?.id !== student.id ||
    current.connectionId !== student.connectionId
  ) {
    return "unauthorized";
  }
  return isMcpLiveContextEnabled(db, student.id, student.connectionId)
    ? "ready"
    : "disabled";
}

function liveAccessError(
  c: Context<StudentMcpEnv>,
  access: "unauthorized" | "disabled",
) {
  if (access === "unauthorized") return studentMcpUnauthorized(c);
  return c.json(
    { error: "AI_LIVE_DISABLED", message: "学生未开启实时过程授权" },
    403,
  );
}

function readWaitTask(db: Db, studentId: string) {
  const tasks = db
    .select({
      id: aiTasks.id,
      createdAt: aiTasks.createdAt,
      attemptId: aiTasks.attemptId,
      questionId: aiTasks.questionId,
    })
    .from(aiTasks)
    .where(
      and(
        eq(aiTasks.studentId, studentId),
        eq(aiTasks.channel, "mcp"),
        eq(aiTasks.status, "created"),
        isNull(aiTasks.cancelRequestedAt),
      ),
    )
    .orderBy(asc(aiTasks.createdAt), asc(aiTasks.id))
    .all();
  for (const task of tasks) {
    try {
      const policy = resolveAttemptQuestionAiPolicy(
        db,
        studentId,
        task.attemptId,
        task.questionId,
        sqliteAiPolicyConfigSource,
      );
      if (policy.resolution.usable) {
        return aiMcpWaitTaskSchema.parse({
          kind: "task",
          id: task.id,
          createdAt: task.createdAt,
        });
      }
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      // 作废或失权任务不会阻止后续可领取任务。
    }
  }
  return null;
}

/**
 * 创建 /mcp/student 子应用（app.route("/mcp/student", …) 挂载）。
 * 全方法接听（app.all）：POST 走 SDK；GET/DELETE 交由 SDK stateless 语义
 * 处理（GET=200 立即关闭的空 SSE 流、DELETE=200 空体，教师 mount 同款）；
 * 协议内错误（Content-Type / 方法不符等）由 SDK 按 MCP 规范应答。
 */
export function createStudentMcpRoutes(options: StudentMcpMountOptions) {
  const rejectForeignOrigin = createRejectForeignOrigin(options.publicUrl);
  const requireToken = createRequireStudentMcpToken(options.db);
  // 快照装配 HMAC 密钥一次性读入（与路由层同源 DATA_DIR/secret.key）
  const hmacSecret = loadOrCreateSecretKey(options.dataDir);
  return new Hono<StudentMcpEnv>()
    .use("*", rejectForeignOrigin)
    .use("*", requireToken)
    .get("/wait", async (c) => {
      const rawTimeout = c.req.query("timeout") ?? "30";
      if (
        !/^\d+$/.test(rawTimeout) ||
        Number(rawTimeout) < 1 ||
        Number(rawTimeout) > 30
      ) {
        return c.json(
          { error: "VALIDATION_ERROR", message: "等待时间须为 1 至 30 秒" },
          400,
        );
      }
      const student = c.var.mcpStudent;
      const deadline = Date.now() + Number(rawTimeout) * 1000;
      while (true) {
        const access = readLiveAccess(options.db, c);
        if (access !== "ready") return liveAccessError(c, access);
        const task = readWaitTask(options.db, student.id);
        if (task !== null) return c.json(task);
        const remaining = deadline - Date.now();
        if (remaining <= 0 || c.req.raw.signal.aborted)
          return c.body(null, 204);
        await new Promise<void>((resolve) => {
          const signal = c.req.raw.signal;
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, Math.min(250, remaining));
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
    })
    .get("/events", (c) => {
      const access = readLiveAccess(options.db, c);
      if (access !== "ready") return liveAccessError(c, access);
      c.header("X-Accel-Buffering", "no");
      const response = streamSSE(c, async (stream) => {
        const signal = c.req.raw.signal;
        const deadline = Date.now() + 60_000;
        const sent = new Set<string>();
        let nextHeartbeat = Date.now() + 15_000;
        await stream.write(": keepalive\n\n");
        while (!stream.aborted && !signal.aborted && Date.now() < deadline) {
          if (readLiveAccess(options.db, c) !== "ready") return;
          const task = readWaitTask(options.db, c.var.mcpStudent.id);
          if (task !== null && !sent.has(task.id)) {
            // 事件只唤醒领取；每次重连从数据库重新对账。
            sent.add(task.id);
            await stream.writeSSE({
              event: "task",
              id: task.id,
              data: JSON.stringify(task),
            });
          }
          if (!stream.aborted && Date.now() >= nextHeartbeat) {
            await stream.write(": keepalive\n\n");
            nextHeartbeat = Date.now() + 15_000;
          }
          if (!stream.aborted && !signal.aborted) await stream.sleep(1000);
        }
      });
      response.headers.set("Cache-Control", "no-store");
      return response;
    })
    .all("/", async (c) => {
      // 鉴权通过：token 绑定的学生（c.var.mcpStudent）成为本请求全部工具的域
      const server = createStudentMcpServer({
        db: options.db,
        dataDir: options.dataDir,
        studentId: c.var.mcpStudent.id,
        connectionId: c.var.mcpStudent.connectionId,
        hmacSecret,
      });
      // stateless 模式：不传 sessionIdGenerator（缺省即 undefined = 无会话；
      // 教师 mount.ts 同款注释口径）+ JSON 响应模式（工具型服务器）
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      // 请求结束关闭 transport 与 server 实例（stateless：不留任何状态）
      transport.onclose = () => {
        void server.close();
      };
      try {
        await server.connect(transport);
        return await transport.handleRequest(c.req.raw);
      } finally {
        // 兜底清理（onclose 之外路径，如 handleRequest 抛错）；
        // 已关闭时再关为幂等 no-op
        await transport.close();
      }
    });
}

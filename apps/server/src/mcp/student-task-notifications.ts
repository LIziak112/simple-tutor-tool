import {
  AI_TASK_PENDING_PER_STUDENT,
  aiMcpWaitTaskSchema,
} from "@tutor/contract";
import { and, asc, eq, isNull } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Db } from "../db/client.ts";
import { aiTasks } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { sqliteAiPolicyConfigSource } from "../services/ai-companion/ai-policy-config-source.ts";
import { mcpLiveContextGrant } from "../services/ai-companion/connection-service.ts";
import { resolveAttemptQuestionAiPolicy } from "../services/ai-companion/teaching-policy-service.ts";
import {
  type StudentMcpEnv,
  studentMcpToolAuthorization,
  unauthorizedMcpStudent,
} from "./student-auth.ts";

const POLL_MS = 1_000;
const STREAM_MS = 60_000;
const HEARTBEAT_MS = 15_000;

function waitForPoll(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

function nextTask(db: Db, studentId: string, sent?: ReadonlySet<string>) {
  const candidates = db
    .select({
      id: aiTasks.id,
      attemptId: aiTasks.attemptId,
      questionId: aiTasks.questionId,
      createdAt: aiTasks.createdAt,
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
    .limit(AI_TASK_PENDING_PER_STUDENT)
    .all();
  for (const task of candidates) {
    if (sent?.has(task.id)) continue;
    try {
      const { resolution } = resolveAttemptQuestionAiPolicy(
        db,
        studentId,
        task.attemptId,
        task.questionId,
        sqliteAiPolicyConfigSource,
        { frozenOnly: true },
      );
      if (!resolution.usable) continue;
    } catch (error) {
      if (error instanceof HttpError) continue;
      throw error;
    }
    const result = aiMcpWaitTaskSchema.safeParse({
      kind: "task",
      id: task.id,
      createdAt: task.createdAt,
    });
    if (result.success) return result.data;
  }
  return null;
}

function liveAccess(c: Context<StudentMcpEnv>, db: Db) {
  const student = c.var.mcpStudent;
  const authorized = studentMcpToolAuthorization(
    db,
    c.req.header("authorization"),
    student,
  );
  const readGrant = () =>
    mcpLiveContextGrant(db, student.studentId, student.connectionId);
  const initial = readGrant();
  return () => {
    if (!authorized()) return "unauthorized";
    return initial !== null && readGrant() === initial ? "ready" : "disabled";
  };
}

function deniedResponse(
  c: Context<StudentMcpEnv>,
  access: "unauthorized" | "disabled",
) {
  return access === "unauthorized"
    ? unauthorizedMcpStudent(c)
    : c.json(
        { error: "AI_LIVE_DISABLED", message: "实时过程授权已关闭或更新" },
        403,
      );
}

/** 通知仅唤醒领取，连接中最多同时保留一次长轮询和一条事件流。 */
export function createStudentTaskNotificationRoutes(db: Db) {
  const polls = new Set<string>();
  const streams = new Set<string>();
  const tooMany = (c: Context<StudentMcpEnv>) =>
    c.json(
      { error: "AI_NOTIFICATION_BUSY", message: "已有正在运行的同类通知请求" },
      429,
      { "Retry-After": "1" },
    );
  return new Hono<StudentMcpEnv>()
    .get("/wait", async (c) => {
      c.header("Cache-Control", "no-store");
      if (c.req.raw.method !== "GET")
        return c.body(null, 405, { Allow: "GET" });
      const timeout = c.req.query("timeout") ?? "30";
      const seconds = Number(timeout);
      if (!/^\d{1,2}$/.test(timeout) || seconds < 1 || seconds > 30) {
        return c.json(
          { error: "VALIDATION_ERROR", message: "等待时间须为 1 至 30 秒" },
          400,
        );
      }
      const { connectionId, studentId } = c.var.mcpStudent;
      const checkAccess = liveAccess(c, db);
      const access = checkAccess();
      if (access !== "ready") return deniedResponse(c, access);
      if (polls.has(connectionId)) return tooMany(c);
      polls.add(connectionId);
      try {
        const deadline = performance.now() + seconds * 1000;
        const signal = c.req.raw.signal;
        while (!signal.aborted) {
          const access = checkAccess();
          if (access !== "ready") return deniedResponse(c, access);
          const task = nextTask(db, studentId);
          if (task) return c.json(task);
          const remaining = deadline - performance.now();
          if (remaining <= 0) break;
          await waitForPoll(signal, Math.min(POLL_MS, remaining));
        }
        return c.body(null, 204);
      } finally {
        polls.delete(connectionId);
      }
    })
    .get("/events", (c) => {
      c.header("Cache-Control", "no-store");
      if (c.req.raw.method !== "GET")
        return c.body(null, 405, { Allow: "GET" });
      const { connectionId, studentId } = c.var.mcpStudent;
      const checkAccess = liveAccess(c, db);
      const access = checkAccess();
      if (access !== "ready") return deniedResponse(c, access);
      if (streams.has(connectionId)) return tooMany(c);
      streams.add(connectionId);
      c.header("X-Accel-Buffering", "no");
      const response = streamSSE(c, async (stream) => {
        const signal = c.req.raw.signal;
        const cancellation = new AbortController();
        const release = () => {
          if (!cancellation.signal.aborted) {
            cancellation.abort();
            streams.delete(connectionId);
          }
        };
        const stop = () => {
          release();
          stream.abort();
        };
        stream.onAbort(release);
        signal.addEventListener("abort", stop, { once: true });
        const timeout = setTimeout(stop, STREAM_MS);
        const sent = new Set<string>();
        let nextHeartbeat = performance.now() + HEARTBEAT_MS;
        try {
          if (signal.aborted) return;
          await stream.write(": keepalive\n\n");
          while (!cancellation.signal.aborted && checkAccess() === "ready") {
            const task = nextTask(db, studentId, sent);
            if (task) {
              sent.add(task.id);
              await stream.writeSSE({
                event: "task",
                id: task.id,
                data: JSON.stringify(task),
              });
            } else if (performance.now() >= nextHeartbeat) {
              await stream.write(": keepalive\n\n");
              nextHeartbeat = performance.now() + HEARTBEAT_MS;
            } else {
              await waitForPoll(cancellation.signal, POLL_MS);
            }
          }
        } catch {
          // 流已打开，避免把异常原文写入事件或日志。
          console.warn("学生 MCP 求助通知提前结束");
        } finally {
          clearTimeout(timeout);
          signal.removeEventListener("abort", stop);
          release();
        }
      });
      response.headers.set("Cache-Control", "no-store");
      return response;
    });
}

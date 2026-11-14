import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { aiConnections } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { registerDevice } from "./device-service.ts";

/** 设备只绑定鉴权连接；不接受客户端设备声明，也不读取连接的私密配置。 */
export function registerMcpMemoDevice(
  db: Db,
  studentId: string,
  connectionId: string | undefined,
  now = new Date(),
): string | undefined {
  // 保留旧的服务端注册调用兼容；真实 MCP 鉴权始终传连接 id。
  if (connectionId === undefined) return undefined;
  const connection = db
    .select({ id: aiConnections.id })
    .from(aiConnections)
    .where(
      and(
        eq(aiConnections.id, connectionId),
        eq(aiConnections.studentId, studentId),
        eq(aiConnections.channel, "mcp"),
        isNull(aiConnections.archivedAt),
      ),
    )
    .get();
  if (!connection) throw new HttpError(404, "NOT_FOUND", "连接不存在或不可见");
  return registerDevice(
    db,
    { type: "student", id: studentId },
    {
      deviceId: connection.id,
      type: "agent",
      os: "MCP 连接",
      browser: connection.id.slice(0, 8),
    },
    now,
  ).deviceId;
}

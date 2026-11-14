import type { Db } from "../../db/client.ts";
import { HttpError } from "../../lib/http-error.ts";
import { listStudentAiConnections } from "./connection-service.ts";

/** 所有任务创建入口共用首次知情门；不为没有连接的账号建立僵尸任务。 */
export function requireAiInformedGate(db: Db, studentId: string): void {
  if (listStudentAiConnections(db, studentId).length === 0)
    throw new HttpError(
      403,
      "AI_SETUP_REQUIRED",
      "还没有可用的 AI 连接，请先在设置中完成连接与首次知情确认",
    );
}

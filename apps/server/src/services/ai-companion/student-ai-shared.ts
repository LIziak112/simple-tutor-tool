import { createHash } from "node:crypto";
import type { Db } from "../../db/client.ts";
import { HttpError } from "../../lib/http-error.ts";

/**
 * AI 伴学两套任务类型（逐题 ai_tasks / 整体复盘 ai_attempt_review_tasks）
 * 共用的服务层小件：事务句柄统一、哈希、冲突错误、北京自然日窗口、稳定
 * 游标编解码。由 student-ai-queue 与 student-ai-attempt-review 的同式副本
 * 收敛而来（/simplify 闸门，2026-10-24）——配额口径与游标格式只此一份。
 */

/** 事务句柄（db.transaction 回调参数）按 Db 传递：同一底层连接，结构同源 */
export type QueueTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 事务参数按 Db 传递：两者包装同一底层 better-sqlite3 连接，查询方法签名
 * 同源；断言只发生在本函数一处（不用 any，不绕过类型检查的其余部分）。
 */
export function asDb(handle: Db | QueueTx): Db {
  return handle as Db;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 409 AI_STATE_CONFLICT（状态 CAS 不符等共享资源冲突） */
export function conflict(message: string): HttpError {
  return new HttpError(409, "AI_STATE_CONFLICT", message);
}

/** 北京自然日窗口 [startIso, endIso)（AI 日限额与作业列表同一计数口径） */
export function beijingDayWindowOf(now: Date): {
  startIso: string;
  endIso: string;
} {
  const DAY_MS = 86_400_000;
  const BEIJING_OFFSET_MS = 8 * 3_600_000;
  const dayStartMs =
    Math.floor((now.getTime() + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS -
    BEIJING_OFFSET_MS;
  return {
    startIso: new Date(dayStartMs).toISOString(),
    endIso: new Date(dayStartMs + DAY_MS).toISOString(),
  };
}

/** 游标载荷（base64url JSON；稳定排序键 createdAt+id 的不透明化） */
export interface CursorPayload {
  readonly c: string;
  readonly i: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** 解码失败抛 400 VALIDATION_ERROR（调用方无需重复兜底） */
export function decodeCursor(cursor: string): CursorPayload {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (
      typeof parsed.c !== "string" ||
      typeof parsed.i !== "string" ||
      parsed.c.length === 0 ||
      parsed.i.length === 0
    ) {
      throw new Error("invalid cursor payload");
    }
    return { c: parsed.c, i: parsed.i };
  } catch {
    throw new HttpError(400, "VALIDATION_ERROR", "分页游标格式非法");
  }
}

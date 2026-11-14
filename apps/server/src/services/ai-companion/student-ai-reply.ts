import { randomUUID } from "node:crypto";
import type { AiMessage, AiReplyIssue } from "@tutor/contract";
import { AI_REPLY_MAX_CHARS } from "@tutor/contract";
import { checkAiReply } from "@tutor/md-dsl";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { aiFacts, aiMessages } from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";
import { asDb, type QueueTx } from "./student-ai-shared.ts";

/**
 * 回信写入原语（MCP 写回与页内派发写回共用）：截断、格式校验与警告降级、
 * 回信行入库。从 student-ai-queue 抽出（审查修复 2026-11-10，队列模块只降不升）；
 * 任务状态转换与事实记录仍在队列模块，这里不碰任务行。
 */

/** 回信正文超长截断（契约口径：不硬拒，截断并显式声明） */
export function truncateReply(text: string): {
  content: string;
  truncated: boolean;
} {
  if (text.length <= AI_REPLY_MAX_CHARS)
    return { content: text, truncated: false };
  return {
    content: text.slice(0, AI_REPLY_MAX_CHARS),
    truncated: true,
  };
}

export interface CheckedReply {
  readonly content: string;
  readonly truncated: boolean;
  readonly formatWarnings: AiReplyIssue[];
}

/**
 * MCP 写回的格式门：明确 error 阻止写回（422，保留租约让 Agent 修正后重提）；
 * 合法长回信截断后再查一次，截断造成的 error 降级为 TRUNCATED_MATH warning
 * （页面安全降级显示），其余 warning 原样提示复核。
 */
export function checkedReplyOf(replyMarkdown: string): CheckedReply {
  const checked = checkAiReply(replyMarkdown);
  if (!checked.valid) {
    throw new HttpError(
      422,
      "AI_REPLY_FORMAT_INVALID",
      "回信数学格式有误，请按行列反馈修正后使用当前租约重新提交。",
      { _issues: checked.issues, version: checked.version },
    );
  }
  const { content, truncated } = truncateReply(replyMarkdown);
  const storedCheck = truncated ? checkAiReply(content) : checked;
  const formatWarnings = storedCheck.issues.map((issue) =>
    truncated && issue.severity === "error"
      ? {
          ...issue,
          severity: "warning" as const,
          code: "TRUNCATED_MATH" as const,
          message: "截断后的片段格式不完整，页面将安全降级显示。",
        }
      : issue,
  );
  return { content, truncated, formatWarnings };
}

/** 回信入库（assistant 消息行；createdAt 用调用方的事务时刻） */
export function insertAssistantReply(
  tx: QueueTx,
  taskId: string,
  content: string,
  nowIso: string,
): void {
  tx.insert(aiMessages)
    .values({
      id: randomUUID(),
      taskId,
      role: "assistant",
      contentMd: content,
      createdAt: nowIso,
    })
    .run();
}

/** 学生及教师共用的对话消息投影，按时间和 ID 稳定排序。 */
export function messageRowsOf(db: Db | QueueTx, taskId: string): AiMessage[] {
  return asDb(db)
    .select({
      id: aiMessages.id,
      taskId: aiMessages.taskId,
      role: aiMessages.role,
      contentMd: aiMessages.contentMd,
      createdAt: aiMessages.createdAt,
    })
    .from(aiMessages)
    .where(eq(aiMessages.taskId, taskId))
    .orderBy(asc(aiMessages.createdAt), asc(aiMessages.id))
    .all();
}

export function studentMessagesOf(
  db: Db | QueueTx,
  taskId: string,
): AiMessage[] {
  return messageRowsOf(db, taskId).filter(
    (message) => message.role === "student",
  );
}

export function latestMessageAtOf(
  db: Db | QueueTx,
  taskId: string,
): string | undefined {
  return asDb(db)
    .select({ createdAt: aiMessages.createdAt })
    .from(aiMessages)
    .where(eq(aiMessages.taskId, taskId))
    .orderBy(desc(aiMessages.createdAt))
    .limit(1)
    .get()?.createdAt;
}

/** 对话消息按发生次序排列，兼容同毫秒与时钟回拨。 */
export function nextMessageAtOf(now: string, latest?: string | null): string {
  return latest != null && now <= latest
    ? new Date(Date.parse(latest) + 1).toISOString()
    : now;
}

/** 同一内容仅在应答当前一轮时算重放。 */
export function lastReplyReceipt(
  db: Db | QueueTx,
  taskId: string,
): { contentHash: string; delivered: boolean; generation?: number } | null {
  const fact = asDb(db)
    .select()
    .from(aiFacts)
    .where(and(eq(aiFacts.taskId, taskId), eq(aiFacts.type, "reply_received")))
    .orderBy(desc(aiFacts.serverTs))
    .limit(1)
    .get();
  if (fact?.detailJson == null) return null;
  const lastStudent = studentMessagesOf(db, taskId).at(-1);
  if (lastStudent && fact.serverTs < lastStudent.createdAt) return null;
  try {
    const { contentHash, delivered, generation } = JSON.parse(
      fact.detailJson,
    ) as { contentHash?: unknown; delivered?: unknown; generation?: unknown };
    return typeof contentHash === "string"
      ? {
          contentHash,
          delivered: delivered !== false,
          ...(typeof generation === "number" && { generation }),
        }
      : null;
  } catch {
    return null;
  }
}

/** 首条学生消息行（创建时插入；视图读取与 refresh 替换正文共用） */
export function firstStudentMessageRow(
  db: Db | QueueTx,
  taskId: string,
): typeof aiMessages.$inferSelect | undefined {
  return asDb(db)
    .select()
    .from(aiMessages)
    .where(and(eq(aiMessages.taskId, taskId), eq(aiMessages.role, "student")))
    .orderBy(asc(aiMessages.createdAt), asc(aiMessages.id))
    .get();
}

/** 首条学生消息（任务问题正文；数据残缺是故障不是空问题） */
export function firstQuestionOf(db: Db | QueueTx, taskId: string): string {
  const row = firstStudentMessageRow(db, taskId);
  if (row === undefined) {
    throw new HttpError(
      500,
      "AI_CONTEXT_BROKEN",
      "任务缺少首条学生消息，数据不完整",
    );
  }
  return row.contentMd;
}

export function hasAssistantReply(db: Db | QueueTx, taskId: string): boolean {
  return (
    asDb(db)
      .select({ id: aiMessages.id })
      .from(aiMessages)
      .where(
        and(eq(aiMessages.taskId, taskId), eq(aiMessages.role, "assistant")),
      )
      .get() !== undefined
  );
}

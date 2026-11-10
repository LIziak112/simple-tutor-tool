import { randomUUID } from "node:crypto";
import type { AiReplyIssue } from "@tutor/contract";
import { AI_REPLY_MAX_CHARS } from "@tutor/contract";
import { checkAiReply } from "@tutor/md-dsl";
import { aiMessages } from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";
import type { QueueTx } from "./student-ai-shared.ts";

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

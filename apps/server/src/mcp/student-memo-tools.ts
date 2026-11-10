import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MEMO_MCP_MEDIA_MAX_BYTES,
  MEMO_TAG_MAX,
  MEMO_TAGS_MAX,
  MEMO_TEXT_MAX,
  memoKindSchema,
} from "@tutor/contract";
import { z } from "zod";
import type { Db } from "../db/client";
import { listMemos, readMemoMedia } from "../services/memo-read";
import { createAgentMemo } from "../services/memo-service";
import { guard, jsonContent } from "./tool-result";

/**
 * 随笔三工具（模块 5 第一步，问题清单 Q9「随笔读取 / 转记」；Q17 首轮仅本人 +
 * 本人授权的 Agent）。全部复用 memo-read / memo-service 既有服务层，与页面接口同
 * 一规则；studentId 只来自鉴权注入的 deps。
 * - list_my_memos：只读列表（文字正文 + 媒体元信息，不内联字节）；
 * - add_memo：Agent 代为转记一条文字随笔（source=agent；语音转写、对话结论归档
 *   都从这里进——转写在 Agent 侧做，服务端不转码不转写）；
 * - get_memo_media：按 id 取一条语音 / 图片 / 手写的字节（SDK audio / image
 *   content 内联），超 MEMO_MCP_MEDIA_MAX_BYTES 返回结构化错误让 Agent 改走
 *   元信息或让学生在页面里听 / 看。
 */

const memoAnchorInputSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("question"),
      attemptId: z.uuid().describe("作答 id（须为本人的作答）"),
      questionId: z.string().min(1).describe("题号（DSL 题 id）"),
      label: z.string().trim().min(1).max(120).optional(),
    }),
    z.object({
      kind: z.literal("lecture"),
      lectureId: z.uuid().describe("讲义 id（须为本人可见）"),
      sectionId: z.string().min(1).optional(),
      label: z.string().trim().min(1).max(120).optional(),
    }),
  ])
  .describe("上下文锚：锚到当前题或讲义；省略 = 无锚");

export function registerStudentMemoTools(
  server: McpServer,
  deps: {
    readonly db: Db;
    readonly dataDir: string;
    readonly studentId: string;
  },
): void {
  const { db, dataDir, studentId } = deps;

  server.registerTool(
    "list_my_memos",
    {
      description:
        "列出我（当前学生）的随笔：文字正文、语音 / 图片 / 手写的元信息（格式、字节、时长）、上下文锚、标签，按记录时间倒序分页。只读。媒体字节请用 get_memo_media 按 id 取。",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional().describe("上一页返回的 nextCursor"),
        kind: memoKindSchema.optional(),
        tag: z.string().min(1).max(MEMO_TAG_MAX).optional(),
        attemptId: z.uuid().optional().describe("只看锚到该作答的"),
        lectureId: z.uuid().optional().describe("只看锚到该讲义的"),
        since: z.iso
          .datetime({ offset: true })
          .optional()
          .describe("只看记录时间不早于此刻的"),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard((query) => jsonContent(listMemos(db, studentId, query))),
  );

  server.registerTool(
    "add_memo",
    {
      description:
        "替我（当前学生）记一条文字随笔（source=agent）：语音的转写文本、对话里的结论、要点摘录都从这里转记。原始随笔不可改——转写请新增一条，不要试图改原语音。每次调用新增一条，重试前先确认是否已记。",
      inputSchema: {
        text: z.string().trim().min(1).max(MEMO_TEXT_MAX),
        tags: z
          .array(z.string().trim().min(1).max(MEMO_TAG_MAX))
          .max(MEMO_TAGS_MAX)
          .optional(),
        anchor: memoAnchorInputSchema.optional(),
        recordedAt: z.iso
          .datetime({ offset: true })
          .optional()
          .describe(
            "内容实际发生的时间（如转写对应的原语音时间）；省略 = 现在",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guard((input) => jsonContent(createAgentMemo(db, studentId, input))),
  );

  server.registerTool(
    "get_memo_media",
    {
      description:
        "按 id 取我（当前学生）一条语音 / 图片 / 手写随笔的媒体内容（语音以 audio、图片与手写以 image 内联返回，附元信息）。超过 8 MB 的媒体不内联，返回 MEMO_MEDIA_TOO_LARGE 并附元信息。",
      inputSchema: { memoId: z.uuid() },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(({ memoId }) => {
      const file = readMemoMedia(db, dataDir, studentId, memoId);
      const meta = jsonContent({ memo: file.memo });
      if (file.bytes.byteLength > MEMO_MCP_MEDIA_MAX_BYTES) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "MEMO_MEDIA_TOO_LARGE",
                  message: `媒体 ${file.bytes.byteLength} 字节超过 MCP 内联上限 ${MEMO_MCP_MEDIA_MAX_BYTES} 字节，请让学生在页面里查看`,
                  memo: file.memo,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
      const data = Buffer.from(file.bytes).toString("base64");
      return {
        content: [
          ...meta.content,
          file.memo.kind === "voice"
            ? { type: "audio" as const, data, mimeType: file.contentType }
            : { type: "image" as const, data, mimeType: file.contentType },
        ],
      };
    }),
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AI_REPLY_CHECK_VERSION,
  AI_REPLY_FORMAT_INSTRUCTIONS,
  AI_REPLY_MAX_CHARS,
  aiTaskStatusSchema,
} from "@tutor/contract";
import { checkAiReply } from "@tutor/md-dsl";
import { z } from "zod";
import { HttpError } from "../lib/http-error";
import {
  collectAiTaskMaterialBytes,
  taskOf,
} from "../services/ai-companion/student-ai-materials.ts";
import {
  claimMcpTask,
  listStudentAiTasks,
  renewMcpLease,
  submitMcpReply,
} from "../services/ai-companion/student-ai-queue.ts";
import { outboundAssemblyOfTask } from "../services/ai-companion/student-ai-worker.ts";
import { learningRecordAiViewForTask } from "../services/learning-record-ai.ts";
import { submitRubricOpinion } from "../services/rubric-review-service.ts";
import { AI_MCP_CLAIM_IMAGES_MAX_BYTES } from "./mcp-image-budget.ts";
import type { StudentMcpServerDeps } from "./student-server.ts";
import { guard, jsonContent } from "./tool-result";

/** 契约截断阈值32KiB之上留余量，既有回信入参上限不变。 */
const REPLY_INPUT_MAX_CHARS = 40_000;

/** 逐题AI任务的读取、领取、续租与写回，只调用既有任务服务。 */
export function registerStudentAiTaskTools(
  server: McpServer,
  deps: StudentMcpServerDeps,
): void {
  const { db, dataDir, studentId } = deps;
  server.registerTool(
    "check_ai_reply",
    {
      description:
        "提交前检查 AI 回信的数学格式；只检查传入正文，不保存、不领取、不续租、不改变任务状态。按行列反馈修正 error 后再提交。" +
        AI_REPLY_FORMAT_INSTRUCTIONS,
      inputSchema: { replyMarkdown: z.string().max(REPLY_INPUT_MAX_CHARS) },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(({ replyMarkdown }) => jsonContent(checkAiReply(replyMarkdown))),
  );

  // 1. list_my_ai_tasks：只读列表（无领取/已读副作用）
  server.registerTool(
    "list_my_ai_tasks",
    {
      description:
        "列出当前学生的 AI 求助任务（元信息：状态、通道、创建时间、上下文版本、是否已有回信等），游标分页。只读：不领取任务、不标记已读。可用 status 过滤（created=待领取、claimed=处理中、replied=已回信等）。",
      inputSchema: {
        status: aiTaskStatusSchema
          .optional()
          .describe("按状态过滤；缺省 = 全部"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("每页条数，缺省 20"),
        cursor: z
          .string()
          .optional()
          .describe("上一页返回的 nextCursor；缺省首页"),
      },
      annotations: { readOnlyHint: true },
    },
    guard(({ status, limit, cursor }) => {
      const result = listStudentAiTasks(db, {
        studentId,
        ...(status !== undefined ? { status } : {}),
        limit: limit ?? 20,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      return jsonContent(result);
    }),
  );

  // 2. claim_ai_task：领取（幂等/上限/逐任务模式裁决/固定材料装配）
  server.registerTool(
    "claim_ai_task",
    {
      description:
        "领取一个 AI 求助任务：缺省按创建时间领取下一个待领取任务（无任务返回 claimed:false）；携带 taskId = 指定领取（重放已领取任务 → 409，不改抢其他任务）。领取即出站：按当前教学模式实时裁决并重装配提示词（提交后的待处理任务按复盘尺度），返回租约（leaseToken/leaseUntil）、generation、contextVersion、完整出站消息（system + 数据段 + 历史 + 学生诉求）与材料图像。图像为 PNG base64（SDK image content）；材料合计超限将显式报 AI_MATERIAL_TOO_LARGE（租约信息随错误交付，可仅文字写回）。不支持识图的客户端可传 includeImages=false 显式不附图。写回用 submit_ai_reply（数据段含「量表」段的判卷任务改用 submit_rubric_opinion 逐项写回），长处理用 renew_ai_lease 续租。",
      inputSchema: {
        taskId: z
          .string()
          .uuid()
          .optional()
          .describe("指定领取的任务 id；缺省 = 按创建时间领取下一个"),
        includeImages: z
          .boolean()
          .optional()
          .describe("是否随领取返回材料图像（默认 true）；false = 显式仅文字"),
      },
    },
    guard(async ({ taskId, includeImages }) => {
      const claimed = claimMcpTask(db, {
        studentId,
        ...(taskId !== undefined ? { taskId } : {}),
      });
      if (claimed === null) {
        return jsonContent({
          claimed: false,
          message: "当前没有可领取的任务",
        });
      }
      const task = taskOf(db, claimed.taskId);
      if (task === undefined) {
        throw new HttpError(
          500,
          "AI_CONTEXT_BROKEN",
          "领取的任务行缺失，请稍后重试",
        );
      }
      // LR-PR5：学习记录视图（可选增强；装配失败省略 record，材料照常交付）
      const recordView = learningRecordAiViewForTask(db, dataDir, task);
      // 装配（领取事务外；快照损坏 → AI_CONTEXT_BROKEN 不伪造题面）
      const assembly = outboundAssemblyOfTask(db, task, { recordView });
      const base = {
        claimed: true as const,
        replyFormat: {
          version: AI_REPLY_CHECK_VERSION,
          instructions: AI_REPLY_FORMAT_INSTRUCTIONS,
          manifestUrl: new URL(
            "api/public/ai-reply-checker/manifest.json",
            `${deps.publicUrl.replace(/\/$/, "")}/`,
          ).href,
        },
        taskId: claimed.taskId,
        attemptId: task.attemptId,
        questionId: task.questionId,
        modeAtSend: task.modeAtSend,
        beforeSubmit: task.beforeSubmit,
        leaseToken: claimed.leaseToken,
        leaseUntil: claimed.leaseUntil,
        generation: claimed.generation,
        contextVersion: claimed.contextVersion,
        runtimeEpoch: claimed.runtimeEpoch,
        systemPromptMd: assembly.systemPromptMd,
        contextDataMd: assembly.contextDataMd,
        messages: assembly.messages,
        ...(recordView !== undefined ? { record: recordView } : {}),
      };
      if (includeImages === false) {
        return jsonContent({ ...base, imagesIncluded: false, materials: [] });
      }
      // 材料字节：缺件按 AI_MATERIAL_BROKEN 报错（不虚报已附图）；超限显式
      // 拒绝但不静默丢页——租约信息随错误交付，客户端可仅文字写回
      const collected = collectAiTaskMaterialBytes(db, dataDir, claimed.taskId);
      const totalBytes = collected.reduce(
        (sum, item) => sum + item.row.byteSize,
        0,
      );
      if (totalBytes > AI_MCP_CLAIM_IMAGES_MAX_BYTES) {
        throw new HttpError(
          413,
          "AI_MATERIAL_TOO_LARGE",
          `材料图像合计 ${totalBytes} 字节，超过单次领取附图上限 ${AI_MCP_CLAIM_IMAGES_MAX_BYTES} 字节（base64 膨胀后报文受限）；任务已领取，可凭租约仅文字写回，或放任租约过期由学生重新发起`,
          {
            ...base,
            materials: collected.map((item) => ({
              kind: item.row.kind,
              pageIndex: item.row.pageIndex,
              byteSize: item.row.byteSize,
            })),
          },
        );
      }
      const text = jsonContent({
        ...base,
        imagesIncluded: true,
        materials: collected.map((item) => ({
          kind: item.row.kind,
          pageIndex: item.row.pageIndex,
          byteSize: item.row.byteSize,
        })),
      });
      // 图像按 SDK 真实 content 结构追加（顺序与 materials 元信息一致）
      return {
        content: [
          ...text.content,
          ...collected.map((item) => ({
            type: "image" as const,
            data: Buffer.from(item.bytes).toString("base64"),
            mimeType: "image/png" as const,
          })),
        ],
      };
    }),
  );

  // 3. renew_ai_lease：续租（仅当前有效 lease 持有者）
  server.registerTool(
    "renew_ai_lease",
    {
      description:
        "续租当前持有的任务租约（每次 +10 分钟，累计上限 60 分钟）。只对 claim_ai_task 返回的未过期 leaseToken 有效；租约已过期或不是当前持有者 → 409。",
      inputSchema: {
        taskId: z.string().uuid().describe("claim_ai_task 返回的任务 id"),
        leaseToken: z.string().min(1).describe("claim_ai_task 返回的租约凭证"),
      },
    },
    guard(({ taskId, leaseToken }) => {
      const { leaseUntil } = renewMcpLease(db, {
        studentId,
        taskId,
        leaseToken,
      });
      return jsonContent({ renewed: true, taskId, leaseUntil });
    }),
  );

  // 4. submit_ai_reply：回信写回（沿共享写回逻辑，不直写库）
  server.registerTool(
    "submit_ai_reply",
    {
      description:
        "把 AI 回信写回平台（学生在伴学栏查看）。校验任务归属与租约：leaseToken 必须是当前有效持有者；contextVersion/runtimeEpoch 与领取时不一致 → 409（迟到回执仅记事实，不覆盖首次成功）。同内容重放幂等成功（duplicate:true）；正文超过平台上限将被截断并在 truncated:true 声明。正文用 Markdown。" +
        AI_REPLY_FORMAT_INSTRUCTIONS,
      inputSchema: {
        taskId: z.string().uuid().describe("claim_ai_task 返回的任务 id"),
        leaseToken: z.string().min(1).describe("claim_ai_task 返回的租约凭证"),
        replyMarkdown: z
          .string()
          .min(1)
          .max(REPLY_INPUT_MAX_CHARS)
          .describe("回信正文（Markdown）"),
        contextVersion: z
          .string()
          .optional()
          .describe(
            "领取时返回的 contextVersion（推荐携带，旧上下文回执将被拒绝）",
          ),
        runtimeEpoch: z
          .string()
          .optional()
          .describe("领取时返回的 runtimeEpoch（推荐携带）"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    guard(
      ({ taskId, leaseToken, replyMarkdown, contextVersion, runtimeEpoch }) => {
        // 超长由服务层按契约单源截断（truncated:true 声明），MCP 层不提前截断
        const result = submitMcpReply(db, {
          studentId,
          taskId,
          leaseToken,
          replyMarkdown,
          ...(contextVersion !== undefined
            ? { expectedContextVersion: contextVersion }
            : {}),
          ...(runtimeEpoch !== undefined
            ? { expectedRuntimeEpoch: runtimeEpoch }
            : {}),
        });
        return jsonContent({
          submitted: true,
          taskId,
          duplicate: result.duplicate,
          truncated: result.truncated,
          formatWarnings: result.formatWarnings ?? [],
          maxChars: AI_REPLY_MAX_CHARS,
        });
      },
    ),
  );

  // 4b. submit_rubric_opinion：量表判卷意见写回（模块 3）——同一任务租约，
  //     结构化逐项档位落 responses.rubric_agent_json，同时生成回信入伴学栏
  server.registerTool(
    "submit_rubric_opinion",
    {
      description:
        "只用于量表判卷任务（数据段「量表」段末尾写着「学习者请你按量表逐项给出独立意见」）：写回逐项意见，每个量表项一个档位（1–4，1 最低）+ 可选一句证据（引用作答原文或量表依据）+ 整体一句评语。校验任务归属与租约（同 submit_ai_reply）；项必须与量表一一对应，缺项/多项/未知 id 拒绝。普通求助任务（即使数据段带「量表」段）、答案尚未公布、练习已不可用 → 409 RUBRIC_NOT_AVAILABLE，此时改用 submit_ai_reply 写普通回信。意见只是参考，学习者会与自评并排后裁定。平台会据此生成一条 Markdown 回信，无需再调 submit_ai_reply。",
      inputSchema: {
        taskId: z.string().uuid().describe("claim_ai_task 返回的任务 id"),
        leaseToken: z.string().min(1).describe("claim_ai_task 返回的租约凭证"),
        ratings: z
          .array(
            z.object({
              id: z.string().min(1).describe("量表项 id（如 r1）"),
              level: z.number().int().min(1).max(4).describe("档位 1–4"),
              evidence: z
                .string()
                .max(300)
                .optional()
                .describe("一句证据：引用作答原文或说明依据"),
            }),
          )
          .min(1)
          .describe("逐项评定，须覆盖量表全部项"),
        note: z.string().min(1).max(300).describe("整体一句评语"),
        contextVersion: z.string().optional(),
        runtimeEpoch: z.string().optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    guard(
      ({ taskId, leaseToken, ratings, note, contextVersion, runtimeEpoch }) => {
        const result = submitRubricOpinion(db, {
          studentId,
          taskId,
          leaseToken,
          opinion: { ratings, note },
          ...(contextVersion !== undefined
            ? { expectedContextVersion: contextVersion }
            : {}),
          ...(runtimeEpoch !== undefined
            ? { expectedRuntimeEpoch: runtimeEpoch }
            : {}),
        });
        return jsonContent({
          submitted: true,
          taskId,
          duplicate: result.duplicate,
          agent: result.review.agent,
        });
      },
    ),
  );
}

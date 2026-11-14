import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  aiAttemptReviewReportSchema,
  aiAttemptReviewStatusSchema,
} from "@tutor/contract";
import { z } from "zod";
import {
  claimAttemptReviewTask,
  renewAttemptReviewLease,
  submitAttemptReviewResult,
} from "../services/ai-companion/student-ai-attempt-review.ts";
import { listAttemptReviewTasks } from "../services/ai-companion/student-ai-attempt-review-list.ts";
import type { StudentMcpServerDeps } from "./student-server.ts";
import { guard, jsonContent } from "./tool-result";

/** 整卷复盘是独立任务类型，领取与回写沿现有租约和授权。 */
export function registerStudentAttemptReviewTools(
  server: McpServer,
  deps: StudentMcpServerDeps,
): void {
  const { db, studentId, hmacSecret } = deps;
  // 5. list_my_attempt_reviews：整体复盘任务只读列表（独立任务类型，不与
  //    逐题任务混排；领取/写回用下列专属工具）
  server.registerTool(
    "list_my_attempt_reviews",
    {
      description:
        "列出当前学生的「本次练习整体复盘」任务（元信息：状态、覆盖题数、创建时间），游标分页。只读：不领取任务。整体复盘是独立任务类型：一个 attempt 一份整体上下文，与逐题求助任务互不混排。",
      inputSchema: {
        status: aiAttemptReviewStatusSchema
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
      const result = listAttemptReviewTasks(db, {
        studentId,
        ...(status !== undefined ? { status } : {}),
        limit: limit ?? 20,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      return jsonContent({
        tasks: result.tasks.map((task) => ({
          taskId: task.id,
          attemptId: task.attemptId,
          status: task.status,
          questionCount: task.questionCount,
          createdAt: task.createdAt,
        })),
      });
    }),
  );

  // 6. claim_attempt_review：领取整体复盘任务（领取即出站：整体快照+提示词+租约）
  server.registerTool(
    "claim_attempt_review",
    {
      description:
        "领取一个「本次练习整体复盘」任务：缺省按创建时间领取下一个待领取任务（无任务返回 claimed:false）；携带 taskId = 指定领取（范围或授权已变化 → 409，任务转为暂停，不悄悄改抢）。领取即出站：返回本次练习的整体快照（每题题面、作答状态、参考答案与解析、统计）、固定分析提示词与租约。按提示词产出约定 JSON 报告后用 submit_attempt_review_result 写回；长处理用 renew_attempt_review_lease 续租。",
      inputSchema: {
        taskId: z
          .string()
          .uuid()
          .optional()
          .describe("指定领取的任务 id；缺省 = 按创建时间领取下一个"),
      },
    },
    guard(({ taskId }) => {
      const claimed = claimAttemptReviewTask(
        db,
        { studentId, ...(taskId !== undefined ? { taskId } : {}) },
        { hmacSecret },
      );
      if (claimed === null) {
        return jsonContent({
          claimed: false,
          message: "当前没有可领取的整体复盘任务",
        });
      }
      return jsonContent({ claimed: true, ...claimed });
    }),
  );

  // 7. renew_attempt_review_lease：续租（仅当前有效租约持有者）
  server.registerTool(
    "renew_attempt_review_lease",
    {
      description:
        "续租当前持有的整体复盘任务租约（每次 +10 分钟，累计上限 60 分钟）。只对 claim_attempt_review 返回的未过期 leaseToken 有效；过期或非当前持有者 → 409。",
      inputSchema: {
        taskId: z
          .string()
          .uuid()
          .describe("claim_attempt_review 返回的任务 id"),
        leaseToken: z
          .string()
          .min(1)
          .describe("claim_attempt_review 返回的租约凭证"),
      },
    },
    guard(({ taskId, leaseToken }) => {
      const { leaseUntil } = renewAttemptReviewLease(
        db,
        { studentId, taskId, leaseToken },
        { hmacSecret },
      );
      return jsonContent({ renewed: true, taskId, leaseUntil });
    }),
  );

  // 8. submit_attempt_review_result：报告结构与服务层共享契约，证据和授权在服务层复核
  server.registerTool(
    "submit_attempt_review_result",
    {
      description:
        "把整体复盘的结构化 JSON 报告写回平台。校验任务归属与租约：leaseToken 必须是当前有效持有者，generation/snapshotVersion 与领取时不一致 → 409（迟到报告仅记事实，不覆盖）。同内容重放幂等成功（duplicate:true）；报告超 32KiB 或引用范围外题号将被拒绝。结构见领取视图的提示词说明。",
      inputSchema: {
        taskId: z
          .string()
          .uuid()
          .describe("claim_attempt_review 返回的任务 id"),
        leaseToken: z
          .string()
          .min(1)
          .describe("claim_attempt_review 返回的租约凭证"),
        generation: z
          .number()
          .int()
          .min(1)
          .describe("claim_attempt_review 返回的出站代次"),
        snapshotVersion: z
          .string()
          .min(1)
          .describe("claim_attempt_review 返回的快照版本"),
        report: aiAttemptReviewReportSchema,
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    guard(({ taskId, leaseToken, generation, snapshotVersion, report }) => {
      const result = submitAttemptReviewResult(
        db,
        {
          studentId,
          taskId,
          leaseToken,
          generation,
          snapshotVersion,
          report,
        },
        { hmacSecret },
      );
      return jsonContent({
        submitted: true as const,
        taskId,
        duplicate: result.duplicate,
      });
    }),
  );
}

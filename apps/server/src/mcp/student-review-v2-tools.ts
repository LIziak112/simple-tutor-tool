import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { reviewV2CreateSchema, reviewV2ReportSchema } from "@tutor/contract";
import { z } from "zod";
import {
  claimReviewV2Task,
  createReviewV2Run,
  listReviewV2Runs,
  renewReviewV2Lease,
  submitReviewV2Report,
} from "../services/ai-companion/review-v2.ts";
import type { StudentMcpServerDeps } from "./student-server.ts";
import { guard, jsonContent } from "./tool-result.ts";

/** 新协议用显式v2工具；旧任务快照/五段报告仍由旧工具原样读取。 */
export function registerStudentReviewV2Tools(
  server: McpServer,
  deps: StudentMcpServerDeps,
) {
  const { db, studentId, hmacSecret } = deps;
  const options = { hmacSecret };
  server.registerTool(
    "create_review_run_v2",
    {
      description:
        "按整卷、单元、已公布批次或讲练已提交阶段创建复盘；大卷自动分片，每片最多30题，范围由服务端核验。先向学生确认范围和诉求，mutationId固定用于网络重试。",
      inputSchema: { attemptId: z.uuid(), ...reviewV2CreateSchema.shape },
      annotations: { idempotentHint: true, destructiveHint: false },
    },
    guard(({ attemptId, ...input }) =>
      jsonContent({
        run: createReviewV2Run(db, studentId, attemptId, input, options),
      }),
    ),
  );
  server.registerTool(
    "list_review_runs_v2",
    {
      description:
        "列出本人某次作答的范围复盘及分片状态，不返回快照原题、答案、报告或租约。",
      inputSchema: { attemptId: z.uuid() },
      annotations: { readOnlyHint: true },
    },
    guard(({ attemptId }) =>
      jsonContent({
        runs: listReviewV2Runs(db, studentId, attemptId, options),
      }),
    ),
  );
  server.registerTool(
    "claim_review_part_v2",
    {
      description:
        "指定领取本人分片任务。返回版本2快照、严格分节清单和有时限的租约；所有分片完成后才能领取汇总，汇总只有子报告。撤权或范围变化拒绝出站。",
      inputSchema: { taskId: z.uuid() },
    },
    guard(({ taskId }) =>
      jsonContent(claimReviewV2Task(db, studentId, taskId, options)),
    ),
  );
  server.registerTool(
    "renew_review_part_lease_v2",
    {
      description:
        "续租本人当前分片，每次10分钟，累计不超过60分钟，不能恢复过期租约。",
      inputSchema: { taskId: z.uuid(), leaseToken: z.string().min(1) },
    },
    guard(({ taskId, leaseToken }) =>
      jsonContent(
        renewReviewV2Lease(db, studentId, taskId, leaseToken, options),
      ),
    ),
  );
  server.registerTool(
    "submit_review_part_v2",
    {
      description:
        "提交版本2分节报告。题号只能引用本片原卷题号；模板键/标题/顺序必须准确，迟到或取消不能覆盖报告。同代同内容重放幂等。",
      inputSchema: {
        taskId: z.uuid(),
        leaseToken: z.string().min(1),
        generation: z.number().int().positive(),
        snapshotVersion: z.string().min(1),
        report: reviewV2ReportSchema,
      },
      annotations: { idempotentHint: true, destructiveHint: false },
    },
    guard((input) =>
      jsonContent(submitReviewV2Report(db, studentId, input, options)),
    ),
  );
}

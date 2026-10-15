import {
  AI_TASK_QUEUE_BUCKETS,
  type AiStatusData,
} from "@tutor/contract";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { aiTasks } from "../../db/schema.ts";
import { listStudentAiConnections } from "./connection-service.ts";
import {
  resolveAttemptQuestionAiPolicy,
  type AiPolicyConfigSource,
} from "./teaching-policy-service.ts";
import { sqliteAiPolicyConfigSource } from "./ai-policy-config-source.ts";

/**
 * SAI-20 学生单题状态服务（B11；GET /api/student/ai/status 的数据源）。
 *
 * 伴学栏与发送控制器的唯一服务端裁决入口（SAI-18 遗留①兑现）：有效模式与
 * 原因、本题完成态、默认通道与连接态、首次知情门槛、本题任务摘要。每次
 * 查询实时裁决（教师刚改设置立即生效——不缓存跨事件使用），GET 零副作用。
 *
 * 口径说明：
 * - 首次知情（需求 §4.3）的权威记录 = 「存在任一 active 连接」——SAI-18
 *   设置页在无任何连接时强制知情确认后才能保存第一条连接，因此存在连接
 *   即已跨过首次知情；删光连接后重新配置会再次经过同一门槛。
 * - connectionReady 只对默认通道判定（已配置且非 needs_rekey）；「已连接」
 *   不凭存在 Token 宣称（§6.2），verifyStatus=unverified 仍算 ready——
 *   保存即可发送，探针失败由发送链路如实报错。
 * - taskSummary 按 (student, attempt, question) 隔离，跨题任务不计入。
 */
export function studentAiStatusOf(
  db: Db,
  input: {
    readonly studentId: string;
    readonly attemptId: string;
    readonly questionId: string;
  },
  configSource: AiPolicyConfigSource = sqliteAiPolicyConfigSource,
): AiStatusData {
  const { resolution, completed } = resolveAttemptQuestionAiPolicy(
    db,
    input.studentId,
    input.attemptId,
    input.questionId,
    configSource,
  );
  const connections = listStudentAiConnections(db, input.studentId);
  const fallback = connections.find((item) => item.isDefault) ?? null;
  const scope = and(
    eq(aiTasks.studentId, input.studentId),
    eq(aiTasks.attemptId, input.attemptId),
    eq(aiTasks.questionId, input.questionId),
  );
  const countBy = (statuses: readonly string[] | null): number =>
    db
      .select({ id: aiTasks.id })
      .from(aiTasks)
      .where(statuses === null ? scope : and(scope, inArray(aiTasks.status, [...statuses])))
      .all().length;
  return {
    resolution,
    completed,
    channelDefault: fallback?.channel ?? null,
    connectionReady:
      fallback !== null && fallback.verifyStatus !== "needs_rekey",
    firstUseRequired: connections.length === 0,
    taskSummary: {
      total: countBy(null),
      active: countBy([
        ...AI_TASK_QUEUE_BUCKETS.pending,
        ...AI_TASK_QUEUE_BUCKETS.processing,
      ]),
      unreadReplies: db
        .select({ id: aiTasks.id })
        .from(aiTasks)
        .where(
          and(
            scope,
            eq(aiTasks.status, "replied"),
            isNull(aiTasks.replyDeliveredAt),
          ),
        )
        .all().length,
    },
  };
}

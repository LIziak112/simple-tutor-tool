import {
  AI_TASK_QUEUE_BUCKETS,
  type AiBatchCreateData,
  type AiBatchCreateItemResult,
  type AiBatchReviewItem,
  type AiChannel,
} from "@tutor/contract";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  type Attempt,
  aiTasks,
  assignments,
  responses,
} from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";
import { answersReleased, requireUsableAttempt } from "../attempt-service.ts";
import { createAiTask } from "./student-ai-queue.ts";

/**
 * SAI-31 批量错题复盘服务（B16；需求规格 §8 末段）。
 *
 * 复用单题装配与任务创建（createAiTask 单源：快照/策略/配额/幂等全在既有
 * 路径），批量层只做三件事：
 * 1. 可选题裁决：从**本人本次结果**的 responses 行取最终判定——判对逐项
 *    拒绝（不默认选也不接受伪造，请求结构上就没有 correct 字段）；待批
 *    （finalCorrect=null）可加入（学生主动勾选由前端分组把关）；答案未
 *    公布的卷整卷条目统一拒绝（判对判错同文案，不借批量结果泄露对错）；
 *    未交卷拒绝。归属/作废/失权由 requireUsableAttempt 单源把关。
 * 2. 幂等键派生：每题 mutationId = `${batchMutationId}:${attemptId}:
 *    ${questionId}`——同批重放/网络重试命中既有任务（already_exists），
 *    不重复创建、不重复计费；跨学生撞键由 createAiTask 全局唯一索引语义
 *    拒绝（409 → 逐项 failed）。
 * 3. 不重复收费：同题已有**进行中**任务（pending/processing 桶，别的幂等
 *    键——如伴学栏单题求助）→ outcome=paused 复用该任务，不新建；幂等
 *    重放判定先于本检查（重放报告 already_exists）。
 *
 * 一题失败不连坐：逐项独立 try/catch，失败项带服务端原文原因返回，其余
 * 条目照常处理；每题一份上下文（createAiTask 快照装配天然按题隔离，批量
 * 不拼卷、不注入当天概况——需求 §8「批量复盘仍是一题一份上下文」）。
 *
 * 三通道行为差异不在本层：inapp 任务落 created 由 worker 按配额逐个派发；
 * mcp 任务落 created 等外部客户端领取；link 任务落 created 由前端逐题
 * 生成票据（POST /ai/tasks/:id/share 既有单题链路，缺件如实呈现）。
 */

/** 批量逐项结果构造助手：失败不携带任务 id（防把他人/未建行误标成功） */
function failedItem(
  item: AiBatchReviewItem,
  error: string,
): AiBatchCreateItemResult {
  return {
    attemptId: item.attemptId,
    questionId: item.questionId,
    outcome: "failed",
    taskId: null,
    error,
  };
}

/**
 * 本卷答案公布态（与结果视图同口径：course/wrong/lesson 恒公布，assignment
 * 按作业行读时比较）。作业行缺失按**未公布**处理（fail closed）：公布态
 * 无法判定时拒绝批量，绝不借逐项对错结果泄露判分。
 */
function attemptAnswersReleased(db: Db, attempt: Attempt): boolean {
  if (attempt.sourceType !== "assignment" || attempt.assignmentId === null) {
    return true;
  }
  const assignment = db
    .select()
    .from(assignments)
    .where(eq(assignments.id, attempt.assignmentId))
    .get();
  if (assignment === undefined) return false;
  return answersReleased(assignment, new Date());
}

export interface CreateAiBatchReviewInput {
  readonly studentId: string;
  readonly items: readonly AiBatchReviewItem[];
  readonly channel: AiChannel;
  /** 批量复盘诉求（每题任务的首条学生消息共用同一句） */
  readonly question: string;
  /** 批次幂等键（路由契约已保证非空；逐题派生见函数头注释） */
  readonly mutationId: string;
}

/**
 * 批量创建复盘任务：逐项裁决 + 逐项结果 + 汇总计数（契约
 * aiBatchCreateDataSchema 单源投影）。任何单项失败不影响其他项；返回
 * 永不抛出（鉴权/形状错误在路由层先行，本层逐项消化业务拒绝）。
 */
export function createAiBatchReviewTasks(
  db: Db,
  input: CreateAiBatchReviewInput,
  options: { hmacSecret: string },
): AiBatchCreateData {
  const results: AiBatchCreateItemResult[] = [];
  for (const item of input.items) {
    results.push(
      createOneBatchItem(db, input, item, { hmacSecret: options.hmacSecret }),
    );
  }
  return {
    items: results,
    summary: {
      created: results.filter((row) => row.outcome === "created").length,
      alreadyExists: results.filter((row) => row.outcome === "already_exists")
        .length,
      paused: results.filter((row) => row.outcome === "paused").length,
      failed: results.filter((row) => row.outcome === "failed").length,
    },
  };
}

/** 单个条目裁决与创建（见 createAiBatchReviewTasks 头注释的规则序） */
function createOneBatchItem(
  db: Db,
  input: CreateAiBatchReviewInput,
  item: AiBatchReviewItem,
  options: { hmacSecret: string },
): AiBatchCreateItemResult {
  // 派生幂等键预检：跨学生撞键按冲突拒绝（createAiTask 的 409 文案同源，
  // 此处先行是为不把他人任务行误报成 already_exists）
  const derivedMutationId = `${input.mutationId}:${item.attemptId}:${item.questionId}`;
  try {
    const attempt = requireUsableAttempt(db, input.studentId, item.attemptId);
    if (attempt.status === "draft") {
      return failedItem(item, "这份作答还未交卷，交卷后才能批量加入复盘");
    }
    if (!attemptAnswersReleased(db, attempt)) {
      return failedItem(
        item,
        "这份作业的答案未公布，公布后才能批量加入 AI 复盘",
      );
    }
    const response = db
      .select()
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, item.attemptId),
          eq(responses.questionId, item.questionId),
        ),
      )
      .get();
    if (response === undefined) {
      return failedItem(item, "题目不存在或不属于这次练习");
    }
    if (response.finalCorrect === true) {
      return failedItem(item, "该题已判对，无需复盘");
    }
    // 幂等重放优先于「同题进行中」复用：同批重放报告 already_exists
    const existingByKey = db
      .select({ id: aiTasks.id, studentId: aiTasks.studentId })
      .from(aiTasks)
      .where(eq(aiTasks.mutationId, derivedMutationId))
      .get();
    if (existingByKey !== undefined) {
      if (existingByKey.studentId !== input.studentId) {
        return failedItem(
          item,
          "该幂等键已用于不同内容的任务，请刷新页面后重新发送",
        );
      }
      const { task, created } = createAiTask(
        db,
        {
          studentId: input.studentId,
          attemptId: item.attemptId,
          questionId: item.questionId,
          question: input.question,
          channel: input.channel,
          mutationId: derivedMutationId,
        },
        { hmacSecret: options.hmacSecret },
      );
      return {
        attemptId: item.attemptId,
        questionId: item.questionId,
        outcome: created ? "created" : "already_exists",
        taskId: task.id,
        error: null,
      };
    }
    // 同题已有进行中任务（pending/processing 桶）：复用不新建，不重复计费
    const activeStatuses = [
      ...AI_TASK_QUEUE_BUCKETS.pending,
      ...AI_TASK_QUEUE_BUCKETS.processing,
    ];
    const active = db
      .select()
      .from(aiTasks)
      .where(
        and(
          eq(aiTasks.attemptId, item.attemptId),
          eq(aiTasks.questionId, item.questionId),
          inArray(aiTasks.status, activeStatuses),
        ),
      )
      .get();
    if (active !== undefined) {
      return {
        attemptId: item.attemptId,
        questionId: item.questionId,
        outcome: "paused",
        taskId: active.id,
        error: null,
      };
    }
    const { task, created } = createAiTask(
      db,
      {
        studentId: input.studentId,
        attemptId: item.attemptId,
        questionId: item.questionId,
        question: input.question,
        channel: input.channel,
        mutationId: derivedMutationId,
      },
      { hmacSecret: options.hmacSecret },
    );
    return {
      attemptId: item.attemptId,
      questionId: item.questionId,
      outcome: created ? "created" : "already_exists",
      taskId: task.id,
      error: null,
    };
  } catch (error) {
    if (error instanceof HttpError) {
      return failedItem(item, error.message);
    }
    throw error;
  }
}

import { z } from "zod";
import { attemptSourceSchema } from "./attempt.ts";

/**
 * 学生端 AI 伴学：任务来源摘要（「求助记录」列表的附加视图）。
 *
 * 两类任务共用作答级摘要：整卷复盘任务只到作答这一层；逐题任务在其上追加
 * 卷内题号与批次来源。只放展示与导航定位所需的公开字段——不携带题面、答案
 * 或作答内容。
 */

/**
 * 作答级来源摘要：来源 / 第几次 / 标题 + 各来源的导航定位键 + 作答阶段。
 * - title：作业标题 / 课程名 / 讲练页标题；wrong 来源无卷标题恒 null；
 * - attemptStatus 供列表呈现作答阶段（作答中 / 已交卷 / 已批改）。
 */
export const aiAttemptOriginSummarySchema = z
  .object({
    sourceType: attemptSourceSchema,
    /** 第几次作答（course/wrong/lesson 递增；assignment 缺省 1、显式重做后递增，hall-15313） */
    attemptNo: z.number().int().min(1),
    /** 来源标题（wrong 为 null） */
    title: z.string().nullable(),
    /** 导航定位键（按来源非空；前端据此构造原作答地址，不按 questionId 反查） */
    assignmentId: z.string().nullable(),
    courseId: z.string().nullable(),
    unitId: z.string().nullable(),
    lectureId: z.string().nullable(),
    /** 作答阶段：draft | submitted | graded */
    attemptStatus: z.enum(["draft", "submitted", "graded"]),
  })
  .strict();
export type AiAttemptOriginSummary = z.infer<
  typeof aiAttemptOriginSummarySchema
>;

/**
 * 批量复盘批次来源：同一次「批量复盘」确认创建的逐题任务共用一个批次。
 * 只放标识、任务数与发起时刻——批次幂等键原文不出服务端。
 */
export const aiTaskBatchOriginSchema = z
  .object({
    /** 批次不透明标识（服务端由批次幂等键派生的哈希） */
    id: z.string().min(1),
    /** 该批次创建的逐题任务总数（含已归档） */
    taskCount: z.number().int().min(1),
    /** 批次内最早任务的创建时刻（= 学生确认这次批量复盘的时刻） */
    createdAt: z.string().min(1),
  })
  .strict();
export type AiTaskBatchOrigin = z.infer<typeof aiTaskBatchOriginSchema>;

/**
 * 逐题任务来源摘要（SAI-23 全局队列列表按任务 id 挂在 origins 上；单题历史
 * 调用方不消费可省略）。
 * - questionNo 按建卷冻结序（unitId 首现序 + rowid 组内序）计算；null = 该题
 *   已不在本卷行中（软删/缺失），如实呈现不伪造题号；
 * - batch：null = 单题求助（必须显式给出，缺省不等于「不属于任何批次」）。
 */
export const aiTaskOriginSummarySchema = aiAttemptOriginSummarySchema
  .extend({
    /** 卷内题号（1 起全卷连续）；null = 题已不在本卷 */
    questionNo: z.number().int().min(1).nullable(),
    batch: aiTaskBatchOriginSchema.nullable(),
  })
  .strict();
export type AiTaskOriginSummary = z.infer<typeof aiTaskOriginSummarySchema>;

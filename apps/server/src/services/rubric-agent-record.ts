import {
  type Rubric,
  type RubricAssessment,
  type RubricOpinionInput,
  rubricOpinionBlockOf,
  rubricRatingsProblem,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { type AiTaskRow, type ResponseRow, responses } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { snapshotPurposeOf } from "./ai-companion/student-ai-queue";
import { asDb, type QueueTx } from "./ai-companion/student-ai-shared";
import {
  buildAttemptQuestionWhere,
  practiceQuestionFeedbackStateOf,
  requireUsableAttempt,
} from "./attempt-service";
import { snapshotOfRow } from "./snapshot";

/**
 * 通用量表判卷（模块 3）Agent 意见落账：MCP（submit_rubric_opinion）与页内
 * 通道（回信末尾的 rubric-opinion 块）两条路共用同一组门禁与同一份记录
 * 写法（审查 #99-02 / #99-03 / #99-04）。记录写在回信落库的同一事务里，
 * 由队列模块的 onReplied / onDelivered 钩子回调。
 */

export type RubricOpinionTarget =
  | { readonly ok: true; readonly row: ResponseRow; readonly rubric: Rubric }
  | { readonly ok: false; readonly message: string };

/**
 * 三道门：任务目的是量表判卷、题有量表、本人卷可用且该题答案已公布
 * （与自评 / 裁定的 requireRubricTarget 同口径——意见不能先于公布进入结果页）。
 */
export function rubricOpinionTargetOf(
  db: Db,
  task: AiTaskRow,
  now: Date | string,
): RubricOpinionTarget {
  if (snapshotPurposeOf(task) !== "rubric_opinion") {
    return {
      ok: false,
      message: "该任务不是量表判卷任务，请用 submit_ai_reply 回信",
    };
  }
  const row = db
    .select()
    .from(responses)
    .where(buildAttemptQuestionWhere(task.attemptId, task.questionId))
    .get();
  const rubric = row === undefined ? undefined : snapshotOfRow(row)?.rubric;
  if (row === undefined || rubric === undefined) {
    return {
      ok: false,
      message: "这道题没有量表，请用 submit_ai_reply 回信",
    };
  }
  let attempt: ReturnType<typeof requireUsableAttempt>;
  try {
    attempt = requireUsableAttempt(db, task.studentId, task.attemptId);
  } catch (error) {
    if (error instanceof HttpError) {
      return { ok: false, message: "这份练习已不可用，量表意见不再写回" };
    }
    throw error;
  }
  if (
    practiceQuestionFeedbackStateOf(db, attempt, row, now).status !== "released"
  ) {
    return {
      ok: false,
      message: "答案尚未公布，量表意见暂不能写回，请用 submit_ai_reply 回信",
    };
  }
  return { ok: true, row, rubric };
}

export function rubricAgentRecordOf(
  opinion: RubricOpinionInput,
  taskId: string,
  now: Date | string,
): RubricAssessment {
  return {
    source: "agent",
    ratings: opinion.ratings,
    note: opinion.note,
    at: new Date(now).toISOString(),
    taskId,
  };
}

/** 结构化意见落 responses.rubric_agent_json（调用方保证与回信同事务） */
export function writeRubricAgentRecord(
  tx: Db | QueueTx,
  rowId: string,
  record: RubricAssessment,
): void {
  asDb(tx)
    .update(responses)
    .set({ rubricAgentJson: JSON.stringify(record) })
    .where(eq(responses.id, rowId))
    .run();
}

/** 意见 → 回信 Markdown（伴学栏照常可读；结构化记录另存量表列） */
export function rubricOpinionMarkdownOf(
  rubric: Rubric,
  opinion: RubricOpinionInput,
): string {
  const lines = ["**量表意见**", ""];
  for (const item of rubric.items) {
    const rating = opinion.ratings.find((r) => r.id === item.id);
    if (rating === undefined) continue;
    const evidence = rating.evidence ? `——${rating.evidence}` : "";
    lines.push(
      `- ${item.title}：${rating.level} / ${rubric.levels}${evidence}`,
    );
  }
  lines.push("", opinion.note);
  return lines.join("\n");
}

// ---------- 页内通道 ----------

export interface InappReplyPlan {
  /** 实际入库的回信正文（结构化块已替换为可读的量表意见段） */
  readonly replyMd: string;
  /** 交付成功时同事务追加写入；原文照发时为 undefined */
  readonly onDelivered?: (tx: QueueTx) => void;
}

/**
 * 页内通道的回信落库计划：判卷任务回信末尾带合法的 rubric-opinion 块 →
 * 块替换为可读段 + 同事务落 Agent 记录；非判卷任务 / 没有块 / 块与量表
 * 对不上 / 门禁不过 → 原文照发（回信仍可读，只是没有结构化意见）。
 */
export function inappReplyPlanOf(
  db: Db,
  task: AiTaskRow,
  replyMd: string,
  now: Date | string,
): InappReplyPlan {
  if (snapshotPurposeOf(task) !== "rubric_opinion") return { replyMd };
  const block = rubricOpinionBlockOf(replyMd);
  if (block === null) return { replyMd };
  const target = rubricOpinionTargetOf(db, task, now);
  if (!target.ok) return { replyMd };
  if (rubricRatingsProblem(target.rubric, block.opinion.ratings) !== null) {
    return { replyMd };
  }
  const record = rubricAgentRecordOf(block.opinion, task.id, now);
  const rendered = [
    block.rest,
    rubricOpinionMarkdownOf(target.rubric, block.opinion),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
  return {
    replyMd: rendered,
    onDelivered: (tx) => writeRubricAgentRecord(tx, target.row.id, record),
  };
}

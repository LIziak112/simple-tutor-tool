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

/** 门禁不过的原因码（MCP 文案给 Agent，页内文案给学生，各按码取） */
export type RubricOpinionBlockedReason =
  | "not_rubric_task"
  | "no_rubric"
  | "attempt_unusable"
  | "not_released";

export type RubricOpinionTarget =
  | { readonly ok: true; readonly row: ResponseRow; readonly rubric: Rubric }
  | {
      readonly ok: false;
      readonly reason: RubricOpinionBlockedReason;
      /** 给 MCP Agent 的说明（409 RUBRIC_NOT_AVAILABLE 文案） */
      readonly message: string;
    };

const AGENT_BLOCKED_MESSAGE: Record<RubricOpinionBlockedReason, string> = {
  not_rubric_task: "该任务不是量表判卷任务，请用 submit_ai_reply 回信",
  no_rubric: "这道题没有量表，请用 submit_ai_reply 回信",
  attempt_unusable: "这份练习已不可用，量表意见不再写回",
  not_released: "答案尚未公布，量表意见暂不能写回，请用 submit_ai_reply 回信",
};

/** 页内通道：块没入账时替换进回信的说明里，给学生看的原因 */
const STUDENT_BLOCKED_REASON: Record<RubricOpinionBlockedReason, string> = {
  not_rubric_task: "这次不是量表判卷任务",
  no_rubric: "这道题没有量表",
  attempt_unusable: "这份练习已不可用",
  not_released: "答案尚未公布",
};

function blocked(reason: RubricOpinionBlockedReason): RubricOpinionTarget {
  return { ok: false, reason, message: AGENT_BLOCKED_MESSAGE[reason] };
}

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
    return blocked("not_rubric_task");
  }
  const row = db
    .select()
    .from(responses)
    .where(buildAttemptQuestionWhere(task.attemptId, task.questionId))
    .get();
  const rubric = row === undefined ? undefined : snapshotOfRow(row)?.rubric;
  if (row === undefined || rubric === undefined) return blocked("no_rubric");
  let attempt: ReturnType<typeof requireUsableAttempt>;
  try {
    attempt = requireUsableAttempt(db, task.studentId, task.attemptId);
  } catch (error) {
    if (error instanceof HttpError) return blocked("attempt_unusable");
    throw error;
  }
  if (
    practiceQuestionFeedbackStateOf(db, attempt, row, now).status !== "released"
  ) {
    return blocked("not_released");
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
  if (opinion.note !== "") lines.push("", opinion.note);
  return lines.join("\n");
}

// ---------- 页内通道 ----------

export interface InappReplyPlan {
  /** 实际入库的回信正文（结构化块已替换为可读的量表意见段或未入账说明） */
  readonly replyMd: string;
  /** 交付成功时同事务追加写入；没有结构化意见要落时为 undefined */
  readonly onDelivered?: (tx: QueueTx) => void;
}

function joinParts(...parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join("\n\n");
}

/** 块定位到但没入账：替换成给学生看的一句说明（原始 JSON 不进伴学栏） */
function unrecordedNoteOf(reason: string): string {
  return `（AI 附带的量表意见未入账：${reason}）`;
}

/**
 * 页内通道的回信落库计划：
 * - 回信里没有 rubric-opinion 块 → 原文照发；
 * - 有块（不论任务目的）→ 块一律从正文剔除：判卷任务、门禁通过、评定项与量表
 *   对得上 → 替换为可读的量表意见段 + 同事务落 Agent 记录；否则替换为一句
 *   「未入账 + 原因」的说明，回信其余部分照发。
 */
export function inappReplyPlanOf(
  db: Db,
  task: AiTaskRow,
  replyMd: string,
  now: Date | string,
): InappReplyPlan {
  const parsed = rubricOpinionBlockOf(replyMd);
  if (parsed.kind === "none") return { replyMd };
  if (parsed.kind === "invalid") {
    return {
      replyMd: joinParts(
        parsed.rest,
        unrecordedNoteOf(`格式无效，${parsed.problem}`),
      ),
    };
  }
  const target = rubricOpinionTargetOf(db, task, now);
  if (!target.ok) {
    return {
      replyMd: joinParts(
        parsed.rest,
        unrecordedNoteOf(STUDENT_BLOCKED_REASON[target.reason]),
      ),
    };
  }
  const problem = rubricRatingsProblem(target.rubric, parsed.opinion.ratings);
  if (problem !== null) {
    return { replyMd: joinParts(parsed.rest, unrecordedNoteOf(problem)) };
  }
  const record = rubricAgentRecordOf(parsed.opinion, task.id, now);
  return {
    replyMd: joinParts(
      parsed.rest,
      rubricOpinionMarkdownOf(target.rubric, parsed.opinion),
    ),
    onDelivered: (tx) => writeRubricAgentRecord(tx, target.row.id, record),
  };
}

/**
 * 规划阶段意外抛错（读库 / 快照损坏等）时的兜底：回信照常交付，块（若能定位）
 * 替换为说明——已经拿到的回信不能因为落账失败而丢掉（审查 Important 1）。
 */
export function inappReplyFallbackOf(replyMd: string): InappReplyPlan {
  try {
    const parsed = rubricOpinionBlockOf(replyMd);
    if (parsed.kind === "none") return { replyMd };
    return {
      replyMd: joinParts(
        parsed.rest,
        unrecordedNoteOf("服务暂时无法核对量表，可稍后重新发起判卷"),
      ),
    };
  } catch {
    return { replyMd };
  }
}

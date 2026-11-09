import {
  type Rubric,
  type RubricAdjudication,
  type RubricAssessment,
  type RubricFinalRequest,
  type RubricOpinionInput,
  type RubricRating,
  type RubricReview,
  type RubricSelfRequest,
  rubricRatingsProblem,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { aiTasks, type ResponseRow, responses } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { submitMcpReply } from "./ai-companion/student-ai-queue";
import {
  buildAttemptQuestionWhere,
  practiceQuestionFeedbackStateOf,
  questionNotFound,
  requireUsableAttempt,
} from "./attempt-service";
import { rubricReviewOf } from "./rubric-review-read";
import { snapshotOfRow } from "./snapshot";

/**
 * 通用量表判卷（模块 3）写侧：自评 / 本人裁定 / Agent 意见三份记录互不覆盖
 * （「意见和结果分开」）。校验链与自评同款：本人卷 + 未作废 + 已提交且公布 +
 * 题有量表；量表分不写 teacherMark / finalCorrect，也不推动 graded（D7 同纪律）。
 * 读侧见 rubric-review-read.ts。
 */

// ---------- 写：共用校验链 ----------

interface RubricTarget {
  row: ResponseRow;
  rubric: Rubric;
}

/** 本人卷 + 行属本卷 + 已提交且公布 + 题有量表；否则按既有码拒绝 */
function requireRubricTarget(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  now: Date | string,
): RubricTarget {
  const attempt = requireUsableAttempt(db, studentId, attemptId);
  const row = db
    .select()
    .from(responses)
    .where(buildAttemptQuestionWhere(attemptId, questionId))
    .get();
  if (row === undefined) throw questionNotFound();
  const state = practiceQuestionFeedbackStateOf(db, attempt, row, now);
  if (state.status !== "released") {
    throw new HttpError(
      403,
      "RUBRIC_NOT_AVAILABLE",
      "交卷并公布后才能按量表评价",
    );
  }
  const rubric = snapshotOfRow(row)?.rubric;
  if (rubric === undefined) {
    throw new HttpError(403, "RUBRIC_NOT_AVAILABLE", "这道题没有量表");
  }
  return { row, rubric };
}

function assertRatings(rubric: Rubric, ratings: readonly RubricRating[]) {
  const problem = rubricRatingsProblem(rubric, ratings);
  if (problem !== null) {
    throw new HttpError(400, "RUBRIC_RATINGS_INVALID", problem);
  }
}

function freshRowOf(db: Db, id: string): ResponseRow {
  const row = db.select().from(responses).where(eq(responses.id, id)).get();
  if (row === undefined) throw questionNotFound();
  return row;
}

// ---------- 写：本人自评 ----------

export function saveRubricSelf(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  req: RubricSelfRequest,
  now: Date | string = new Date(),
): RubricReview {
  const { row, rubric } = requireRubricTarget(
    db,
    studentId,
    attemptId,
    questionId,
    now,
  );
  assertRatings(rubric, req.ratings);
  const record: RubricAssessment = {
    source: "self",
    ratings: req.ratings,
    note: req.note,
    at: new Date(now).toISOString(),
  };
  db.update(responses)
    .set({ rubricSelfJson: JSON.stringify(record) })
    .where(eq(responses.id, row.id))
    .run();
  const review = rubricReviewOf(db, freshRowOf(db, row.id), { rubric });
  if (review === null) throw questionNotFound();
  return review;
}

// ---------- 写：本人裁定 ----------

export function saveRubricFinal(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
  req: RubricFinalRequest,
  now: Date | string = new Date(),
): RubricReview {
  const { row, rubric } = requireRubricTarget(
    db,
    studentId,
    attemptId,
    questionId,
    now,
  );
  const current = rubricReviewOf(db, row, { rubric });
  if (current === null) throw questionNotFound();
  let ratings: readonly RubricRating[];
  if (req.decision === "self") {
    if (current.self === null) {
      throw new HttpError(
        409,
        "RUBRIC_RATINGS_INVALID",
        "还没有自评，不能保留自评",
      );
    }
    ratings = current.self.ratings;
  } else if (req.decision === "agent") {
    if (current.agent === null) {
      throw new HttpError(
        409,
        "RUBRIC_RATINGS_INVALID",
        "还没有 Agent 意见，不能采纳",
      );
    }
    ratings = current.agent.ratings;
  } else {
    if (req.ratings === undefined) {
      throw new HttpError(
        400,
        "RUBRIC_RATINGS_INVALID",
        "自行改写需要逐项档位",
      );
    }
    assertRatings(rubric, req.ratings);
    ratings = req.ratings;
  }
  const record: RubricAdjudication = {
    decision: req.decision,
    ratings: [...ratings],
    note: req.note,
    at: new Date(now).toISOString(),
  };
  db.update(responses)
    .set({ rubricFinalJson: JSON.stringify(record) })
    .where(eq(responses.id, row.id))
    .run();
  const review = rubricReviewOf(db, freshRowOf(db, row.id), { rubric });
  if (review === null) throw questionNotFound();
  return review;
}

// ---------- 写：Agent 意见（MCP，走任务租约） ----------

export interface SubmitRubricOpinionInput {
  readonly studentId: string;
  readonly taskId: string;
  readonly leaseToken: string;
  readonly opinion: RubricOpinionInput;
  readonly expectedContextVersion?: string;
  readonly expectedRuntimeEpoch?: string;
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

/**
 * Agent 经 MCP 写回量表意见：先校验量表与档位（不动库），再沿 submitMcpReply
 * 走任务归属 / 租约 / contextVersion / 幂等（回信入伴学栏，状态 replied），
 * 最后把结构化意见落到 rubric_agent_json（首份为准，重放不覆盖）。
 */
export function submitRubricOpinion(
  db: Db,
  input: SubmitRubricOpinionInput,
  options: { now?: Date | string } = {},
): { duplicate: boolean; review: RubricReview } {
  const task = db
    .select()
    .from(aiTasks)
    .where(eq(aiTasks.id, input.taskId))
    .get();
  if (task === undefined || task.studentId !== input.studentId) {
    throw new HttpError(404, "NOT_FOUND", "AI 任务不存在");
  }
  const row = db
    .select()
    .from(responses)
    .where(buildAttemptQuestionWhere(task.attemptId, task.questionId))
    .get();
  const rubric = row === undefined ? undefined : snapshotOfRow(row)?.rubric;
  if (row === undefined || rubric === undefined) {
    throw new HttpError(
      409,
      "RUBRIC_NOT_AVAILABLE",
      "这道题没有量表，请用 submit_ai_reply 回信",
    );
  }
  assertRatings(rubric, input.opinion.ratings);
  const result = submitMcpReply(
    db,
    {
      studentId: input.studentId,
      taskId: input.taskId,
      leaseToken: input.leaseToken,
      replyMarkdown: rubricOpinionMarkdownOf(rubric, input.opinion),
      ...(input.expectedContextVersion !== undefined
        ? { expectedContextVersion: input.expectedContextVersion }
        : {}),
      ...(input.expectedRuntimeEpoch !== undefined
        ? { expectedRuntimeEpoch: input.expectedRuntimeEpoch }
        : {}),
    },
    options,
  );
  if (!result.duplicate || row.rubricAgentJson === null) {
    const record: RubricAssessment = {
      source: "agent",
      ratings: input.opinion.ratings,
      note: input.opinion.note,
      at: new Date(options.now ?? new Date()).toISOString(),
      taskId: task.id,
    };
    db.update(responses)
      .set({ rubricAgentJson: JSON.stringify(record) })
      .where(eq(responses.id, row.id))
      .run();
  }
  const review = rubricReviewOf(db, freshRowOf(db, row.id), { rubric });
  if (review === null) throw questionNotFound();
  return { duplicate: result.duplicate, review };
}

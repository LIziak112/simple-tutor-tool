import {
  ownRun,
  publicRun,
  requireRunAccess,
  tasksOf,
} from "./review-v2-store.ts";

export {
  claimReviewV2Task,
  renewReviewV2Lease,
  submitReviewV2Report,
} from "./review-v2-worker.ts";

import { randomUUID } from "node:crypto";
import {
  REVIEW_V2_SECTIONS,
  type ReviewV2Create,
  type ReviewV2RunPublic,
  reviewV2CreateSchema,
  reviewV2ReportSchema,
} from "@tutor/contract";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { reviewV2Runs, reviewV2Tasks } from "../../db/schema.ts";
import { canonicalJsonOf } from "../../lib/canonical-json.ts";
import { HttpError } from "../../lib/http-error.ts";
import { buildReviewV2Plan, type ReviewV2Options } from "./review-v2-range.ts";
import { assertStudentAiTaskQuota, sha256Hex } from "./student-ai-shared.ts";

function conflict(message: string): never {
  throw new HttpError(409, "AI_REVIEW_CONFLICT", message);
}
export function getReviewV2Run(
  db: Db,
  studentId: string,
  runId: string,
  options: ReviewV2Options,
) {
  const run = ownRun(db, studentId, runId);
  requireRunAccess(db, run, options);
  return publicRun(db, run);
}
export function listReviewV2Runs(
  db: Db,
  studentId: string,
  attemptId: string,
  options: ReviewV2Options,
) {
  const runs = db
    .select()
    .from(reviewV2Runs)
    .where(
      and(
        eq(reviewV2Runs.studentId, studentId),
        eq(reviewV2Runs.attemptId, attemptId),
      ),
    )
    .orderBy(desc(reviewV2Runs.createdAt), desc(reviewV2Runs.id))
    .limit(30)
    .all();
  // 任一范围撤权即不向普通出口返还旧进度和报告。
  return runs.flatMap((run) => {
    try {
      requireRunAccess(db, run, options);
      return [publicRun(db, run)];
    } catch (error) {
      if (error instanceof HttpError && [403, 404, 409].includes(error.status))
        return [];
      throw error;
    }
  });
}
export function previewReviewV2(
  db: Db,
  studentId: string,
  attemptId: string,
  input: ReviewV2Create,
  options: ReviewV2Options,
) {
  const plan = buildReviewV2Plan(
    db,
    studentId,
    attemptId,
    reviewV2CreateSchema.parse(input),
    options,
  );
  return {
    schemaVersion: 2 as const,
    previewVersion: plan.previewVersion,
    questionCount: plan.questionCount,
    partCount: plan.snapshots.length,
    sections: REVIEW_V2_SECTIONS[input.profile],
  };
}
export function createReviewV2Run(
  db: Db,
  studentId: string,
  attemptId: string,
  rawInput: ReviewV2Create,
  options: ReviewV2Options,
): ReviewV2RunPublic {
  const input = reviewV2CreateSchema.parse(rawInput);
  return db.$client
    .transaction(() => {
      const digest = sha256Hex(canonicalJsonOf({ attemptId, input }));
      const existing = db
        .select()
        .from(reviewV2Runs)
        .where(
          and(
            eq(reviewV2Runs.studentId, studentId),
            eq(reviewV2Runs.mutationId, input.mutationId),
          ),
        )
        .get();
      if (existing) {
        if (existing.requestDigest !== digest)
          conflict("同一请求键已用于另一份复盘");
        requireRunAccess(db, existing, options);
        return publicRun(db, existing);
      }
      const plan = buildReviewV2Plan(db, studentId, attemptId, input, options);
      if (
        input.expectedPreviewVersion !== undefined &&
        input.expectedPreviewVersion !== plan.previewVersion
      )
        conflict("复盘范围已变化，请重新预览");
      const now = options.now ?? new Date(),
        nowIso = now.toISOString(),
        runId = randomUUID();
      db.insert(reviewV2Runs)
        .values({
          id: runId,
          studentId,
          attemptId,
          mutationId: input.mutationId,
          requestDigest: digest,
          previewVersion: plan.previewVersion,
          scopeJson: JSON.stringify(input.scope),
          profile: input.profile,
          purpose: input.purpose,
          questionCount: plan.questionCount,
          createdAt: nowIso,
        })
        .run();
      const allNos: number[] = [];
      for (const [index, snapshot] of plan.snapshots.entries()) {
        if (snapshot.kind !== "questions")
          throw new HttpError(500, "INTERNAL", "分片类型错误");
        assertStudentAiTaskQuota(db, studentId, now);
        const nos = snapshot.questions.map((question) => question.questionNo);
        allNos.push(...nos);
        db.insert(reviewV2Tasks)
          .values({
            id: randomUUID(),
            runId,
            studentId,
            ordinal: index,
            kind: "questions",
            status: "created",
            questionNosJson: JSON.stringify(nos),
            snapshotJson: JSON.stringify(snapshot),
            snapshotVersion: snapshot.snapshotVersion,
            createdAt: nowIso,
            updatedAt: nowIso,
          })
          .run();
      }
      if (plan.snapshots.length > 1) {
        assertStudentAiTaskQuota(db, studentId, now);
        db.insert(reviewV2Tasks)
          .values({
            id: randomUUID(),
            runId,
            studentId,
            ordinal: plan.snapshots.length,
            kind: "summary",
            status: "blocked",
            questionNosJson: JSON.stringify(allNos),
            createdAt: nowIso,
            updatedAt: nowIso,
          })
          .run();
      }
      return publicRun(db, ownRun(db, studentId, runId));
    })
    .immediate();
}
export function reviewV2Detail(
  db: Db,
  studentId: string,
  runId: string,
  options: ReviewV2Options,
) {
  const run = ownRun(db, studentId, runId);
  requireRunAccess(db, run, options);
  return {
    run: publicRun(db, run),
    reports: tasksOf(db, runId).flatMap((task) =>
      task.reportJson === null
        ? []
        : [
            {
              taskId: task.id,
              kind: task.kind,
              report: reviewV2ReportSchema.parse(JSON.parse(task.reportJson)),
            },
          ],
    ),
  };
}
export function cancelReviewV2Run(
  db: Db,
  studentId: string,
  runId: string,
  options: ReviewV2Options,
) {
  return db.$client
    .transaction(() => {
      ownRun(db, studentId, runId);
      // 本人可以在内容撤权后取消排队；响应只确认取消，不返还任何旧内容。
      for (const task of tasksOf(db, runId))
        if (task.status !== "replied" && task.status !== "cancelled")
          db.update(reviewV2Tasks)
            .set({
              status: "cancelled",
              leaseToken: null,
              leaseUntil: null,
              updatedAt: (options.now ?? new Date()).toISOString(),
            })
            .where(eq(reviewV2Tasks.id, task.id))
            .run();
      return { cancelled: true as const };
    })
    .immediate();
}

import {
  type ReviewV2RunPublic,
  reviewV2RunPublicSchema,
  reviewV2ScopeSchema,
} from "@tutor/contract";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  type ReviewV2RunRow,
  reviewV2Runs,
  reviewV2Tasks,
} from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";
import { type ReviewV2Options, reviewV2Range } from "./review-v2-range.ts";

export function ownRun(db: Db, studentId: string, runId: string) {
  const run = db
    .select()
    .from(reviewV2Runs)
    .where(
      and(eq(reviewV2Runs.id, runId), eq(reviewV2Runs.studentId, studentId)),
    )
    .get();
  if (!run) throw new HttpError(404, "NOT_FOUND", "复盘不存在");
  return run;
}
export function requireRunAccess(
  db: Db,
  run: ReviewV2RunRow,
  options: ReviewV2Options,
) {
  return reviewV2Range(
    db,
    run.studentId,
    run.attemptId,
    reviewV2ScopeSchema.parse(JSON.parse(run.scopeJson)),
    options,
  );
}
export function tasksOf(db: Db, runId: string) {
  return db
    .select()
    .from(reviewV2Tasks)
    .where(eq(reviewV2Tasks.runId, runId))
    .orderBy(asc(reviewV2Tasks.ordinal))
    .all();
}
export function publicRun(db: Db, run: ReviewV2RunRow): ReviewV2RunPublic {
  return reviewV2RunPublicSchema.parse({
    id: run.id,
    attemptId: run.attemptId,
    scope: JSON.parse(run.scopeJson),
    profile: run.profile,
    purpose: run.purpose,
    questionCount: run.questionCount,
    createdAt: run.createdAt,
    tasks: tasksOf(db, run.id).map((task) => ({
      id: task.id,
      kind: task.kind,
      status: task.status,
      questionNos: JSON.parse(task.questionNosJson),
      generation: task.generation,
      hasResult: task.reportJson !== null,
      createdAt: task.createdAt,
    })),
  });
}

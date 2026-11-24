import {
  ATTEMPT_BATCH_SUBMISSION_MAX_BYTES,
  type AttemptSubmitRequest,
  attemptBatchSubmissionBatchSchema,
  attemptBatchSubmissionFinishSchema,
  attemptBatchSubmissionReceiptSchema,
  attemptBatchSubmissionSessionSchema,
  attemptBatchSubmissionStartSchema,
  attemptSubmitRequestSchema,
} from "@tutor/contract";
import { type Context, Hono, type Next } from "hono";
import type { StudentEnv } from "../auth/require-student";
import type { Db } from "../db/client.ts";
import { parseJsonBody, parseJsonBodyOrEmpty } from "../lib/http-error.ts";
import { guardBodyLimit } from "../lib/request-body-limit.ts";
import {
  cancelAttemptBatchSubmission,
  finishAttemptBatchSubmission,
  stageAttemptSubmissionBatch,
  startAttemptBatchSubmission,
} from "../services/attempt-batch-submission.ts";
import { submitAssignmentAttempt } from "../services/kernel-assignment-confirmation.ts";

export const attemptSubmitPath = "/attempts/:id/submit";
export type StudentAttemptSubmit<Result> = (
  db: Db,
  studentId: string,
  attemptId: string,
  now: Date,
  body: AttemptSubmitRequest,
) => Result;

export function createStudentAttemptSubmitRoutes<Result>(
  db: Db,
  submit: StudentAttemptSubmit<Result>,
) {
  return new Hono<StudentEnv>().post(attemptSubmitPath, async (c) => {
    const body = await parseJsonBodyOrEmpty(c, attemptSubmitRequestSchema);
    return c.json({
      ok: true,
      data: submit(
        db,
        c.var.student.id,
        c.req.param("id"),
        new Date(),
        body ?? { revisions: [] },
      ),
    });
  });
}

export function createStudentBatchSubmissionRoutes(db: Db, dataDir: string) {
  const limitBatch = (method: "POST" | "PUT") => {
    const guard = guardBodyLimit({
      method,
      limit: ATTEMPT_BATCH_SUBMISSION_MAX_BYTES,
      code: "SUBMIT_BATCH_TOO_LARGE",
      message: "交卷批次过大，请重新打开本次练习",
    });
    return <Path extends string>(c: Context<StudentEnv, Path>, next: Next) =>
      guard(c, next);
  };
  return new Hono<StudentEnv>()
    .route(
      "/",
      createStudentAttemptSubmitRoutes(db, (db, ...args) =>
        submitAssignmentAttempt(db, dataDir, ...args),
      ),
    )
    .post("/attempts/:id/submit-batches", limitBatch("POST"), async (c) => {
      const input = await parseJsonBody(c, attemptBatchSubmissionStartSchema);
      c.header("Cache-Control", "private, no-store");
      return c.json(
        {
          ok: true,
          data: attemptBatchSubmissionSessionSchema.parse(
            startAttemptBatchSubmission(
              db,
              c.var.student.id,
              c.req.param("id"),
              input.batchCount,
            ),
          ),
        },
        201,
      );
    })
    .put(
      "/attempts/:id/submit-batches/:submissionId",
      limitBatch("PUT"),
      async (c) => {
        const input = await parseJsonBody(c, attemptBatchSubmissionBatchSchema);
        c.header("Cache-Control", "private, no-store");
        return c.json({
          ok: true,
          data: attemptBatchSubmissionReceiptSchema.parse(
            stageAttemptSubmissionBatch(
              db,
              c.var.student.id,
              c.req.param("id"),
              c.req.param("submissionId"),
              input,
            ),
          ),
        });
      },
    )
    .post(
      "/attempts/:id/submit-batches/:submissionId/finish",
      limitBatch("POST"),
      async (c) => {
        const input = await parseJsonBody(
          c,
          attemptBatchSubmissionFinishSchema,
        );
        c.header("Cache-Control", "private, no-store");
        return c.json({
          ok: true,
          data: finishAttemptBatchSubmission(
            db,
            c.var.student.id,
            c.req.param("id"),
            c.req.param("submissionId"),
            input.confirmedSavedAnswers,
          ),
        });
      },
    )
    .delete("/attempts/:id/submit-batches/:submissionId", (c) => {
      cancelAttemptBatchSubmission(
        db,
        c.var.student.id,
        c.req.param("id"),
        c.req.param("submissionId"),
      );
      c.header("Cache-Control", "private, no-store");
      return c.json({ ok: true, data: null });
    });
}

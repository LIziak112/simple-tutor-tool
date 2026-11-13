import {
  ATTEMPT_BATCH_SUBMISSION_MAX_BYTES,
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
import { submitAttempt } from "../services/attempt-service.ts";

export function createStudentBatchSubmissionRoutes(db: Db) {
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
    .post("/attempts/:id/submit", async (c) => {
      const body = await parseJsonBodyOrEmpty(c, attemptSubmitRequestSchema);
      return c.json({
        ok: true,
        data: submitAttempt(
          db,
          c.var.student.id,
          c.req.param("id"),
          new Date(),
          body ?? { revisions: [] },
        ),
      });
    })
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

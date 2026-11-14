import { reviewV2CreateSchema } from "@tutor/contract";
import { Hono } from "hono";
import { z } from "zod";
import type { StudentEnv } from "../auth/require-student.ts";
import type { Db } from "../db/client.ts";
import { HttpError, parseJsonBody } from "../lib/http-error.ts";
import {
  cancelReviewV2Run,
  createReviewV2Run,
  listReviewV2Runs,
  previewReviewV2,
  reviewV2Detail,
} from "../services/ai-companion/review-v2.ts";
import { requireAiInformedGate } from "../services/ai-companion/student-ai-informed.ts";

function id(value: string) {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success)
    throw new HttpError(400, "VALIDATION_ERROR", "复盘标识不合法");
  return parsed.data;
}
export function createStudentReviewV2Routes(db: Db, hmacSecret: string) {
  const options = { hmacSecret };
  return new Hono<StudentEnv>()
    .use("/ai/review-v2/*", async (c, next) => {
      c.header("cache-control", "private, no-store");
      await next();
    })
    .get("/ai/review-v2/attempts/:attemptId", (c) =>
      c.json({
        ok: true,
        data: {
          runs: listReviewV2Runs(
            db,
            c.var.student.id,
            id(c.req.param("attemptId")),
            options,
          ),
        },
      }),
    )
    .post("/ai/review-v2/attempts/:attemptId/preview", async (c) => {
      const input = await parseJsonBody(c, reviewV2CreateSchema);
      return c.json({
        ok: true,
        data: previewReviewV2(
          db,
          c.var.student.id,
          id(c.req.param("attemptId")),
          input,
          options,
        ),
      });
    })
    .post("/ai/review-v2/attempts/:attemptId", async (c) => {
      requireAiInformedGate(db, c.var.student.id);
      const input = await parseJsonBody(c, reviewV2CreateSchema);
      return c.json({
        ok: true,
        data: {
          run: createReviewV2Run(
            db,
            c.var.student.id,
            id(c.req.param("attemptId")),
            input,
            options,
          ),
        },
      });
    })
    .get("/ai/review-v2/runs/:runId", (c) =>
      c.json({
        ok: true,
        data: reviewV2Detail(
          db,
          c.var.student.id,
          id(c.req.param("runId")),
          options,
        ),
      }),
    )
    .post("/ai/review-v2/runs/:runId/cancel", async (c) => {
      await parseJsonBody(c, z.strictObject({}));
      return c.json({
        ok: true,
        data: cancelReviewV2Run(
          db,
          c.var.student.id,
          id(c.req.param("runId")),
          options,
        ),
      });
    });
}

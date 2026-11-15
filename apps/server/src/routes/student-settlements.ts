import { attemptPartialRequestSchema } from "@tutor/contract";
import { Hono } from "hono";
import type { StudentEnv } from "../auth/require-student.ts";
import type { Db } from "../db/client.ts";
import { HttpError, parseJsonBody } from "../lib/http-error.ts";
import {
  getStudentSettlement,
  settleStudentAttempt,
} from "../services/attempt-partial.ts";

export function createStudentSettlementRoutes(db: Db) {
  return new Hono<StudentEnv>()
    .post("/attempts/:id/settlements", async (c) => {
      c.header("Cache-Control", "private, no-store");
      const request = await parseJsonBody(c, attemptPartialRequestSchema);
      return c.json({
        ok: true,
        data: settleStudentAttempt(
          db,
          c.var.student.id,
          c.req.param("id"),
          request,
        ),
      });
    })
    .get("/attempts/:id/settlements/:seq", (c) => {
      c.header("Cache-Control", "private, no-store");
      const seq = Number(c.req.param("seq"));
      if (!Number.isSafeInteger(seq) || seq < 1)
        throw new HttpError(404, "SETTLEMENT_NOT_FOUND", "本批结果不存在");
      return c.json({
        ok: true,
        data: getStudentSettlement(
          db,
          c.var.student.id,
          c.req.param("id"),
          seq,
        ),
      });
    });
}

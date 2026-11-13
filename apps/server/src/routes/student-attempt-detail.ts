import { attemptDetailDataSchema, attemptIdSchema } from "@tutor/contract";
import type { Context } from "hono";
import type { Db } from "../db/client";
import { HttpError } from "../lib/http-error";
import { readConditionalAttemptDetail } from "../services/attempt-detail-cache";

export function respondAttemptDetail(
  c: Context,
  db: Db,
  studentId: string,
  attemptId: string,
) {
  c.header("Cache-Control", "private, no-store");
  const ownedAttemptId = attemptIdSchema.safeParse(attemptId);
  if (!ownedAttemptId.success) {
    throw new HttpError(404, "ATTEMPT_NOT_FOUND", "作答记录不存在");
  }
  const { etag, detail } = readConditionalAttemptDetail(
    db,
    studentId,
    ownedAttemptId.data,
    c.req.header("If-None-Match"),
  );
  if (etag !== null) c.header("ETag", etag);
  return detail === null
    ? c.body(null, 304)
    : c.json({ ok: true, data: attemptDetailDataSchema.parse(detail) });
}

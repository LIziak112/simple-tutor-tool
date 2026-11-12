import type { Context } from "hono";
import type { Db } from "../db/client";
import { readConditionalAttemptDetail } from "../services/attempt-detail-cache";

export function respondAttemptDetail(
  c: Context,
  db: Db,
  studentId: string,
  attemptId: string,
) {
  c.header("Cache-Control", "private, no-store");
  const { etag, detail } = readConditionalAttemptDetail(
    db,
    studentId,
    attemptId,
    c.req.header("If-None-Match"),
  );
  if (etag !== null) c.header("ETag", etag);
  return detail === null
    ? c.body(null, 304)
    : c.json({ ok: true, data: detail });
}

import { attemptDetailDataSchema, attemptIdSchema } from "@tutor/contract";
import type { Context } from "hono";
import type { Db } from "../db/client";
import { HttpError } from "../lib/http-error";
import { readConditionalAttemptDetail } from "../services/attempt-detail-cache";
import { readKernelAssignmentDetail } from "../services/kernel-assignment-drafts.ts";

export function respondAttemptDetail(
  c: Context,
  db: Db,
  studentId: string,
  attemptId: string,
  dataDir?: string,
) {
  c.header("Cache-Control", "private, no-store");
  const ownedAttemptId = attemptIdSchema.safeParse(attemptId);
  if (!ownedAttemptId.success) {
    throw new HttpError(404, "ATTEMPT_NOT_FOUND", "作答记录不存在");
  }
  const ifNoneMatch = c.req.header("If-None-Match");
  const kernel =
    dataDir === undefined
      ? undefined
      : readKernelAssignmentDetail(
          db,
          dataDir,
          studentId,
          ownedAttemptId.data,
          ifNoneMatch,
        );
  const { etag, detail } =
    kernel ??
    readConditionalAttemptDetail(
      db,
      studentId,
      ownedAttemptId.data,
      ifNoneMatch,
    );
  if (etag !== null) c.header("ETag", etag);
  return detail === null
    ? c.body(null, 304)
    : c.json({ ok: true, data: attemptDetailDataSchema.parse(detail) });
}

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { Attempt } from "../db/schema.ts";
import { kernelAssignments } from "../db/schema-kernel-assignments.ts";
import { HttpError } from "../lib/http-error.ts";

export function hasKernelAssignmentTables(db: Db): boolean {
  return (
    db.$client
      .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
      .get("kernel_assignments") !== undefined
  );
}

export function isKernelAssignment(
  db: Pick<Db, "select">,
  assignmentId: string,
): boolean {
  return (
    db
      .select()
      .from(kernelAssignments)
      .where(eq(kernelAssignments.assignmentId, assignmentId))
      .get() !== undefined
  );
}

export function isKernelAttempt(
  db: Pick<Db, "select">,
  attempt: Attempt,
): boolean {
  return (
    attempt.sourceType === "assignment" &&
    attempt.assignmentId !== null &&
    isKernelAssignment(db, attempt.assignmentId)
  );
}

export function requireLegacyAttemptWrite(
  db: Pick<Db, "select">,
  attempt: Attempt,
): void {
  if (isKernelAttempt(db, attempt))
    throw new HttpError(
      503,
      "KERNEL_ATTEMPT_WRITE_UNAVAILABLE",
      "内核作答暂未开放此操作",
    );
}

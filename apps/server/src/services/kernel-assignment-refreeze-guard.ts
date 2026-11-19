import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { Attempt } from "../db/schema.ts";
import { kernelAttemptRefreezes } from "../db/schema-kernel-assignments.ts";
import { HttpError } from "../lib/http-error.ts";
import { isKernelAttempt } from "./kernel-assignment-routing.ts";

export function pendingKernelRefreeze(
  db: Pick<Db, "select">,
  attemptId: string,
) {
  return db
    .select()
    .from(kernelAttemptRefreezes)
    .where(eq(kernelAttemptRefreezes.attemptId, attemptId))
    .get();
}

function kernelRefreezePending(): never {
  throw new HttpError(
    503,
    "KERNEL_ATTEMPT_REFREEZE_PENDING",
    "正在恢复题目版本，请保留本机草稿并重新进入练习",
  );
}

export function requireNoPendingKernelRefreeze(
  db: Pick<Db, "select">,
  attempt: Attempt,
): void {
  if (isKernelAttempt(db, attempt) && pendingKernelRefreeze(db, attempt.id))
    kernelRefreezePending();
}

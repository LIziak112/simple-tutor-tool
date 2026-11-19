import { eq } from "drizzle-orm";
import type { openLearningRuntime } from "learning-kernel";
import type { Db } from "../db/client.ts";
import { type Attempt, attempts } from "../db/schema.ts";

type Runtime = ReturnType<typeof openLearningRuntime>;

export function projectKernelDraftActivity(
  db: Db,
  attempt: Attempt,
  runtime: Runtime,
): Attempt {
  if (attempt.status !== "draft") return attempt;
  const times = runtime.readChoiceDraftActivity(
    { role: "student", id: attempt.studentId },
    attempt.id,
  );
  if (times === undefined) return attempt;
  const { firstChangedAt, lastChangedAt } = times;
  const activatedAt =
    firstChangedAt !== null &&
    (attempt.activatedAt === null || firstChangedAt < attempt.activatedAt)
      ? firstChangedAt
      : attempt.activatedAt;
  const previousActivity = attempt.lastActivityAt ?? attempt.startedAt;
  const lastActivityAt =
    lastChangedAt === null
      ? attempt.lastActivityAt
      : lastChangedAt > previousActivity
        ? lastChangedAt
        : previousActivity;
  if (
    activatedAt === attempt.activatedAt &&
    lastActivityAt === attempt.lastActivityAt
  )
    return attempt;
  db.update(attempts)
    .set({ activatedAt, lastActivityAt })
    .where(eq(attempts.id, attempt.id))
    .run();
  return { ...attempt, activatedAt, lastActivityAt };
}

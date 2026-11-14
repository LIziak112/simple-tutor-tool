import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import {
  at,
  closeTimingFixtures,
  timingFixture,
} from "../test/submission-time-fixture.ts";
import {
  ATTEMPT_ACTIVATION_BACKFILL_KEY,
  backfillAttemptActivation,
} from "./backfill-attempt-activation.ts";
import { attempts, dataMigrations } from "./schema.ts";

afterEach(closeTimingFixtures);
it.each(["empty", "view", "answer", "flag", "submitted"])(
  "历史%s只按持久化证据回填开始时刻且幂等",
  (kind) => {
    const env = timingFixture();
    env.db
      .delete(dataMigrations)
      .where(eq(dataMigrations.key, ATTEMPT_ACTIVATION_BACKFILL_KEY))
      .run();
    if (kind === "view") env.event("question_view", 10, "q1");
    if (kind === "answer")
      env.db.$client
        .prepare("UPDATE responses SET answer_json='{}' WHERE attempt_id=?")
        .run(env.attemptId);
    if (kind === "flag")
      env.db.$client
        .prepare(
          "UPDATE responses SET student_flag='unsure' WHERE attempt_id=?",
        )
        .run(env.attemptId);
    if (kind === "submitted")
      env.db
        .update(attempts)
        .set({ status: "submitted" })
        .where(eq(attempts.id, env.attemptId))
        .run();
    const activated = !["empty", "view"].includes(kind);
    expect(backfillAttemptActivation(env.db, new Date(at(100)))).toBe(
      activated ? 1 : 0,
    );
    expect(env.db.select().from(attempts).get()?.activatedAt).toBe(
      activated ? at(0) : null,
    );
    expect(backfillAttemptActivation(env.db, new Date(at(200)))).toBe(0);
  },
);

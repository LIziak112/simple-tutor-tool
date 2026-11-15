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
it.each([
  "empty",
  "view",
  "answer",
  "flag",
  "submitted",
  // 旧版只在实质写入点更新最近作答时间（含画了又全擦掉的正式手写）
  "touched",
  // Agent 经 MCP 组的错题卷建好即入账；学生自己圈的、范围快照损坏的仍按证据
  "agent",
  "selection",
  "broken-scope",
])("历史%s只按持久化证据回填开始时刻且幂等", (kind) => {
  const env = timingFixture();
  env.db
    .delete(dataMigrations)
    .where(eq(dataMigrations.key, ATTEMPT_ACTIVATION_BACKFILL_KEY))
    .run();
  const scopes: Record<string, string> = {
    agent: JSON.stringify({ kind: "ai", label: "最近一周 · 错 2 次以上" }),
    selection: JSON.stringify({ kind: "selection", questionCount: 2 }),
    "broken-scope": '{"kind":"ai"',
  };
  const scope = scopes[kind];
  if (scope !== undefined)
    env.db
      .update(attempts)
      .set({ practiceScopeJson: scope })
      .where(eq(attempts.id, env.attemptId))
      .run();
  if (kind === "touched")
    env.db
      .update(attempts)
      .set({ lastActivityAt: at(30) })
      .where(eq(attempts.id, env.attemptId))
      .run();
  if (kind === "view") env.event("question_view", 10, "q1");
  if (kind === "answer")
    env.db.$client
      .prepare("UPDATE responses SET answer_json='{}' WHERE attempt_id=?")
      .run(env.attemptId);
  if (kind === "flag")
    env.db.$client
      .prepare("UPDATE responses SET student_flag='unsure' WHERE attempt_id=?")
      .run(env.attemptId);
  if (kind === "submitted")
    env.db
      .update(attempts)
      .set({ status: "submitted" })
      .where(eq(attempts.id, env.attemptId))
      .run();
  const activated = !["empty", "view", "selection", "broken-scope"].includes(
    kind,
  );
  expect(backfillAttemptActivation(env.db, new Date(at(100)))).toBe(
    activated ? 1 : 0,
  );
  expect(env.db.select().from(attempts).get()?.activatedAt).toBe(
    activated ? at(0) : null,
  );
  expect(backfillAttemptActivation(env.db, new Date(at(200)))).toBe(0);
});

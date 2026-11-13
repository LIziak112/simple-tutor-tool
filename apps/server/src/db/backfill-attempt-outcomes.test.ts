import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  frozenDraftAttempt,
  snapshotJsonOf,
} from "../test/evidence-fixtures.ts";
import { makeStudent } from "../test/note-fixtures.ts";
import { runBackfills } from "./backfill.ts";
import { attempts, dataMigrations, responses } from "./schema.ts";
import { createTestDb } from "./test-utils.ts";

it("只修正冻结且已收尾的可确定派生状态，并与完成标记原子落库", () => {
  const db = createTestDb();
  const studentId = makeStudent(db);
  const key = "reconcile_attempt_outcomes_v1";
  db.delete(dataMigrations).where(eq(dataMigrations.key, key)).run();
  const at = "2026-10-02T00:00:00.000Z";
  const seed = (
    snapshotJson: string | null,
    abandonedAt: string | null = null,
  ) => {
    const { attemptId } = frozenDraftAttempt(db, studentId, [
      { questionId: "q1", snapshotJson },
    ]);
    db.update(attempts)
      .set({
        sourceType: "wrong",
        status: "submitted",
        submittedAt: at,
        abandonedAt,
        scoreAuto: 20,
        scoreFinal: null,
      })
      .where(eq(attempts.id, attemptId))
      .run();
    db.update(responses)
      .set({ autoCorrect: true, finalCorrect: true })
      .where(eq(responses.attemptId, attemptId))
      .run();
    return attemptId;
  };
  const validSnapshot = snapshotJsonOf({ id: "q1" });
  const valid = seed(validSnapshot);
  const invalid = seed("{}");
  const abandoned = seed(validSnapshot, at);
  const invalidVerdict = seed(validSnapshot);
  db.update(responses)
    .set({ autoCorrect: false })
    .where(eq(responses.attemptId, invalidVerdict))
    .run();
  const unverified = seed(validSnapshot);
  db.update(attempts)
    .set({ legacyUnverified: true })
    .where(eq(attempts.id, unverified))
    .run();
  const impossibleAuto = seed(validSnapshot);
  db.update(responses)
    .set({ gradingPolicy: "manual_only" })
    .where(eq(responses.attemptId, impossibleAuto))
    .run();
  const rowOf = (id: string) =>
    db.select().from(attempts).where(eq(attempts.id, id)).get();
  db.$client.exec(`
    CREATE TRIGGER fail_outcome_marker BEFORE INSERT ON data_migrations
    WHEN NEW.key = 'reconcile_attempt_outcomes_v1'
    BEGIN SELECT RAISE(ABORT, '测试修正提交失败'); END
  `);
  expect(() => runBackfills(db, new Date(at))).toThrow("测试修正提交失败");
  expect(rowOf(valid)).toMatchObject({
    status: "submitted",
    scoreAuto: 20,
    scoreFinal: null,
  });
  expect(
    db.select().from(dataMigrations).where(eq(dataMigrations.key, key)).get(),
  ).toBeUndefined();
  db.$client.exec("DROP TRIGGER fail_outcome_marker");
  runBackfills(db, new Date(at));
  expect(rowOf(valid)).toMatchObject({
    status: "graded",
    scoreAuto: 100,
    scoreFinal: 100,
    submittedAt: at,
  });
  for (const id of [
    invalid,
    abandoned,
    invalidVerdict,
    unverified,
    impossibleAuto,
  ]) {
    expect(rowOf(id)).toMatchObject({
      status: "submitted",
      scoreAuto: 20,
      scoreFinal: null,
    });
  }
  expect(
    db.select().from(dataMigrations).where(eq(dataMigrations.key, key)).get()
      ?.appliedAt,
  ).toBe(at);
  runBackfills(db);
  expect(rowOf(valid)?.scoreFinal).toBe(100);
});

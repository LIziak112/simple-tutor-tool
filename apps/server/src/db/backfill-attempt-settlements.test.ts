import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { writeFinalSettlementWithin } from "../services/attempt-settlement.ts";
import {
  at,
  closeTimingFixtures,
  timingFixture,
} from "../test/submission-time-fixture.ts";
import { backfillAttemptSettlements } from "./backfill-attempt-settlements.ts";
import { attempts, responses } from "./schema.ts";

afterEach(closeTimingFixtures);
function historical() {
  const env = timingFixture();
  env.db.$client
    .prepare(
      "DELETE FROM data_migrations WHERE key='attempt_final_settlements_v1'",
    )
    .run();
  env.db
    .update(attempts)
    .set({
      status: "submitted",
      submittedAt: at(10),
      frozenAt: null,
      legacyUnverified: true,
      activeSec: 99,
    })
    .run();
  env.db
    .update(responses)
    .set({ activeSec: 0, questionSnapshotJson: null })
    .where(eq(responses.id, env.row("q1").id))
    .run();
  return env;
}

it("历史旧完成卷全部归属，保留坏快照/旧时间/判分/id/rowid，重复全回填零写", () => {
  const env = historical();
  const before = env.db.$client
    .prepare("SELECT rowid,* FROM responses ORDER BY rowid")
    .all();
  const attemptBefore = env.db.select().from(attempts).get();
  backfillAttemptSettlements(env.db, new Date(at(30)));
  expect(env.db.select().from(attempts).get()).toEqual(attemptBefore);
  const after = env.db.$client
    .prepare("SELECT rowid,* FROM responses ORDER BY rowid")
    .all();
  expect(after).toEqual(
    before.map((r) => ({ ...(r as object), settlement_seq: 1 })),
  );
  expect(
    env.db.$client
      .prepare(
        "SELECT seq,question_count,active_sec,created_at FROM attempt_settlements",
      )
      .get(),
  ).toEqual({ seq: 1, question_count: 2, active_sec: 0, created_at: at(10) });
  const total = env.db.$client.prepare("SELECT total_changes()").pluck().get();
  backfillAttemptSettlements(env.db, new Date(at(40)));
  expect(env.db.$client.prepare("SELECT total_changes()").pluck().get()).toBe(
    total,
  );
  env.db.transaction((tx) => writeFinalSettlementWithin(tx, env.attemptId));
  expect(env.db.$client.prepare("SELECT total_changes()").pluck().get()).toBe(
    total,
  );
});

it("作废完成卷仍保留历史final；作废draft不补final；空完成卷写0/NULL", () => {
  const finished = historical();
  finished.db
    .update(attempts)
    .set({ abandonedAt: at(20) })
    .run();
  finished.db.delete(responses).run();
  backfillAttemptSettlements(finished.db, new Date(at(30)));
  expect(
    finished.db.$client
      .prepare("SELECT question_count,active_sec FROM attempt_settlements")
      .get(),
  ).toEqual({ question_count: 0, active_sec: null });
  const draft = timingFixture();
  draft.db.$client
    .prepare(
      "DELETE FROM data_migrations WHERE key='attempt_final_settlements_v1'",
    )
    .run();
  draft.db
    .update(attempts)
    .set({ abandonedAt: at(20) })
    .run();
  backfillAttemptSettlements(draft.db, new Date(at(30)));
  expect(
    draft.db.$client
      .prepare("SELECT count(*) FROM attempt_settlements")
      .pluck()
      .get(),
  ).toBe(0);
});

it("缺失/非法完成时间不冒充历史；失败不写完成标记，成员失败整体回滚", () => {
  const env = historical();
  env.db.update(attempts).set({ submittedAt: null }).run();
  expect(() => backfillAttemptSettlements(env.db, new Date(at(30)))).toThrow();
  expect(
    env.db.$client
      .prepare(
        "SELECT count(*) FROM data_migrations WHERE key='attempt_final_settlements_v1'",
      )
      .pluck()
      .get(),
  ).toBe(0);
  env.db.update(attempts).set({ submittedAt: "非法时间" }).run();
  expect(() => backfillAttemptSettlements(env.db, new Date(at(30)))).toThrow();
  env.db
    .update(attempts)
    .set({ submittedAt: at(10) })
    .run();
  env.db.$client.exec(
    "CREATE TRIGGER fail_member BEFORE UPDATE OF settlement_seq ON responses BEGIN SELECT RAISE(ABORT,'测试回填失败'); END",
  );
  expect(() => backfillAttemptSettlements(env.db, new Date(at(30)))).toThrow(
    "测试回填失败",
  );
  expect(
    env.db.$client
      .prepare("SELECT count(*) FROM attempt_settlements")
      .pluck()
      .get(),
  ).toBe(0);
});

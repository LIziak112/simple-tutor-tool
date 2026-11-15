import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { attempts } from "../db/schema.ts";
import { createTestDir } from "../db/test-utils.ts";
import { gzipJson, noteDoc } from "../test/note-fixtures.ts";
import {
  at,
  closeTimingFixtures,
  timingFixture,
} from "../test/submission-time-fixture.ts";
import { touchAttemptActivity } from "./attempt-activity.ts";
import {
  openedAttemptPurgeOptionsOf,
  purgeOpenedAttempts,
} from "./attempt-opened-purge.ts";
import { saveNoteVersion } from "./note-service.ts";

afterEach(closeTimingFixtures);
it("首次空白草稿同步不激活，清除时按循环FK顺序删除空稿版本", () => {
  const env = timingFixture();
  saveNoteVersion(
    env.db,
    createTestDir(),
    env.studentId,
    env.attemptId,
    "q1",
    gzipJson(noteDoc(0)),
    { baseRevision: 0, mutationId: crypto.randomUUID() },
  );
  expect(env.db.select().from(attempts).get()?.activatedAt).toBeNull();
  expect(
    purgeOpenedAttempts(env.db, {
      enabled: true,
      now: new Date(at(8 * 86400)),
    }),
  ).toBe(1);
  for (const table of ["notes", "note_versions", "note_images"])
    expect(
      env.db.$client.prepare(`SELECT count(*) AS n FROM ${table}`).get(),
    ).toEqual({ n: 0 });
  expect(env.db.$client.pragma("foreign_key_check")).toEqual([]);
});
it("清除默认关闭，配置默认七天且拒绝非法天数", () => {
  const env = timingFixture();
  expect(openedAttemptPurgeOptionsOf({})).toEqual({ enabled: false, days: 7 });
  expect(() =>
    openedAttemptPurgeOptionsOf({ ATTEMPT_OPENED_PURGE_DAYS: "0" }),
  ).toThrow();
  expect(purgeOpenedAttempts(env.db, { now: new Date(at(9 * 86400)) })).toBe(0);
  expect(env.db.select().from(attempts).get()).toBeDefined();
});

it("删除旧空卷与浏览事件，兼容time receipt/profile保护触发器，保留未到期卷", () => {
  const env = timingFixture();
  env.event("question_view", 10, "q1");
  const event = env.db.$client
    .prepare("SELECT id FROM events WHERE attempt_id=?")
    .get(env.attemptId) as { id: string };
  env.db.$client
    .prepare(
      "INSERT INTO attempt_event_receipts(attempt_id,event_id,origin,kind,received_at) VALUES(?,?,'client','event',?)",
    )
    .run(env.attemptId, event.id, at(10));
  expect(() =>
    env.db.$client
      .prepare("DELETE FROM attempt_event_receipts WHERE attempt_id=?")
      .run(env.attemptId),
  ).toThrow("immutable");
  expect(
    purgeOpenedAttempts(env.db, {
      enabled: true,
      now: new Date(at(6 * 86400)),
    }),
  ).toBe(0);
  expect(
    purgeOpenedAttempts(env.db, {
      enabled: true,
      now: new Date(at(8 * 86400)),
    }),
  ).toBe(1);
  for (const table of [
    "attempts",
    "responses",
    "events",
    "attempt_time_profiles",
    "attempt_event_receipts",
  ]) {
    expect(
      env.db.$client.prepare(`SELECT count(*) AS n FROM ${table}`).get(),
    ).toEqual({ n: 0 });
  }
  expect(env.db.$client.pragma("foreign_key_check")).toEqual([]);
  expect(env.db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
});

it("有答案证据但漏激活的卷和已激活的卷都不得清除", () => {
  const env = timingFixture();
  env.db.$client
    .prepare("UPDATE responses SET answer_json='{}' WHERE attempt_id=?")
    .run(env.attemptId);
  expect(
    purgeOpenedAttempts(env.db, {
      enabled: true,
      now: new Date(at(8 * 86400)),
    }),
  ).toBe(0);
  env.db.$client
    .prepare("UPDATE responses SET answer_json=NULL WHERE attempt_id=?")
    .run(env.attemptId);
  touchAttemptActivity(env.db, env.attemptId, at(20));
  expect(
    purgeOpenedAttempts(env.db, {
      enabled: true,
      now: new Date(at(8 * 86400)),
    }),
  ).toBe(0);
  expect(
    env.db.select().from(attempts).where(eq(attempts.id, env.attemptId)).get()
      ?.activatedAt,
  ).toBe(at(20));
});

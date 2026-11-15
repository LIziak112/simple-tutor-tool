import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  at,
  closeTimingFixtures,
  timingFixture,
} from "../test/submission-time-fixture.ts";

afterEach(closeTimingFixtures);
it("结算序号只可首次绑定同卷结算；正整数、同键及唯一final由数据库守门", () => {
  const env = timingFixture();
  const other = timingFixture();
  const insert = env.db.$client.prepare(
    "INSERT INTO attempt_settlements (id,attempt_id,seq,kind,created_at,question_count,mutation_id,request_digest) VALUES (?,?,?,'final',?,2,?,?)",
  );
  insert.run(randomUUID(), env.attemptId, 1, at(20), "final-key", "digest");
  const bind = env.db.$client.prepare(
    "UPDATE responses SET settlement_seq=? WHERE id=?",
  );
  expect(() => bind.run(1, env.row("q1").id)).not.toThrow();
  expect(() => bind.run(null, env.row("q1").id)).toThrow("结算归属不可变");
  expect(() => bind.run(2, env.row("q1").id)).toThrow("结算归属不可变");
  expect(() => bind.run(-1, env.row("q2").id)).toThrow("结算归属无效");
  expect(() => bind.run(1.5, env.row("q2").id)).toThrow("结算归属无效");
  expect(() => bind.run(2, env.row("q2").id)).toThrow("结算归属无效");
  expect(() =>
    insert.run(randomUUID(), env.attemptId, 2, at(20), "other", "digest"),
  ).toThrow();
  const partial = env.db.$client.prepare(
    "INSERT INTO attempt_settlements(id,attempt_id,seq,kind,created_at,question_count,mutation_id,request_digest) VALUES(?,?,?,'partial',?,1,?,?)",
  );
  expect(() =>
    partial.run(
      randomUUID(),
      env.attemptId,
      2,
      at(20),
      "final-key",
      "changed-digest",
    ),
  ).toThrow("UNIQUE constraint failed");
  expect(() =>
    partial.run(
      randomUUID(),
      env.attemptId,
      1,
      at(20),
      "different-key",
      "digest",
    ),
  ).toThrow("UNIQUE constraint failed");
  env.db.$client
    .prepare(
      "INSERT INTO attempts(id,student_id,source_type,status,started_at) VALUES('other-attempt',?,'wrong','draft',?)",
    )
    .run(env.studentId, at(0));
  expect(() =>
    env.db.$client
      .prepare(
        "INSERT INTO responses(id,attempt_id,question_id,settlement_seq) VALUES('other-row','other-attempt','q',1)",
      )
      .run(),
  ).toThrow("结算归属无效");
  expect(() =>
    env.db.$client
      .prepare("UPDATE responses SET attempt_id=? WHERE id=?")
      .run(other.attemptId, env.row("q1").id),
  ).toThrow();
  expect(() =>
    env.db.$client
      .prepare("UPDATE attempt_settlements SET question_count=4")
      .run(),
  ).toThrow("结算事实不可变");
});

it("未绑定的异卷序号不成立，正常先删子行再删attempt可以级联清理结算", () => {
  const env = timingFixture();
  env.db.$client
    .prepare(
      "INSERT INTO attempt_settlements (id,attempt_id,seq,kind,created_at,question_count,mutation_id,request_digest) VALUES (?,?,1,'final',?,2,'key','digest')",
    )
    .run(randomUUID(), env.attemptId, at(20));
  env.db.$client
    .prepare("UPDATE responses SET settlement_seq=1 WHERE attempt_id=?")
    .run(env.attemptId);
  expect(() =>
    env.db.$client.prepare("DELETE FROM attempt_settlements").run(),
  ).toThrow("结算仍有成员");
  env.db.$client
    .prepare("DELETE FROM responses WHERE attempt_id=?")
    .run(env.attemptId);
  expect(() =>
    env.db.$client
      .prepare("DELETE FROM attempts WHERE id=?")
      .run(env.attemptId),
  ).not.toThrow();
  expect(
    env.db.$client
      .prepare("SELECT count(*) FROM attempt_settlements")
      .pluck()
      .get(),
  ).toBe(0);
  expect(env.db.$client.pragma("foreign_key_check")).toEqual([]);
});

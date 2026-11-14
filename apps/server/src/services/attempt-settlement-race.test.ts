import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PracticeQuestionSubmitWithAnswer } from "@tutor/contract";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { startSettlementRace } from "../test/settlement-race-harness.ts";
import {
  closeTimingFixtures,
  timingFixture,
} from "../test/submission-time-fixture.ts";

afterEach(closeTimingFixtures);
async function race(
  env: ReturnType<typeof timingFixture>,
  requests: (PracticeQuestionSubmitWithAnswer | null)[],
) {
  const folder = mkdtempSync(join(tmpdir(), "settlement-race-"));
  const filename = join(folder, "test.db");
  await env.db.$client.backup(filename);
  const run = startSettlementRace(
    filename,
    env.studentId,
    env.attemptId,
    requests,
  );
  onTestFinished(run.stop);
  try {
    const results = await run.completion;
    expect(
      results.filter((result) => !result.ok).map((result) => result.code),
    ).not.toContain("SQLITE_BUSY_SNAPSHOT");
    expect(
      results.filter((result) => !result.ok).map((result) => result.code),
    ).not.toContain("SQLITE_BUSY");
    const { createDb } = await import("../db/client.ts");
    const copy = createDb(filename);
    try {
      expect(
        copy.$client
          .prepare(
            "SELECT count(*) FROM attempt_settlements WHERE kind='final'",
          )
          .pluck()
          .get(),
      ).toBe(1);
      expect(
        copy.$client
          .prepare("SELECT count(*) FROM responses WHERE settlement_seq=1")
          .pluck()
          .get(),
      ).toBe(2);
      expect(
        copy.$client
          .prepare("SELECT count(*) FROM events WHERE type='submit'")
          .pluck()
          .get(),
      ).toBe(1);
      expect(
        results.every(
          (result) =>
            result.ok ||
            ["ALREADY_SUBMITTED", "QUESTION_ALREADY_SUBMITTED"].includes(
              result.code ?? "",
            ),
        ),
      ).toBe(true);
      expect(results.some((result) => result.ok)).toBe(true);
    } finally {
      copy.$client.close();
    }
  } finally {
    await run.stop();
    rmSync(folder, { recursive: true, force: true });
  }
}

it("两个独立连接并发整卷交卷，只落一个final", async () => {
  const env = timingFixture();
  await race(env, [null, null]);
}, 20000);
it("逐题末题与整卷交卷竞争，只收尾一次", async () => {
  const env = timingFixture();
  env.submit("q1", 10);
  await race(env, [env.practiceRequest("q2"), null]);
}, 20000);
it("最后两题经独立连接同时提交，仍恰好一次收尾", async () => {
  const env = timingFixture();
  await race(env, [env.practiceRequest("q1"), env.practiceRequest("q2")]);
}, 20000);

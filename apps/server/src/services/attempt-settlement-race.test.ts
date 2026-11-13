import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PracticeQuestionSubmitWithAnswer } from "@tutor/contract";
import { afterEach, expect, it } from "vitest";
import {
  closeTimingFixtures,
  timingFixture,
} from "../test/submission-time-fixture.ts";

afterEach(closeTimingFixtures);
type Outcome = { ok: boolean; code?: string };
async function race(
  env: ReturnType<typeof timingFixture>,
  requests: (PracticeQuestionSubmitWithAnswer | null)[],
) {
  const folder = mkdtempSync(join(tmpdir(), "settlement-race-"));
  const filename = join(folder, "test.db");
  await env.db.$client.backup(filename);
  const workers = requests.map((request) =>
    fork(
      new URL("../test/settlement-race-worker.ts", import.meta.url),
      [filename, env.studentId, env.attemptId, JSON.stringify(request)],
      {
        execArgv: ["--import", import.meta.resolve("tsx")],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    ),
  );
  try {
    const outcomes = workers.map(
      (worker) =>
        new Promise<Outcome>((resolve, reject) => {
          worker.once("error", reject);
          worker.on("message", (message) => {
            const value = message as Outcome & { ready?: boolean };
            if (!value.ready) resolve(value);
          });
          worker.once("exit", (code) => {
            if (code !== 0) reject(new Error(`竞争执行器退出${code}`));
          });
        }),
    );
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve) =>
            worker.on("message", (message) => {
              if ((message as { ready?: boolean }).ready) resolve();
            }),
          ),
      ),
    );
    for (const worker of workers) worker.send("go");
    const results = await Promise.all(outcomes);
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
    for (const worker of workers) worker.kill();
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

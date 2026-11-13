import { once } from "node:events";
import { expect, it, onTestFinished } from "vitest";
import { startSettlementRace } from "./settlement-race-harness";
import { closeTimingFixtures, timingFixture } from "./submission-time-fixture";

it("真实child在ready前退出时直接拒绝并保留stderr，不遗留等不到ready的Promise", async () => {
  const run = startSettlementRace(
    "unused.db",
    "student",
    "attempt",
    [null, null],
    new URL("./fixtures/settlement-race-startup-failure.mjs", import.meta.url),
  );
  onTestFinished(run.stop);
  // 从创建后立即消费结果；仅等真实child关闭，不用短timeout把永不拒绝伪装成成功。
  const observed = run.completion.then(
    () => ({ kind: "success" as const }),
    (error) => ({ kind: "failure" as const, error }),
  );
  await Promise.all(run.workers.map((worker) => once(worker, "close")));
  const outcome = await Promise.race([
    observed,
    Promise.resolve({ kind: "pending" as const }),
  ]);
  expect(outcome.kind).toBe("failure");
  if (outcome.kind !== "failure")
    throw new Error("child已退出，但ready屏障仍未拒绝");
  expect(String(outcome.error)).toContain("settlement-startup-marker");
  expect(String(outcome.error)).toContain("starting");
  expect(run.workers.every((w) => w.exitCode === 1)).toBe(true);
}, 20000);

it("一侧启动失败时停止并等待仍存活的peer，撤掉自有listener后再返回清理", async () => {
  const env = timingFixture();
  const run = startSettlementRace(
    "unused.db",
    env.studentId,
    env.attemptId,
    [null, env.practiceRequest("q2")],
    new URL("./fixtures/settlement-race-startup-failure.mjs", import.meta.url),
  );
  onTestFinished(run.stop);
  try {
    await expect(run.completion).rejects.toThrow("code=1");
  } finally {
    await run.stop();
    closeTimingFixtures();
  }
  expect(run.workers).toHaveLength(2);
  for (const worker of run.workers) {
    expect(worker.exitCode !== null || worker.signalCode !== null).toBe(true);
    expect(worker.connected).toBe(false);
    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.listenerCount("error")).toBe(0);
    expect(worker.listenerCount("close")).toBe(0);
    expect(worker.stderr?.listenerCount("data")).toBe(0);
  }
}, 20000);

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttemptPartialRequest } from "@tutor/contract";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { createDb } from "../db/client.ts";
import { startSettlementRace } from "../test/settlement-race-harness.ts";
import { studentPracticeReadEnv } from "../test/student-mcp-practice-fixtures.ts";

const opened: Awaited<ReturnType<typeof studentPracticeReadEnv>>[] = [];
afterEach(async () => {
  for (const env of opened.splice(0)) {
    await env.client.close();
    env.db.$client.close();
  }
});
async function race(sameRequest: boolean) {
  const env = await studentPracticeReadEnv("class");
  opened.push(env);
  const req: AttemptPartialRequest = {
    workflowVersion: 1,
    workflowRevision: 0,
    mutationId: randomUUID(),
    questions: env.revisions
      .slice(0, sameRequest ? 2 : 1)
      .map((revision, index) => ({
        questionId: `q-${index + 1}`,
        questionRevisionId: revision,
        expectedAnswerRevision: 0,
        evidence: { questionId: `q-${index + 1}`, state: "none" },
      })),
  };
  const folder = mkdtempSync(join(tmpdir(), "partial-race-"));
  const file = join(folder, "test.db");
  await env.db.$client.backup(file);
  const running = startSettlementRace(
    file,
    env.studentId,
    env.practiceId,
    [req, sameRequest ? req : null],
    new URL("../test/partial-race-worker.ts", import.meta.url),
  );
  onTestFinished(running.stop);
  try {
    const outcomes = await running.completion;
    expect(outcomes.some((outcome) => outcome.ok)).toBe(true);
    expect(
      outcomes.every(
        (outcome) =>
          outcome.ok ||
          [
            "WORKFLOW_RESTRICTED",
            "ALREADY_SUBMITTED",
            "QUESTION_ALREADY_SUBMITTED",
          ].includes(outcome.code ?? ""),
      ),
    ).toBe(true);
    if (sameRequest) expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    const copy = createDb(file);
    try {
      expect(
        copy.$client
          .prepare(
            "select count(*) n from attempt_settlements where kind='final'",
          )
          .pluck()
          .get(),
      ).toBe(1);
      expect(
        copy.$client
          .prepare(
            "select count(*) n from responses where settlement_seq is not null",
          )
          .pluck()
          .get(),
      ).toBe(2);
      expect(
        copy.$client
          .prepare("select count(*) n from events where type='submit'")
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      copy.$client.close();
    }
  } finally {
    await running.stop();
    rmSync(folder, { recursive: true, force: true });
  }
}
it("同请求在独立连接并发只生成一次final与成员", () => race(true), 30000);
it("分批与整卷在独立连接竞争只收尾一次", () => race(false), 30000);

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { expect, it, onTestFinished } from "vitest";
import { createDb } from "../../db/client.ts";
import {
  attempts,
  responses,
  reviewV2Runs,
  reviewV2Tasks,
} from "../../db/schema.ts";
import { insertResponse } from "../../test/ai-companion-fixtures.ts";
import { startSettlementRace } from "../../test/settlement-race-harness.ts";
import { studentPracticeReadEnv } from "../../test/student-mcp-practice-fixtures.ts";

it.each([true, false])(
  "独立进程创建同键复盘，同内容=%s，只有一张完整任务图",
  async (same) => {
    const e = await studentPracticeReadEnv("class"),
      folder = mkdtempSync(join(tmpdir(), "review-v2-race-")),
      file = join(folder, "test.db");
    for (let i = 3; i <= 31; i++) insertResponse(e.db, e.practiceId, `q-${i}`);
    e.db
      .update(attempts)
      .set({ status: "submitted", submittedAt: new Date().toISOString() })
      .where(eq(attempts.id, e.practiceId))
      .run();
    e.db
      .update(responses)
      .set({ submittedAt: new Date().toISOString() })
      .where(eq(responses.attemptId, e.practiceId))
      .run();
    await e.db.$client.backup(file);
    const request = {
      mutationId: randomUUID(),
      purpose: "复盘",
      profile: "objective",
      scope: { kind: "attempt" },
    };
    const running = startSettlementRace(
      file,
      e.studentId,
      e.practiceId,
      [request, same ? request : { ...request, purpose: "不同诉求" }],
      new URL("../../test/review-v2-race-worker.ts", import.meta.url),
    );
    onTestFinished(running.stop);
    try {
      const results = await running.completion;
      expect(results.filter((result) => result.ok)).toHaveLength(same ? 2 : 1);
      if (!same)
        expect(results.find((result) => !result.ok)?.code).toBe(
          "AI_REVIEW_CONFLICT",
        );
      const db = createDb(file);
      try {
        expect(db.select().from(reviewV2Runs).all()).toHaveLength(1);
        expect(db.select().from(reviewV2Tasks).all()).toHaveLength(3);
      } finally {
        db.$client.close();
      }
    } finally {
      await running.stop();
      await e.client.close();
      e.db.$client.close();
      rmSync(folder, { recursive: true, force: true });
    }
  },
  30000,
);

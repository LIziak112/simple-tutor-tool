import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { createDb } from "../db/client.ts";
import { releaseGateSql } from "./answer-publication-sql.ts";
import { attemptAnswersPublished } from "./practice-workflow-service.ts";

it("SQLite 与服务层共用同一批公布边界向量", () => {
  const db = createDb(":memory:");
  const now = "2026-10-10T12:00:00.000Z";
  const vectors = [
    ["course", null, null, true],
    ["assignment", null, null, false],
    ["assignment", "on_submit", null, true],
    ["assignment", "after_due", null, false],
    ["assignment", "after_due", "bad-date", false],
    ["assignment", "after_due", "2026-02-30T00:00:00Z", false],
    ["assignment", "after_due", "2026-10-10T01:00:00", false],
    ["assignment", "after_due", "2026-10-10T12:00:00Z", true],
    ["assignment", "after_due", "2026-10-10T12:00:00.001Z", false],
    ["assignment", "after_due", "2026-10-10T13:00:00+02:00", true],
    ["assignment", "unknown_policy", null, false],
  ] as const;
  try {
    for (const [sourceType, answerRelease, dueAt, expected] of vectors) {
      const result = db.get<{ published: number | null }>(sql`
        SELECT ${releaseGateSql(now)} AS published
        FROM (SELECT ${sourceType} AS source_type) AS attempts
        CROSS JOIN (SELECT ${answerRelease} AS answer_release, ${dueAt} AS due_at) AS assignments
      `);
      const release = answerRelease === null ? null : { answerRelease, dueAt };
      expect(
        Boolean(result?.published),
        [sourceType, answerRelease, dueAt].join(","),
      ).toBe(expected);
      expect(
        attemptAnswersPublished(
          { sourceType, attemptSubmitted: true, release },
          now,
        ),
      ).toBe(expected);
    }
  } finally {
    db.$client.close();
  }
});

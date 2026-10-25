import { describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-utils";
import { attemptResultCounts, resultCountsSummary } from "./result-counts";

describe("冻结作答题数聚合", () => {
  it("未做进分母，幽灵行不计，草稿不产生结果，教师改判后即时刷新", () => {
    const db = createTestDb();
    try {
      db.$client.pragma("foreign_keys = OFF");
      db.$client.exec(
        "INSERT INTO attempts (id, student_id, status, started_at) VALUES ('done','student','submitted','2026-10-25'),('draft','student','draft','2026-10-25')",
      );
      const insert = db.$client.prepare(
        "INSERT INTO responses (id,attempt_id,question_id,question_snapshot_json,final_correct,auto_correct,answered,review_eligible) VALUES (?,?,?,?,?,?,?,?)",
      );
      insert.run("right", "done", "q1", "{}", 1, 0, 1, 0);
      insert.run("blank", "done", "q2", "{}", 0, 0, 0, 0);
      insert.run("pending", "done", "q3", "{}", null, null, 1, 0);
      insert.run("self", "done", "q4", "{}", null, null, 1, 1);
      insert.run("ghost", "done", "q5", null, 1, 1, 1, 0);
      insert.run("draft-row", "draft", "q1", "{}", 1, 1, 1, 0);
      const rows = [
        { id: "done", status: "submitted" as const },
        { id: "draft", status: "draft" as const },
      ];
      expect(attemptResultCounts(db, rows).get("done")).toEqual({
        correctCount: 1,
        totalCount: 4,
        pendingCount: 1,
        pendingSelfReviewCount: 1,
      });
      expect(attemptResultCounts(db, rows).has("draft")).toBe(false);
      db.$client.exec("UPDATE responses SET final_correct=0 WHERE id='right'");
      expect(attemptResultCounts(db, rows).get("done")?.correctCount).toBe(0);
    } finally {
      db.$client.close();
    }
  });
  it("最佳按真实比例选完整的一轮，同率取最近，零题不参与", () => {
    const make = (correctCount: number, totalCount: number) => ({
      correctCount,
      totalCount,
      pendingCount: 0,
      pendingSelfReviewCount: 0,
    });
    const map = new Map([
      ["a", make(1, 2)],
      ["b", make(2, 5)],
      ["c", make(3, 6)],
      ["empty", make(0, 0)],
    ]);
    const summary = resultCountsSummary(["a", "b", "c", "empty"], map);
    expect(summary.firstResultCounts).toEqual(make(1, 2));
    expect(summary.latestResultCounts).toEqual(make(0, 0));
    expect(summary.bestResultCounts).toEqual(make(3, 6));
  });
});

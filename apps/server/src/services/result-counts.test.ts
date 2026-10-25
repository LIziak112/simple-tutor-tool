import { describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-utils";
import { attemptResultCounts, resultCountsSummary } from "./result-counts";

describe("冻结作答题数聚合（QM-12 有效判定口径）", () => {
  it("判对走有效判定（教师判>自评>自动），未做进分母，幽灵行不计，草稿不产生结果，教师改判后即时刷新", () => {
    const db = createTestDb();
    try {
      db.$client.pragma("foreign_keys = OFF");
      db.$client.exec(
        "INSERT INTO attempts (id, student_id, status, started_at) VALUES ('done','student','submitted','2026-10-25'),('draft','student','draft','2026-10-25')",
      );
      const insert = db.$client.prepare(
        "INSERT INTO responses (id,attempt_id,question_id,question_snapshot_json,final_correct,auto_correct,answered,grading_policy,teacher_mark,self_review_verdict,self_review_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      );
      // 自动判对：effective=auto true
      insert.run(
        "auto-right",
        "done",
        "q1",
        "{}",
        1,
        1,
        1,
        null,
        null,
        null,
        null,
      );
      // 自评「对了」：reference_self 行有效判定=自评 true（finalCorrect 恒 null）
      insert.run(
        "self-right",
        "done",
        "q2",
        "{}",
        null,
        null,
        1,
        "reference_self",
        null,
        "correct",
        "2026-10-25T00:00:00.000Z",
      );
      // 自评「错了」：入分母不计判对、不进任何待判计数
      insert.run(
        "self-wrong",
        "done",
        "q3",
        "{}",
        null,
        null,
        1,
        "reference_self",
        null,
        "wrong",
        "2026-10-25T00:00:00.000Z",
      );
      // 教师批错：effective=teacher false（自评/自动被教师判定覆盖）
      insert.run(
        "teacher-wrong",
        "done",
        "q4",
        "{}",
        0,
        1,
        1,
        null,
        "wrong",
        null,
        null,
      );
      // 未做判错（#6980-3）：answered=false 仍进分母，不计判对
      insert.run("blank", "done", "q5", "{}", 0, 0, 0, null, null, null, null);
      // 待批：finalCorrect null 且非 reference_self 行（D4 谓词）
      insert.run(
        "pending",
        "done",
        "q6",
        "{}",
        null,
        null,
        1,
        null,
        null,
        null,
        null,
      );
      // 待自评：reference_self 且教师未判且学生未自评
      insert.run(
        "self-pending",
        "done",
        "q7",
        "{}",
        null,
        null,
        1,
        "reference_self",
        null,
        null,
        null,
      );
      // 幽灵行（快照缺失）：不计入任何计数
      insert.run("ghost", "done", "q8", null, 1, 1, 1, null, null, null, null);
      // 草稿行：整卷不产生结果
      insert.run(
        "draft-row",
        "draft",
        "q1",
        "{}",
        1,
        1,
        1,
        null,
        null,
        null,
        null,
      );
      const rows = [
        { id: "done", status: "submitted" as const },
        { id: "draft", status: "draft" as const },
      ];
      expect(attemptResultCounts(db, rows).get("done")).toEqual({
        correctCount: 2,
        totalCount: 7,
        pendingCount: 1,
        pendingSelfReviewCount: 1,
      });
      expect(attemptResultCounts(db, rows).has("draft")).toBe(false);
      // 教师改判自动判对行 → 判对即时回落（判定优先级教师最高）
      db.$client.exec(
        "UPDATE responses SET teacher_mark='wrong', final_correct=0 WHERE id='auto-right'",
      );
      expect(attemptResultCounts(db, rows).get("done")?.correctCount).toBe(1);
      // 待自评行自评「对了」→ 判对 +1、待自评归零（有效判定回落自评）
      db.$client.exec(
        "UPDATE responses SET self_review_verdict='correct', self_review_at='2026-10-25T01:00:00.000Z' WHERE id='self-pending'",
      );
      const after = attemptResultCounts(db, rows).get("done");
      expect(after?.correctCount).toBe(2);
      expect(after?.pendingSelfReviewCount).toBe(0);
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

import type { Question } from "@tutor/contract";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { attempts, responses } from "../db/schema";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils";
import { seedDemoData } from "./seed-demo";

/**
 * 演示种子的判分分布（TASK-f9439bfd 差异清单的数据面）：按「题型 · 行策略 ·
 * 判分结果」计数，锁住种子交卷链路的真实产出，策略口径变化必须在这里显式改
 * 断言，不允许静默漂移。
 */

const SEED_NOW = "2026-11-20T12:00:00.000Z";

type Outcome = "未交" | "教师判" | "自动对" | "自动错" | "待自评" | "教师待批";

function outcomeOf(
  row: typeof responses.$inferSelect,
  status: string,
): Outcome {
  if (status === "draft") return "未交";
  if (row.teacherMark !== null) return "教师判";
  if (row.autoCorrect !== null) return row.autoCorrect ? "自动对" : "自动错";
  return row.gradingPolicy === "reference_self" ? "待自评" : "教师待批";
}

let db: Db;

beforeAll(async () => {
  db = createTestDb();
  await seedDemoData(db, TEST_TEACHER_ID, { now: SEED_NOW });
}, 30_000);

function distribution(): Record<string, number> {
  const rows = db
    .select({ row: responses, status: attempts.status })
    .from(responses)
    .innerJoin(attempts, eq(attempts.id, responses.attemptId))
    .all();
  const counts: Record<string, number> = {};
  for (const { row, status } of rows) {
    const type = (JSON.parse(row.questionSnapshotJson ?? "{}") as Question)
      .type;
    const key = `${type}/${row.gradingPolicy ?? "NULL"}/${outcomeOf(row, status)}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

describe("演示种子判分分布", () => {
  it("已交卷行按开卷冻结的默认策略判分：solve/fill 有参考 → 待自评，客观题照旧", () => {
    expect(distribution()).toEqual({
      "judge/auto/自动对": 8,
      "judge/auto/自动错": 3,
      "choice/auto/自动对": 7,
      "choice/auto/自动错": 4,
      "multi/auto/自动对": 6,
      "fill/reference_self/待自评": 6,
      "solve/reference_self/待自评": 10,
      "solve/reference_self/教师判": 1,
      "judge/auto/未交": 2,
      "choice/auto/未交": 2,
      "multi/auto/未交": 1,
      "fill/reference_self/未交": 1,
      "solve/reference_self/未交": 2,
    });
  });

  it("卷级结果：无教师待批行，11 份已交卷全部 graded，待自评行计分母不计分子", () => {
    const rows = db
      .select({ status: attempts.status, scoreFinal: attempts.scoreFinal })
      .from(attempts)
      .all()
      .filter((row) => row.status !== "draft")
      .map((row) => `${row.status}:${row.scoreFinal ?? "null"}`)
      .sort();
    expect(rows).toEqual([
      "graded:0",
      "graded:20",
      "graded:33",
      "graded:33",
      "graded:40",
      "graded:60",
      "graded:60",
      "graded:60",
      "graded:60",
      "graded:67",
      "graded:67",
    ]);
  });
});

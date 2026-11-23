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
  it("已交卷历史行按空策略造数：solve 走 final 等价比较、fill 进教师待批", () => {
    expect(distribution()).toEqual({
      "judge/NULL/自动对": 8,
      "judge/NULL/自动错": 3,
      "choice/NULL/自动对": 7,
      "choice/NULL/自动错": 4,
      "multi/NULL/自动对": 6,
      "fill/NULL/教师待批": 6,
      "solve/NULL/自动对": 7,
      "solve/NULL/自动错": 1,
      "solve/NULL/教师判": 1,
      "solve/NULL/教师待批": 2,
      "judge/auto/未交": 2,
      "choice/auto/未交": 2,
      "multi/auto/未交": 1,
      "fill/reference_self/未交": 1,
      "solve/reference_self/未交": 2,
    });
  });

  it("卷级结果：3 份 graded（含 solve 自动判对计分）、8 份 submitted 待批", () => {
    const rows = db
      .select({ status: attempts.status, scoreFinal: attempts.scoreFinal })
      .from(attempts)
      .all()
      .filter((row) => row.status !== "draft")
      .map((row) => `${row.status}:${row.scoreFinal ?? "null"}`)
      .sort();
    expect(rows).toEqual([
      "graded:100",
      "graded:100",
      "graded:67",
      ...Array<string>(8).fill("submitted:null"),
    ]);
  });
});

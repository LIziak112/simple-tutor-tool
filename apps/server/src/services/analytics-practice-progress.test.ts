import { analyticsQuerySchema } from "@tutor/contract";
import { and, eq, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { attempts, responses } from "../db/schema";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils";
import { getAnalyticsOverview } from "./analytics-service";
import { type SeedDemoResult, seedDemoData } from "./seed-demo";

/**
 * M4-D3 学情矩阵进行中进度计数（§13）：课程单元格子对 in-progress 的 v1 新协议
 * 草稿卷携带 practiceSubmittedCount / practiceQuestionCount（n/N 纯公开进度
 * 计数白名单，不含对错/得分/答案）；legacy 卷格子缺省（前端回落既有呈现）。
 * 种子复用 seed-demo（李小红 U2 进行中草稿），测试内把该草稿升级为 v1 协议并
 * 直写一行 submittedAt 模拟「逐题已交 1/3」——独立 db 实例，不影响既有矩阵测试。
 */

/** 固定时间基准（与 analytics-service.test.ts 同款周四正午） */
const SEED_NOW = "2026-10-01T04:00:00.000Z";

let db: Db;
let seed: SeedDemoResult;

beforeAll(async () => {
  db = createTestDb();
  seed = await seedDemoData(db, TEST_TEACHER_ID, { now: SEED_NOW });
});

/** 单元列单元格定位（course-unit 判别） */
function unitCellOf(
  overview: ReturnType<typeof getAnalyticsOverview>,
  studentId: string,
  unitId: string,
) {
  const cell = overview.matrix.cells.find(
    (item) =>
      item.kind === "course-unit" &&
      item.studentId === studentId &&
      item.unitId === unitId,
  );
  if (cell === undefined || cell.kind !== "course-unit") {
    throw new Error(`夹具缺少单元单元格：${studentId.slice(0, 8)}/${unitId}`);
  }
  return cell;
}

describe("完成矩阵进行中进度计数（M4-D3）", () => {
  it("v1 in-progress 草稿卷格子携带 n/N；legacy 卷格子缺省", () => {
    // 李小红 U2 课程草稿 → 升级为 v1 协议并直写一行已提交（行级 submittedAt
    // 是 v1 逐题提交的落库事实；直写只造计数输入，不涉及任何答案列）
    const draft = db
      .select()
      .from(attempts)
      .where(
        and(
          eq(attempts.studentId, seed.students.s2.id),
          eq(attempts.unitId, seed.units.u2.id),
          eq(attempts.status, "draft"),
        ),
      )
      .get();
    expect(draft).toBeDefined();
    db.update(attempts)
      .set({ practiceWorkflowVersion: 1, feedbackMode: "per_question" })
      .where(eq(attempts.id, draft?.id ?? ""))
      .run();
    const firstRow = db
      .select({ id: responses.id })
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, draft?.id ?? ""),
          isNull(responses.submittedAt),
        ),
      )
      .get();
    expect(firstRow).toBeDefined();
    db.update(responses)
      .set({ submittedAt: SEED_NOW })
      .where(eq(responses.id, firstRow?.id ?? ""))
      .run();

    const overview = getAnalyticsOverview(
      db,
      TEST_TEACHER_ID,
      analyticsQuerySchema.parse({}),
      SEED_NOW,
    );
    const u2 = unitCellOf(overview, seed.students.s2.id, seed.units.u2.id);
    // U2 共 3 题：已提交 1 行 → n/N = 1/3
    expect(u2.status).toBe("in-progress");
    expect(u2.practiceSubmittedCount).toBe(1);
    expect(u2.practiceQuestionCount).toBe(3);

    // legacy 对照：陈小明 U1（已交卷、旧协议）不带计数
    const u1 = unitCellOf(overview, seed.students.s1.id, seed.units.u1.id);
    expect(u1.status).not.toBe("in-progress");
    expect(u1.practiceSubmittedCount).toBeUndefined();
    expect(u1.practiceQuestionCount).toBeUndefined();
  });
});

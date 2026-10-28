import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import {
  courseItems,
  courseStudents,
  courses,
  responses,
  students,
} from "../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { studentAttemptContext } from "./attempt-context.ts";
import {
  frozenMaterialsForQuestion,
  frozenMaterialsFromRows,
} from "./attempt-question-materials.ts";
import { getAttemptDetail, startCourseAttempt } from "./attempt-service.ts";
import { commitImport } from "./content-service.ts";
import { listAttemptContextSnapshots } from "./material-repository.ts";
import { snapshotOfRow } from "./snapshot.ts";

/**
 * TT-14 细项 5：QM 读写路径的查询数/载荷体积自动化度量（数字回填执行
 * 报告）。计数口径：包一层 db.$client.prepare（drizzle 全部语句经此入口，
 * better-sqlite3 同步执行——计数即语句数）；载荷体积按 JSON.stringify
 * 字节数。断言只锁**结构不变量**（缓存修复前后结果一致、语句数不随题数
 * 线性发散），绝对数字打印进测试输出供报告引用（随数据形态浮动）。
 */

/** 21 题卷：组 5 题（组材料）+ 15 solo 题各带题级 ::ref + 二十空 fill + 长作文 */
const PERF_MD = [
  "---",
  "kind: practice",
  "unit: 性能度量卷",
  "---",
  "",
  "# 性能卷",
  "",
  '::::material{title="组共享长材料"}',
  ...Array.from({ length: 40 }, (_, i) => `组材料第 ${i + 1} 行：数据与结论。`),
  "::::",
  "",
  '::::material{title="题级材料"}',
  "题级引用材料正文。",
  "::::",
  "",
  '::::group{title="资料组"}',
  "::ref{material=mat-性能度量卷-1}",
  ...Array.from({ length: 5 }, (_, i) => `::ref{question=性能度量卷-${i + 1}}`),
  "::::",
  "",
  // 组内 5 题（judge）
  ...Array.from(
    { length: 5 },
    (_, i) =>
      `::::question{type=judge difficulty=1}\n组内第 ${i + 1} 题。[[正确]]\n::::`,
  ),
  // solo 15 题：题级引用
  ...Array.from(
    { length: 14 },
    (_, i) =>
      `::::question{type=solve difficulty=2}\n::ref{material=mat-性能度量卷-2}\nsolo 第 ${i + 1} 题解答。\n::::`,
  ),
  "::::question{type=response difficulty=3 word-min=800 word-max=1200}",
  "::ref{material=mat-性能度量卷-2}",
  "长作文题：结合给定资料，写一篇议论文。",
  "::::",
  "",
  "::::question{type=fill difficulty=2}",
  `${Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 空 [[${i + 1}]]`).join(
    "，",
  )}。`,
  "::::",
].join("\n");

interface PerfEnv {
  db: Db;
  attemptId: string;
  studentId: string;
}

function makeEnv(): PerfEnv {
  const db = createTestDb();
  commitImport(
    db,
    TEST_TEACHER_ID,
    { markdown: PERF_MD, filename: "性能卷.md" },
    undefined,
    undefined,
    true,
  );
  const studentId = "student-qm-perf-1";
  const courseId = "course-qm-perf";
  const unitId = "性能度量卷";
  const now = "2026-10-25T12:00:00.000Z";
  db.insert(students)
    .values({
      id: studentId,
      teacherId: TEST_TEACHER_ID,
      displayName: "性能学生",
      loginName: "qm-perf-stu",
      passwordHash: null,
      linkToken: "link-qm-perf-1",
      linkEnabled: true,
      passwordEnabled: false,
      note: null,
      archivedAt: null,
      createdAt: now,
    })
    .run();
  db.insert(courses)
    .values({
      id: courseId,
      teacherId: TEST_TEACHER_ID,
      title: "性能课程",
      order: 0,
      archivedAt: null,
      description: null,
      createdAt: now,
    })
    .run();
  db.insert(courseItems)
    .values({
      id: randomUUID(),
      courseId,
      kind: "unit",
      refId: unitId,
      title: null,
      order: 0,
      visible: true,
      publishAt: null,
      createdAt: now,
    })
    .run();
  db.insert(courseStudents)
    .values({ courseId, studentId, joinedAt: now })
    .run();
  const started = startCourseAttempt(db, studentId, courseId, unitId, {}, true);
  return { db, attemptId: started.id, studentId };
}

/** 包一层 prepare 计数（drizzle 全部语句经 db.$client.prepare） */
function withPrepareCount<T>(
  db: Db,
  run: () => T,
): { result: T; count: number } {
  const client = db.$client;
  const original = client.prepare.bind(client);
  let count = 0;
  client.prepare = ((...args: Parameters<typeof original>) => {
    count += 1;
    return original(...args);
  }) as typeof client.prepare;
  try {
    return { result: run(), count };
  } finally {
    client.prepare = original;
  }
}

describe("TT-14 细项 5：查询数与载荷体积度量", () => {
  it("studentAttemptContext：多材料卷一次读取的语句数与载荷（报告数字）", () => {
    const env = makeEnv();
    const { result, count } = withPrepareCount(env.db, () =>
      studentAttemptContext(env.db, env.attemptId),
    );
    const snapshotCount = listAttemptContextSnapshots(
      env.db,
      env.attemptId,
    ).length;
    console.log(
      `[qm-perf] studentAttemptContext prepares = ${count}（快照条目 ${snapshotCount}）`,
    );
    console.log(
      `[qm-perf] context 载荷 = ${JSON.stringify(result).length} B（材料 ${result.materials.length} 份 + 组 ${result.groups.length} 个）`,
    );
    // 结构不变量：一次全量读取（语句数不随材料/组数量线性发散）
    expect(count).toBeLessThanOrEqual(snapshotCount + 2);
    expect(result.materials.length).toBe(2);
    expect(result.groups.length).toBe(1);
  });

  it("逐题闭包 O(行×快照)：旧口径每题一次全表读；预取缓存后每 attempt 一次且结果一致（顺手修验证）", () => {
    const env = makeEnv();
    const rows = env.db
      .select()
      .from(responses)
      .where(eq(responses.attemptId, env.attemptId))
      .all();
    expect(rows.length).toBe(21);
    const snapshots = new Map(
      rows.map((row) => [row.questionId, snapshotOfRow(row)] as const),
    );

    // 旧口径（单题便捷入口逐题调用）：每题一次快照表全读（export-service
    // 修复前的实际形态——130 题卷即 130 次）
    const legacy = withPrepareCount(env.db, () =>
      rows.map((row) =>
        frozenMaterialsForQuestion(
          env.db,
          env.attemptId,
          row.questionId,
          snapshots.get(row.questionId) ?? null,
        ),
      ),
    );
    console.log(
      `[qm-perf] 逐题闭包旧口径 prepares = ${legacy.count}（${rows.length} 题 × 每题 1 次快照读）`,
    );
    expect(legacy.count).toBeGreaterThanOrEqual(rows.length);

    // 新口径（export-service 预取缓存 + 纯函数）：每 attempt 一次
    const cached = withPrepareCount(env.db, () => {
      const snapshotRows = listAttemptContextSnapshots(env.db, env.attemptId);
      return rows.map((row) =>
        frozenMaterialsFromRows(
          snapshotRows,
          row.questionId,
          snapshots.get(row.questionId) ?? null,
        ),
      );
    });
    console.log(
      `[qm-perf] 预取缓存口径 prepares = ${cached.count}（单 attempt 1 次快照读，循环内 0 查询）`,
    );
    expect(cached.count).toBeLessThanOrEqual(2);
    // 修复前后结果逐题一致（正确性守卫）
    expect(cached.result).toEqual(legacy.result);
  });

  it("draft 载荷体积：二十空 + 长作文 + 多材料卷（报告数字）", () => {
    const env = makeEnv();
    const { result, count } = withPrepareCount(env.db, () =>
      getAttemptDetail(env.db, env.studentId, env.attemptId),
    );
    const questionCount = (
      result.units as ReadonlyArray<{ questions: readonly unknown[] }>
    ).reduce((sum, unit) => sum + unit.questions.length, 0);
    const bytes = JSON.stringify(result).length;
    console.log(
      `[qm-perf] ${questionCount} 题卷 draft 载荷 = ${bytes} B（读路径 prepares = ${count}）`,
    );
    expect(questionCount).toBe(21);
    expect(bytes).toBeGreaterThan(0);
  });
});

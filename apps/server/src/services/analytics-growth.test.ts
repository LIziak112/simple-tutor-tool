import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { analyticsQuerySchema } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, it, vi } from "vitest";
import { createDb, type Db } from "../db/client";
import { runMigrations } from "../db/migrate";
import { responses, teachers } from "../db/schema";
import {
  createTestDb,
  makeMigrationsFolderUpTo,
  TEST_TEACHER_ID,
} from "../db/test-utils";
import { snapshotJsonOf } from "../test/evidence-fixtures";
import {
  getAnalyticsOverview,
  getAnalyticsQuestions,
  getAnalyticsStudent,
} from "./analytics-service";

const NOW = "2026-10-01T12:00:00.000Z";
const COURSE_ID = "00000000-0000-4000-8000-000000000000";
const COURSE_COUNT = 24;
const STUDENT_COUNT = 60;
const WEEKS = 52;
const QUESTIONS = 20;
const MEASURE_LATENCY = process.env.OWNCLASS_MEASURE_ANALYTICS === "1";

/** 原始 active_sec 夹具是迁移前的历史数据，不能在新卷中伪造活动账。 */
function createHistoricalDb(): Db {
  const db = createDb(":memory:");
  const folder = makeMigrationsFolderUpTo("0068_attempt_settlement_guards");
  try {
    migrate(db, { migrationsFolder: folder });
    db.insert(teachers)
      .values({
        id: TEST_TEACHER_ID,
        loginName: "teacher",
        isAdmin: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
    return db;
  } catch (error) {
    db.$client.close();
    throw error;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** 一年每生每周两卷，每卷 20 题，题库复用同一套题。 */
function seedYear(db: Db): void {
  const client = db.$client;
  client.transaction(() => {
    const course = client.prepare(
      'insert into courses (id, teacher_id, title, "order", created_at) values (?, ?, ?, ?, ?)',
    );
    const item = client.prepare(
      'insert into course_items (id, course_id, kind, ref_id, "order", created_at) values (?, ?, ?, ?, 0, ?)',
    );
    const student = client.prepare(
      "insert into students (id, teacher_id, display_name, login_name, link_token, created_at) values (?, ?, ?, ?, ?, ?)",
    );
    const member = client.prepare(
      "insert into course_students values (?, ?, ?)",
    );
    const question = client.prepare(
      "insert into questions (teacher_id, id, unit_id, \"order\", type, difficulty, stem_md, hints_json, source_md, updated_at) values (?, ?, ?, ?, ?, 2, ?, '[]', ?, ?)",
    );
    const attempt = client.prepare(
      "insert into attempts (id, student_id, source_type, course_id, unit_id, attempt_no, status, started_at, submitted_at, frozen_at) values (?, ?, 'course', ?, ?, ?, 'graded', ?, ?, ?)",
    );
    const response = client.prepare(
      "insert into responses (id, attempt_id, question_id, unit_id, question_snapshot_json, answer_json, active_sec, auto_correct, final_correct, answered) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
    );
    const unitId = "year-unit";
    client
      .prepare(
        'insert into units (teacher_id, id, title, "order", updated_at) values (?, ?, ?, 0, ?)',
      )
      .run(TEST_TEACHER_ID, unitId, "全年题库", NOW);
    const courseIds = Array.from(
      { length: COURSE_COUNT },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    courseIds.forEach((id, i) => {
      course.run(id, TEST_TEACHER_ID, `课程 ${i}`, i, NOW);
      item.run(`item-${i}`, id, "unit", unitId, NOW);
    });
    const fixtures = Array.from({ length: QUESTIONS }, (_, i) => {
      const id = `year-q${i}`;
      question.run(
        TEST_TEACHER_ID,
        id,
        unitId,
        i,
        "judge",
        "判断",
        "判断",
        NOW,
      );
      return [
        id,
        snapshotJsonOf({
          id,
          type: "judge",
          answers: { kind: "judge", value: true },
        }),
      ] as const;
    });
    for (let i = 0; i < STUDENT_COUNT; i++) {
      const id = `student-${i}`;
      student.run(id, TEST_TEACHER_ID, id, id, id, NOW);
      for (const courseId of courseIds) member.run(courseId, id, NOW);
      for (let week = 0; week < WEEKS; week++) {
        const date = new Date(
          Date.parse(NOW) - (WEEKS - week) * 7 * 86400000,
        ).toISOString();
        for (let n = 0; n < 2; n++) {
          const courseIndex = (2 * week + n) % COURSE_COUNT;
          const courseId = courseIds[courseIndex];
          if (courseId === undefined) throw new Error("课程夹具缺失");
          const attemptId = `${id}-${week}-${n}`;
          attempt.run(
            attemptId,
            id,
            courseId,
            unitId,
            1 + Math.floor((2 * week + n) / COURSE_COUNT),
            date,
            date,
            date,
          );
          for (const [questionId, snapshot] of fixtures) {
            const correct = Number((i + week) % 3 !== 0);
            response.run(
              `${attemptId}-${questionId}`,
              attemptId,
              questionId,
              unitId,
              snapshot,
              '{"kind":"judge","value":true}',
              courseIndex === 0 ? 180 : 25 + (i % 10),
              correct,
              correct,
            );
          }
        }
      }
    }
  })();
}

function measure<T>(db: Db, read: () => T) {
  let queries = 0;
  let rows = 0;
  let attemptRows = 0;
  let courseItemQueries = 0;
  let medianQueries = 0;
  const plans = new Set<string>();
  const original = db.$client.prepare.bind(db.$client);
  const prepare = vi.spyOn(db.$client, "prepare").mockImplementation((sql) => {
    queries++;
    if (/from "course_items"/u.test(sql)) courseItemQueries++;
    if (
      /select "question_id", "active_sec" from "responses"/u.test(sql) ||
      /median_input/u.test(sql)
    )
      medianQueries++;
    const statement = original(sql);
    const all = statement.all.bind(statement);
    statement.all = (...params) => {
      const result = all(...params);
      rows += result.length;
      if (
        /median_input|from "attempts" inner join "students"|from "course_items"/u.test(
          sql,
        )
      ) {
        const explain = original(`EXPLAIN QUERY PLAN ${sql}`).all(
          ...params,
        ) as Array<{ detail: string }>;
        for (const row of explain) {
          if (/^(SCAN|SEARCH) /u.test(row.detail)) plans.add(row.detail);
        }
      }
      if (
        /from "attempts" inner join "students"/u.test(sql) &&
        /order by/u.test(sql)
      )
        attemptRows += result.length;
      return result;
    };
    return statement;
  });
  let result: T;
  try {
    result = read();
  } finally {
    prepare.mockRestore();
  }
  // 常规回归验证查询、行量与结果。隔离量测时才重复执行以取延迟分位数。
  const samples = Array.from({ length: MEASURE_LATENCY ? 12 : 0 }, () => {
    const start = performance.now();
    read();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return {
    result,
    queries,
    rows,
    attemptRows,
    courseItemQueries,
    medianQueries,
    plans: [...plans],
    p95Ms: MEASURE_LATENCY
      ? Math.round(samples.at(Math.ceil(samples.length * 0.95) - 1) ?? 0)
      : undefined,
  };
}

it("一年夹具量测学情读取量、课程条目批取与统计一致性", () => {
  const db = createHistoricalDb();
  try {
    seedYear(db);
    runMigrations(db);
    const all = analyticsQuerySchema.parse({ days: "all" });
    const recent = analyticsQuerySchema.parse({
      days: 30,
      courseId: COURSE_ID,
    });
    const measurements = [
      [
        "overview-all",
        measure(db, () => getAnalyticsOverview(db, TEST_TEACHER_ID, all, NOW)),
      ],
      [
        "overview-course",
        measure(db, () =>
          getAnalyticsOverview(db, TEST_TEACHER_ID, recent, NOW),
        ),
      ],
      [
        "student",
        measure(db, () =>
          getAnalyticsStudent(db, TEST_TEACHER_ID, "student-0", all, NOW),
        ),
      ],
      [
        "questions-course",
        measure(db, () =>
          getAnalyticsQuestions(
            db,
            TEST_TEACHER_ID,
            { ...recent, days: "all" },
            NOW,
          ),
        ),
      ],
    ] as const;
    for (const [name, { result, ...metrics }] of measurements) {
      const digest = createHash("sha256")
        .update(JSON.stringify(result))
        .digest("hex");
      console.log(
        "[analytics-year]",
        name,
        JSON.stringify({ ...metrics, digest }),
      );
    }
    const overview = measurements[0][1];
    const course = measurements[1][1];
    const profile = measurements[2][1];
    expect(overview.result.studentCount).toBe(STUDENT_COUNT);
    expect(overview.result.matrix.unitColumns).toHaveLength(COURSE_COUNT);
    expect(course.result.matrix.unitColumns).toHaveLength(1);
    expect(measurements[3][1].result.questions[0]).toMatchObject({
      submittedCount: STUDENT_COUNT,
      anomalyCount: STUDENT_COUNT,
      medianSec: 180,
    });
    expect([
      overview.courseItemQueries,
      overview.medianQueries,
      course.attemptRows,
      profile.attemptRows,
    ]).toEqual([1, 0, STUDENT_COUNT * 5, WEEKS * 2]);
  } finally {
    db.$client.close();
  }
}, 30_000);

it("教师域中位数含重做及窗外样本，偶数取中间两值，写入后即重算", () => {
  const db = createHistoricalDb();
  try {
    const client = db.$client;
    client
      .prepare(
        "insert into students (id, teacher_id, display_name, login_name, link_token, created_at) values ('ours', ?, 'ours', 'ours', 'ours', ?), ('other', 'other-teacher', 'other', 'other', 'other', ?)",
      )
      .run(TEST_TEACHER_ID, NOW, NOW);
    const attempt = client.prepare(
      "insert into attempts (id, student_id, source_type, attempt_no, status, started_at, submitted_at) values (?, ?, ?, ?, ?, ?, ?)",
    );
    const response = client.prepare(
      "insert into responses (id, attempt_id, question_id, question_snapshot_json, active_sec) values (?, ?, ?, ?, ?)",
    );
    const questionId = "median-boundary";
    const snapshot = snapshotJsonOf({ id: questionId });
    for (const [id, student, source, no, status, date, sec] of [
      ["recent", "ours", "assignment", 1, "graded", NOW, 100],
      ["old", "ours", "course", 2, "graded", "2025-10-01T12:00:00.000Z", 10],
      ["redo", "ours", "wrong", 3, "graded", NOW, 20],
      ["another", "ours", "wrong", 1, "graded", NOW, 30],
      ["draft", "ours", "wrong", 1, "draft", NOW, 1000],
      ["other", "other", "wrong", 1, "graded", NOW, 1000],
    ] as const) {
      attempt.run(id, student, source, no, status, date, date);
      response.run(id, id, questionId, snapshot, sec);
    }
    runMigrations(db);
    const read = () =>
      getAnalyticsStudent(
        db,
        TEST_TEACHER_ID,
        "ours",
        analyticsQuerySchema.parse({ days: 1 }),
        NOW,
      ).anomalies;
    expect(read()).toMatchObject([
      { attemptId: "recent", medianSec: 25, reasons: ["slow"] },
    ]);
    db.update(responses)
      .set({ activeSec: 120 })
      .where(
        and(
          eq(responses.attemptId, "redo"),
          eq(responses.questionId, questionId),
        ),
      )
      .run();
    expect(read()).toEqual([]);
  } finally {
    db.$client.close();
  }
});

it("课程筛选对旧作业卷回退作业归属，显式卷归属优先", () => {
  const db = createTestDb();
  try {
    const client = db.$client;
    const second = "00000000-0000-4000-8000-000000000001";
    const addCourse = client.prepare(
      'insert into courses (id, teacher_id, title, "order", created_at) values (?, ?, ?, 0, ?)',
    );
    for (const id of [COURSE_ID, second])
      addCourse.run(id, TEST_TEACHER_ID, id, NOW);
    client
      .prepare(
        "insert into assignments (id, teacher_id, course_id, title, created_at, deleted_at) values ('work', ?, ?, '历史作业', ?, ?)",
      )
      .run(TEST_TEACHER_ID, COURSE_ID, NOW, NOW);
    client
      .prepare(
        "insert into students (id, teacher_id, display_name, login_name, link_token, created_at) values ('ours', ?, 'ours', 'ours', 'ours', ?)",
      )
      .run(TEST_TEACHER_ID, NOW);
    const insertAttempt = client.prepare(
      "insert into attempts (id, student_id, source_type, assignment_id, course_id, status, started_at, submitted_at) values (?, 'ours', 'assignment', 'work', ?, 'graded', ?, ?)",
    );
    const insertResponse = client.prepare(
      "insert into responses (id, attempt_id, question_id, question_snapshot_json) values (?, ?, ?, ?)",
    );
    for (const [id, courseId] of [
      ["old", null],
      ["explicit", second],
    ] as const) {
      insertAttempt.run(id, courseId, NOW, NOW);
      insertResponse.run(id, id, id, snapshotJsonOf({ id }));
    }
    const list = (courseId: string) =>
      getAnalyticsQuestions(
        db,
        TEST_TEACHER_ID,
        analyticsQuerySchema.parse({ courseId }),
        NOW,
      ).questions.map(({ questionId }) => questionId);
    expect(list(COURSE_ID)).toEqual(["old"]);
    expect(list(second)).toEqual(["explicit"]);
  } finally {
    db.$client.close();
  }
});

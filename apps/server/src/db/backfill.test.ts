import { asc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { runBackfills } from "./backfill.ts";
import { createDb, type Db } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import {
  appSettings,
  assignmentStudents,
  assignments,
  assignmentUnits,
  attempts,
  courseItems,
  courseStudents,
  courses,
  dataMigrations,
  events,
  lectures,
  libraryFolders,
  responses,
  students,
  teachers,
  units,
} from "./schema.ts";
import {
  createTestDb,
  makeMigrationsFolderUpTo,
  TEST_TEACHER_ID,
} from "./test-utils.ts";

/**
 * D23 数据搬迁测试（T2A.1 验收项）：「T2A 前结构」fixture 库 → 迁移 → 回填 → 断言。
 *
 * 旧库构造方式：把真实迁移目录截断到指定边界迁移复制到临时目录，
 * 用 drizzle 官方 migrator 建出旧结构（journal 记录完整，随后 runMigrations 只补
 * 边界之后的迁移）；fixture 数据用原生 SQL 插入（此时新 schema 的 drizzle 插入
 * 会带新列，对旧表不适用）。fixture 规模按任务要求：2 课程、3 讲义、4 单元、
 * 2 学生、1 作业、1 已交卷 attempt。
 *
 * T2A.7（D23-5）用 T2A.6 时代结构（边界 0012）另建 fixture，见下方独立 describe。
 */

/** T2A 前最后一个迁移的 tag（此后均为 Phase 2A 结构变更） */
const PRE_T2A_LAST_TAG = "0008_curved_hex";
/** T2A.7 前最后一个迁移的 tag（T2A.6 时代：attempts 已带来源列，作业仍单单元） */
const PRE_T2A7_LAST_TAG = "0012_aromatic_piledriver";
/** T2B 前最后一个迁移的 tag（T2A.9 完成态；T2B.1 在此之上加多教师基础结构） */
const PRE_T2B_LAST_TAG = "0015_oval_franklin_storm";

/** 建「T2A 前结构」内存库（只应用 0000–0008） */
function createPreT2aDb(): Db {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: makeMigrationsFolderUpTo(PRE_T2A_LAST_TAG) });
  return db;
}

/** 建「T2A.6 时代结构」内存库（只应用 0000–0012，T2A.7 结构变更之前） */
function createPreT2a7Db(): Db {
  const db = createDb(":memory:");
  migrate(db, {
    migrationsFolder: makeMigrationsFolderUpTo(PRE_T2A7_LAST_TAG),
  });
  return db;
}

/** 建「T2B 前结构」内存库（只应用 0000–0015，T2B.1 结构变更之前） */
function createPreT2bDb(): Db {
  const db = createDb(":memory:");
  migrate(db, {
    migrationsFolder: makeMigrationsFolderUpTo(PRE_T2B_LAST_TAG),
  });
  return db;
}

/** fixture 数据（原生 SQL，对旧结构插行）。固定时间戳保证断言可重复。 */
function insertPreT2aFixture(db: Db): void {
  const t = "2026-01-15T10:00:00.000Z";
  db.$client.exec(`
    INSERT INTO courses (id, title, "order", created_at) VALUES
      ('c-a', '初一上', 0, '${t}'),
      ('c-b', '初一下', 1, '${t}');
    INSERT INTO lectures (id, course_id, title, markdown, "order", updated_at) VALUES
      ('l-a1', 'c-a', '第一讲 有理数', '# 第一讲 有理数', 0, '${t}'),
      ('l-a2', 'c-a', '第二讲 数轴',   '# 第二讲 数轴',   1, '${t}'),
      ('l-b1', 'c-b', '第三讲 绝对值', '# 第三讲 绝对值', 0, '${t}');
    INSERT INTO units (id, course_id, lecture_id, title, "order", updated_at) VALUES
      ('u-a1', 'c-a', 'l-a1', '有理数练习一', 0, '${t}'),
      ('u-a2', 'c-a', 'l-a1', '有理数练习二', 1, '${t}'),
      ('u-a3', 'c-a', NULL,   '随堂小测',     2, '${t}'),
      ('u-b1', 'c-b', 'l-b1', '绝对值练习',   0, '${t}');
    INSERT INTO questions (id, unit_id, "order", type, difficulty, stem_md, hints_json, source_md, version, updated_at) VALUES
      ('q-a1-1', 'u-a1', 0, 'judge', 1, '题干1', '[]', '::::question\n::::', 1, '${t}'),
      ('q-a1-2', 'u-a1', 1, 'judge', 1, '题干2', '[]', '::::question\n::::', 1, '${t}'),
      ('q-a2-1', 'u-a2', 0, 'judge', 1, '题干3', '[]', '::::question\n::::', 1, '${t}'),
      ('q-a3-1', 'u-a3', 0, 'judge', 1, '题干4', '[]', '::::question\n::::', 1, '${t}'),
      ('q-b1-1', 'u-b1', 0, 'judge', 1, '题干5', '[]', '::::question\n::::', 1, '${t}');
    INSERT INTO students (id, display_name, login_name, link_token, link_enabled, password_enabled, archived_at, created_at) VALUES
      ('s-1', '张三', '张三', 'tok-1', 1, 0, NULL, '${t}'),
      ('s-2', '李四', '李四', 'tok-2', 1, 0, '${t}', '${t}');
    INSERT INTO assignments (id, unit_id, title, created_at) VALUES
      ('as-1', 'u-a1', '有理数作业一', '${t}');
    INSERT INTO attempts (id, student_id, assignment_id, unit_id, status, started_at, submitted_at) VALUES
      ('at-1', 's-1', 'as-1', 'u-a1', 'submitted', '${t}', '${t}');
  `);
}

/** 完整走一遍生产启动流程：runMigrations（补 0009+）→ runBackfills */
function migrateAndBackfill(db: Db): void {
  runMigrations(db);
  runBackfills(db, new Date("2026-09-27T00:00:00.000Z"));
}

/** 某课程目录条目按 order 展开（refId + kind + visible），便于断言顺序与可见性 */
function itemTuples(db: Db, courseId: string): [string, string, boolean][] {
  return db
    .select({
      refId: courseItems.refId,
      kind: courseItems.kind,
      visible: courseItems.visible,
      order: courseItems.order,
    })
    .from(courseItems)
    .where(eq(courseItems.courseId, courseId))
    .orderBy(asc(courseItems.order))
    .all()
    .map((row) => [row.refId ?? "", row.kind, row.visible]);
}

describe("D23 数据搬迁（T2A 前结构 fixture → 迁移 → 回填）", () => {
  it("步骤 1：每个课程建同名文件夹，讲义/单元 folderId 指向该文件夹", () => {
    const db = createPreT2aDb();
    insertPreT2aFixture(db);
    migrateAndBackfill(db);

    const folders = db
      .select()
      .from(libraryFolders)
      .orderBy(asc(libraryFolders.order))
      .all();
    expect(folders.map((f) => f.name)).toEqual(["初一上", "初一下"]);
    const [folderA, folderB] = folders;

    const lectureRows = db.select().from(lectures).all();
    for (const row of lectureRows) {
      expect(row.folderId).toBe(
        row.id.startsWith("l-a") ? folderA?.id : folderB?.id,
      );
    }
    const unitRows = db.select().from(units).all();
    for (const row of unitRows) {
      expect(row.folderId).toBe(
        row.id.startsWith("u-a") ? folderA?.id : folderB?.id,
      );
    }
    // 旧列保留：courseId 值原样（@deprecated T2A，不删不写）
    expect(
      lectureRows.every(
        (row) => row.courseId === "c-a" || row.courseId === "c-b",
      ),
    ).toBe(true);
    expect(
      unitRows.every((row) => row.courseId === "c-a" || row.courseId === "c-b"),
    ).toBe(true);
    // 新列默认值
    expect(lectureRows.every((row) => row.deletedAt === null)).toBe(true);
    expect(unitRows.every((row) => row.deletedAt === null)).toBe(true);
  });

  it("步骤 2+3：目录顺序 = 讲义后跟配套单元；讲义可见、单元隐藏", () => {
    const db = createPreT2aDb();
    insertPreT2aFixture(db);
    migrateAndBackfill(db);

    // 初一上：l-a1 → u-a1、u-a2（配套，按单元原顺序）→ l-a2 → u-a3（无配套，追加末尾）
    expect(itemTuples(db, "c-a")).toEqual([
      ["l-a1", "lecture", true],
      ["u-a1", "unit", false],
      ["u-a2", "unit", false],
      ["l-a2", "lecture", true],
      ["u-a3", "unit", false],
    ]);
    // 初一下：l-b1 → u-b1
    expect(itemTuples(db, "c-b")).toEqual([
      ["l-b1", "lecture", true],
      ["u-b1", "unit", false],
    ]);
    // 唯一约束落位：(courseId, kind, refId) 无重复
    expect(itemTuples(db, "c-a").length).toBe(
      new Set(itemTuples(db, "c-a")).size,
    );
  });

  it("步骤 4：所有未归档学生加入所有课程；已归档学生不入课", () => {
    const db = createPreT2aDb();
    insertPreT2aFixture(db);
    migrateAndBackfill(db);

    const members = db
      .select()
      .from(courseStudents)
      .orderBy(asc(courseStudents.courseId), asc(courseStudents.studentId))
      .all();
    expect(members.map((m) => [m.courseId, m.studentId])).toEqual([
      ["c-a", "s-1"],
      ["c-b", "s-1"],
    ]);
    expect(
      members.every((m) => m.joinedAt === "2026-09-27T00:00:00.000Z"),
    ).toBe(true);
    expect(members.some((m) => m.studentId === "s-2")).toBe(false);
  });

  it("已有作答与作业完好；外键完整性通过", () => {
    const db = createPreT2aDb();
    insertPreT2aFixture(db);
    migrateAndBackfill(db);

    const attempt = db.select().from(attempts).get();
    expect(attempt).toMatchObject({
      id: "at-1",
      studentId: "s-1",
      assignmentId: "as-1",
      unitId: "u-a1",
      status: "submitted",
    });
    const assignment = db.select().from(assignments).get();
    expect(assignment).toMatchObject({
      id: "as-1",
      unitId: "u-a1",
      title: "有理数作业一",
    });
    expect(
      db.select({ id: courseItems.id }).from(courseItems).all().length,
    ).toBe(7);
    expect(db.$client.pragma("foreign_key_check")).toHaveLength(0);
  });

  it("幂等：重复执行 runBackfills（乃至重复 runMigrations）无重复数据", () => {
    const db = createPreT2aDb();
    insertPreT2aFixture(db);
    migrateAndBackfill(db);

    // 再跑一遍完整启动流程（迁移幂等 + 回填标记防重跑）
    runMigrations(db);
    runBackfills(db, new Date("2026-09-28T00:00:00.000Z"));

    expect(db.select().from(libraryFolders).all()).toHaveLength(2);
    expect(db.select().from(courseItems).all()).toHaveLength(7);
    expect(db.select().from(courseStudents).all()).toHaveLength(2);
    // joinedAt 不被第二次执行改写（标记命中，整个回填被跳过）
    expect(
      db
        .select()
        .from(courseStudents)
        .all()
        .every((m) => m.joinedAt === "2026-09-27T00:00:00.000Z"),
    ).toBe(true);
    // 标记表：各回填键各一行，appliedAt 仍是首次时间戳
    expect(db.select().from(dataMigrations).all()).toEqual([
      {
        key: "t2a1_library_courses_backfill",
        appliedAt: "2026-09-27T00:00:00.000Z",
      },
      {
        key: "t2a6_attempts_source_backfill",
        appliedAt: "2026-09-27T00:00:00.000Z",
      },
      {
        key: "t2a7_assignments_backfill",
        appliedAt: "2026-09-27T00:00:00.000Z",
      },
      {
        key: "t2b1_multi_teacher_backfill",
        appliedAt: "2026-09-27T00:00:00.000Z",
      },
      {
        key: "t2b6_app_settings_init",
        appliedAt: "2026-09-27T00:00:00.000Z",
      },
      {
        key: "t32a_grading_semantics_backfill",
        appliedAt: "2026-09-27T00:00:00.000Z",
      },
      {
        key: "t40a_events_backfill",
        appliedAt: "2026-09-27T00:00:00.000Z",
      },
    ]);
  });

  it("步骤 6（T2A.6，D23-6）：旧 attempts 全部 sourceType=assignment、attemptNo=1，原值保留", () => {
    const db = createPreT2aDb();
    insertPreT2aFixture(db);
    migrateAndBackfill(db);

    const attempt = db.select().from(attempts).get();
    expect(attempt).toMatchObject({
      id: "at-1",
      sourceType: "assignment",
      attemptNo: 1,
      // assignmentId/unitId 原值保留（旧作业 attempt 的 unitId 即当时那份作业的单元）
      assignmentId: "as-1",
      unitId: "u-a1",
      // courseId 由 T2A.7 回填（D23-5）：取作业单元 u-a1 的 legacy 课程 c-a
      courseId: "c-a",
    });

    // 幂等：标记防重跑后，后续新建的 course 作答（attemptNo 递增）不被回填触碰
    db.insert(attempts)
      .values({
        id: "at-course",
        studentId: "s-1",
        sourceType: "course",
        assignmentId: null,
        courseId: "c-a",
        unitId: "u-a2",
        attemptNo: 3,
        status: "draft",
        startedAt: "2026-09-28T00:00:00.000Z",
        submittedAt: null,
        activeSec: null,
        device: null,
        scoreAuto: null,
        scoreFinal: null,
      })
      .run();
    runBackfills(db, new Date("2026-09-29T00:00:00.000Z"));
    const after = db
      .select()
      .from(attempts)
      .where(eq(attempts.id, "at-course"))
      .get();
    expect(after).toMatchObject({ sourceType: "course", attemptNo: 3 });
  });

  it("全新空库（createTestDb 路径）：回填无数据可搬，仅写标记；结构即最终态", () => {
    const db = createTestDb();
    expect(db.select().from(libraryFolders).all()).toEqual([]);
    expect(db.select().from(courseItems).all()).toEqual([]);
    expect(db.select().from(courseStudents).all()).toEqual([]);
    expect(db.select().from(dataMigrations).all()).toHaveLength(7);
    // 全新库再跑一次同样幂等
    runBackfills(db);
    expect(db.select().from(dataMigrations).all()).toHaveLength(7);
  });
});

// ---------- D23-5：作业多单元与名单结构回填（T2A.7） ----------

/**
 * T2A.6 时代结构的 fixture（原生 SQL 插行，表结构 = 0000–0012）：
 * 2 课程、2 单元（legacy courseId 一非 NULL（c-a）一 NULL）、2 学生、
 * 2 作业（as-1 单元属 c-a、as-2 单元无课程）、各指派 1–2 学生、
 * 1 份已交卷 assignment attempt（courseId 为 NULL，T2A.6 时代口径）。
 */
function insertPreT2a7Fixture(db: Db): void {
  const t1 = "2026-02-10T08:00:00.000Z";
  const t2 = "2026-02-12T08:00:00.000Z";
  db.$client.exec(`
    INSERT INTO courses (id, title, "order", created_at) VALUES
      ('c-a', '初一上', 0, '${t1}');
    INSERT INTO units (id, course_id, lecture_id, title, "order", updated_at) VALUES
      ('u-a1', 'c-a', NULL, '有理数练习一', 0, '${t1}'),
      ('u-b1', NULL,  NULL, '随堂补练',     0, '${t1}');
    INSERT INTO students (id, display_name, login_name, link_token, link_enabled, password_enabled, archived_at, created_at) VALUES
      ('s-1', '张三', '张三', 'tok-1', 1, 0, NULL, '${t1}'),
      ('s-2', '李四', '李四', 'tok-2', 1, 0, NULL, '${t1}');
    INSERT INTO assignments (id, unit_id, title, created_at) VALUES
      ('as-1', 'u-a1', '有理数作业一', '${t1}'),
      ('as-2', 'u-b1', '随堂补练作业', '${t2}');
    INSERT INTO assignment_students (assignment_id, student_id) VALUES
      ('as-1', 's-1'),
      ('as-1', 's-2'),
      ('as-2', 's-1');
    INSERT INTO attempts (id, student_id, assignment_id, unit_id, status, started_at, submitted_at) VALUES
      ('at-1', 's-1', 'as-1', 'u-a1', 'submitted', '${t2}', '${t2}');
  `);
}

describe("D23-5 作业结构搬迁（T2A.6 时代结构 fixture → 迁移 → 回填）", () => {
  it("每个作业写入 assignment_units 一行 order=0；unitId 原值保留", () => {
    const db = createPreT2a7Db();
    insertPreT2a7Fixture(db);
    migrateAndBackfill(db);

    const rows = db
      .select()
      .from(assignmentUnits)
      .orderBy(asc(assignmentUnits.assignmentId))
      .all();
    expect(rows).toEqual([
      { assignmentId: "as-1", unitId: "u-a1", order: 0 },
      { assignmentId: "as-2", unitId: "u-b1", order: 0 },
    ]);
    // 旧列保留：unitId 值原样（@deprecated T2A，不删不写）
    const assignmentRows = db
      .select()
      .from(assignments)
      .orderBy(asc(assignments.id))
      .all();
    expect(assignmentRows.map((row) => [row.id, row.unitId])).toEqual([
      ["as-1", "u-a1"],
      ["as-2", "u-b1"],
    ]);
  });

  it("courseId 取单元 legacy 课程：有课程写课程 id，无课程保持 null", () => {
    const db = createPreT2a7Db();
    insertPreT2a7Fixture(db);
    migrateAndBackfill(db);

    const courseById = db
      .select({ id: assignments.id, courseId: assignments.courseId })
      .from(assignments)
      .all()
      .map((row) => [row.id, row.courseId] as const);
    expect(courseById).toEqual([
      ["as-1", "c-a"], // u-a1 的 legacy courseId = c-a
      ["as-2", null], // u-b1 无 legacy 课程 → 保持 null
    ]);
  });

  it("assignment_students.addedAt 补作业 createdAt；removedAt 全 null", () => {
    const db = createPreT2a7Db();
    insertPreT2a7Fixture(db);
    migrateAndBackfill(db);

    const rows = db
      .select()
      .from(assignmentStudents)
      .orderBy(
        asc(assignmentStudents.assignmentId),
        asc(assignmentStudents.studentId),
      )
      .all();
    expect(
      rows.map((row) => [
        row.assignmentId,
        row.studentId,
        row.addedAt,
        row.removedAt,
      ]),
    ).toEqual([
      // addedAt = 各自作业的 createdAt（as-1 建于 t1、as-2 建于 t2）
      ["as-1", "s-1", "2026-02-10T08:00:00.000Z", null],
      ["as-1", "s-2", "2026-02-10T08:00:00.000Z", null],
      ["as-2", "s-1", "2026-02-12T08:00:00.000Z", null],
    ]);
  });

  it("旧作业 attempt 的 courseId 回填为所属作业课程（D9 语义）；外键完整性通过", () => {
    const db = createPreT2a7Db();
    insertPreT2a7Fixture(db);
    migrateAndBackfill(db);

    const attempt = db.select().from(attempts).get();
    expect(attempt).toMatchObject({
      id: "at-1",
      sourceType: "assignment",
      courseId: "c-a", // as-1 的课程
      assignmentId: "as-1",
      unitId: "u-a1",
    });
    expect(db.$client.pragma("foreign_key_check")).toHaveLength(0);
  });

  it("幂等：重复执行 runBackfills 无重复数据、值不漂移", () => {
    const db = createPreT2a7Db();
    insertPreT2a7Fixture(db);
    migrateAndBackfill(db);

    runMigrations(db);
    runBackfills(db, new Date("2026-09-28T00:00:00.000Z"));

    // assignment_units 仍各 1 行、order 不漂移
    expect(db.select().from(assignmentUnits).all()).toEqual([
      { assignmentId: "as-1", unitId: "u-a1", order: 0 },
      { assignmentId: "as-2", unitId: "u-b1", order: 0 },
    ]);
    // courseId / addedAt / attempts.courseId 均不被第二次执行改写
    const courseById = db
      .select({ id: assignments.id, courseId: assignments.courseId })
      .from(assignments)
      .all()
      .map((row) => [row.id, row.courseId] as const);
    expect(courseById).toEqual([
      ["as-1", "c-a"],
      ["as-2", null],
    ]);
    expect(
      db
        .select()
        .from(assignmentStudents)
        .all()
        .every((row) => row.addedAt !== null && row.removedAt === null),
    ).toBe(true);
    expect(db.select().from(attempts).get()?.courseId).toBe("c-a");
    // 标记 appliedAt 仍是首次时间戳
    expect(db.select().from(dataMigrations).all()).toHaveLength(7);
    expect(
      db
        .select()
        .from(dataMigrations)
        .all()
        .every((row) => row.appliedAt === "2026-09-27T00:00:00.000Z"),
    ).toBe(true);
  });

  it("标记命中后，T2A.7 新形态数据（多单元作业/移出名单行）不被回填触碰", () => {
    const db = createPreT2a7Db();
    insertPreT2a7Fixture(db);
    migrateAndBackfill(db);

    // 模拟 T2A.7 服务写入的新形态：unitId=NULL 的多单元作业、名单行带 removedAt
    const t3 = "2026-03-01T08:00:00.000Z";
    db.insert(assignments)
      .values({
        id: "as-3",
        unitId: null,
        courseId: "c-a",
        title: "两单元作业",
        dueAt: null,
        deletedAt: null,
        createdAt: t3,
      })
      .run();
    db.insert(assignmentUnits)
      .values([
        { assignmentId: "as-3", unitId: "u-a1", order: 0 },
        { assignmentId: "as-3", unitId: "u-b1", order: 1 },
      ])
      .run();
    db.insert(assignmentStudents)
      .values({
        assignmentId: "as-3",
        studentId: "s-2",
        addedAt: t3,
        removedAt: t3,
      })
      .run();

    runBackfills(db, new Date("2026-09-29T00:00:00.000Z"));

    // 新形态原样：不加 assignment_units 行、不移除 removedAt、courseId 不动
    expect(
      db
        .select()
        .from(assignmentUnits)
        .where(eq(assignmentUnits.assignmentId, "as-3"))
        .all(),
    ).toHaveLength(2);
    const row = db
      .select()
      .from(assignmentStudents)
      .where(eq(assignmentStudents.assignmentId, "as-3"))
      .get();
    expect(row).toMatchObject({ addedAt: t3, removedAt: t3 });
    expect(
      db.select().from(assignments).where(eq(assignments.id, "as-3")).get()
        ?.courseId,
    ).toBe("c-a");
  });
});

// ---------- T2B.1：多教师基础结构迁移（D9/D10/D11） ----------

/**
 * T2B 前结构（T2A.9 完成态）fixture（原生 SQL 插行，表结构 = 0000–0015）。
 * 规模按任务要求：2 课程、3 讲义、4 单元、2 学生、1 多单元作业、2 已交卷 attempt。
 * 与 pre-T2A/pre-T2A7 fixture 不同：本 fixture 预置 t2a 系列回填标记（模拟
 * 「已跑过 Phase 2A 回填的生产库升级到 T2B.1」这一真实路径），数据即 post-T2A 形态
 * （folderId 直接落位、作业走 assignment_units、名单行带 addedAt）。
 */
function insertPreT2bFixture(db: Db): void {
  const t0 = "2026-01-10T08:00:00.000Z";
  const t1 = "2026-02-10T08:00:00.000Z";
  const t2 = "2026-02-12T08:00:00.000Z";
  db.$client.exec(`
    -- 已跑过 Phase 2A 回填的标记（本 fixture 数据即回填后形态）
    INSERT INTO data_migrations (key, applied_at) VALUES
      ('t2a1_library_courses_backfill', '${t0}'),
      ('t2a6_attempts_source_backfill', '${t0}'),
      ('t2a7_assignments_backfill', '${t0}');
    -- 唯一教师行（密码已设置；id/createdAt 固定便于断言「升级不动这三列」）
    INSERT INTO teachers (id, password_hash, api_token, created_at) VALUES
      ('th-1', 'scrypt$模拟哈希', NULL, '${t0}');
    INSERT INTO library_folders (id, name, "order", created_at) VALUES
      ('f-a', '初一上', 0, '${t0}'),
      ('f-b', '初一下', 1, '${t0}');
    INSERT INTO courses (id, title, "order", archived_at, description, created_at) VALUES
      ('c-a', '初一上', 0, NULL, NULL, '${t0}'),
      ('c-b', '初一下', 1, NULL, '下学期', '${t0}');
    INSERT INTO lectures (id, course_id, folder_id, title, markdown, "order", updated_at, deleted_at) VALUES
      ('l-a1', NULL, 'f-a', '第一讲 有理数', '# 第一讲 有理数', 0, '${t0}', NULL),
      ('l-a2', NULL, 'f-a', '第二讲 数轴',   '# 第二讲 数轴',   1, '${t0}', NULL),
      ('l-b1', NULL, 'f-b', '第三讲 绝对值', '# 第三讲 绝对值', 0, '${t0}', '${t1}');
    INSERT INTO units (id, course_id, folder_id, lecture_id, title, topic, "order", updated_at, deleted_at) VALUES
      ('u-a1', NULL, 'f-a', 'l-a1', '有理数练习一', '有理数', 0, '${t0}', NULL),
      ('u-a2', NULL, 'f-a', 'l-a1', '有理数练习二', NULL,    1, '${t0}', NULL),
      ('u-a3', NULL, 'f-a', NULL,   '随堂小测',     NULL,    2, '${t0}', NULL),
      ('u-b1', NULL, 'f-b', 'l-b1', '绝对值练习',   NULL,    0, '${t0}', NULL);
    INSERT INTO questions (id, unit_id, "order", type, difficulty, stem_md, options_json, answers_json, hints_json, solution_md, source_md, version, updated_at, deleted_at) VALUES
      ('q-a1-1', 'u-a1', 0, 'judge', 1, '题干1 [[正确]]', NULL, '{"kind":"judge","value":true}', '["提示A"]', '详解1', '::::question{type=judge}\n题干1 [[正确]]\n::::', 2, '${t1}', NULL),
      ('q-a1-2', 'u-a1', 1, 'fill',  2, '计算：__(-3)+7=$__ 4', NULL, NULL, '[]', NULL, '::::question{type=fill}\n::::', 1, '${t0}', NULL),
      ('q-a2-1', 'u-a2', 0, 'judge', 1, '题干3 [[错误]]', NULL, '{"kind":"judge","value":false}', '[]', NULL, '::::question{type=judge}\n题干3 [[错误]]\n::::', 1, '${t0}', NULL),
      ('q-a3-1', 'u-a3', 0, 'judge', 1, '题干4 [[正确]]', NULL, '{"kind":"judge","value":true}', '[]', NULL, '::::question{type=judge}\n题干4 [[正确]]\n::::', 1, '${t0}', '${t1}'),
      ('q-b1-1', 'u-b1', 0, 'judge', 1, '题干5 [[正确]]', NULL, '{"kind":"judge","value":true}', '[]', NULL, '::::question{type=judge}\n题干5 [[正确]]\n::::', 1, '${t0}', NULL);
    INSERT INTO knowledge_points (id, name) VALUES
      ('kp-1', '一元一次方程'),
      ('kp-2', '有理数');
    INSERT INTO question_knowledge (question_id, knowledge_point_id) VALUES
      ('q-a1-1', 'kp-1'),
      ('q-a1-1', 'kp-2'),
      ('q-a2-1', 'kp-1'),
      ('q-b1-1', 'kp-2');
    INSERT INTO imports (id, filename, kind, raw_md, report_json, source_path, batch_id, folder_id, created_at) VALUES
      ('im-1', '练习.md', 'practice', '# 原文', '{}', 'chapter1/练习.md', 'batch-1', 'f-a', '${t1}');
    INSERT INTO students (id, display_name, login_name, password_hash, link_token, link_enabled, password_enabled, note, archived_at, created_at) VALUES
      ('s-1', '张三', '张三', 'scrypt$学生哈希', 'tok-1', 1, 1, NULL, NULL, '${t0}'),
      ('s-2', '李四', '李四', NULL,             'tok-2', 1, 0, '备注', NULL, '${t0}');
    INSERT INTO assignments (id, unit_id, course_id, title, due_at, answer_release, deleted_at, created_at) VALUES
      ('as-1', NULL, 'c-a', '综合练习一', '${t2}', 'on_submit', NULL, '${t1}');
    INSERT INTO assignment_units (assignment_id, unit_id, "order") VALUES
      ('as-1', 'u-a1', 0),
      ('as-1', 'u-a2', 1);
    INSERT INTO assignment_students (assignment_id, student_id, added_at, removed_at) VALUES
      ('as-1', 's-1', '${t1}', NULL),
      ('as-1', 's-2', '${t1}', NULL);
    INSERT INTO course_items (id, course_id, kind, ref_id, title, "order", visible, publish_at, created_at) VALUES
      ('ci-1', 'c-a', 'lecture', 'l-a1', NULL,      0, 1, NULL, '${t0}'),
      ('ci-2', 'c-a', 'unit',    'u-a1', NULL,      1, 0, NULL, '${t0}'),
      ('ci-3', 'c-b', 'section', NULL,    '第一节', 0, 1, '${t1}', '${t0}');
    INSERT INTO course_students (course_id, student_id, joined_at) VALUES
      ('c-a', 's-1', '${t0}');
    INSERT INTO attempts (id, student_id, source_type, assignment_id, course_id, unit_id, attempt_no, status, started_at, submitted_at, active_sec, device, score_auto, score_final) VALUES
      -- T3.2a 判分口径回填后的一致形态：at-1 = 1 可判分全对（r-1）、1 待批（r-2）
      -- → scoreAuto=100、submitted；at-2 = 教师改判对（r-3 teacherMark=correct，
      -- finalCorrect=1）→ scoreAuto=0（自动判错）、scoreFinal=100、graded
      ('at-1', 's-1', 'assignment', 'as-1', 'c-a', 'u-a1', 1, 'submitted', '${t1}', '${t1}', 120, 'iPad', 100, NULL),
      ('at-2', 's-2', 'assignment', 'as-1', 'c-a', NULL,   1, 'graded',    '${t2}', '${t2}', 90,  NULL,   0, 100);
    INSERT INTO responses (id, attempt_id, question_id, question_version, question_snapshot_json, answer_json, auto_correct, final_correct, teacher_mark, teacher_comment, active_sec, hints_used, hints_opened_json, change_count, ink_id) VALUES
      ('r-1', 'at-1', 'q-a1-1', 2, '{"id":"q-a1-1"}', '{"kind":"judge","value":true}',  1, 1,    NULL, NULL, 30, 1, '[0]', 2, NULL),
      ('r-2', 'at-1', 'q-a1-2', 1, '{"id":"q-a1-2"}', NULL,                              NULL, NULL, NULL, NULL, 0,  0, NULL,  0, 'ink-1'),
      ('r-3', 'at-2', 'q-a1-1', 2, '{"id":"q-a1-1"}', '{"kind":"judge","value":false}', 0,    1,    'correct', '很好', 30, 0, NULL,  1, NULL);
    INSERT INTO ink (id, attempt_id, question_id, strokes_path, png_path, width, height, stroke_count, updated_at) VALUES
      ('ink-1', 'at-1', 'q-a1-2', 'blobs/ink/at-1/q.json.gz', 'blobs/ink/at-1/q.png', 800, 600, 12, '${t1}');
  `);
}

/** 迁移涉及的全部业务表（teachers 单独断言：升级会改行，不进保真对比） */
const PRE_T2B_TABLES = [
  "library_folders",
  "courses",
  "lectures",
  "units",
  "questions",
  "knowledge_points",
  "question_knowledge",
  "imports",
  "students",
  "assignments",
  "assignment_units",
  "assignment_students",
  "course_items",
  "course_students",
  "attempts",
  "responses",
  "ink",
] as const;

/**
 * 全库业务表快照（键排序 + 行排序，剔除 teacher_id 列）：
 * 迁移只允许加 teacherId / 改主键 / 去外键，任何既有列的值都不得变化
 * （任务要求「单元/题目数据与关联一字不差」，这里以全表逐行对比覆盖）。
 */
function snapshotBusinessTables(db: Db): Map<string, string[]> {
  const snapshot = new Map<string, string[]>();
  for (const table of PRE_T2B_TABLES) {
    const rows = (
      db.$client.prepare(`SELECT * FROM ${table}`).all() as Array<
        Record<string, unknown>
      >
    ).map((row) => {
      delete row.teacher_id; // 新增归属列不参与保真对比
      // 迁移新增列（带默认值/可空）同理不参与保真对比——本测试断言的是存量
      // 数据不丢不坏，新增列见 schema/migrate 测试：T6R.3 的 frozen_at /
      // legacy_unverified（attempts）与 unit_id（**仅 responses**——0023 新增；
      // attempts.unit_id 是 T2A.6 既有列，必须保留在对比内）
      delete row.frozen_at;
      delete row.legacy_unverified;
      if (table === "responses") delete row.unit_id;
      return JSON.stringify(row, Object.keys(row).sort());
    });
    snapshot.set(table, rows.sort());
  }
  return snapshot;
}

describe("T2B.1 多教师基础结构迁移（post-T2A 结构 fixture → 迁移 → 回填）", () => {
  it("结构变更：units/questions 复合主键生效、D10 外键全部去除（foreign_key_check 通过）", () => {
    const db = createPreT2bDb();
    insertPreT2bFixture(db);
    migrateAndBackfill(db);

    // 迁移后的建表 SQL 里不再有指向 units/questions 的外键（D10 核对清单）
    const ddl = (
      db.$client
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN ('questions','units','question_knowledge','assignments','assignment_units','attempts','responses','ink')",
        )
        .all() as Array<{ sql: string }>
    )
      .map((row) => row.sql)
      .join("\n");
    expect(ddl).not.toMatch(/REFERENCES\s+`?units`?\s*\(/i);
    expect(ddl).not.toMatch(/REFERENCES\s+`?questions`?\s*\(/i);
    expect(db.$client.pragma("foreign_key_check")).toHaveLength(0);

    // units：同 (teacherId, id) 拒绝重复；同 id 不同 teacherId 合法（D10 目标形态，
    // 用全新 id 验证约束本身——fixture 行的 teacherId 由回填写入，属下一组断言）
    expect(() =>
      db.$client
        .prepare(
          `INSERT INTO units (id, teacher_id, folder_id, lecture_id, title, topic, "order", updated_at, deleted_at)
           VALUES ('u-dup', 'th-1', NULL, NULL, '甲的单元', NULL, 0, '2026-01-01T00:00:00.000Z', NULL)`,
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      db.$client
        .prepare(
          `INSERT INTO units (id, teacher_id, folder_id, lecture_id, title, topic, "order", updated_at, deleted_at)
           VALUES ('u-dup', 'th-1', NULL, NULL, '甲的重复单元', NULL, 0, '2026-01-01T00:00:00.000Z', NULL)`,
        )
        .run(),
    ).toThrow();
    db.$client
      .prepare(
        `INSERT INTO units (id, teacher_id, folder_id, lecture_id, title, topic, "order", updated_at, deleted_at)
         VALUES ('u-dup', 'th-2', NULL, NULL, '乙的同名单元', NULL, 0, '2026-01-01T00:00:00.000Z', NULL)`,
      )
      .run();
    // questions：同 id 不同 teacherId 合法；question_knowledge 主键含 teacherId
    db.$client
      .prepare(
        `INSERT INTO questions (id, teacher_id, unit_id, "order", type, difficulty, stem_md, options_json, answers_json, hints_json, solution_md, source_md, version, updated_at, deleted_at)
         VALUES ('q-dup', 'th-1', 'u-dup', 0, 'judge', 1, '甲的题干', NULL, NULL, '[]', NULL, '::::question\n::::', 1, '2026-01-01T00:00:00.000Z', NULL)`,
      )
      .run();
    db.$client
      .prepare(
        `INSERT INTO questions (id, teacher_id, unit_id, "order", type, difficulty, stem_md, options_json, answers_json, hints_json, solution_md, source_md, version, updated_at, deleted_at)
         VALUES ('q-dup', 'th-2', 'u-dup', 0, 'judge', 1, '乙的题干', NULL, NULL, '[]', NULL, '::::question\n::::', 1, '2026-01-01T00:00:00.000Z', NULL)`,
      )
      .run();
    db.$client
      .prepare(
        "INSERT INTO question_knowledge (teacher_id, question_id, knowledge_point_id) VALUES ('th-2', 'q-dup', 'kp-1')",
      )
      .run();
    db.$client.close();
  });

  it("数据保真：全部业务表逐行一字不差（仅新增 teacherId 列）", () => {
    const db = createPreT2bDb();
    insertPreT2bFixture(db);
    const before = snapshotBusinessTables(db);
    migrateAndBackfill(db);
    const after = snapshotBusinessTables(db);
    for (const table of PRE_T2B_TABLES) {
      expect(after.get(table)).toEqual(before.get(table));
    }
    db.$client.close();
  });

  it("回填：唯一教师行升级（loginName/isAdmin，密码 id createdAt 不动）；全部根行 teacherId 正确且无 NULL", () => {
    const db = createPreT2bDb();
    insertPreT2bFixture(db);
    migrateAndBackfill(db);

    // D4 升级：只动 loginName/isAdmin，其余列原样
    expect(db.select().from(teachers).all()).toEqual([
      {
        id: "th-1",
        loginName: "teacher",
        isAdmin: true,
        disabledAt: null,
        passwordHash: "scrypt$模拟哈希",
        apiToken: null,
        createdAt: "2026-01-10T08:00:00.000Z",
      },
    ]);

    // 9 张根表全部行 teacherId = 'th-1' 且无 NULL（D9）
    const rootTables = [
      "students",
      "courses",
      "library_folders",
      "lectures",
      "units",
      "questions",
      "imports",
      "assignments",
      "question_knowledge",
    ] as const;
    for (const table of rootTables) {
      const nullCount = db.$client
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE teacher_id IS NULL`)
        .get() as { n: number };
      expect(nullCount.n, table).toBe(0);
      const wrongCount = db.$client
        .prepare(
          `SELECT count(*) AS n FROM ${table} WHERE teacher_id <> 'th-1'`,
        )
        .get() as { n: number };
      expect(wrongCount.n, table).toBe(0);
    }
    // 复合主键语义在回填后对既有行生效：(th-1, 'u-a1') 已存在 → 重复插入被拒
    expect(() =>
      db.$client
        .prepare(
          `INSERT INTO units (id, teacher_id, folder_id, lecture_id, title, topic, "order", updated_at, deleted_at)
           VALUES ('u-a1', 'th-1', NULL, NULL, '重复单元', NULL, 0, '2026-03-02T00:00:00.000Z', NULL)`,
        )
        .run(),
    ).toThrow();
    db.$client.close();
  });

  it("pre-T2A 库升级路径：t2a1 建的文件夹同获 teacherId 回填", () => {
    const db = createPreT2aDb();
    db.$client.exec(`
      INSERT INTO teachers (id, password_hash, api_token, created_at) VALUES
        ('th-old', 'scrypt$模拟哈希', NULL, '2026-01-01T00:00:00.000Z');
    `);
    insertPreT2aFixture(db);
    migrateAndBackfill(db);

    // t2a1 本次运行新建「初一上/初一下」文件夹 → t2b1 回填 teacherId
    const folders = db.select().from(libraryFolders).all();
    expect(folders.map((f) => [f.name, f.teacherId])).toEqual([
      ["初一上", "th-old"],
      ["初一下", "th-old"],
    ]);
    expect(db.select().from(teachers).get()).toMatchObject({
      id: "th-old",
      loginName: "teacher",
      isAdmin: true,
    });
    db.$client.close();
  });

  it("带 FK 的子表迁移后照常写入：交卷写 responses、上传笔迹写 ink 不报 foreign key mismatch", () => {
    const db = createPreT2bDb();
    insertPreT2bFixture(db);
    migrateAndBackfill(db);

    // 交卷补写 responses（含快照与判分）；上传笔迹写 ink——外键已去除，
    // 若有残留指向 questions 的 FK 会在此抛 foreign key mismatch
    db.$client
      .prepare(
        "INSERT INTO responses (id, attempt_id, question_id, question_version, question_snapshot_json, answer_json, auto_correct, final_correct, teacher_mark, teacher_comment, active_sec, hints_used, hints_opened_json, change_count, ink_id) VALUES ('r-new', 'at-1', 'q-a2-1', 1, '{\"id\":\"q-a2-1\"}', '{\"kind\":\"judge\",\"value\":false}', 0, NULL, NULL, NULL, 10, 0, NULL, 0, NULL)",
      )
      .run();
    db.$client
      .prepare(
        `INSERT INTO ink (id, attempt_id, question_id, strokes_path, png_path, width, height, stroke_count, updated_at)
         VALUES ('ink-new', 'at-2', 'q-a1-1', 'blobs/ink/at-2/q.json.gz', 'blobs/ink/at-2/q.png', 800, 600, 5, '2026-03-01T00:00:00.000Z')`,
      )
      .run();
    // 作业补单元（assignment_units 同为重建子表）
    db.$client
      .prepare(
        "INSERT INTO assignment_units (assignment_id, unit_id, \"order\") VALUES ('as-1', 'u-b1', 2)",
      )
      .run();
    expect(
      db.$client.prepare("SELECT count(*) AS n FROM responses").get(),
    ).toMatchObject({ n: 4 });
    db.$client.close();
  });

  it("幂等：重复执行 runMigrations + runBackfills 无重复数据、值不漂移", () => {
    const db = createPreT2bDb();
    insertPreT2bFixture(db);
    migrateAndBackfill(db);
    const countsBefore = new Map(
      PRE_T2B_TABLES.map((table) => {
        const row = db.$client
          .prepare(`SELECT count(*) AS n FROM ${table}`)
          .get() as { n: number };
        return [table, row.n] as const;
      }),
    );

    runMigrations(db);
    runBackfills(db, new Date("2026-09-28T00:00:00.000Z"));

    for (const table of PRE_T2B_TABLES) {
      const row = db.$client
        .prepare(`SELECT count(*) AS n FROM ${table}`)
        .get() as { n: number };
      expect(row.n).toBe(countsBefore.get(table));
    }
    expect(db.$client.pragma("foreign_key_check")).toHaveLength(0);
    db.$client.close();
  });
});

describe("T2B.6 app_settings 初始键回填（D8：allowRegistration='true'）", () => {
  /** T2B.6 前最后一个迁移的 tag（T2B.5 完成态；T2B.6 在此之上建 app_settings） */
  const PRE_T2B6_LAST_TAG = "0017_light_ulik";

  /** 建「T2B.6 前结构」内存库（不含 app_settings 表） */
  function createPreT2b6Db(): Db {
    const db = createDb(":memory:");
    migrate(db, {
      migrationsFolder: makeMigrationsFolderUpTo(PRE_T2B6_LAST_TAG),
    });
    return db;
  }

  it("存量库升级：建出 app_settings 表并插入 allowRegistration='true'（默认开）", () => {
    const db = createPreT2b6Db();
    // 升级前无 app_settings 表（原生 SQL 探测，避免 drizzle 类型依赖新结构）
    expect(() =>
      db.$client.prepare("SELECT * FROM app_settings").all(),
    ).toThrow();
    migrateAndBackfill(db);

    expect(db.select().from(appSettings).all()).toEqual([
      { key: "allowRegistration", value: "true" },
    ]);
    db.$client.close();
  });

  it("全新库（createTestDb 同款全量流程）：键存在且为 'true'", () => {
    const db = createTestDb();
    expect(
      db
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, "allowRegistration"))
        .get(),
    ).toEqual({ key: "allowRegistration", value: "true" });
    db.$client.close();
  });

  it("幂等且不覆盖管理员改动：改 'false' 后重启不回弹；标记行丢失也不覆盖", () => {
    const db = createTestDb();
    // 管理员关闭注册
    db.update(appSettings)
      .set({ value: "false" })
      .where(eq(appSettings.key, "allowRegistration"))
      .run();

    // 重启（标记已存在 → 跳过）
    runBackfills(db, new Date("2026-09-30T00:00:00.000Z"));
    expect(
      db
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, "allowRegistration"))
        .get()?.value,
    ).toBe("false");

    // 极端情形：标记行丢失（库被手工改过）→ onConflictDoNothing 兜底仍不覆盖
    db.delete(dataMigrations)
      .where(eq(dataMigrations.key, "t2b6_app_settings_init"))
      .run();
    runBackfills(db, new Date("2026-09-30T00:00:00.000Z"));
    expect(
      db
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, "allowRegistration"))
        .get()?.value,
    ).toBe("false");
    // 标记重新写入，且表中仍只有一行
    expect(
      db
        .select()
        .from(dataMigrations)
        .where(eq(dataMigrations.key, "t2b6_app_settings_init"))
        .all(),
    ).toHaveLength(1);
    expect(db.select().from(appSettings).all()).toHaveLength(1);
    db.$client.close();
  });
});

describe("孤儿资源兜底（T2A.1 事故修复：与主标记无关、每次启动执行、幂等）", () => {
  /**
   * 复现事故形态：正常搬迁完成后（标记已存在），「新迁移+回填已执行、导入仍旧版
   * 写法」的中间态服务写入了只带 courseId、不带 folderId、无 course_items 条目的
   * 讲义/单元（旧版导入不建条目）。另造齐各边界对照行。
   */
  function seedOrphans(db: Db): void {
    const t = "2026-09-27T03:00:00.000Z";
    // 事故孤儿：courseId 指向现有课程、folderId NULL、未软删、无条目
    db.insert(lectures)
      .values({
        id: "l-x1",
        courseId: "c-a",
        title: "事故讲义一",
        markdown: "# 一",
        order: 5,
        updatedAt: t,
      })
      .run();
    db.insert(units)
      .values({
        id: "u-x1",
        courseId: "c-a",
        lectureId: null,
        title: "事故单元",
        order: 3,
        updatedAt: t,
      })
      .run();
    // 对照：courseId 指向不存在的课程 → 不兜底
    db.insert(lectures)
      .values({
        id: "l-x2",
        courseId: "c-zombie",
        title: "僵尸课程讲义",
        markdown: "# 二",
        order: 6,
        updatedAt: t,
      })
      .run();
    // 对照：已软删 → 不兜底
    db.insert(lectures)
      .values({
        id: "l-x3",
        courseId: "c-a",
        title: "已删孤儿",
        markdown: "# 三",
        order: 7,
        updatedAt: t,
        deletedAt: t,
      })
      .run();
    // 对照：folderId NULL 但该课程已有条目（如教师后来主动移入未归类）→ 整体跳过
    db.insert(lectures)
      .values({
        id: "l-x4",
        courseId: "c-a",
        title: "有条目孤儿",
        markdown: "# 四",
        order: 8,
        updatedAt: t,
      })
      .run();
    db.insert(courseItems)
      .values({
        id: crypto.randomUUID(),
        courseId: "c-a",
        kind: "lecture",
        refId: "l-x4",
        title: null,
        order: 99, // 放末尾，避免与既有条目 order 冲突影响断言排序
        visible: true,
        publishAt: null,
        createdAt: t,
      })
      .run();
    // 对照：文件夹不存在的新课程（兜底需现场建同名文件夹）
    db.insert(courses)
      .values({ id: "c-new", title: "新课程", order: 5, createdAt: t })
      .run();
    db.insert(lectures)
      .values({
        id: "l-x5",
        courseId: "c-new",
        title: "新课程讲义",
        markdown: "# 五",
        order: 9,
        updatedAt: t,
      })
      .run();
  }

  /** 讲义/单元行按 id 快照（folderId 映射），用于断言「原有数据不动」 */
  function folderIdByLecture(db: Db): Map<string, string | null> {
    return new Map(
      db
        .select({ id: lectures.id, folderId: lectures.folderId })
        .from(lectures)
        .all()
        .map((row) => [row.id, row.folderId] as const),
    );
  }

  it("标记已存在 + 孤儿讲义/单元 → 补 folderId 与条目（讲义可见/单元隐藏），原有数据不动", () => {
    const db = createPreT2aDb();
    insertPreT2aFixture(db);
    migrateAndBackfill(db);
    seedOrphans(db);
    const before = folderIdByLecture(db);

    // 主标记已存在：这次 runBackfills 只会走孤儿兜底（模拟下一次启动）
    runBackfills(db, new Date("2026-09-28T00:00:00.000Z"));

    const folderA = db
      .select()
      .from(libraryFolders)
      .where(eq(libraryFolders.name, "初一上"))
      .get();
    // 事故孤儿被补齐：folderId + 条目（讲义 visible=true、单元 visible=false，接末尾）
    expect(folderIdByLecture(db).get("l-x1")).toBe(folderA?.id);
    expect(itemTuples(db, "c-a")).toEqual([
      ["l-a1", "lecture", true],
      ["u-a1", "unit", false],
      ["u-a2", "unit", false],
      ["l-a2", "lecture", true],
      ["u-a3", "unit", false],
      ["l-x4", "lecture", true], // 对照条目原样（兜底未动它，也未补 folderId）
      ["l-x1", "lecture", true], // 事故孤儿补齐：接末尾
      ["u-x1", "unit", false],
    ]);
    // 新课程的孤儿：现场建同名文件夹并补齐
    const folderNew = db
      .select()
      .from(libraryFolders)
      .where(eq(libraryFolders.name, "新课程"))
      .get();
    expect(folderNew).toBeDefined();
    expect(folderIdByLecture(db).get("l-x5")).toBe(folderNew?.id);
    expect(itemTuples(db, "c-new")).toEqual([["l-x5", "lecture", true]]);

    // 对照行全部不动：僵尸课程、已软删、条目已存在（连 folderId 也不改）
    expect(folderIdByLecture(db).get("l-x2")).toBeNull();
    expect(folderIdByLecture(db).get("l-x3")).toBeNull();
    expect(folderIdByLecture(db).get("l-x4")).toBeNull();
    // 原有讲义 folderId 原样
    for (const [id, folderId] of before) {
      if (id !== "l-x1" && id !== "l-x5") {
        expect(folderIdByLecture(db).get(id)).toBe(folderId);
      }
    }
    // 原有目录、成员、标记不动（joinedAt/appliedAt 仍是首次时间戳）
    expect(itemTuples(db, "c-b")).toEqual([
      ["l-b1", "lecture", true],
      ["u-b1", "unit", false],
    ]);
    expect(
      db
        .select()
        .from(courseStudents)
        .all()
        .every((m) => m.joinedAt === "2026-09-27T00:00:00.000Z"),
    ).toBe(true);
    expect(db.select().from(dataMigrations).all()).toEqual([
      {
        key: "t2a1_library_courses_backfill",
        appliedAt: "2026-09-27T00:00:00.000Z",
      },
      {
        key: "t2a6_attempts_source_backfill",
        appliedAt: "2026-09-27T00:00:00.000Z",
      },
      {
        key: "t2a7_assignments_backfill",
        appliedAt: "2026-09-27T00:00:00.000Z",
      },
      {
        key: "t2b1_multi_teacher_backfill",
        appliedAt: "2026-09-27T00:00:00.000Z",
      },
      {
        key: "t2b6_app_settings_init",
        appliedAt: "2026-09-27T00:00:00.000Z",
      },
      {
        key: "t32a_grading_semantics_backfill",
        appliedAt: "2026-09-27T00:00:00.000Z",
      },
      {
        key: "t40a_events_backfill",
        appliedAt: "2026-09-27T00:00:00.000Z",
      },
    ]);
  });

  it("兜底幂等：重复执行结果一致（无重复文件夹/条目/改写）", () => {
    const db = createPreT2aDb();
    insertPreT2aFixture(db);
    migrateAndBackfill(db);
    seedOrphans(db);
    runBackfills(db, new Date("2026-09-28T00:00:00.000Z"));

    const foldersAfterFirst = db.select().from(libraryFolders).all();
    const itemsAfterFirst = db.select().from(courseItems).all();
    const lecturesAfterFirst = folderIdByLecture(db);

    runBackfills(db, new Date("2026-09-29T00:00:00.000Z"));

    expect(db.select().from(libraryFolders).all()).toEqual(foldersAfterFirst);
    expect(db.select().from(courseItems).all()).toEqual(itemsAfterFirst);
    expect(folderIdByLecture(db)).toEqual(lecturesAfterFirst);
  });

  it("对已正常搬迁的库跑兜底：零改动", () => {
    const db = createPreT2aDb();
    insertPreT2aFixture(db);
    migrateAndBackfill(db);

    const folders = db.select().from(libraryFolders).all();
    const items = db.select().from(courseItems).all();
    const members = db.select().from(courseStudents).all();
    const lectureFolderIds = folderIdByLecture(db);
    const unitFolderIds = new Map(
      db
        .select({ id: units.id, folderId: units.folderId })
        .from(units)
        .all()
        .map((row) => [row.id, row.folderId] as const),
    );

    runBackfills(db, new Date("2026-09-29T00:00:00.000Z"));

    expect(db.select().from(libraryFolders).all()).toEqual(folders);
    expect(db.select().from(courseItems).all()).toEqual(items);
    expect(db.select().from(courseStudents).all()).toEqual(members);
    expect(folderIdByLecture(db)).toEqual(lectureFolderIds);
    expect(
      new Map(
        db
          .select({ id: units.id, folderId: units.folderId })
          .from(units)
          .all()
          .map((row) => [row.id, row.folderId] as const),
      ),
    ).toEqual(unitFolderIds);
    expect(db.select().from(dataMigrations).all()).toHaveLength(7);
  });
});

// ---------- T3.2a：判分口径存量回填（D1/D2/D3） ----------

/**
 * 契约 questionSchema 合法形态的题目快照（判分输入以 responses.
 * questionSnapshotJson 为准——与交卷时同源）。
 */
function snapshotJson(question: {
  id: string;
  type: string;
  answers?: unknown;
  options?: unknown;
}): string {
  return JSON.stringify({
    id: question.id,
    type: question.type,
    difficulty: 1,
    knowledge: ["考点"],
    stemMd: "题干",
    ...(question.options !== undefined ? { options: question.options } : {}),
    ...(question.answers !== undefined ? { answers: question.answers } : {}),
    hints: [],
    sourceMd: "原文",
  });
}

/** 回填测试用的题目快照（choice 可判 / multi 全对答案 / fill 单空 / solve 无标准答案） */
const SNAPSHOTS = {
  choice: snapshotJson({
    id: "bg-q1",
    type: "choice",
    options: [{ text: "A" }, { text: "B" }],
    answers: { kind: "choice", index: 1 },
  }),
  multi: snapshotJson({
    id: "bg-q2",
    type: "multi",
    options: [{ text: "A" }, { text: "B" }, { text: "C" }],
    answers: { kind: "multi", indexes: [0, 2] },
  }),
  fill: snapshotJson({
    id: "bg-q3",
    type: "fill",
    answers: { kind: "fill", blanks: [["8"]] },
  }),
  /** solve 未给标准答案（无 :::answer）——判 null 进待批，不受 D1 影响 */
  solveNoAnswer: snapshotJson({ id: "bg-q4", type: "solve" }),
} as const;

/**
 * 旧口径构造一份 attempt + responses（T3.2a 之前的交卷形态：
 * finalCorrect 恒 null；未作答客观题 autoCorrect=null 而非 false）。
 * 返回 attemptId。responses 形态由调用方逐行传入。
 */
function seedLegacyAttempt(
  db: Db,
  attempt: { id: string; status: string; scoreAuto: number | null },
  rows: {
    id: string;
    questionId: string;
    snapshot: string | null;
    answerJson: string | null;
    autoCorrect: boolean | null;
  }[],
): void {
  db.insert(attempts)
    .values({
      id: attempt.id,
      studentId: "bg-s1",
      sourceType: "course",
      assignmentId: null,
      courseId: null,
      unitId: "bg-u1",
      attemptNo: 1,
      status: attempt.status as "draft" | "submitted" | "graded",
      startedAt: "2026-09-01T00:00:00.000Z",
      submittedAt:
        attempt.status === "draft" ? null : "2026-09-01T00:10:00.000Z",
      activeSec: null,
      device: null,
      scoreAuto: attempt.scoreAuto,
      scoreFinal: null,
    })
    .run();
  for (const row of rows) {
    db.insert(responses)
      .values({
        id: row.id,
        attemptId: attempt.id,
        questionId: row.questionId,
        questionVersion: 1,
        questionSnapshotJson: row.snapshot,
        answerJson: row.answerJson,
        autoCorrect: row.autoCorrect,
        finalCorrect: null, // 旧口径：交卷从不写 finalCorrect
        teacherMark: null,
        teacherComment: null,
        activeSec: null,
        hintsUsed: 0,
        changeCount: 0,
        inkId: null,
      })
      .run();
  }
}

/** 回填测试的最小前置：学生 + 单元（表 FK 需要；题目本体不参与——判分只看快照） */
function seedBackfillFixture(db: Db): void {
  db.insert(students)
    .values({
      id: "bg-s1",
      teacherId: TEST_TEACHER_ID,
      displayName: "回填学生",
      loginName: "bg-s1",
      passwordHash: null,
      linkToken: "bg-tok",
      createdAt: "2026-09-01T00:00:00.000Z",
    })
    .run();
}

/**
 * 模拟「T3.2a 前的旧库升级」：createTestDb 已把空库标记跑完，先摘掉 t32a
 * 标记再 runBackfills，让判分回填真正作用于刚构造的旧口径数据。
 */
function runGradingBackfill(db: Db): void {
  db.delete(dataMigrations)
    .where(eq(dataMigrations.key, "t32a_grading_semantics_backfill"))
    .run();
  runBackfills(db, new Date("2026-09-30T00:00:00.000Z"));
}

describe("T3.2a 判分口径回填（旧口径已交 attempt → D1/D2/D3 重算）", () => {
  it("未作答客观题重判 false、finalCorrect 写回、scoreAuto 分母变化、status/scoreFinal 按 D2；快照缺失跳过保留原值；draft 不动", () => {
    const db = createTestDb();
    seedBackfillFixture(db);
    // 旧口径已交卷：choice 答对（1/1 → scoreAuto=100）+ 单选未作答（旧判 null）+
    // solve 已答无标准答案（null）+ 判断题快照缺失（当年判对，防御行）。
    // （D1「未作答客观题重判 false」的题位原为填空——2026-10-02 fill 全人工批改
    // 起未作答 fill 亦为 null，改用未作答单选保住该断言；fill 的新口径见幂等用例）
    seedLegacyAttempt(
      db,
      { id: "bg-at1", status: "submitted", scoreAuto: 100 },
      [
        {
          id: "bg-r1",
          questionId: "bg-q1",
          snapshot: SNAPSHOTS.choice,
          answerJson: JSON.stringify({ kind: "choice", index: 1 }),
          autoCorrect: true,
        },
        {
          id: "bg-r2",
          questionId: "bg-q6",
          snapshot: SNAPSHOTS.choice.replace("bg-q1", "bg-q6"),
          answerJson: null,
          autoCorrect: null,
        },
        {
          id: "bg-r3",
          questionId: "bg-q4",
          snapshot: SNAPSHOTS.solveNoAnswer,
          answerJson: JSON.stringify({ kind: "final", finalAnswer: "略" }),
          autoCorrect: null,
        },
        {
          id: "bg-r4",
          questionId: "bg-q9",
          snapshot: null, // 快照缺失：跳过重判、保留原值
          answerJson: JSON.stringify({ kind: "judge", value: true }),
          autoCorrect: true,
        },
      ],
    );
    // 对照：draft 的 responses 不被回填触碰
    seedLegacyAttempt(db, { id: "bg-atd", status: "draft", scoreAuto: null }, [
      {
        id: "bg-rd",
        questionId: "bg-q3",
        snapshot: null,
        answerJson: JSON.stringify({ kind: "fill", values: ["8"] }),
        autoCorrect: null,
      },
    ]);

    runGradingBackfill(db);

    const rowOf = (id: string) =>
      db.select().from(responses).where(eq(responses.id, id)).get();
    // choice 答对：autoCorrect 不变，finalCorrect 按 D3 写回
    expect(rowOf("bg-r1")).toMatchObject({
      autoCorrect: true,
      finalCorrect: true,
    });
    // D1 核心：未作答单选由 null 重判 false，finalCorrect 同步写 false
    expect(rowOf("bg-r2")).toMatchObject({
      autoCorrect: false,
      finalCorrect: false,
    });
    // 无标准答案 solve：仍 null/null（题目侧判定优先，进待批）
    expect(rowOf("bg-r3")).toMatchObject({
      autoCorrect: null,
      finalCorrect: null,
    });
    // 快照缺失：autoCorrect 保留原值 true，finalCorrect = teacherMark ?? autoCorrect
    expect(rowOf("bg-r4")).toMatchObject({
      autoCorrect: true,
      finalCorrect: true,
    });
    // draft 行原样（未交卷不判分）
    expect(rowOf("bg-rd")).toMatchObject({
      autoCorrect: null,
      finalCorrect: null,
    });

    // attempt 级：scoreAuto 分母变化（旧 1/1=100 → 新 2/3=67，未作答单选进分母）；
    // 存在待批（solve）→ 保持 submitted、scoreFinal=null（D2）
    const attempt = db
      .select()
      .from(attempts)
      .where(eq(attempts.id, "bg-at1"))
      .get();
    expect(attempt).toMatchObject({
      status: "submitted",
      scoreAuto: 67,
      scoreFinal: null,
    });
    expect(
      db.select().from(attempts).where(eq(attempts.id, "bg-atd")).get()?.status,
    ).toBe("draft");
    db.$client.close();
  });

  it("全客观题卷：回填后 graded 且 scoreFinal = round(对/全部题)（D2）；多选空选重判 false", () => {
    const db = createTestDb();
    seedBackfillFixture(db);
    // 旧口径：multi 答对 + multi 空选（旧判 null 不进分母 → scoreAuto=100、submitted）
    seedLegacyAttempt(
      db,
      { id: "bg-at2", status: "submitted", scoreAuto: 100 },
      [
        {
          id: "bg-r5",
          questionId: "bg-q2",
          snapshot: SNAPSHOTS.multi,
          answerJson: JSON.stringify({ kind: "multi", indexes: [0, 2] }),
          autoCorrect: true,
        },
        {
          id: "bg-r6",
          questionId: "bg-q5",
          snapshot: SNAPSHOTS.multi.replace("bg-q2", "bg-q5"),
          answerJson: JSON.stringify({ kind: "multi", indexes: [] }),
          autoCorrect: null,
        },
      ],
    );

    runGradingBackfill(db);

    // D1：多选空选（学生选后又全部取消）重判 false
    expect(
      db.select().from(responses).where(eq(responses.id, "bg-r6")).get(),
    ).toMatchObject({ autoCorrect: false, finalCorrect: false });
    // 全部 finalCorrect 非 null → graded；scoreFinal = round(1/2×100) = 50（D2）
    const attempt = db
      .select()
      .from(attempts)
      .where(eq(attempts.id, "bg-at2"))
      .get();
    expect(attempt).toMatchObject({
      status: "graded",
      scoreAuto: 50,
      scoreFinal: 50,
    });
    db.$client.close();
  });

  it("幂等：重复执行（标记防重跑 / 标记丢失后重跑）结果不变", () => {
    const db = createTestDb();
    seedBackfillFixture(db);
    seedLegacyAttempt(
      db,
      { id: "bg-at3", status: "submitted", scoreAuto: 100 },
      [
        {
          id: "bg-r7",
          questionId: "bg-q1",
          snapshot: SNAPSHOTS.choice,
          answerJson: JSON.stringify({ kind: "choice", index: 0 }), // 答错
          autoCorrect: false,
        },
        {
          id: "bg-r8",
          questionId: "bg-q3",
          snapshot: SNAPSHOTS.fill,
          answerJson: null,
          autoCorrect: null,
        },
      ],
    );

    runGradingBackfill(db);
    const afterFirst = {
      responses: db.select().from(responses).all(),
      attempts: db.select().from(attempts).all(),
    };
    // fill 未作答重判 null（2026-10-02 起 fill 全人工批改，未作答亦进待批）→
    // 存在待批 → submitted、scoreFinal=null；唯一可判题（choice）答错 → scoreAuto=0
    expect(
      afterFirst.attempts.find((row) => row.id === "bg-at3"),
    ).toMatchObject({ status: "submitted", scoreAuto: 0, scoreFinal: null });

    // ① 标记命中：整体跳过
    runBackfills(db, new Date("2026-10-01T00:00:00.000Z"));
    expect(db.select().from(responses).all()).toEqual(afterFirst.responses);
    expect(db.select().from(attempts).all()).toEqual(afterFirst.attempts);

    // ② 极端情形：标记行丢失（库被手工改过）→ 重算确定性，结果不变
    db.delete(dataMigrations)
      .where(eq(dataMigrations.key, "t32a_grading_semantics_backfill"))
      .run();
    runBackfills(db, new Date("2026-10-01T00:00:00.000Z"));
    expect(db.select().from(responses).all()).toEqual(afterFirst.responses);
    expect(db.select().from(attempts).all()).toEqual(afterFirst.attempts);
    db.$client.close();
  });
});

// ---------- T4.0a：events 表 studentId / lectureId 存量回填（D8） ----------

/** T4.0a 前最后一个迁移的 tag（0019 为 events 加列迁移） */
const PRE_T4_0A_LAST_TAG = "0018_young_vivisector";

/** 建「T4.0a 前结构」内存库（events 无 student_id/lecture_id 列） */
function createPreT40aDb(): Db {
  const db = createDb(":memory:");
  migrate(db, {
    migrationsFolder: makeMigrationsFolderUpTo(PRE_T4_0A_LAST_TAG),
  });
  return db;
}

/**
 * T4.0a 前形态 fixture（原生 SQL）：1 学生 + 1 attempt + 1 讲义，
 * 事件覆盖三类——attempt 上下文 3 条（studentId 待按 attempt 回填，其中
 * page_hidden 无题目语义）、无 attempt 的 lecture_expand 2 条（lectureId
 * 待从 payload 回填、studentId 无法归属保留 NULL）。
 */
function insertPreT40aFixture(db: Db): void {
  const t = "2026-03-01T08:00:00.000Z";
  db.$client.exec(`
    INSERT INTO students (id, teacher_id, display_name, login_name, link_token, link_enabled, password_enabled, archived_at, created_at) VALUES
      ('s-1', '${TEST_TEACHER_ID}', '张三', '张三', 'tok-1', 1, 0, NULL, '${t}');
    INSERT INTO attempts (id, student_id, source_type, assignment_id, course_id, unit_id, attempt_no, status, started_at, submitted_at, active_sec, device, score_auto, score_final) VALUES
      ('at-1', 's-1', 'assignment', NULL, NULL, 'u-1', 1, 'draft', '${t}', NULL, NULL, NULL, NULL, NULL);
    INSERT INTO lectures (id, teacher_id, course_id, folder_id, title, markdown, "order", updated_at, deleted_at) VALUES
      ('l-1', '${TEST_TEACHER_ID}', NULL, NULL, '第一讲', '# 第一讲', 0, '${t}', NULL);
    INSERT INTO events (id, attempt_id, question_id, type, payload_json, client_ts, server_ts) VALUES
      ('ev-1', 'at-1', 'q-1', 'question_focus', '{"type":"question_focus","clientTs":1772000000000,"questionId":"q-1"}', 1772000000000, '${t}'),
      ('ev-2', 'at-1', 'q-1', 'answer_change', '{"type":"answer_change","clientTs":1772000001000,"questionId":"q-1"}', 1772000001000, '${t}'),
      ('ev-3', NULL, NULL, 'lecture_expand', '{"type":"lecture_expand","clientTs":1772000002000,"lectureId":"l-1","directive":"solution","index":1}', 1772000002000, '${t}'),
      ('ev-4', NULL, NULL, 'lecture_expand', '{"type":"lecture_expand","clientTs":1772000003000,"lectureId":"l-1","directive":"fold","index":2}', 1772000003000, '${t}'),
      ('ev-5', 'at-1', NULL, 'page_hidden', '{"type":"page_hidden","clientTs":1772000004000}', 1772000004000, '${t}');
  `);
}

describe("T4.0a events 补列回填（pre-T4.0a 结构 fixture → 迁移 → 回填）", () => {
  it("结构变更：events 加 student_id / lecture_id 列与 (studentId, lectureId, clientTs) 索引", () => {
    const db = createPreT40aDb();
    insertPreT40aFixture(db);
    migrateAndBackfill(db);

    const idx = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'",
      )
      .all() as Array<{ name: string }>;
    expect(idx.map((row) => row.name)).toContain(
      "events_student_lecture_client_ts_idx",
    );
    expect(db.$client.pragma("foreign_key_check")).toHaveLength(0);
    db.$client.close();
  });

  it("有 attemptId 的行按 attempt 回填 studentId；lecture_expand 从 payload 回填 lectureId；无归属的保留 NULL", () => {
    const db = createPreT40aDb();
    insertPreT40aFixture(db);
    migrateAndBackfill(db);

    const rowOf = (id: string) =>
      db
        .select({ studentId: events.studentId, lectureId: events.lectureId })
        .from(events)
        .where(eq(events.id, id))
        .get();
    // attempt 上下文行：studentId 回填、lectureId 保持 NULL（payload 无讲义语义）
    expect(rowOf("ev-1")).toEqual({ studentId: "s-1", lectureId: null });
    expect(rowOf("ev-2")).toEqual({ studentId: "s-1", lectureId: null });
    // 讲义行：lectureId 从 payload 回填、studentId 无法归属保留 NULL（D8）
    expect(rowOf("ev-3")).toEqual({ studentId: null, lectureId: "l-1" });
    expect(rowOf("ev-4")).toEqual({ studentId: null, lectureId: "l-1" });
    // attempt 上下文但无题目语义：同 ev-1 口径
    expect(rowOf("ev-5")).toEqual({ studentId: "s-1", lectureId: null });
    db.$client.close();
  });

  it("幂等：重复执行 runBackfills（乃至标记丢失重跑）结果不变；新代码写入的行不被触碰", () => {
    const db = createPreT40aDb();
    insertPreT40aFixture(db);
    migrateAndBackfill(db);
    const afterFirst = db
      .select({
        id: events.id,
        studentId: events.studentId,
        lectureId: events.lectureId,
      })
      .from(events)
      .all();

    // ① 标记命中：整体跳过
    runMigrations(db);
    runBackfills(db, new Date("2026-10-01T00:00:00.000Z"));
    expect(
      db
        .select({
          id: events.id,
          studentId: events.studentId,
          lectureId: events.lectureId,
        })
        .from(events)
        .all(),
    ).toEqual(afterFirst);

    // ② 标记丢失（库被手工改过）→ IS NULL 守卫下重跑，值不漂移
    db.delete(dataMigrations)
      .where(eq(dataMigrations.key, "t40a_events_backfill"))
      .run();
    runBackfills(db, new Date("2026-10-02T00:00:00.000Z"));
    expect(
      db
        .select({
          id: events.id,
          studentId: events.studentId,
          lectureId: events.lectureId,
        })
        .from(events)
        .all(),
    ).toEqual(afterFirst);

    // 新代码写入的行（两列已带值）不被触碰
    db.insert(events)
      .values({
        id: "ev-new",
        attemptId: null,
        questionId: null,
        studentId: "s-1",
        lectureId: "l-1",
        type: "lecture_visible",
        payloadJson:
          '{"type":"lecture_visible","clientTs":1772000005000,"lectureId":"l-1","viewId":"v-1"}',
        clientTs: 1772000005000,
        serverTs: "2026-10-02T00:00:00.000Z",
      })
      .run();
    runBackfills(db, new Date("2026-10-03T00:00:00.000Z"));
    expect(
      db.select().from(events).where(eq(events.id, "ev-new")).get(),
    ).toMatchObject({ studentId: "s-1", lectureId: "l-1" });
    db.$client.close();
  });

  it("坏 payloadJson 行防御性跳过（不抛错、lectureId 保持 NULL）；读侧兼容 NULL 归属行", async () => {
    const db = createTestDb();
    // attempts.student_id 有外键：先建学生行
    db.insert(students)
      .values({
        id: "s-bad",
        teacherId: TEST_TEACHER_ID,
        displayName: "坏数据学生",
        loginName: "s-bad",
        passwordHash: null,
        linkToken: "tok-bad",
        createdAt: "2026-03-01T00:00:00.000Z",
      })
      .run();
    db.insert(attempts)
      .values({
        id: "at-bad",
        studentId: "s-bad",
        sourceType: "course",
        assignmentId: null,
        courseId: null,
        unitId: "u-bad",
        attemptNo: 1,
        status: "draft",
        startedAt: "2026-03-01T00:00:00.000Z",
        submittedAt: null,
        activeSec: null,
        device: null,
        scoreAuto: null,
        scoreFinal: null,
      })
      .run();
    db.insert(events)
      .values({
        id: "ev-bad",
        attemptId: "at-bad",
        questionId: null,
        studentId: null,
        lectureId: null,
        type: "lecture_expand",
        payloadJson: "不是 JSON",
        clientTs: 1772000006000,
        serverTs: "2026-03-01T00:00:00.000Z",
      })
      .run();
    // createTestDb 已写标记：摘掉让回填真正作用于刚构造的行
    db.delete(dataMigrations)
      .where(eq(dataMigrations.key, "t40a_events_backfill"))
      .run();
    expect(() =>
      runBackfills(db, new Date("2026-10-01T00:00:00.000Z")),
    ).not.toThrow();
    // 坏行：studentId 仍可按 attempt 回填（第 1 步不依赖 payload）；lectureId 跳过
    expect(
      db
        .select({ studentId: events.studentId, lectureId: events.lectureId })
        .from(events)
        .where(eq(events.id, "ev-bad"))
        .get(),
    ).toEqual({ studentId: "s-bad", lectureId: null });

    // 读侧兼容：既有读路径（attemptTimeline）对 NULL 归属行照常返回
    const { attemptTimeline } = await import("../services/event-service.ts");
    const timeline = attemptTimeline(db, "at-bad");
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ type: "lecture_expand" });
    db.$client.close();
  });
});

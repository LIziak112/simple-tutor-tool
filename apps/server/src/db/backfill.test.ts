import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { runBackfills } from "./backfill.ts";
import { createDb, type Db } from "./client.ts";
import { resolveMigrationsFolder, runMigrations } from "./migrate.ts";
import {
  assignments,
  attempts,
  courseItems,
  courseStudents,
  courses,
  dataMigrations,
  lectures,
  libraryFolders,
  units,
} from "./schema.ts";
import { createTestDb } from "./test-utils.ts";

/**
 * D23 数据搬迁测试（T2A.1 验收项）：「T2A 前结构」fixture 库 → 迁移 → 回填 → 断言。
 *
 * 旧库构造方式：把真实迁移目录截断到最后一个 T2A 前迁移（0008）复制到临时目录，
 * 用 drizzle 官方 migrator 建出旧结构（journal 记录完整，随后 runMigrations 只补
 * 0009+）；fixture 数据用原生 SQL 插入（此时新 schema 的 drizzle 插入会带新列，
 * 对旧表不适用）。fixture 规模按任务要求：2 课程、3 讲义、4 单元、2 学生、
 * 1 作业、1 已交卷 attempt。
 */

/** T2A 前最后一个迁移的 tag（此后均为 Phase 2A 结构变更） */
const PRE_T2A_LAST_TAG = "0008_curved_hex";

/** 用真实迁移目录的前半段（0000–0008）在临时目录拼出「T2A 前迁移目录」 */
function makePreT2aMigrationsFolder(): string {
  const src = resolveMigrationsFolder();
  const journal: {
    version: string;
    dialect: string;
    entries: { tag: string }[];
  } = JSON.parse(readFileSync(join(src, "meta", "_journal.json"), "utf8"));
  const kept: { tag: string }[] = [];
  for (const entry of journal.entries) {
    kept.push(entry);
    if (entry.tag === PRE_T2A_LAST_TAG) break;
  }
  if (kept.at(-1)?.tag !== PRE_T2A_LAST_TAG) {
    throw new Error(`迁移目录中未找到 T2A 前边界 ${PRE_T2A_LAST_TAG}`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "tutor-pre-t2a-"));
  mkdirSync(join(tmp, "meta"), { recursive: true });
  writeFileSync(
    join(tmp, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: kept }),
  );
  for (const entry of kept) {
    copyFileSync(join(src, `${entry.tag}.sql`), join(tmp, `${entry.tag}.sql`));
  }
  return tmp;
}

/** 建「T2A 前结构」内存库（只应用 0000–0008） */
function createPreT2aDb(): Db {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: makePreT2aMigrationsFolder() });
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
    // 标记表：t2a1 与 t2a6 各一行，appliedAt 仍是首次时间戳
    expect(db.select().from(dataMigrations).all()).toEqual([
      {
        key: "t2a1_library_courses_backfill",
        appliedAt: "2026-09-27T00:00:00.000Z",
      },
      {
        key: "t2a6_attempts_source_backfill",
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
      // assignment 来源 courseId 为 null（T2A.7 起才取作业所属课程）
      courseId: null,
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
    expect(db.select().from(dataMigrations).all()).toHaveLength(2);
    // 全新库再跑一次同样幂等
    runBackfills(db);
    expect(db.select().from(dataMigrations).all()).toHaveLength(2);
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
    expect(db.select().from(dataMigrations).all()).toHaveLength(2);
  });
});

import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "./client";
import {
  attempts,
  courseItems,
  courseStudents,
  courses,
  dataMigrations,
  lectures,
  libraryFolders,
  students,
  units,
} from "./schema";

/** 事务参数类型（与 services/question-sync.ts 的 Tx 同一定义方式） */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * D23 现有数据搬迁（T2A.1 一次完成，幂等）。
 *
 * drizzle 迁移只做结构变更（DDL，经 pnpm db:generate 生成，不手改）；
 * 数据回填以代码执行，放在应用启动的 runMigrations 之后（本文件），
 * 以 data_migrations 表的完成标记防重跑，整个回填在单事务内完成
 * （标记行与数据同事务写入，失败即整体回滚，可安全重试）。
 *
 * 本文件执行 D23 步骤 1–4、7（T2A.1）与步骤 6（T2A.6）：
 * 1. 每个现有课程在资源库建同名文件夹；课程下的讲义/单元 folderId 指向该文件夹；
 * 2. 每个现有课程生成课程目录：按讲义原顺序，每篇讲义后紧跟其配套单元
 *    （units.lectureId 指向该讲义且 courseId 属该课程，按单元原顺序），
 *    剩余单元按原顺序追加在末尾；
 * 3. 讲义条目 visible=true；单元条目 visible=false（默认隐藏，教师按教学节奏开放）；
 * 4. 所有现有未归档学生加入所有现有课程（保持「学生能看到全部讲义」现状）；
 * 6. 现有 attempts：sourceType='assignment'、attemptNo=1（T2A.6，独立标记）；
 * 7. 「默认课程」按普通课程处理（无需特判，D23-7）。
 *
 * 另有孤儿资源兜底（backfillOrphans，与主标记无关、每次启动都执行、幂等），
 * 见该函数注释。
 */

/** 本组回填的完成标记 key */
const T2A1_BACKFILL_KEY = "t2a1_library_courses_backfill";
/** D23-6（T2A.6 attempts 来源回填）的完成标记 key（与 t2a1 独立：两任务分期合入） */
const T2A6_ATTEMPTS_BACKFILL_KEY = "t2a6_attempts_source_backfill";

/**
 * 执行全部未完成的数据搬迁（启动流程在 runMigrations 之后调用；
 * createTestDb 同样调用，保证测试库形态与生产一致）。
 * now 可注入（测试固定时间戳用）。
 *
 * 结构：主搬迁（一次性，标记防重跑）→ 孤儿兜底（每次启动执行，幂等）。
 */
export function runBackfills(db: Db, now: Date = new Date()): void {
  const appliedKeys = new Set(
    db
      .select({ key: dataMigrations.key })
      .from(dataMigrations)
      .all()
      .map((row) => row.key),
  );
  if (!appliedKeys.has(T2A1_BACKFILL_KEY)) {
    db.transaction((tx) => {
      backfillT2a1(tx, now);
      tx.insert(dataMigrations)
        .values({ key: T2A1_BACKFILL_KEY, appliedAt: now.toISOString() })
        .run();
    });
  }
  if (!appliedKeys.has(T2A6_ATTEMPTS_BACKFILL_KEY)) {
    db.transaction((tx) => {
      backfillT2a6Attempts(tx);
      tx.insert(dataMigrations)
        .values({ key: T2A6_ATTEMPTS_BACKFILL_KEY, appliedAt: now.toISOString() })
        .run();
    });
  }
  backfillOrphans(db, now);
}

/**
 * 课程同名文件夹（存在即复用——D23-1 同款规则；无则追加到末尾）。
 * 事务内调用。content-service 的导入兼容路径复用本函数（同一套 find-or-create 口径）。
 */
export function ensureCourseFolder(
  tx: Tx,
  courseTitle: string,
  nowIso: string,
): { id: string } {
  const existing = tx
    .select({ id: libraryFolders.id })
    .from(libraryFolders)
    .where(eq(libraryFolders.name, courseTitle))
    .orderBy(asc(libraryFolders.order))
    .get();
  if (existing !== undefined) return existing;
  const id = crypto.randomUUID();
  const maxOrder = tx
    .select({ order: libraryFolders.order })
    .from(libraryFolders)
    .all()
    .reduce((max, row) => Math.max(max, row.order), -1);
  tx.insert(libraryFolders)
    .values({ id, name: courseTitle, order: maxOrder + 1, createdAt: nowIso })
    .run();
  return { id };
}

/** D23 步骤 1–4：资源库文件夹 + 课程目录 + 全员入课（见文件头注释） */
function backfillT2a1(tx: Tx, now: Date): void {
  const nowIso = now.toISOString();

  const courseRows = tx
    .select()
    .from(courses)
    .orderBy(asc(courses.order), asc(courses.title))
    .all();

  for (const course of courseRows) {
    // ---- 步骤 1：同名文件夹（存在即复用；同名不唯一，取 order 最靠前的一个） ----
    const folderId = ensureCourseFolder(tx, course.title, nowIso).id;

    // 课程下的讲义/单元（旧结构口径：courseId 归属；排序与原内容树一致）
    const courseLectures = tx
      .select({ id: lectures.id })
      .from(lectures)
      .where(eq(lectures.courseId, course.id))
      .orderBy(asc(lectures.order), asc(lectures.title))
      .all();
    const courseUnits = tx
      .select({ id: units.id, lectureId: units.lectureId })
      .from(units)
      .where(eq(units.courseId, course.id))
      .orderBy(asc(units.order), asc(units.title))
      .all();

    tx.update(lectures)
      .set({ folderId })
      .where(eq(lectures.courseId, course.id))
      .run();
    tx.update(units)
      .set({ folderId })
      .where(eq(units.courseId, course.id))
      .run();

    // ---- 步骤 2 + 3：生成课程目录（讲义可见、单元隐藏） ----
    const lectureIdSet = new Set(courseLectures.map((row) => row.id));
    const rows: {
      courseId: string;
      kind: "lecture" | "unit";
      refId: string;
      visible: boolean;
      order: number;
    }[] = [];
    for (const lecture of courseLectures) {
      rows.push({
        courseId: course.id,
        kind: "lecture",
        refId: lecture.id,
        visible: true,
        order: rows.length,
      });
      // 配套单元：lectureId 指向本讲义且属于本课程（按单元原顺序紧跟讲义）
      for (const unit of courseUnits) {
        if (unit.lectureId === lecture.id) {
          rows.push({
            courseId: course.id,
            kind: "unit",
            refId: unit.id,
            visible: false,
            order: rows.length,
          });
        }
      }
    }
    // 剩余单元（无配套讲义、或配套讲义不在本课程）：按原顺序追加末尾
    for (const unit of courseUnits) {
      if (unit.lectureId === null || !lectureIdSet.has(unit.lectureId)) {
        rows.push({
          courseId: course.id,
          kind: "unit",
          refId: unit.id,
          visible: false,
          order: rows.length,
        });
      }
    }
    for (const row of rows) {
      tx.insert(courseItems)
        .values({
          id: crypto.randomUUID(),
          courseId: row.courseId,
          kind: row.kind,
          refId: row.refId,
          title: null,
          order: row.order,
          visible: row.visible,
          publishAt: null,
          createdAt: nowIso,
        })
        // 幂等兜底：唯一约束 (courseId, kind, refId) 命中即跳过
        .onConflictDoNothing({
          target: [courseItems.courseId, courseItems.kind, courseItems.refId],
        })
        .run();
    }
  }

  // ---- 步骤 4：所有未归档学生加入所有课程（复合主键冲突即跳过） ----
  const liveStudentIds = tx
    .select({ id: students.id, archivedAt: students.archivedAt })
    .from(students)
    .all()
    .filter((row) => row.archivedAt === null)
    .map((row) => row.id);
  for (const course of courseRows) {
    for (const studentId of liveStudentIds) {
      tx.insert(courseStudents)
        .values({ courseId: course.id, studentId, joinedAt: nowIso })
        .onConflictDoNothing()
        .run();
    }
  }
}

// ---------- D23-6：attempts 来源回填（T2A.6） ----------

/**
 * 现有 attempts 一律 sourceType='assignment'、attemptNo=1（D23-6）。
 *
 * 幂等口径：
 * - 迁移已给新列默认值（source_type DEFAULT 'assignment'、attempt_no DEFAULT 1），
 *   本步骤是对「迁移默认值之外仍可能残留的中间态」的显式兜底（如迁移文件被
 *   旧版本进程以手写 SQL 绕过、或列默认值在极端路径未生效）；
 * - 首次执行时库中不可能存在 course 作答——课程作答只能由 T2A.6 之后的代码
 *   创建，而新代码启动必先完成本回填（runBackfills 在服务监听前执行），
 *   因此无条件 UPDATE 不会误伤 course 作答的 attemptNo；
 * - 完成标记 t2a6_attempts_source_backfill 防重跑：此后新建的 course 作答
 *   （attemptNo 递增）不会再被触碰。
 * assignmentId/unitId 原值保留不改（D23-6：旧作业 attempt 的 unitId 即当时
 * 那份作业的单元）。
 */
function backfillT2a6Attempts(tx: Tx): void {
  tx.update(attempts)
    .set({ sourceType: "assignment", attemptNo: 1 })
    .run();
}

// ---------- 孤儿资源兜底（T2A.1 事故修复） ----------

/**
 * 孤儿资源兜底：与主标记无关，**每次启动都执行**，纯幂等（处理完成后不再命中
 * 兜底条件；对已正常搬迁的库零改动）。
 *
 * 背景：主搬迁带一次性完成标记；若服务曾在「新迁移+回填已执行、但导入仍是
 * 旧版写法」的中间态运行（如 tsx watch 热重启窗口），旧版导入只写 lectures/
 * units 行（folderId=NULL、courseId 指向课程），不建 course_items 条目——
 * 这些资源成为孤儿（教师内容页按 course_items 组装，看不到它们）。
 *
 * 兜底条件（全部满足才处理）：
 * - folderId IS NULL 且 deletedAt IS NULL（未软删）；
 * - courseId 非空且指向现有课程；
 * - **该课程没有该资源的目录条目**。
 *
 * 处理：补 folderId（该课程同名文件夹，无则建）+ 追加 course_items 条目
 * （讲义 visible=true、单元 visible=false——D23-3 口径；order 接在该课程
 * 现有条目末尾）。
 *
 * 「条目已存在则整体跳过（连 folderId 也不动）」的理由：新代码不再写 courseId
 * （@deprecated T2A），条目已存在的 legacy 行只可能是教师后来主动把资源
 * 「移入未归类」（T2A.2 起删除文件夹会把 folderId 置回 NULL）——不能在每次
 * 启动时被兜底改回去。folderId 已有值的行不满足兜底条件，不受影响
 * （资源库中未加入任何课程是合法状态）。
 */
function backfillOrphans(db: Db, now: Date): void {
  const nowIso = now.toISOString();
  const courseById = new Map(
    db
      .select({ id: courses.id, title: courses.title })
      .from(courses)
      .all()
      .map((row) => [row.id, row] as const),
  );

  const orphanLectures = db
    .select({ id: lectures.id, courseId: lectures.courseId })
    .from(lectures)
    .where(
      and(
        isNull(lectures.folderId),
        isNull(lectures.deletedAt),
        isNotNull(lectures.courseId),
      ),
    )
    .orderBy(asc(lectures.order), asc(lectures.title))
    .all();
  for (const row of orphanLectures) {
    const course =
      row.courseId !== null ? courseById.get(row.courseId) : undefined;
    if (course === undefined) continue; // courseId 指向不存在的课程：不兜底
    rescueOrphan(db, {
      kind: "lecture",
      refId: row.id,
      courseId: course.id,
      courseTitle: course.title,
      visible: true,
      nowIso,
    });
  }

  const orphanUnits = db
    .select({ id: units.id, courseId: units.courseId })
    .from(units)
    .where(
      and(
        isNull(units.folderId),
        isNull(units.deletedAt),
        isNotNull(units.courseId),
      ),
    )
    .orderBy(asc(units.order), asc(units.title))
    .all();
  for (const row of orphanUnits) {
    const course =
      row.courseId !== null ? courseById.get(row.courseId) : undefined;
    if (course === undefined) continue;
    rescueOrphan(db, {
      kind: "unit",
      refId: row.id,
      courseId: course.id,
      courseTitle: course.title,
      visible: false,
      nowIso,
    });
  }
}

/** 单个孤儿资源的补齐（单事务：文件夹 + folderId + 目录条目，可安全重入） */
function rescueOrphan(
  db: Db,
  input: {
    kind: "lecture" | "unit";
    refId: string;
    courseId: string;
    courseTitle: string;
    visible: boolean;
    nowIso: string;
  },
): void {
  const hasItem =
    db
      .select({ id: courseItems.id })
      .from(courseItems)
      .where(
        and(
          eq(courseItems.courseId, input.courseId),
          eq(courseItems.kind, input.kind),
          eq(courseItems.refId, input.refId),
        ),
      )
      .get() !== undefined;
  if (hasItem) return; // 见 backfillOrphans 注释：整体跳过

  db.transaction((tx) => {
    const folder = ensureCourseFolder(tx, input.courseTitle, input.nowIso);
    if (input.kind === "lecture") {
      tx.update(lectures)
        .set({ folderId: folder.id })
        .where(eq(lectures.id, input.refId))
        .run();
    } else {
      tx.update(units)
        .set({ folderId: folder.id })
        .where(eq(units.id, input.refId))
        .run();
    }
    const nextOrder =
      tx
        .select({ order: courseItems.order })
        .from(courseItems)
        .where(eq(courseItems.courseId, input.courseId))
        .all()
        .reduce((max, row) => Math.max(max, row.order), -1) + 1;
    tx.insert(courseItems)
      .values({
        id: crypto.randomUUID(),
        courseId: input.courseId,
        kind: input.kind,
        refId: input.refId,
        title: null,
        order: nextOrder,
        visible: input.visible,
        publishAt: null,
        createdAt: input.nowIso,
      })
      .onConflictDoNothing({
        target: [courseItems.courseId, courseItems.kind, courseItems.refId],
      })
      .run();
  });
}

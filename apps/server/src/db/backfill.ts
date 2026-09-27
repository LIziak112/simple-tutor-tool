import { asc, eq } from "drizzle-orm";
import type { Db } from "./client";
import {
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
 * 本任务执行 D23 步骤 1–4、7（5、6 属 T2A.7/T2A.6）：
 * 1. 每个现有课程在资源库建同名文件夹；课程下的讲义/单元 folderId 指向该文件夹；
 * 2. 每个现有课程生成课程目录：按讲义原顺序，每篇讲义后紧跟其配套单元
 *    （units.lectureId 指向该讲义且 courseId 属该课程，按单元原顺序），
 *    剩余单元按原顺序追加在末尾；
 * 3. 讲义条目 visible=true；单元条目 visible=false（默认隐藏，教师按教学节奏开放）；
 * 4. 所有现有未归档学生加入所有现有课程（保持「学生能看到全部讲义」现状）；
 * 7. 「默认课程」按普通课程处理（无需特判，D23-7）。
 */

/** 本组回填的完成标记 key */
const T2A1_BACKFILL_KEY = "t2a1_library_courses_backfill";

/**
 * 执行全部未完成的数据搬迁（启动流程在 runMigrations 之后调用；
 * createTestDb 同样调用，保证测试库形态与生产一致）。
 * now 可注入（测试固定时间戳用）。
 */
export function runBackfills(db: Db, now: Date = new Date()): void {
  const applied = db
    .select({ key: dataMigrations.key })
    .from(dataMigrations)
    .where(eq(dataMigrations.key, T2A1_BACKFILL_KEY))
    .get();
  if (applied !== undefined) return;

  db.transaction((tx) => {
    backfillT2a1(tx, now);
    tx.insert(dataMigrations)
      .values({ key: T2A1_BACKFILL_KEY, appliedAt: now.toISOString() })
      .run();
  });
}

/** D23 步骤 1–4：资源库文件夹 + 课程目录 + 全员入课（见文件头注释） */
function backfillT2a1(tx: Tx, now: Date): void {
  const nowIso = now.toISOString();

  const courseRows = tx
    .select()
    .from(courses)
    .orderBy(asc(courses.order), asc(courses.title))
    .all();

  // 已有文件夹的最大 order 之后继续编号（理论上首跑时表为空，防御性取 max+1）
  const existingFolders = tx
    .select({ order: libraryFolders.order })
    .from(libraryFolders)
    .all();
  let nextFolderOrder =
    existingFolders.reduce((max, row) => Math.max(max, row.order), -1) + 1;

  for (const course of courseRows) {
    // ---- 步骤 1：同名文件夹（存在即复用；同名不唯一，取 order 最靠前的一个） ----
    let folder = tx
      .select()
      .from(libraryFolders)
      .where(eq(libraryFolders.name, course.title))
      .orderBy(asc(libraryFolders.order))
      .get();
    if (folder === undefined) {
      const folderId = crypto.randomUUID();
      const folderOrder = nextFolderOrder;
      nextFolderOrder += 1;
      tx.insert(libraryFolders)
        .values({
          id: folderId,
          name: course.title,
          order: folderOrder,
          createdAt: nowIso,
        })
        .run();
      folder = {
        id: folderId,
        name: course.title,
        order: folderOrder,
        createdAt: nowIso,
      };
    }

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
      .set({ folderId: folder.id })
      .where(eq(lectures.courseId, course.id))
      .run();
    tx.update(units)
      .set({ folderId: folder.id })
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

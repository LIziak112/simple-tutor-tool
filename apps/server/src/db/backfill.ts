import { questionSchema, studentAnswerSchema } from "@tutor/contract";
import { grade } from "@tutor/grading";
import { and, asc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { finalScoreOf } from "../services/attempt-service.ts";
import type { Db } from "./client";
import {
  appSettings,
  assignments,
  assignmentUnits,
  attempts,
  courseItems,
  courseStudents,
  courses,
  dataMigrations,
  events,
  imports,
  lectures,
  libraryFolders,
  questionKnowledge,
  questions,
  type ResponseRow,
  responses,
  students,
  teachers,
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
 * 本文件执行 D23 步骤 1–4、7（T2A.1）、步骤 6（T2A.6）与步骤 5（T2A.7）：
 * 1. 每个现有课程在资源库建同名文件夹；课程下的讲义/单元 folderId 指向该文件夹；
 * 2. 每个现有课程生成课程目录：按讲义原顺序，每篇讲义后紧跟其配套单元
 *    （units.lectureId 指向该讲义且 courseId 属该课程，按单元原顺序），
 *    剩余单元按原顺序追加在末尾；
 * 3. 讲义条目 visible=true；单元条目 visible=false（默认隐藏，教师按教学节奏开放）；
 * 4. 所有现有未归档学生加入所有现有课程（保持「学生能看到全部讲义」现状）；
 * 5. 现有作业（T2A.7）：assignment_units 写入原 unitId（order=0）、courseId 取该
 *    单元原所属课程（units.courseId，deprecated 列；无课程保持 null）、
 *    assignment_students.addedAt 补作业 createdAt、旧作业 attempt 的 courseId
 *    补作业所属课程（D9 语义）；
 * 6. 现有 attempts：sourceType='assignment'、attemptNo=1（T2A.6，独立标记）；
 * 7. 「默认课程」按普通课程处理（无需特判，D23-7）。
 * 8. 现有 events：有 attemptId 的行按 attempt→student 回填 studentId、
 *    同批从存量 lecture_expand payload 回填 lectureId（T4.0a，D8，独立标记）。
 *
 * 另有孤儿资源兜底（backfillOrphans，与主标记无关、每次启动都执行、幂等），
 * 见该函数注释。
 */

/** 本组回填的完成标记 key */
const T2A1_BACKFILL_KEY = "t2a1_library_courses_backfill";
/** D23-6（T2A.6 attempts 来源回填）的完成标记 key（与 t2a1 独立：两任务分期合入） */
const T2A6_ATTEMPTS_BACKFILL_KEY = "t2a6_attempts_source_backfill";
/** D23-5（T2A.7 作业多单元/名单结构回填）的完成标记 key（与前两个独立） */
const T2A7_ASSIGNMENTS_BACKFILL_KEY = "t2a7_assignments_backfill";
/**
 * T2B.1（多教师基础结构回填）的完成标记 key：唯一教师行升级（D4）+
 * 全部业务根行 teacherId 回填（D9）。排在 t2a 系列之后，顺带覆盖
 * t2a1 回填期间新建的文件夹行。
 */
const T2B1_MULTI_TEACHER_BACKFILL_KEY = "t2b1_multi_teacher_backfill";
/**
 * T2B.6（app_settings 初始键回填，D8）的完成标记 key：插入
 * allowRegistration='true'（注册开关默认开）。
 */
const T2B6_APP_SETTINGS_BACKFILL_KEY = "t2b6_app_settings_init";
/**
 * T3.2a（判分口径 D1/D2/D3 存量回填）的完成标记 key：对已交卷 attempt 按
 * 新判分语义重算 responses.autoCorrect / finalCorrect 与 attempt 的
 * scoreAuto / scoreFinal / status。数据回填（非结构变更），见 backfillT32aGrading。
 */
const T32A_GRADING_SEMANTICS_BACKFILL_KEY = "t32a_grading_semantics_backfill";
/**
 * T4.0a（events 表补 studentId / lectureId 列，D8）的完成标记 key：
 * 有 attemptId 的行按 attempt → student 回填、同批从存量 lecture_expand
 * payload 回填 lectureId；无 attemptId 的存量讲义事件 studentId 保留 NULL
 * （无法归属，读侧按非空过滤）。见 backfillT40aEvents。
 */
const T40A_EVENTS_STUDENT_LECTURE_BACKFILL_KEY = "t40a_events_backfill";

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
        .values({
          key: T2A6_ATTEMPTS_BACKFILL_KEY,
          appliedAt: now.toISOString(),
        })
        .run();
    });
  }
  if (!appliedKeys.has(T2A7_ASSIGNMENTS_BACKFILL_KEY)) {
    db.transaction((tx) => {
      backfillT2a7Assignments(tx);
      tx.insert(dataMigrations)
        .values({
          key: T2A7_ASSIGNMENTS_BACKFILL_KEY,
          appliedAt: now.toISOString(),
        })
        .run();
    });
  }
  if (!appliedKeys.has(T2B1_MULTI_TEACHER_BACKFILL_KEY)) {
    db.transaction((tx) => {
      backfillT2b1(tx);
      tx.insert(dataMigrations)
        .values({
          key: T2B1_MULTI_TEACHER_BACKFILL_KEY,
          appliedAt: now.toISOString(),
        })
        .run();
    });
  }
  if (!appliedKeys.has(T2B6_APP_SETTINGS_BACKFILL_KEY)) {
    db.transaction((tx) => {
      backfillT2b6(tx);
      tx.insert(dataMigrations)
        .values({
          key: T2B6_APP_SETTINGS_BACKFILL_KEY,
          appliedAt: now.toISOString(),
        })
        .run();
    });
  }
  if (!appliedKeys.has(T32A_GRADING_SEMANTICS_BACKFILL_KEY)) {
    db.transaction((tx) => {
      backfillT32aGrading(tx);
      tx.insert(dataMigrations)
        .values({
          key: T32A_GRADING_SEMANTICS_BACKFILL_KEY,
          appliedAt: now.toISOString(),
        })
        .run();
    });
  }
  if (!appliedKeys.has(T40A_EVENTS_STUDENT_LECTURE_BACKFILL_KEY)) {
    db.transaction((tx) => {
      backfillT40aEvents(tx);
      tx.insert(dataMigrations)
        .values({
          key: T40A_EVENTS_STUDENT_LECTURE_BACKFILL_KEY,
          appliedAt: now.toISOString(),
        })
        .run();
    });
  }
  backfillOrphans(db, now);
}

/**
 * 最早的教师行 id（createdAt 同刻按 id 稳定排序）；无教师行返回 null。
 * T2B.1 单教师等价期的统一取值口径（正常库只有一行；返回 null 仅出现在
 * 全新库首启、教师尚未创建的阶段——此时也不可能有任何课程/资源数据）。
 */
function firstTeacherId(db: Tx | Db): string | null {
  const row = db
    .select({ id: teachers.id })
    .from(teachers)
    .orderBy(asc(teachers.createdAt), asc(teachers.id))
    .get();
  return row?.id ?? null;
}

/**
 * 课程同名文件夹（存在即复用——D23-1 同款规则；无则追加到末尾）。
 * 事务内调用。content-service 的导入兼容路径复用本函数（同一套 find-or-create 口径）。
 * teacherId（T2B.1/D9）：新建文件夹时写入归属教师（代码层恒写非空；
 * null 仅在「无教师行且仍有课程数据」的不可能状态下出现）。
 * T2B.3 起查找与 order 取值都限定本教师域（D13：导入只与本教师域的文件夹合并；
 * teacherId 为 null 时库中必然没有教师行（也就无从分域），退回按名全局匹配，
 * 与历史行为一致，保证孤儿兜底在该不可能状态下仍幂等）。
 */
export function ensureCourseFolder(
  tx: Tx,
  courseTitle: string,
  nowIso: string,
  teacherId: string | null,
): { id: string } {
  const existing = tx
    .select({ id: libraryFolders.id })
    .from(libraryFolders)
    .where(
      teacherId === null
        ? eq(libraryFolders.name, courseTitle)
        : and(
            eq(libraryFolders.teacherId, teacherId),
            eq(libraryFolders.name, courseTitle),
          ),
    )
    .orderBy(asc(libraryFolders.order))
    .get();
  if (existing !== undefined) return existing;
  const id = crypto.randomUUID();
  const maxOrder = tx
    .select({ order: libraryFolders.order })
    .from(libraryFolders)
    .where(
      teacherId === null ? undefined : eq(libraryFolders.teacherId, teacherId),
    )
    .all()
    .reduce((max, row) => Math.max(max, row.order), -1);
  tx.insert(libraryFolders)
    .values({
      id,
      teacherId,
      name: courseTitle,
      order: maxOrder + 1,
      createdAt: nowIso,
    })
    .run();
  return { id };
}

/** D23 步骤 1–4：资源库文件夹 + 课程目录 + 全员入课（见文件头注释） */
function backfillT2a1(tx: Tx, now: Date): void {
  const nowIso = now.toISOString();
  const teacherId = firstTeacherId(tx);

  const courseRows = tx
    .select()
    .from(courses)
    .orderBy(asc(courses.order), asc(courses.title))
    .all();

  for (const course of courseRows) {
    // ---- 步骤 1：同名文件夹（存在即复用；同名不唯一，取 order 最靠前的一个） ----
    const folderId = ensureCourseFolder(tx, course.title, nowIso, teacherId).id;

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
  tx.update(attempts).set({ sourceType: "assignment", attemptNo: 1 }).run();
}

// ---------- D23-5：作业多单元与名单结构回填（T2A.7） ----------

/**
 * 现有作业搬到 T2A.7 结构（D23-5）：
 * 1. assignment_units：每个现有作业写入原 unitId（order=0）——旧作业即单单元作业；
 * 2. assignments.courseId：取该作业单元的 legacy units.courseId（deprecated 列），
 *    单元无课程则保持 null；
 * 3. assignment_students.addedAt：为空的行回填为该作业 createdAt（列可空仅因
 *    SQLite 加 NOT NULL 列需重建表，代码层恒写保证非空）；
 * 4. attempts.courseId：sourceType='assignment' 且 courseId 为空的行回填为所属
 *    作业的 courseId（D9：assignment 作答记作业所属课程）——须在步骤 2 之后执行。
 *
 * 幂等口径（除完成标记外，每步自身也可重入）：
 * - 步骤 1：onConflictDoNothing 命中复合主键 (assignmentId, unitId) 即跳过；
 * - 步骤 2/3：UPDATE 带 WHERE course_id IS NULL / added_at IS NULL 守卫，
 *   已回填或新代码已写入的行不再触碰；unit_id 为 NULL 的行（T2A.7 新作业）
 *   子查询无命中，course_id 保持原值；
 * - 步骤 4：只更新 courseId IS NULL 且映射命中的行，重跑时不再命中。
 */
function backfillT2a7Assignments(tx: Tx): void {
  // ---- 步骤 1：assignment_units 写入原 unitId（order=0） ----
  for (const row of tx
    .select({ id: assignments.id, unitId: assignments.unitId })
    .from(assignments)
    .where(isNotNull(assignments.unitId))
    .all()) {
    if (row.unitId === null) continue; // 类型收窄（where 已过滤，运行时不可达）
    tx.insert(assignmentUnits)
      .values({ assignmentId: row.id, unitId: row.unitId, order: 0 })
      .onConflictDoNothing({
        target: [assignmentUnits.assignmentId, assignmentUnits.unitId],
      })
      .run();
  }

  // ---- 步骤 2：courseId 取单元 legacy 课程（单元无课程则子查询为 NULL，原值不动） ----
  tx.run(sql`
    UPDATE assignments
    SET course_id = (SELECT course_id FROM units WHERE units.id = assignments.unit_id)
    WHERE course_id IS NULL
  `);

  // ---- 步骤 3：addedAt 为空的行补作业 createdAt ----
  tx.run(sql`
    UPDATE assignment_students
    SET added_at = (
      SELECT created_at FROM assignments
      WHERE assignments.id = assignment_students.assignment_id
    )
    WHERE added_at IS NULL
  `);

  // ---- 步骤 4：旧作业 attempt 的 courseId 补作业所属课程（D9） ----
  // 先查 assignments 映射再逐行更新（步骤 2 已把 legacy courseId 写入映射来源）
  const assignmentCourseById = new Map<string, string>();
  for (const row of tx
    .select({ id: assignments.id, courseId: assignments.courseId })
    .from(assignments)
    .all()) {
    if (row.courseId !== null) assignmentCourseById.set(row.id, row.courseId);
  }
  for (const row of tx
    .select({ id: attempts.id, assignmentId: attempts.assignmentId })
    .from(attempts)
    .where(
      and(
        eq(attempts.sourceType, "assignment"),
        isNull(attempts.courseId),
        isNotNull(attempts.assignmentId),
      ),
    )
    .all()) {
    const courseId = assignmentCourseById.get(row.assignmentId ?? "");
    if (courseId === undefined) continue; // 作业无课程：保持 null
    tx.update(attempts).set({ courseId }).where(eq(attempts.id, row.id)).run();
  }
}

// ---------- T2B.1：教师升级与 teacherId 回填（D4/D9） ----------

/**
 * 多教师基础结构的数据回填（一次性，标记 t2b1_multi_teacher_backfill 防重跑）：
 * 1. 唯一教师行升级为管理员（D4）：loginName='teacher'、isAdmin=true——
 *    **只写这两列**，密码、id、createdAt 原样不动，部署者无感；
 * 2. 全部业务根行 teacherId 回填该教师 id（D9）：students、courses、
 *    library_folders、lectures、units、questions、imports、assignments、
 *    question_knowledge（后者主键含 teacherId，D11）。
 *
 * 幂等口径：完成标记防重跑之外，每步 UPDATE 自带 IS NULL / 值收敛守卫——
 * 已回填或新代码已写入的行不会再次触碰。
 *
 * 无教师行（全新库首启、setup 未做）：无数据可回填，仅写标记；此后 setup
 * 创建的教师行自带 loginName/isAdmin（teacher-auth-service），业务行由各
 * 创建入口写 teacherId。多教师行在本阶段不可能出现（第二位教师的入口
 * T2B.6 才上线）——真出现说明库被手工改过，停下来抛错绝不猜归属。
 */
function backfillT2b1(tx: Tx): void {
  const teacherRows = tx
    .select({ id: teachers.id })
    .from(teachers)
    .orderBy(asc(teachers.createdAt), asc(teachers.id))
    .all();
  if (teacherRows.length > 1) {
    throw new Error(
      `T2B.1 回填发现 ${teacherRows.length} 行教师数据（本阶段系统应为单教师）——请先检查数据库是否被手工修改，再重试启动。`,
    );
  }
  const teacher = teacherRows[0];
  if (teacher === undefined) return; // 无教师行：无数据可搬（见函数头注释）

  // 1. 教师行升级（值收敛写法：已是目标值时无实际变更）
  tx.update(teachers)
    .set({ loginName: "teacher", isAdmin: true })
    .where(eq(teachers.id, teacher.id))
    .run();

  // 2. 根表 teacherId 回填（统一 sql 模板避开异构表的类型联合；
  //    WHERE teacher_id IS NULL 守卫 → 重跑与新代码已写的行均不触碰）
  const rootTables = [
    students,
    courses,
    libraryFolders,
    lectures,
    units,
    questions,
    imports,
    assignments,
    questionKnowledge,
  ];
  for (const table of rootTables) {
    tx.run(
      sql`UPDATE ${table} SET teacher_id = ${teacher.id} WHERE teacher_id IS NULL`,
    );
  }
}

// ---------- T2B.6：app_settings 初始键（D8） ----------

/**
 * 插入注册开关初始键 allowRegistration='true'（一次性，标记防重跑）。
 * onConflictDoNothing 双保险：即使标记行丢失重跑，也不会覆盖管理员改过的值
 * （'false' 行已存在 → 冲突跳过）。
 */
function backfillT2b6(tx: Tx): void {
  tx.insert(appSettings)
    .values({ key: "allowRegistration", value: "true" })
    .onConflictDoNothing({ target: appSettings.key })
    .run();
}

// ---------- T3.2a：判分口径存量回填（D1/D2/D3） ----------

/** JSON.parse 的窄化包装：坏数据返回 undefined（与 attempt-service 同口径） */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * T3.2a 判分口径存量回填（一次性，标记 t32a_grading_semantics_backfill）：
 * D1（未作答客观题判错）/ D3（交卷写 finalCorrect = teacherMark ?? autoCorrect）
 * / D2（scoreFinal 分母=全部题、graded=全部非 null）上线前已交卷的 attempt，
 * 按新口径重算：
 *
 * 1. 逐题重判 autoCorrect：判分输入**以 responses.questionSnapshotJson 为准**
 *    （与交卷时同源——题目此后可能被编辑/软删，当前 questions 内容不代表作答
 *    当时）；快照缺失或解析失败的题**跳过并保留原值**（防御异常行，不猜）；
 *    学生答案取 answerJson（坏数据按未作答）；
 * 2. 写 finalCorrect = teacherMark ?? autoCorrect（存量 teacherMark 尚无写入
 *    链路，防御性识别 'correct'/'wrong'，其余按 null）；
 * 3. 重算 attempt：scoreAuto = 答对 ÷ autoCorrect 非 null 题数（未作答客观题
 *    从此进分母）；scoreFinal/status 由 finalScoreOf（D2）——全部非 null →
 *    graded + scoreFinal，否则 submitted + null。
 *
 * 范围与幂等：只处理**已交卷且有 responses 行**的 attempt（draft 不判分；
 * 无 responses 的历史异常行无从重算，原样保留）。重算从快照确定性推导，
 * 重复执行结果不变；行级/attempt 级仅在值有变化时 UPDATE（对按新口径已
 * 一致的库零写入）。
 */
function backfillT32aGrading(tx: Tx): void {
  const submittedAttempts = tx
    .select()
    .from(attempts)
    .where(ne(attempts.status, "draft"))
    .all();
  if (submittedAttempts.length === 0) return;

  const responsesByAttempt = new Map<string, ResponseRow[]>();
  for (const row of tx.select().from(responses).all()) {
    const list = responsesByAttempt.get(row.attemptId);
    if (list === undefined) responsesByAttempt.set(row.attemptId, [row]);
    else list.push(row);
  }

  for (const attempt of submittedAttempts) {
    const rows = responsesByAttempt.get(attempt.id);
    if (rows === undefined || rows.length === 0) continue; // 无 responses：无从重算

    const autoCorrects: (boolean | null)[] = [];
    const finalCorrects: (boolean | null)[] = [];
    for (const row of rows) {
      // 快照 → 契约 Question（缺失/解析失败 → null = 跳过重判，保留原 autoCorrect）
      const snapshotParsed =
        row.questionSnapshotJson === null
          ? null
          : questionSchema.safeParse(jsonOf(row.questionSnapshotJson));
      const question = snapshotParsed?.success ? snapshotParsed.data : null;
      const answerParsed =
        row.answerJson === null
          ? undefined
          : studentAnswerSchema.safeParse(jsonOf(row.answerJson));
      const answer = answerParsed?.success ? answerParsed.data : undefined;
      const autoCorrect =
        question !== null ? grade(question, answer) : row.autoCorrect;
      const teacherMark =
        row.teacherMark === "correct"
          ? true
          : row.teacherMark === "wrong"
            ? false
            : null;
      const finalCorrect = teacherMark ?? autoCorrect;
      if (
        autoCorrect !== row.autoCorrect ||
        finalCorrect !== row.finalCorrect
      ) {
        tx.update(responses)
          .set({ autoCorrect, finalCorrect })
          .where(eq(responses.id, row.id))
          .run();
      }
      autoCorrects.push(autoCorrect);
      finalCorrects.push(finalCorrect);
    }

    // D1 口径的 scoreAuto（答对 ÷ autoCorrect 非 null 题数；无可判分为 null）
    const autoGradable = autoCorrects.filter((v) => v !== null).length;
    const scoreAuto =
      autoGradable === 0
        ? null
        : Math.round(
            (autoCorrects.filter((v) => v === true).length / autoGradable) *
              100,
          );
    const { status, scoreFinal } = finalScoreOf(finalCorrects);
    if (
      attempt.scoreAuto !== scoreAuto ||
      attempt.scoreFinal !== scoreFinal ||
      attempt.status !== status
    ) {
      tx.update(attempts)
        .set({ scoreAuto, scoreFinal, status })
        .where(eq(attempts.id, attempt.id))
        .run();
    }
  }
}

// ---------- T4.0a：events 表 studentId / lectureId 存量回填（D8） ----------

/**
 * events 表补列后的存量回填（一次性，标记 t40a_events_backfill 防重跑）：
 * 1. 有 attemptId 的行按 attempt → attempts.studentId 回填 studentId
 *    （关联子查询命中即写；attempt 行异常缺失时保持 NULL，不猜归属）；
 * 2. 同批从存量 payload 回填 lectureId：payload 顶层带 lectureId 的行
 *    （即 lecture_expand，T4.0a 前唯一讲义域事件）提取落列——「学生 × 讲义」
 *    聚合走索引，不必逐行 JSON.parse（§4.2 复审新增的理由）。
 *
 * 边界与幂等：
 * - 无 attemptId 的存量讲义事件（lecture_expand）：lectureId 从 payload 回填，
 *    studentId 无法可靠归属保留 NULL、读侧按 studentId IS NOT NULL 过滤（D8）；
 * - 两步 UPDATE 均带 IS NULL 守卫——已回填或新代码已写入的行不再触碰，
 *    标记行丢失重跑结果不变（坏 payloadJson 跳过，防御异常行）。
 */
function backfillT40aEvents(tx: Tx): void {
  // 1. attempt 上下文行：studentId ← 所属 attempt 的学生
  tx.run(sql`
    UPDATE events
    SET student_id = (SELECT student_id FROM attempts WHERE attempts.id = events.attempt_id)
    WHERE student_id IS NULL AND attempt_id IS NOT NULL
  `);

  // 2. 讲义域行：lectureId ← payload 顶层字段（TS 解析，坏数据跳过）
  for (const row of tx
    .select({ id: events.id, payloadJson: events.payloadJson })
    .from(events)
    .where(isNull(events.lectureId))
    .all()) {
    const parsed = jsonOf(row.payloadJson) as { lectureId?: unknown } | undefined;
    const lectureId = parsed?.lectureId;
    if (typeof lectureId === "string" && lectureId.length > 0) {
      tx.update(events)
        .set({ lectureId })
        .where(eq(events.id, row.id))
        .run();
    }
  }
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
  const teacherId = firstTeacherId(db);
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
      teacherId,
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
      teacherId,
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
    teacherId: string | null;
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
    const folder = ensureCourseFolder(
      tx,
      input.courseTitle,
      input.nowIso,
      input.teacherId,
    );
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

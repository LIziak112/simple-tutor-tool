/**
 * seed-demo CLI 入口（T4.1）：`pnpm seed:demo [--teacher <登录名>] [--reset]`。
 *
 * - 往 DATA_DIR 真库灌演示数据（3 名学生、2 门课程、课程练习含重做 2 次、
 *   4 份作业、手写与未作答题、提示使用与离线标记、讲义阅读事件）——
 *   建数据逻辑全部在 src/services/seed-demo.ts（可复用模块，测试同源）；
 * - 默认教师登录名 `demo`：不存在则创建（随机初始密码，仅本次打印）；
 *   种子数据全部落在该教师域内，与真实教师的业务数据完全隔离（T2B 域模型）；
 * - 幂等：该教师域内已存在种子学生（同名登录名）时提示并退出；--reset 先
 *   清空该教师域内全部业务数据再重新播种（只清这位教师，别的不动）；
 * - 库文件不存在时报错退出（先启动一次服务完成初始化），与 reparse 同口径；
 * - 退出码：0 成功、2 用法/环境错误。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { eq, inArray, or } from "drizzle-orm";
import { hashPassword } from "../src/auth/password.ts";
import { readConfig } from "../src/config.ts";
import { createDb } from "../src/db/client.ts";
import {
  assignmentStudents,
  assignments,
  assignmentUnits,
  attempts,
  courseItems,
  courseStudents,
  courses,
  events,
  imports,
  ink,
  lectures,
  libraryFolders,
  questionKnowledge,
  questions,
  responses,
  students,
  teachers,
  units,
} from "../src/db/schema.ts";
import {
  SEED_STUDENT_LOGIN_NAMES,
  seedDemoData,
} from "../src/services/seed-demo.ts";

const USAGE =
  "用法：pnpm seed:demo [--teacher <登录名>] [--reset]（往 DATA_DIR 灌学情演示数据；默认教师 demo）";

const args = process.argv.slice(2);
let teacherLogin = "demo";
let reset = false;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--teacher") {
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      console.error(`--teacher 需要一个登录名参数\n${USAGE}`);
      process.exit(2);
    }
    teacherLogin = next;
    i += 1;
  } else if (arg === "--reset") {
    reset = true;
  } else {
    console.error(`未知参数：${arg}\n${USAGE}`);
    process.exit(2);
  }
}

const config = readConfig(process.env);
const dbPath = join(config.dataDir, "tutor.db");
if (!existsSync(dbPath)) {
  console.error(
    `数据库不存在：${dbPath}\n请确认 DATA_DIR 指向正确的数据目录（当前：${config.dataDir}），或先启动一次服务完成初始化。`,
  );
  process.exit(2);
}
const db = createDb(dbPath);

try {
  // —— 定位（或创建）目标教师 ——
  let teacher = db
    .select()
    .from(teachers)
    .where(eq(teachers.loginName, teacherLogin))
    .get();
  let initialPassword: string | null = null;
  if (teacher === undefined) {
    const bytes = new Uint8Array(12);
    globalThis.crypto.getRandomValues(bytes);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    initialPassword = btoa(binary).replaceAll("+", "-").replaceAll("/", "_");
    db.insert(teachers)
      .values({
        id: randomUUID(),
        loginName: teacherLogin,
        isAdmin: false,
        disabledAt: null,
        passwordHash: await hashPassword(initialPassword),
        apiToken: null,
        createdAt: new Date().toISOString(),
      })
      .run();
    teacher = db
      .select()
      .from(teachers)
      .where(eq(teachers.loginName, teacherLogin))
      .get();
    if (teacher === undefined) {
      console.error("教师创建失败");
      process.exit(2);
    }
    console.log(`已创建演示教师：${teacherLogin}`);
  }

  // —— 幂等检查 / --reset 清空 ——
  const hasSeed = db
    .select({ loginName: students.loginName })
    .from(students)
    .where(eq(students.teacherId, teacher.id))
    .all()
    .some((row) =>
      (SEED_STUDENT_LOGIN_NAMES as readonly string[]).includes(row.loginName),
    );
  if (hasSeed && !reset) {
    console.error(
      `教师「${teacherLogin}」域内已有种子数据。重新播种请加 --reset（将清空该教师域内全部业务数据，不影响其他教师）。`,
    );
    process.exit(2);
  }
  if (reset) {
    wipeTeacherDomain(teacher.id);
    console.log(`--reset：已清空教师「${teacherLogin}」域内的全部业务数据。`);
  }

  // —— 播种（时间轴相对当前时刻生成，数据总是「最近」的） ——
  const seed = await seedDemoData(db, teacher.id);
  console.log("演示数据播种完成：");
  console.log(
    `  学生：${seed.students.s1.name}、${seed.students.s2.name}、${seed.students.s3.name}（密码 demo-pass-123）`,
  );
  console.log(`  课程：${seed.courses.a.name}、${seed.courses.b.name}`);
  console.log(
    `  作业：${seed.assignments.a1.name} / ${seed.assignments.a2.name} / ${seed.assignments.a3.name} / ${seed.assignments.a4.name}`,
  );
  console.log(
    "  含课程练习重做 2 次、未作答与手写待批题、提示与离线标记、讲义阅读事件",
  );
  if (initialPassword !== null) {
    console.log(`\n演示教师登录名：${teacherLogin}`);
    console.log(`初始密码（仅本次显示，请立即保存）：${initialPassword}`);
  } else {
    console.log(`\n教师「${teacherLogin}」已有密码，按原密码登录即可。`);
  }
  console.log(`\n数据库：${dbPath}`);
  console.log(
    "登录后可在「学情」页（/t/insights，T4.2 上线后）或 /api/teacher/analytics/* 查看数据。",
  );
} finally {
  db.$client.close();
}

/**
 * 清空一位教师域内的全部业务数据（FK 开启，按依赖顺序删除；保留教师行与
 * 教师会话——学生会话随学生删除自然失效，教师本人不受影响）。
 */
function wipeTeacherDomain(teacherId: string): void {
  const studentIds = db
    .select({ id: students.id })
    .from(students)
    .where(eq(students.teacherId, teacherId))
    .all()
    .map((row) => row.id);
  const attemptIds =
    studentIds.length > 0
      ? db
          .select({ id: attempts.id })
          .from(attempts)
          .where(inArray(attempts.studentId, studentIds))
          .all()
          .map((row) => row.id)
      : [];
  const assignmentIds = db
    .select({ id: assignments.id })
    .from(assignments)
    .where(eq(assignments.teacherId, teacherId))
    .all()
    .map((row) => row.id);
  const courseIds = db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.teacherId, teacherId))
    .all()
    .map((row) => row.id);

  // 事件：按 attemptId 或 studentId 命中（讲义域事件无 attempt 上下文）
  const eventConditions = [];
  if (attemptIds.length > 0)
    eventConditions.push(inArray(events.attemptId, attemptIds));
  if (studentIds.length > 0)
    eventConditions.push(inArray(events.studentId, studentIds));
  if (eventConditions.length === 1)
    db.delete(events).where(eventConditions[0]).run();
  else if (eventConditions.length > 1)
    db.delete(events)
      .where(or(...eventConditions))
      .run();

  if (attemptIds.length > 0) {
    db.delete(ink).where(inArray(ink.attemptId, attemptIds)).run();
    db.delete(responses).where(inArray(responses.attemptId, attemptIds)).run();
  }
  if (studentIds.length > 0) {
    db.delete(attempts).where(inArray(attempts.studentId, studentIds)).run();
  }
  if (assignmentIds.length > 0) {
    db.delete(assignmentStudents)
      .where(inArray(assignmentStudents.assignmentId, assignmentIds))
      .run();
    db.delete(assignmentUnits)
      .where(inArray(assignmentUnits.assignmentId, assignmentIds))
      .run();
  }
  db.delete(assignments).where(eq(assignments.teacherId, teacherId)).run();
  if (courseIds.length > 0) {
    db.delete(courseStudents)
      .where(inArray(courseStudents.courseId, courseIds))
      .run();
    db.delete(courseItems)
      .where(inArray(courseItems.courseId, courseIds))
      .run();
  }
  db.delete(courses).where(eq(courses.teacherId, teacherId)).run();
  db.delete(questionKnowledge)
    .where(eq(questionKnowledge.teacherId, teacherId))
    .run();
  db.delete(questions).where(eq(questions.teacherId, teacherId)).run();
  // 依赖顺序：units.lectureId → lectures；units/lectures/imports.folderId →
  // library_folders（导入的课程兼容路径会建同名文件夹，故 imports 先于 folders）
  db.delete(units).where(eq(units.teacherId, teacherId)).run();
  db.delete(lectures).where(eq(lectures.teacherId, teacherId)).run();
  db.delete(imports).where(eq(imports.teacherId, teacherId)).run();
  db.delete(libraryFolders)
    .where(eq(libraryFolders.teacherId, teacherId))
    .run();
  db.delete(students).where(eq(students.teacherId, teacherId)).run();
}

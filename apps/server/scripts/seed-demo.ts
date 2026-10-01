/**
 * seed-demo CLI 入口（T4.1）：`pnpm seed:demo [--teacher <登录名>] [--reset]`。
 *
 * - 往 DATA_DIR 真库灌演示数据（3 名学生、2 门课程、课程练习含重做 2 次、
 *   4 份作业、手写与未作答题、提示使用与离线标记、讲义阅读事件）——
 *   建数据逻辑全部在 src/services/seed-demo.ts（可复用模块，测试同源）；
 * - 默认教师登录名 `demo`：不存在则创建（随机初始密码，仅种子成功后打印）；
 *   种子数据全部落在该教师域内，与真实教师的业务数据完全隔离（T2B 域模型）；
 *   种数据失败时自动回滚本次新建的教师行（不留无法登录的孤儿教师）；
 * - 多教师同库（T4.1 修复）：学生登录名全局唯一（D14），库里已有 demo 域再播
 *   demo2 时自动加数字后缀（陈小明 → 陈小明2 …），displayName 与密码不变；
 *   播种前做全局登录名预检并提前打印避让说明；
 * - 幂等：该教师域内已存在种子学生（按 displayName 识别，含避让后缀的
 *   登录名）时提示并退出；--reset 先清空该教师域内全部业务数据再重新播种
 *   （只清这位教师，别的不动）；
 * - 库文件不存在时报错退出（先启动一次服务完成初始化），与 reparse 同口径；
 * - 退出码：0 成功、2 用法/环境错误、1 播种失败。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { eq } from "drizzle-orm";
import { readConfig } from "../src/config.ts";
import { createDb } from "../src/db/client.ts";
import { students, teachers } from "../src/db/schema.ts";
import {
  createDemoTeacherAndSeed,
  isSeedStudentRow,
  resolveSeedStudentLoginName,
  SEED_STUDENT_LOGIN_NAMES,
  wipeTeacherDomain,
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
  // —— 定位教师（幂等检查 / --reset 清空用；创建延迟到播种一步，失败可整体回滚） ——
  const teacher = db
    .select()
    .from(teachers)
    .where(eq(teachers.loginName, teacherLogin))
    .get();

  // —— 幂等检查 / --reset 清空（语义：该教师域内已有种子学生；按 displayName
  //    识别——多教师避让只改登录名，displayName 恒为种子名） ——
  if (teacher !== undefined) {
    const hasSeed = db
      .select({
        loginName: students.loginName,
        displayName: students.displayName,
      })
      .from(students)
      .where(eq(students.teacherId, teacher.id))
      .all()
      .some(isSeedStudentRow);
    if (hasSeed && !reset) {
      console.error(
        `教师「${teacherLogin}」域内已有种子数据。重新播种请加 --reset（将清空该教师域内全部业务数据，不影响其他教师）。`,
      );
      process.exit(2);
    }
    if (reset) {
      wipeTeacherDomain(db, teacher.id);
      console.log(`--reset：已清空教师「${teacherLogin}」域内的全部业务数据。`);
    }
  } else if (reset) {
    console.log(
      `--reset：教师「${teacherLogin}」不存在，域内无数据可清，将直接创建并播种。`,
    );
  }

  // —— 全局登录名预检（students.login_name 全局唯一、不按教师分片；提前说明避让） ——
  const adjustments = SEED_STUDENT_LOGIN_NAMES.map((base) => ({
    base,
    resolved: resolveSeedStudentLoginName(db, base),
  })).filter((item) => item.resolved !== item.base);
  if (adjustments.length > 0) {
    console.log(
      "提示：以下种子登录名已被库中其他学生占用（学生登录名全局唯一），将自动使用带数字后缀的登录名（显示名与密码不变）：",
    );
    for (const { base, resolved } of adjustments) {
      console.log(`  ${base} → ${resolved}`);
    }
  }

  // —— 播种（时间轴相对当前时刻生成，数据总是「最近」的；定位/新建教师 +
  //    种数据一步完成，新建教师失败时自动回滚教师行与已写入的部分种子数据） ——
  const { initialPassword, seed } = await createDemoTeacherAndSeed(
    db,
    teacherLogin,
  );
  console.log("演示数据播种完成：");
  const studentLine = [seed.students.s1, seed.students.s2, seed.students.s3]
    .map((s) =>
      s.loginName === s.name ? s.name : `${s.name}（登录名 ${s.loginName}）`,
    )
    .join("、");
  console.log(
    `  学生：${studentLine}（密码均为 demo-pass-123${
      adjustments.length > 0 ? "，登录名避让不影响密码" : ""
    }）`,
  );
  console.log(`  课程：${seed.courses.a.name}、${seed.courses.b.name}`);
  console.log(
    `  作业：${seed.assignments.a1.name} / ${seed.assignments.a2.name} / ${seed.assignments.a3.name} / ${seed.assignments.a4.name}`,
  );
  console.log(
    "  含课程练习重做 2 次、未作答与手写待批题、提示与离线标记、讲义阅读事件",
  );
  if (initialPassword !== null) {
    console.log(`\n已创建演示教师：${teacherLogin}`);
    console.log(`初始密码（仅本次显示，请立即保存）：${initialPassword}`);
  } else {
    console.log(`\n教师「${teacherLogin}」已有密码，按原密码登录即可。`);
  }
  console.log(`\n数据库：${dbPath}`);
  console.log(
    "登录后可在「学情」页（/t/insights，T4.2 上线后）或 /api/teacher/analytics/* 查看数据。",
  );
} catch (error) {
  console.error(
    `播种失败：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
} finally {
  db.$client.close();
}

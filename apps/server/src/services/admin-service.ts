import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  AdminOverviewData,
  AdminSettingsData,
  AdminSettingsUpdateRequest,
  AdminTeacherCreateData,
  AdminTeacherCreateRequest,
  AdminTeacherListData,
  AdminTeacherResetPasswordRequest,
  AdminTeacherSummary,
  AdminTeacherUpdateRequest,
} from "@tutor/contract";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { hashPassword } from "../auth/password";
import type { Db } from "../db/client";
import { attempts, students, type Teacher, teachers } from "../db/schema";
import { HttpError } from "../lib/http-error";
import {
  isRegistrationOpen,
  setRegistrationOpen,
} from "./app-settings-service";

/**
 * 管理端领域服务（T2B.6，D3/D19/D20）：教师账号管理常用集（创建/改登录名/
 * 授予撤销 isAdmin/禁用启用/重置密码）+ 注册开关读写 + 概览聚合计数。
 * 路由层挂 requireAdmin（D7），业务规则都在这里。
 * 管理员没有任何业务数据权限（D19）：不提供任何按教师查题库/课程/学生明细的入口，
 * 学生只以计数出现（D20）。
 */

/** 随机初始密码长度（§4.4：默认生成 12 位随机密码） */
const TEACHER_INITIAL_PASSWORD_LENGTH = 12;

/** 随机初始密码字符集：去掉 0/O/1/l/I 等易混淆字符（与学生初始密码同口径） */
const TEACHER_INITIAL_PASSWORD_ALPHABET =
  "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

/** 生成教师随机初始密码（12 位，满足 teacherPasswordSchema 的 8 位下限） */
function generateInitialPassword(): string {
  const bytes = randomBytes(TEACHER_INITIAL_PASSWORD_LENGTH);
  let password = "";
  for (let i = 0; i < TEACHER_INITIAL_PASSWORD_LENGTH; i++) {
    const byte = bytes[i] ?? 0;
    password +=
      TEACHER_INITIAL_PASSWORD_ALPHABET[
        byte % TEACHER_INITIAL_PASSWORD_ALPHABET.length
      ];
  }
  return password;
}

/** 未禁用（活跃）管理员数——LAST_ADMIN 硬约束的判断基准（D3） */
function activeAdminCount(db: Db): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(teachers)
    .where(and(eq(teachers.isAdmin, true), isNull(teachers.disabledAt)))
    .get();
  return row?.n ?? 0;
}

/** 按 id 取教师行；不存在 → 404 TEACHER_NOT_FOUND */
function requireTeacherRow(db: Db, id: string): Teacher {
  const row = db.select().from(teachers).where(eq(teachers.id, id)).get();
  if (!row) {
    throw new HttpError(404, "TEACHER_NOT_FOUND", "教师不存在");
  }
  return row;
}

/** 各教师的学生总数（含已归档；一次分组查询，避免逐行 count） */
function studentCountByTeacher(db: Db): Map<string, number> {
  const rows = db
    .select({
      teacherId: students.teacherId,
      n: sql<number>`count(*)`,
    })
    .from(students)
    .groupBy(students.teacherId)
    .all();
  return new Map(rows.map((row) => [row.teacherId ?? "", row.n] as const));
}

/** 教师行 → 管理端摘要 */
function toSummary(row: Teacher, studentCount: number): AdminTeacherSummary {
  return {
    id: row.id,
    // 列可空仅因迁移口径（D9 同款），各创建入口恒写非空，读侧视为必有
    loginName: row.loginName ?? "",
    isAdmin: row.isAdmin,
    disabledAt: row.disabledAt,
    createdAt: row.createdAt,
    studentCount,
  };
}

/** GET /api/admin/teachers：教师列表（createdAt 升序稳定排序；可按状态筛选） */
export function listTeachers(
  db: Db,
  status: "all" | "active" | "disabled",
): AdminTeacherListData {
  const where =
    status === "active"
      ? isNull(teachers.disabledAt)
      : status === "disabled"
        ? isNotNull(teachers.disabledAt)
        : undefined;
  const rows = db
    .select()
    .from(teachers)
    .where(where)
    .orderBy(asc(teachers.createdAt), asc(teachers.id))
    .all();
  const counts = studentCountByTeacher(db);
  return {
    teachers: rows.map((row) => toSummary(row, counts.get(row.id) ?? 0)),
  };
}

/**
 * POST /api/admin/teachers：管理员创建教师（D3 来源二，不受注册开关影响）。
 * password 未提供时生成 12 位随机密码（一次性明文随响应返回，§4.4）。
 */
export async function createTeacher(
  db: Db,
  request: AdminTeacherCreateRequest,
): Promise<AdminTeacherCreateData> {
  const conflict = db
    .select({ id: teachers.id })
    .from(teachers)
    .where(eq(teachers.loginName, request.loginName))
    .get();
  if (conflict) {
    throw new HttpError(
      409,
      "TEACHER_LOGIN_EXISTS",
      "登录名已被使用，请换一个",
    );
  }

  const provided = request.password;
  const password = provided ?? generateInitialPassword();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.insert(teachers)
    .values({
      id,
      loginName: request.loginName,
      isAdmin: false,
      disabledAt: null,
      passwordHash: await hashPassword(password),
      apiToken: null,
      createdAt,
    })
    .run();

  const row = requireTeacherRow(db, id);
  return {
    teacher: toSummary(row, 0),
    // 管理员自备密码时为 null（管理员自己已知）；生成时返回一次性明文
    initialPassword: provided == null ? password : null,
  };
}

/**
 * PATCH /api/admin/teachers/:id：改登录名 / 授予撤销 isAdmin（缺省 = 不改）。
 * 硬约束（D3）：撤销会使系统失去管理入口时 → 409 LAST_ADMIN——
 * 目标当前是未禁用的管理员，且活跃管理员只剩这一位。
 */
export function updateTeacher(
  db: Db,
  id: string,
  request: AdminTeacherUpdateRequest,
): AdminTeacherSummary {
  const row = requireTeacherRow(db, id);

  if (request.loginName !== undefined && request.loginName !== row.loginName) {
    const conflict = db
      .select({ id: teachers.id })
      .from(teachers)
      .where(eq(teachers.loginName, request.loginName))
      .get();
    if (conflict && conflict.id !== id) {
      throw new HttpError(
        409,
        "TEACHER_LOGIN_EXISTS",
        "登录名已被使用，请换一个",
      );
    }
  }
  if (
    request.isAdmin === false &&
    row.isAdmin &&
    row.disabledAt == null &&
    activeAdminCount(db) <= 1
  ) {
    throw new HttpError(
      409,
      "LAST_ADMIN",
      "系统至少需要一位可用的管理员，请先授予其他教师管理员权限",
    );
  }

  const nextLoginName = request.loginName ?? row.loginName;
  const nextIsAdmin = request.isAdmin ?? row.isAdmin;
  if (nextLoginName !== row.loginName || nextIsAdmin !== row.isAdmin) {
    db.update(teachers)
      .set({ loginName: nextLoginName, isAdmin: nextIsAdmin })
      .where(eq(teachers.id, id))
      .run();
  }
  return toSummary(requireTeacherRow(db, id), studentCountOf(db, id));
}

/** 单个教师的学生数（更新/禁用响应用） */
function studentCountOf(db: Db, teacherId: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(students)
    .where(eq(students.teacherId, teacherId))
    .get();
  return row?.n ?? 0;
}

/**
 * POST /api/admin/teachers/:id/disable：禁用（D5——disabledAt 置值，可逆的人事动作）。
 * 硬约束（D3，验收「LAST_ADMIN 三分支」之一/之二）：
 * - 不能禁用自己（admin 账号一旦自禁将失去恢复入口）→ 409 LAST_ADMIN；
 * - 目标是最后一位未禁用的管理员 → 409 LAST_ADMIN。
 */
export function disableTeacher(
  db: Db,
  id: string,
  actingAdminId: string,
): AdminTeacherSummary {
  const row = requireTeacherRow(db, id);
  if (id === actingAdminId) {
    throw new HttpError(409, "LAST_ADMIN", "不能停用自己");
  }
  if (row.isAdmin && row.disabledAt == null && activeAdminCount(db) <= 1) {
    throw new HttpError(
      409,
      "LAST_ADMIN",
      "系统至少需要一位可用的管理员，请先授予其他教师管理员权限",
    );
  }
  if (row.disabledAt == null) {
    db.update(teachers)
      .set({ disabledAt: new Date().toISOString() })
      .where(eq(teachers.id, id))
      .run();
  }
  return toSummary(requireTeacherRow(db, id), studentCountOf(db, id));
}

/** POST /api/admin/teachers/:id/enable：重新启用（完全恢复原状，D5） */
export function enableTeacher(db: Db, id: string): AdminTeacherSummary {
  requireTeacherRow(db, id);
  db.update(teachers)
    .set({ disabledAt: null })
    .where(eq(teachers.id, id))
    .run();
  return toSummary(requireTeacherRow(db, id), studentCountOf(db, id));
}

/**
 * POST /api/admin/teachers/:id/reset-password：重置密码。
 * password 未提供时生成 12 位随机密码；响应返回一次性明文（§4.4——需线下告知对方）。
 * 重置不吊销既有会话（与登录失败同口径：会话有效期由 Cookie 生命周期决定）。
 */
export async function resetTeacherPassword(
  db: Db,
  id: string,
  request: AdminTeacherResetPasswordRequest,
): Promise<{ password: string }> {
  requireTeacherRow(db, id);
  const password = request.password ?? generateInitialPassword();
  db.update(teachers)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(teachers.id, id))
    .run();
  return { password };
}

// ---------- 注册开关（D8） ----------

/** GET /api/admin/settings：注册开关当前状态 */
export function getAdminSettings(db: Db): AdminSettingsData {
  return { allowRegistration: isRegistrationOpen(db) };
}

/** PATCH /api/admin/settings：切换注册开关（登录页注册入口随 status 联动） */
export function updateAdminSettings(
  db: Db,
  request: AdminSettingsUpdateRequest,
): AdminSettingsData {
  setRegistrationOpen(db, request.allowRegistration);
  return getAdminSettings(db);
}

// ---------- 概览（D20：只返回聚合计数，无任何明细） ----------

/** 表行数（count(*)） */
function countOf(
  db: Db,
  table: typeof teachers | typeof students | typeof attempts,
): number {
  const row = db.select({ n: sql<number>`count(*)` }).from(table).get();
  return row?.n ?? 0;
}

/** 共享目录 .md 文件数（T2B.7 起有内容；目录未建或不可读为 0） */
function sharedFileCount(dataDir: string): number {
  const dir = join(dataDir, "shared");
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/** GET /api/admin/overview：聚合计数（教师/学生/作答/共享文件/注册开关） */
export function adminOverview(db: Db, dataDir: string): AdminOverviewData {
  const activeTeacherRow = db
    .select({ n: sql<number>`count(*)` })
    .from(teachers)
    .where(isNull(teachers.disabledAt))
    .get();
  return {
    teacherCount: countOf(db, teachers),
    activeTeacherCount: activeTeacherRow?.n ?? 0,
    studentCount: countOf(db, students),
    attemptCount: countOf(db, attempts),
    sharedFileCount: sharedFileCount(dataDir),
    registrationOpen: isRegistrationOpen(db),
  };
}

// 供测试与路由层直接操纵 app_settings 行的辅助不在此暴露——开关读写一律经
// app-settings-service，保证 upsert 语义唯一。

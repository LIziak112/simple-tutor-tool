import { randomUUID } from "node:crypto";
import type { TeacherInfo, TeacherStatusData } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { teachers } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { hashPassword, verifyPassword } from "./password";
import {
  clearLoginFailures,
  isLoginLocked,
  loginFailureKeys,
  recordLoginFailure,
} from "./rate-limit";
import { createTeacherSession, pruneExpiredSessions } from "./session";

/**
 * 教师鉴权领域服务（T1.9）。教师单行设计：全系统只有一位老师。
 * 路由层只做「鉴权 → 校验 → 调 service → 包装响应」，业务规则都在这里。
 */

/** 限流用的登录名（单教师系统的固定登录名；T2.1 学生登录换成各自 loginName） */
const TEACHER_LOGIN_NAME = "teacher";

/** 教师行（teachers 单行设计，取第一行；不存在返回 null） */
function getTeacherRow(db: Db) {
  return db.select().from(teachers).get();
}

/** 是否已设置教师（存在且已设置密码才算「有教师」；无密码的占位行不算） */
export function teacherStatus(db: Db): TeacherStatusData {
  return { hasTeacher: getTeacherRow(db)?.passwordHash != null };
}

/** setup 成功 / login 成功的返回：教师信息 + 会话 token（由路由写入 Cookie） */
interface AuthResult {
  teacher: TeacherInfo;
  token: string;
}

/**
 * 首次启动设置密码（仅无教师时可用）。
 * 已设置过 → 409 TEACHER_EXISTS。成功后自动登录（签发会话）。
 */
export async function setupTeacher(
  db: Db,
  password: string,
): Promise<AuthResult> {
  const existing = getTeacherRow(db);
  if (existing?.passwordHash) {
    throw new HttpError(409, "TEACHER_EXISTS", "教师已设置，请直接登录");
  }

  const passwordHash = await hashPassword(password);
  // 复用可能存在的无密码占位行，否则新建（id/createdAt 一经确定不再变）。
  // loginName/isAdmin（D4）：setup 创建的必是第一位教师 = 管理员；T2B.2 起登录名
  // 改由表单提供，本处写入随之为请求值。
  const id = existing?.id ?? randomUUID();
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  if (existing) {
    db.update(teachers)
      .set({ passwordHash, loginName: "teacher", isAdmin: true })
      .where(eq(teachers.id, id))
      .run();
  } else {
    db.insert(teachers)
      .values({
        id,
        loginName: "teacher",
        isAdmin: true,
        disabledAt: null,
        passwordHash,
        apiToken: null,
        createdAt,
      })
      .run();
  }

  pruneExpiredSessions(db);
  const { token } = createTeacherSession(db, id);
  return { teacher: { id, createdAt }, token };
}

/**
 * 密码登录。
 * 顺序：先查锁定（§5.7），再验密码；密码错误统一 INVALID_CREDENTIALS
 * （不区分「无此教师」，防枚举）；成功清零限流计数并签发会话。
 */
export async function loginTeacher(
  db: Db,
  password: string,
  ip: string,
): Promise<AuthResult> {
  const keys = loginFailureKeys(TEACHER_LOGIN_NAME, ip);
  if (isLoginLocked(db, keys)) {
    // 只提示锁定，不泄露是哪个 key、还剩几次以外的信息
    throw new HttpError(
      429,
      "LOCKED",
      "失败次数过多，已临时锁定，请约 10 分钟后再试",
    );
  }

  const row = getTeacherRow(db);
  const passwordOk = row?.passwordHash
    ? await verifyPassword(password, row.passwordHash)
    : false;
  if (!row || !passwordOk) {
    for (const key of keys) {
      recordLoginFailure(db, key);
    }
    throw new HttpError(401, "INVALID_CREDENTIALS", "密码不正确");
  }

  clearLoginFailures(db, keys);
  pruneExpiredSessions(db);
  const { token } = createTeacherSession(db, row.id);
  return { teacher: { id: row.id, createdAt: row.createdAt }, token };
}

/** 按教师 id 取教师信息（requireTeacher 中间件用；教师已不存在 → null） */
export function getTeacherInfo(db: Db, teacherId: string): TeacherInfo | null {
  const row = db
    .select()
    .from(teachers)
    .where(eq(teachers.id, teacherId))
    .get();
  return row?.passwordHash ? { id: row.id, createdAt: row.createdAt } : null;
}

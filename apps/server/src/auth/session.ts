import { randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { sessions } from "../db/schema";

/**
 * 会话服务（老师与学生共用 sessions 表，§5.7）。
 * Cookie 名 tutor_session，值即 sessions.id：
 * - token = randomBytes(32).toString("base64url")（256 位随机，熵高于 UUID）；
 * - 不给 sessions 表加列（T0.5 建好的结构不动），token 直接作主键；
 * - Cookie 属性 httpOnly + SameSite=Lax + Path=/ + Max-Age（与会话 TTL 对齐），
 *   PUBLIC_URL 为 https 时加 Secure；
 * - 滑动续期：守卫校验通过时 touchSession + 重设 Cookie（见 require-teacher /
 *   require-student），活跃用户「最后一次活动 + TTL」内不掉线。
 */

/** 会话 Cookie 名（老师与学生同一种 Cookie） */
export const SESSION_COOKIE = "tutor_session";

/** 教师会话有效期：7 天（学生 90 天见 STUDENT_SESSION_TTL_MS；调整改这里） */
export const TEACHER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 学生会话有效期：90 天（§5.7，T2.1；学生登录低频，长会话减少重新登录摩擦） */
export const STUDENT_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** PUBLIC_URL 是否为 https（决定 Cookie 加不加 Secure） */
export function isSecurePublicUrl(publicUrl: string): boolean {
  return publicUrl.startsWith("https://");
}

/**
 * 会话 Cookie 属性（写入与续期共用，Path 必须一致才能删得掉）。
 * ttlMs 给定时同时设置 Max-Age（秒）——持久化 Cookie，浏览器关闭后登录态仍在
 * （缺省不设 Max-Age，登出清除用：deleteCookie 自带 Max-Age=0）。
 */
export function sessionCookieOptions(isSecure: boolean, ttlMs?: number) {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    path: "/",
    secure: isSecure,
    ...(ttlMs === undefined ? {} : { maxAge: Math.floor(ttlMs / 1000) }),
  };
}

/** 创建教师会话，返回 token（写入 Cookie）与过期时间 */
export function createTeacherSession(
  db: Db,
  teacherId: string,
): { token: string; expiresAt: string } {
  return insertSession(db, "teacher", teacherId, TEACHER_SESSION_TTL_MS);
}

/** 创建学生会话（T2.1，有效期 90 天），返回 token 与过期时间 */
export function createStudentSession(
  db: Db,
  studentId: string,
): { token: string; expiresAt: string } {
  return insertSession(db, "student", studentId, STUDENT_SESSION_TTL_MS);
}

/** 写入一条会话行（教师/学生共用，token 即主键） */
function insertSession(
  db: Db,
  subjectType: "teacher" | "student",
  subjectId: string,
  ttlMs: number,
): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = new Date(now + ttlMs).toISOString();
  db.insert(sessions)
    .values({
      id: token,
      subjectType,
      subjectId,
      expiresAt,
      createdAt: new Date(now).toISOString(),
    })
    .run();
  return { token, expiresAt };
}

/**
 * 按会话 token 查询教师 id。
 * token 不存在 / 不是教师会话 / 已过期 → null。
 * expiresAt 是 UTC ISO 字符串，等长格式下字典序即时间序，可直接比较。
 */
export function getTeacherSession(
  db: Db,
  token: string,
): { teacherId: string } | null {
  const row = db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.id, token),
        eq(sessions.subjectType, "teacher"),
        gt(sessions.expiresAt, new Date().toISOString()),
      ),
    )
    .get();
  return row ? { teacherId: row.subjectId } : null;
}

/**
 * 按会话 token 查询学生 id（T2.1）。
 * token 不存在 / 不是学生会话（教师会话同 Cookie 也过不了）/ 已过期 → null。
 * 注意「学生是否仍存在且未归档」由 requireStudent 守卫另行校验（归档学生会话立即失效）。
 */
export function getStudentSession(
  db: Db,
  token: string,
): { studentId: string } | null {
  const row = db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.id, token),
        eq(sessions.subjectType, "student"),
        gt(sessions.expiresAt, new Date().toISOString()),
      ),
    )
    .get();
  return row ? { studentId: row.subjectId } : null;
}

/**
 * 滑动续期：守卫校验通过时调用，把会话寿命重置为「now + ttl」。
 * 必须与重设 Cookie 的 Max-Age 成对出现（见 require-teacher / require-student），
 * 否则浏览器侧 Cookie 到期即停发，DB 续了也白续。
 */
export function touchSession(db: Db, token: string, ttlMs: number): void {
  db.update(sessions)
    .set({ expiresAt: new Date(Date.now() + ttlMs).toISOString() })
    .where(eq(sessions.id, token))
    .run();
}

/** 删除会话（登出） */
export function deleteSession(db: Db, token: string): void {
  db.delete(sessions).where(eq(sessions.id, token)).run();
}

/** 清理已过期的会话行（登录时顺带调用，防表膨胀） */
export function pruneExpiredSessions(db: Db): void {
  db.delete(sessions)
    .where(lt(sessions.expiresAt, new Date().toISOString()))
    .run();
}

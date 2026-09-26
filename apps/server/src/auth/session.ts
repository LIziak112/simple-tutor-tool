import { randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { sessions } from "../db/schema";

/**
 * 会话服务（老师与学生共用 sessions 表，§5.7）。
 * Cookie 名 tutor_session，值即 sessions.id：
 * - token = randomBytes(32).toString("base64url")（256 位随机，熵高于 UUID）；
 * - 不给 sessions 表加列（T0.5 建好的结构不动），token 直接作主键；
 * - Cookie 属性 httpOnly + SameSite=Lax + Path=/，PUBLIC_URL 为 https 时加 Secure。
 */

/** 会话 Cookie 名（老师与学生同一种 Cookie） */
export const SESSION_COOKIE = "tutor_session";

/** 教师会话有效期：7 天（学生 90 天是 T2.1 的事；调整改这里） */
export const TEACHER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** PUBLIC_URL 是否为 https（决定 Cookie 加不加 Secure） */
export function isSecurePublicUrl(publicUrl: string): boolean {
  return publicUrl.startsWith("https://");
}

/** 会话 Cookie 属性（写入与清除共用，Path 必须一致才能删得掉） */
export function sessionCookieOptions(isSecure: boolean) {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    path: "/",
    secure: isSecure,
  };
}

/** 创建教师会话，返回 token（写入 Cookie）与过期时间 */
export function createTeacherSession(
  db: Db,
  teacherId: string,
): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = new Date(now + TEACHER_SESSION_TTL_MS).toISOString();
  db.insert(sessions)
    .values({
      id: token,
      subjectType: "teacher",
      subjectId: teacherId,
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

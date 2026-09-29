import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { loginFailures } from "../db/schema";

/**
 * 登录限流（§5.7：同一 IP / 同一登录名连续失败 5 次锁定 10 分钟）。
 * login_failures 表按 key 记数：`name:<登录名>` 与 `ip:<IP>` 双 key 独立计数，
 * 任一 key 触发锁定即拒绝登录；成功登录清零全部相关 key。
 * 锁过期后计数重新从 0 开始（不累计历史失败）。
 */

/** 连续失败达到该次数即锁定 */
export const MAX_LOGIN_FAILURES = 5;

/** 锁定时长（毫秒） */
export const LOGIN_LOCK_MS = 10 * 60 * 1000;

/** 限流 key：按登录名与按 IP 各一条（教师登录用） */
export function loginFailureKeys(loginName: string, ip: string): string[] {
  return [`name:${loginName}`, `ip:${ip}`];
}

/**
 * 学生登录限流 key（T2.1）：与教师 key 命名空间隔离（教师固定登录名 teacher，
 * 学生登录名是各自姓名，不隔离会互相污染计数）。同样按登录名与按 IP 双 key。
 */
export function studentLoginFailureKeys(
  loginName: string,
  ip: string,
): string[] {
  return [`student:name:${loginName}`, `student:ip:${ip}`];
}

/** 任一 key 处于锁定期 → true */
export function isLoginLocked(db: Db, keys: string[]): boolean {
  const now = new Date().toISOString();
  for (const key of keys) {
    const row = db
      .select()
      .from(loginFailures)
      .where(eq(loginFailures.key, key))
      .get();
    if (row?.lockedUntil && row.lockedUntil > now) {
      return true;
    }
  }
  return false;
}

/**
 * 记一次失败：计数 +1；达到阈值写 lockedUntil。
 * 仍在锁定期时为 no-op（外层应先查 isLoginLocked 拦截）；
 * 上一轮锁已过期时计数清零重来。
 */
export function recordLoginFailure(db: Db, key: string): void {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const row = db
    .select()
    .from(loginFailures)
    .where(eq(loginFailures.key, key))
    .get();

  if (row?.lockedUntil && row.lockedUntil > nowIso) {
    return;
  }
  // 上一次锁已过期 → 计数重新开始；否则累计
  const previousCount = row?.lockedUntil ? 0 : (row?.count ?? 0);
  const count = previousCount + 1;
  const lockedUntil =
    count >= MAX_LOGIN_FAILURES
      ? new Date(now + LOGIN_LOCK_MS).toISOString()
      : null;

  db.insert(loginFailures)
    .values({ key, count, lockedUntil })
    .onConflictDoUpdate({
      target: loginFailures.key,
      set: { count, lockedUntil },
    })
    .run();
}

/** 成功登录：清零全部相关 key 的失败记录 */
export function clearLoginFailures(db: Db, keys: string[]): void {
  if (keys.length === 0) {
    return;
  }
  db.delete(loginFailures).where(inArray(loginFailures.key, keys)).run();
}

// ---------- 注册限流（T2B.6，D3） ----------

/** 同一 IP 注册尝试上限（1 小时窗口内，含成功尝试——这是防滥用上限，不是失败锁定） */
export const REGISTRATION_MAX_ATTEMPTS = 5;

/** 注册限流锁定时长（毫秒）：1 小时 */
export const REGISTRATION_LOCK_MS = 60 * 60 * 1000;

/** 注册限流 key：按 IP 一条（key 形如 reg:ip:<IP>，与登录 key 命名空间隔离） */
export function registrationAttemptKey(ip: string): string {
  return `reg:ip:${ip}`;
}

/**
 * 记一次注册尝试（不论后续成功与否都计数——与登录的「只记失败」不同：
 * 注册成功同样消耗额度，防止批量建号）。
 * 计数 +1；达到阈值写 lockedUntil（1 小时）。仍在锁定期时为 no-op（外层应先查
 * isLoginLocked 拦截）；上一轮锁已过期时计数清零重来（复用登录限流的口径）。
 */
export function recordRegistrationAttempt(db: Db, key: string): void {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const row = db
    .select()
    .from(loginFailures)
    .where(eq(loginFailures.key, key))
    .get();

  if (row?.lockedUntil && row.lockedUntil > nowIso) {
    return;
  }
  const previousCount = row?.lockedUntil ? 0 : (row?.count ?? 0);
  const count = previousCount + 1;
  const lockedUntil =
    count >= REGISTRATION_MAX_ATTEMPTS
      ? new Date(now + REGISTRATION_LOCK_MS).toISOString()
      : null;

  db.insert(loginFailures)
    .values({ key, count, lockedUntil })
    .onConflictDoUpdate({
      target: loginFailures.key,
      set: { count, lockedUntil },
    })
    .run();
}

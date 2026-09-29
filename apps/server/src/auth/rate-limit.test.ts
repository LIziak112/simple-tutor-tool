import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loginFailures } from "../db/schema.ts";
import { createTestDb } from "../db/test-utils.ts";
import {
  clearLoginFailures,
  isLoginLocked,
  LOGIN_LOCK_MS,
  loginFailureKeys,
  MAX_LOGIN_FAILURES,
  REGISTRATION_LOCK_MS,
  REGISTRATION_MAX_ATTEMPTS,
  recordLoginFailure,
  recordRegistrationAttempt,
  registrationAttemptKey,
} from "./rate-limit.ts";

/**
 * 登录限流单元测试（T1.9，§5.7）：
 * 连续失败 5 次锁定 10 分钟；锁过期后重新计数；成功清零；按 key 独立计数。
 * T2B.6 追加注册限流：同一 IP 1 小时内最多 5 次注册尝试（含成功），超出锁定 1 小时。
 */

describe("recordLoginFailure / isLoginLocked", () => {
  it(`连续失败 ${MAX_LOGIN_FAILURES} 次后锁定，锁截止时间约为 10 分钟后`, () => {
    const db = createTestDb();
    const key = "name:teacher";
    for (let i = 1; i < MAX_LOGIN_FAILURES; i++) {
      recordLoginFailure(db, key);
      expect(isLoginLocked(db, [key])).toBe(false);
      const row = db
        .select()
        .from(loginFailures)
        .where(eq(loginFailures.key, key))
        .get();
      expect(row?.count).toBe(i);
      expect(row?.lockedUntil).toBeNull();
    }
    // 第 5 次：触发锁定
    recordLoginFailure(db, key);
    const row = db
      .select()
      .from(loginFailures)
      .where(eq(loginFailures.key, key))
      .get();
    expect(row?.count).toBe(MAX_LOGIN_FAILURES);
    expect(row?.lockedUntil).not.toBeNull();
    if (row?.lockedUntil) {
      const remaining = Date.parse(row.lockedUntil) - Date.now();
      expect(remaining).toBeGreaterThan(9 * 60 * 1000);
      expect(remaining).toBeLessThanOrEqual(LOGIN_LOCK_MS);
    }
    expect(isLoginLocked(db, [key])).toBe(true);
    db.$client.close();
  });

  it("锁过期后不再算锁定，且计数重新从 1 开始（不累计历史失败）", () => {
    const db = createTestDb();
    const key = "ip:1.2.3.4";
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      recordLoginFailure(db, key);
    }
    expect(isLoginLocked(db, [key])).toBe(true);

    // 把锁截止时间拨回过去，模拟等了 10 分钟
    db.update(loginFailures)
      .set({ lockedUntil: new Date(Date.now() - 1000).toISOString() })
      .where(eq(loginFailures.key, key))
      .run();
    expect(isLoginLocked(db, [key])).toBe(false);

    // 再失败一次：计数应重新为 1（未立即再锁）
    recordLoginFailure(db, key);
    const row = db
      .select()
      .from(loginFailures)
      .where(eq(loginFailures.key, key))
      .get();
    expect(row?.count).toBe(1);
    expect(row?.lockedUntil).toBeNull();
    expect(isLoginLocked(db, [key])).toBe(false);
    db.$client.close();
  });

  it("仍在锁定期时 recordLoginFailure 是 no-op（不延长也不累计）", () => {
    const db = createTestDb();
    const key = "name:teacher";
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      recordLoginFailure(db, key);
    }
    const locked = db
      .select()
      .from(loginFailures)
      .where(eq(loginFailures.key, key))
      .get();
    recordLoginFailure(db, key); // 锁定期间的又一次尝试
    const after = db
      .select()
      .from(loginFailures)
      .where(eq(loginFailures.key, key))
      .get();
    expect(after?.count).toBe(MAX_LOGIN_FAILURES);
    expect(after?.lockedUntil).toBe(locked?.lockedUntil);
    db.$client.close();
  });

  it("name 与 ip 双 key 独立计数，任一 key 锁定即整体锁定", () => {
    const db = createTestDb();
    const keys = loginFailureKeys("teacher", "9.9.9.9");
    expect(keys).toEqual(["name:teacher", "ip:9.9.9.9"]);

    // 只锁 ip key
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      recordLoginFailure(db, "ip:9.9.9.9");
    }
    expect(isLoginLocked(db, keys)).toBe(true);

    // 换一个 IP（name key 计数仍为 0）不锁
    expect(isLoginLocked(db, loginFailureKeys("teacher", "8.8.8.8"))).toBe(
      false,
    );
    db.$client.close();
  });

  it("clearLoginFailures 清空相关 key，计数从头开始", () => {
    const db = createTestDb();
    const keys = loginFailureKeys("teacher", "1.1.1.1");
    for (let i = 0; i < 3; i++) {
      for (const key of keys) {
        recordLoginFailure(db, key);
      }
    }
    clearLoginFailures(db, keys);
    expect(db.select().from(loginFailures).all()).toHaveLength(0);

    // 清零后再失败 4 次不锁（若未清零会立刻锁）
    for (let i = 0; i < MAX_LOGIN_FAILURES - 1; i++) {
      recordLoginFailure(db, "name:teacher");
    }
    expect(isLoginLocked(db, ["name:teacher"])).toBe(false);
    db.$client.close();
  });
});

describe("recordRegistrationAttempt（T2B.6 注册限流，D3）", () => {
  it("key 形如 reg:ip:<IP>；前 5 次尝试计数递增且不锁，第 5 次写 1 小时锁", () => {
    const db = createTestDb();
    const key = registrationAttemptKey("10.2.3.4");
    expect(key).toBe("reg:ip:10.2.3.4");

    for (let i = 1; i < REGISTRATION_MAX_ATTEMPTS; i++) {
      recordRegistrationAttempt(db, key);
      expect(isLoginLocked(db, [key])).toBe(false);
      const row = db
        .select()
        .from(loginFailures)
        .where(eq(loginFailures.key, key))
        .get();
      expect(row?.count).toBe(i);
      expect(row?.lockedUntil).toBeNull();
    }
    // 第 5 次尝试本身放行（锁定自此才生效），锁截止时间约为 1 小时后
    recordRegistrationAttempt(db, key);
    const row = db
      .select()
      .from(loginFailures)
      .where(eq(loginFailures.key, key))
      .get();
    expect(row?.count).toBe(REGISTRATION_MAX_ATTEMPTS);
    expect(row?.lockedUntil).not.toBeNull();
    if (row?.lockedUntil) {
      const remaining = Date.parse(row.lockedUntil) - Date.now();
      expect(remaining).toBeGreaterThan(55 * 60 * 1000);
      expect(remaining).toBeLessThanOrEqual(REGISTRATION_LOCK_MS);
    }
    expect(isLoginLocked(db, [key])).toBe(true);
    db.$client.close();
  });

  it("尝试计数与登录失败计数同 key 命名空间隔离（reg: 前缀），互不污染", () => {
    const db = createTestDb();
    // 同一 IP：登录失败 5 次（ip key 锁）不影响注册尝试，反之亦然
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      recordLoginFailure(db, "ip:10.5.5.5");
    }
    expect(isLoginLocked(db, ["ip:10.5.5.5"])).toBe(true);
    expect(isLoginLocked(db, [registrationAttemptKey("10.5.5.5")])).toBe(false);

    for (let i = 0; i < REGISTRATION_MAX_ATTEMPTS; i++) {
      recordRegistrationAttempt(db, registrationAttemptKey("10.5.5.5"));
    }
    expect(isLoginLocked(db, [registrationAttemptKey("10.5.5.5")])).toBe(true);
    // 两行各自独立
    expect(db.select().from(loginFailures).all()).toHaveLength(2);
    db.$client.close();
  });

  it("锁过期后计数清零重来（与登录限流同口径）", () => {
    const db = createTestDb();
    const key = registrationAttemptKey("10.6.6.6");
    for (let i = 0; i < REGISTRATION_MAX_ATTEMPTS; i++) {
      recordRegistrationAttempt(db, key);
    }
    expect(isLoginLocked(db, [key])).toBe(true);

    db.update(loginFailures)
      .set({ lockedUntil: new Date(Date.now() - 1000).toISOString() })
      .where(eq(loginFailures.key, key))
      .run();
    expect(isLoginLocked(db, [key])).toBe(false);

    recordRegistrationAttempt(db, key);
    const row = db
      .select()
      .from(loginFailures)
      .where(eq(loginFailures.key, key))
      .get();
    expect(row?.count).toBe(1);
    expect(row?.lockedUntil).toBeNull();
    db.$client.close();
  });
});

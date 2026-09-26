import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.ts";

/**
 * scrypt 密码哈希单元测试（T1.9）：
 * 存储格式 `scrypt$N$r$p$salt$hash`、随机盐、timingSafeEqual 校验、脏数据不抛错。
 */

describe("hashPassword / verifyPassword", () => {
  it("哈希格式为 scrypt$16384$8$1$<盐hex>$<哈希hex>，不包含明文密码", async () => {
    const stored = await hashPassword("correct horse battery");
    const parts = stored.split("$");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("scrypt");
    expect(parts[1]).toBe("16384");
    expect(parts[2]).toBe("8");
    expect(parts[3]).toBe("1");
    expect(parts[4]).toMatch(/^[0-9a-f]{32}$/); // 16 字节盐
    expect(parts[5]).toMatch(/^[0-9a-f]{128}$/); // 64 字节哈希
    expect(stored).not.toContain("correct");
  });

  it("同一密码两次哈希盐不同（存储串不同），但都能通过校验", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("错误密码返回 false", async () => {
    const stored = await hashPassword("right-password");
    expect(await verifyPassword("wrong-password", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("存储串损坏（格式错 / 参数非整数 / 非法 hex）返回 false 而不是抛错", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "scrypt$abc$8$1$aa$bb")).toBe(false);
    expect(await verifyPassword("x", "scrypt$16384$8$1$zzzz$bbbb")).toBe(false);
    expect(await verifyPassword("x", "scrypt$16384$8$1$abcd$")).toBe(false);
  });
});

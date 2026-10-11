/**
 * contentHash64 两条路径：安全上下文走 crypto.subtle SHA-256；HTTP 等
 * 非安全上下文（crypto.subtle 为 undefined）降级为确定性 FNV-1a，仍输出
 * 64 位小写 hex（annotationHashSchema 形状）。
 * 圈画底图签名曾因裸调 crypto.subtle.digest 在 http://IP 部署下全挂
 * （2026-10 修复的回归锁）；uuid.test.ts 藏 randomUUID 同理。
 */
import { annotationHashSchema } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { contentHash64 } from "./content-hash";

/** 临时把 crypto.subtle 藏起来，模拟非安全上下文（恢复用返回函数）。
 * 不依赖 subtle 实际挂在原型还是实例上（Node/jsdom 实现各异）：
 * 实例上定义 undefined 影子属性即可遮住原型访问器。 */
function hideSubtle(): () => void {
  const cryptoObject = crypto as { subtle?: unknown };
  const own = Object.getOwnPropertyDescriptor(cryptoObject, "subtle");
  Object.defineProperty(cryptoObject, "subtle", {
    configurable: true,
    value: undefined,
  });
  return () => {
    if (own) Object.defineProperty(cryptoObject, "subtle", own);
    else delete cryptoObject.subtle;
  };
}

describe("contentHash64", () => {
  it("安全上下文：与 crypto.subtle SHA-256 逐字节一致且形状合法", async () => {
    const value = { type: "fill", stemMd: "甲 [[]]", options: [] };
    const expected = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(value)),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const actual = await contentHash64(value);
    expect(actual).toBe(expected);
    expect(annotationHashSchema.safeParse(actual).success).toBe(true);
  });

  it("crypto.subtle 缺失（HTTP 非安全上下文）时降级：不抛错、形状合法、确定性", async () => {
    const restore = hideSubtle();
    try {
      expect((crypto as { subtle?: unknown }).subtle).toBeUndefined();
      const first = await contentHash64({ a: [1, 2, 3] });
      const second = await contentHash64({ a: [1, 2, 3] });
      const other = await contentHash64({ a: [1, 2, 4] });
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(annotationHashSchema.safeParse(first).success).toBe(true);
      expect(second).toBe(first);
      expect(other).not.toBe(first);
    } finally {
      restore();
    }
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { randomUuid } from "./uuid";

/**
 * randomUuid 两条路径：安全上下文直用 crypto.randomUUID；HTTP 等非安全
 * 上下文该 API 缺失时降级 getRandomValues 手搓 v4（线上 http://IP 部署
 * 曾因裸调 randomUUID 抛 TypeError，2026-10 修复的回归锁）。
 */

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 临时把 crypto.randomUUID 藏起来，模拟非安全上下文（恢复用返回函数）。
 * 不依赖 randomUUID 实际挂在原型还是实例上（Node/jsdom 实现各异）：
 * 统一在实例上定义 undefined 自有属性遮蔽一切来源。 */
function hideRandomUuid(): () => void {
  const cryptoObject = crypto as { randomUUID?: unknown };
  const own = Object.getOwnPropertyDescriptor(cryptoObject, "randomUUID");
  Object.defineProperty(cryptoObject, "randomUUID", {
    configurable: true,
    value: undefined,
  });
  return () => {
    if (own === undefined) {
      delete cryptoObject.randomUUID;
    } else {
      Object.defineProperty(cryptoObject, "randomUUID", own);
    }
  };
}

describe("randomUuid（安全/非安全上下文通用）", () => {
  const restores: Array<() => void> = [];

  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
  });

  it("当前环境（安全上下文路径）产出合法 v4 且不重复", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const id = randomUuid();
      expect(id).toMatch(UUID_V4_RE);
      seen.add(id);
    }
    expect(seen.size).toBe(100);
  });

  it("randomUUID 缺失（HTTP 非安全上下文）时降级仍产出合法 v4 且不抛错", () => {
    restores.push(hideRandomUuid());
    expect(typeof crypto.randomUUID).not.toBe("function");
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const id = randomUuid();
      expect(id).toMatch(UUID_V4_RE);
      seen.add(id);
    }
    expect(seen.size).toBe(100);
  });
});

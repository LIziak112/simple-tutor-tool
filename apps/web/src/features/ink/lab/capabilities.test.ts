import { describe, expect, it } from "vitest";
import { probeCapabilities } from "./capabilities.ts";

/**
 * 能力探测纯检测层测试（T6R.1 simplify 下沉后补）：
 * 检测与展示分离——这里只验证结构化结果的形状与不抛错；
 * jsdom 环境的具体值（如 coalescedEvents=false）随环境而定，只锁类型语义。
 */
describe("probeCapabilities", () => {
  it("返回结构化快照且字段类型正确", () => {
    const c = probeCapabilities();
    expect(typeof c.coalescedEvents).toBe("boolean");
    expect(typeof c.pointerrawupdate).toBe("boolean");
    expect(typeof c.inkApi).toBe("boolean");
    expect(typeof c.clipboard).toBe("boolean");
    expect(["yes", "no", "unknown"]).toContain(c.canvasDesynchronized);
    // jsdom 有 location；协议为字符串或 null，不抛错即可
    expect(c.protocol === null || c.protocol.startsWith("http")).toBe(true);
  });

  it("结果不随 UA 字符串变化（行为级证明：不以 UA 推断能力）", () => {
    const before = probeCapabilities();
    const orig = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", {
      value:
        "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
      configurable: true,
    });
    try {
      expect(probeCapabilities()).toEqual(before);
    } finally {
      Object.defineProperty(navigator, "userAgent", {
        value: orig,
        configurable: true,
      });
    }
  });
});

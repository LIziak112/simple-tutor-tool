import { describe, expect, it } from "vitest";
import { publicConfigDataSchema } from "./public-config.ts";

/** 运行时公开配置契约测试（T2.12）：字段、类型与拒绝口径 */

describe("publicConfigDataSchema", () => {
  it("接受 { pwaEnabled, publicUrl } 完整结构", () => {
    const parsed = publicConfigDataSchema.safeParse({
      pwaEnabled: false,
      publicUrl: "http://localhost:8787",
    });
    expect(parsed.success).toBe(true);
  });

  it("https 配置 pwaEnabled=true 也合法", () => {
    const parsed = publicConfigDataSchema.safeParse({
      pwaEnabled: true,
      publicUrl: "https://tutor.example.com",
    });
    expect(parsed.success).toBe(true);
  });

  it("缺少字段 / 类型不符时拒绝（不静默降级）", () => {
    expect(publicConfigDataSchema.safeParse({ pwaEnabled: true }).success).toBe(
      false,
    );
    expect(
      publicConfigDataSchema.safeParse({
        pwaEnabled: "yes",
        publicUrl: "https://tutor.example.com",
      }).success,
    ).toBe(false);
    expect(
      publicConfigDataSchema.safeParse({
        pwaEnabled: true,
        publicUrl: "",
      }).success,
    ).toBe(false);
  });
});

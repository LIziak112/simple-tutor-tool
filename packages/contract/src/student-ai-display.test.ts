import { describe, expect, it } from "vitest";
import { studentAiDisplayPreferenceSchema } from "./student-ai-display";

describe("学生助教显示偏好契约", () => {
  it("无配置默认题下，三种值均可解析", () => {
    expect(studentAiDisplayPreferenceSchema.parse({})).toEqual({
      version: 1,
      layout: "inline",
    });
    for (const layout of ["inline", "side", "dialog"]) {
      expect(studentAiDisplayPreferenceSchema.parse({ layout }).layout).toBe(
        layout,
      );
    }
  });
  it("拒绝未知版本和布局", () => {
    expect(
      studentAiDisplayPreferenceSchema.safeParse({ version: 2 }).success,
    ).toBe(false);
    expect(
      studentAiDisplayPreferenceSchema.safeParse({ layout: "float" }).success,
    ).toBe(false);
  });
});

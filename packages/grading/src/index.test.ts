import { describe, expect, it } from "vitest";
import { gradeIdentity } from "./index";

describe("@tutor/grading：包骨架占位", () => {
  it("占位判分函数恒等返回（正式判分由后续任务替换）", () => {
    expect(gradeIdentity("42")).toBe("42");
  });
});

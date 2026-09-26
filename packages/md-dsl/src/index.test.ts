import { describe, expect, it } from "vitest";
import { MD_DSL_VERSION } from "./index";

describe("@tutor/md-dsl：包骨架占位", () => {
  it("导出 DSL 版本常量，当前为 v2", () => {
    expect(MD_DSL_VERSION).toBe("2");
  });
});

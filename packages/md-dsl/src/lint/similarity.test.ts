import { describe, expect, it } from "vitest";
import {
  levenshtein,
  suggestAttrKey,
  suggestDirectiveName,
} from "./similarity";

/** 近似名建议（UNKNOWN_DIRECTIVE 消息质量的基础） */

describe("levenshtein", () => {
  it("基础距离", () => {
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("tip", "tip")).toBe(0);
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("tps", "tip")).toBe(2);
    expect(levenshtein("hints", "hint")).toBe(1);
    expect(levenshtein("flaw", "lawn")).toBe(2);
  });

  it("对称性：levenshtein(a,b) === levenshtein(b,a)", () => {
    expect(levenshtein("exampl", "example")).toBe(
      levenshtein("example", "exampl"),
    );
    expect(levenshtein("warnin", "warning")).toBe(1);
  });
});

describe("suggestDirectiveName：从注册表主名+别名中找最近候选", () => {
  it("常见手误都能命中", () => {
    expect(suggestDirectiveName("tps")).toBe("tip");
    expect(suggestDirectiveName("hints")).toBe("hint");
    expect(suggestDirectiveName("boxx")).toBe("box");
    expect(suggestDirectiveName("stepss")).toBe("steps");
    expect(suggestDirectiveName("exampl")).toBe("example");
    expect(suggestDirectiveName("warnin")).toBe("warning");
    expect(suggestDirectiveName("soluton")).toBe("solution");
  });

  it("无相近候选时返回 undefined（不硬凑）", () => {
    expect(suggestDirectiveName("zzzzzz")).toBeUndefined();
    expect(suggestDirectiveName("xyz")).toBeUndefined();
    // 未来的指令名不在注册表里，也找不到相近候选
    expect(suggestDirectiveName("video")).toBeUndefined();
  });

  it("距离并列时优先更短的候选", () => {
    // steps 与 step 距离并列时（如 "step1"：到 step 为 1、到 steps 为 2，不并列），
    // 用 "stepsz"：到 steps 距离 1、到 step 距离 2，应选 steps
    expect(suggestDirectiveName("stepsz")).toBe("steps");
  });
});

describe("suggestAttrKey：属性名近似建议", () => {
  it("常见属性手误", () => {
    expect(suggestAttrKey("titel", ["id", "class", "title"])).toBe("title");
    expect(suggestAttrKey("widht", ["id", "class", "src", "width"])).toBe(
      "width",
    );
    expect(suggestAttrKey("colr", ["id", "class", "color"])).toBe("color");
  });

  it("无相近候选返回 undefined", () => {
    expect(suggestAttrKey("zzz", ["id", "class"])).toBeUndefined();
    expect(suggestAttrKey("id", ["id", "class"])).toBe("id");
  });
});

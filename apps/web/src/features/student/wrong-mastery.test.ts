import type { WrongQuestionCard } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WRONG_MASTERY_STANDARD,
  isConquered,
  loadWrongMasteryStandard,
  saveWrongMasteryStandard,
  splitByMastery,
  WRONG_MASTERY_STORAGE_KEY,
} from "./wrong-mastery";

/**
 * 错题本攻克标准（2026-10 产品决策）：学生自选、存本设备 localStorage、
 * 服务端不下发判定规则。宽松=最后一轮做对即攻克；严格（默认）=最后两轮
 * 连续做对且轮次 ≥2 才攻克（两次在不同练习中——一次练习一题只答一次，
 * 天然满足）。首页概览卡与 /s/wrong 页共用本模块，两处口径一致。
 */

/** 轮次工厂（correct 序列 → rounds；attemptId 递增即可） */
function roundsOf(...corrects: boolean[]): WrongQuestionCard["rounds"] {
  return corrects.map((correct, index) => ({
    attemptId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    sourceType: "course",
    correct,
    submittedAt: `2026-10-0${index + 1}T00:00:00.000Z`,
    sourceTitle: `单元 · 第 ${index + 1} 次`,
    courseId: "00000000-0000-4000-8000-00000000000a",
    courseName: "初一上",
  }));
}

/** 条目工厂（只需 rounds，其余字段与攻克判定无关） */
function cardOf(...corrects: boolean[]): Pick<WrongQuestionCard, "rounds"> {
  return { rounds: roundsOf(...corrects) };
}

describe("isConquered（按标准从轮次史计算）", () => {
  it("宽松：最后一轮做对即攻克", () => {
    expect(isConquered(cardOf(false), "lenient")).toBe(false);
    expect(isConquered(cardOf(false, true), "lenient")).toBe(true);
    expect(isConquered(cardOf(false, true, false), "lenient")).toBe(false);
  });

  it("严格：最后两轮连续做对且轮次 ≥2 才攻克；中间做错重新计数", () => {
    expect(isConquered(cardOf(false), "strict")).toBe(false); // 只做过对一次不算
    expect(isConquered(cardOf(false, true), "strict")).toBe(false); // 只对一次
    expect(isConquered(cardOf(false, true, true), "strict")).toBe(true); // 连续两次对
    expect(isConquered(cardOf(true, true), "strict")).toBe(true);
    expect(isConquered(cardOf(true, false, true, true), "strict")).toBe(true);
    // 错-对-对-错：最后一轮错 → 未攻克（中间连续对被最后的错打断）
    expect(isConquered(cardOf(false, true, true, false), "strict")).toBe(false);
    // 对-错-对：最后一轮对但前一轮错 → 未攻克（重新计数）
    expect(isConquered(cardOf(true, false, true), "strict")).toBe(false);
  });

  it("空轮次（防御）恒未攻克", () => {
    expect(isConquered({ rounds: [] }, "strict")).toBe(false);
    expect(isConquered({ rounds: [] }, "lenient")).toBe(false);
  });
});

describe("splitByMastery（按标准分流）", () => {
  it("严格默认：错-对 与 错-对-对 分居两栏", () => {
    const a = cardOf(false, true); // 严格：待复习
    const b = cardOf(false, true, true); // 严格：已攻克
    const { pending, conquered } = splitByMastery(
      [a, b] as WrongQuestionCard[],
      "strict",
    );
    expect(pending).toEqual([a]);
    expect(conquered).toEqual([b]);
  });

  it("宽松：错-对 也算已攻克（同一数据两标准分组不同）", () => {
    const a = cardOf(false, true);
    const { pending, conquered } = splitByMastery(
      [a] as WrongQuestionCard[],
      "lenient",
    );
    expect(pending).toEqual([]);
    expect(conquered).toEqual([a]);
  });
});

describe("localStorage 持久化（本设备自选）", () => {
  it("默认严格；坏值回退默认；保存后读回", () => {
    localStorage.clear();
    expect(loadWrongMasteryStandard()).toBe(DEFAULT_WRONG_MASTERY_STANDARD);
    localStorage.setItem(WRONG_MASTERY_STORAGE_KEY, "乱写的值");
    expect(loadWrongMasteryStandard()).toBe("strict");
    saveWrongMasteryStandard("lenient");
    expect(localStorage.getItem(WRONG_MASTERY_STORAGE_KEY)).toBe("lenient");
    expect(loadWrongMasteryStandard()).toBe("lenient");
    saveWrongMasteryStandard("strict");
    expect(loadWrongMasteryStandard()).toBe("strict");
  });
});

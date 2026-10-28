import { describe, expect, it } from "vitest";
import {
  type CanonicalEmbeddedUnitCandidate,
  canonicalEmbeddedUnitOf,
} from "./lesson-embedded.ts";

/**
 * canonicalEmbeddedUnitOf（多 live 嵌入单元择主，纯函数）规则锁定：
 * 交集最大者胜 → 平局或全零走 updatedAt 字符串降序 → order 升序 → id 升序；
 * 空数组 undefined；单候选恒返回（md 缺注入 id 的兜底场景不能选成 undefined）。
 * 事故背景：教师重导改名单元在同一讲练页留下新旧两个 live 嵌入单元，
 * 旧读侧按 order ASC 取最前会冻结与 md 题槽对不上的旧单元（题全堆页尾）。
 */

/** 字面量候选构造（缺省零题、order 0、updatedAt 固定；逐用例覆写关注字段） */
function candidate(
  overrides: Partial<CanonicalEmbeddedUnitCandidate> & { id: string },
): CanonicalEmbeddedUnitCandidate {
  return {
    topic: null,
    order: 0,
    updatedAt: "2026-06-01T00:00:00.000Z",
    liveQuestionIds: new Set<string>(),
    ...overrides,
  };
}

describe("canonicalEmbeddedUnitOf（多 live 嵌入单元择主，纯函数）", () => {
  it("空数组 → undefined", () => {
    expect(canonicalEmbeddedUnitOf([], new Set(["q1"]))).toBeUndefined();
    expect(canonicalEmbeddedUnitOf([], new Set())).toBeUndefined();
  });

  it("单候选恒返回：交集为零也返回（md 缺注入 id 的兜底场景不能选成 undefined）", () => {
    const only = candidate({
      id: "u-only",
      topic: "有理数",
      liveQuestionIds: new Set(["q9"]),
    });
    expect(canonicalEmbeddedUnitOf([only], new Set(["q1"]))).toBe(only);
    expect(canonicalEmbeddedUnitOf([only], new Set())).toBe(only);
  });

  it("交集最大者胜：即使 updatedAt 更旧、order 更大（一致性优先于新旧与排序）", () => {
    const aligned = candidate({
      id: "u-aligned",
      updatedAt: "2026-01-01T00:00:00.000Z",
      order: 5,
      liveQuestionIds: new Set(["q1", "q2"]),
    });
    const stale = candidate({
      id: "u-stale",
      updatedAt: "2026-10-01T00:00:00.000Z",
      order: 0,
      liveQuestionIds: new Set(["q9"]),
    });
    const slots = new Set(["q1", "q2", "q3"]);
    expect(canonicalEmbeddedUnitOf([stale, aligned], slots)).toBe(aligned);
    // 候选顺序无关
    expect(canonicalEmbeddedUnitOf([aligned, stale], slots)).toBe(aligned);
  });

  it("平局 → updatedAt 字符串降序（新者优先，order/id 均不参与）", () => {
    const older = candidate({
      id: "u-a",
      order: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
      liveQuestionIds: new Set(["q1"]),
    });
    const newer = candidate({
      id: "u-z",
      order: 9,
      updatedAt: "2026-09-01T00:00:00.000Z",
      liveQuestionIds: new Set(["q1"]),
    });
    expect(canonicalEmbeddedUnitOf([older, newer], new Set(["q1"]))).toBe(
      newer,
    );
    expect(canonicalEmbeddedUnitOf([newer, older], new Set(["q1"]))).toBe(
      newer,
    );
  });

  it("全零交集（md 全无注入 id）→ 取 updatedAt 最新", () => {
    const a = candidate({
      id: "u-a",
      updatedAt: "2026-03-01T00:00:00.000Z",
      liveQuestionIds: new Set(["q1"]),
    });
    const b = candidate({
      id: "u-b",
      updatedAt: "2026-08-01T00:00:00.000Z",
      liveQuestionIds: new Set(["q2"]),
    });
    expect(canonicalEmbeddedUnitOf([a, b], new Set(["q9"]))).toBe(b);
    expect(canonicalEmbeddedUnitOf([b, a], new Set(["q9"]))).toBe(b);
  });

  it("同 updatedAt → order 升序；order 也同 → id 升序", () => {
    const same = "2026-06-01T00:00:00.000Z";
    const orderBig = candidate({
      id: "u-a",
      order: 7,
      updatedAt: same,
      liveQuestionIds: new Set(["q1"]),
    });
    const orderSmall = candidate({
      id: "u-z",
      order: 1,
      updatedAt: same,
      liveQuestionIds: new Set(["q1"]),
    });
    expect(
      canonicalEmbeddedUnitOf([orderBig, orderSmall], new Set(["q1"])),
    ).toBe(orderSmall);
    const idA = candidate({
      id: "u-a",
      order: 3,
      updatedAt: same,
      liveQuestionIds: new Set(["q1"]),
    });
    const idZ = candidate({
      id: "u-z",
      order: 3,
      updatedAt: same,
      liveQuestionIds: new Set(["q1"]),
    });
    expect(canonicalEmbeddedUnitOf([idZ, idA], new Set(["q1"]))).toBe(idA);
  });
});

import { describe, expect, it } from "vitest";
import type { TraceEvent } from "./trace-intervals";
import { computeAttemptTraceMetrics } from "./trace-metrics";

/**
 * 学生 × 题（attempt 域）派生指标测试（T4.0b，方案 §4.4.1；测试先行）：
 * - timeToFirstHintSec：首次 directive_interact{hint,open} − 首次 question_focus，
 *   未用提示 null；只用客户端时钟（hint_open 服务端直记不参与）；
 * - hintDwellSec：open→close/blur/隐藏/交卷累加（区间并集防重叠双计）；
 * - inkEditCount：Σ erase+undo+redo+clear（排除 load——load 根本不产生
 *   ink_edit_batch 事件）；
 * - fullscreenUsed / reviewedSolution（交卷后 host=result 的 solution open）；
 * - offlineShare：net_offline 区间 ∩ focus 区间 ÷ activeSec（分母外部传入，
 *   与 computePerQuestionActiveSec 权威口径零漂移；activeSec=0 时 share=0）。
 */

const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const at = (sec: number): number => T0 + sec * 1000;

function ev(
  type: string,
  clientTs: number,
  extra?: Partial<TraceEvent>,
): TraceEvent {
  return { type, clientTs, ...extra };
}

/** host=question 的提示解锁（客户端时钟事件，与 hint_open 直记配对的这条） */
function hintOpen(clientTs: number, questionId: string): TraceEvent {
  return ev("directive_interact", clientTs, {
    host: "question",
    questionId,
    name: "hint",
    action: "open",
    index: 0,
  });
}

describe("timeToFirstHintSec", () => {
  it("首次 hint open − 首次 focus；未用提示为 null", () => {
    const events = [
      ev("attempt_start", at(0)),
      ev("question_focus", at(10), { questionId: "q1" }),
      hintOpen(at(95), "q1"),
      ev("question_focus", at(200), { questionId: "q2" }),
    ];
    const metrics = computeAttemptTraceMetrics(events, { q1: 90, q2: 10 });
    expect(metrics.q1?.timeToFirstHintSec).toBe(85);
    expect(metrics.q2?.timeToFirstHintSec).toBeNull();
  });

  it("只用客户端时钟：hint_open（服务端直记）不参与任何计算", () => {
    const events = [
      ev("question_focus", at(10), { questionId: "q1" }),
      // 服务端直记的 hint_open（clientTs 为服务端时钟）混在流里也不影响
      ev("hint_open", at(1_000_000), { questionId: "q1", index: 0 }),
      hintOpen(at(70), "q1"),
    ];
    const metrics = computeAttemptTraceMetrics(events, { q1: 60 });
    expect(metrics.q1?.timeToFirstHintSec).toBe(60);
    expect(metrics.q1?.hintDwellSec).toBeGreaterThanOrEqual(0);
  });
});

describe("hintDwellSec", () => {
  it("open→blur 结算；多次开（不同提示序号）并集防重叠双计", () => {
    const events = [
      ev("question_focus", at(0), { questionId: "q1" }),
      hintOpen(at(100), "q1"),
      // 第二条提示在未 blur 前解锁（区间重叠，并集只计一次）
      ev("directive_interact", at(200), {
        host: "question",
        questionId: "q1",
        name: "hint",
        action: "open",
        index: 1,
      }),
      ev("question_blur", at(300), { questionId: "q1" }),
      // 再次聚焦并开第三条（新段）
      ev("question_focus", at(1000), { questionId: "q1" }),
      hintOpen(at(1100), "q1"),
      ev("submit", at(1200)),
    ];
    const metrics = computeAttemptTraceMetrics(events, { q1: 1200 });
    // [100,300) ∪ [200,300) = 200s；[1100,1200) = 100s；合计 300s
    expect(metrics.q1?.hintDwellSec).toBe(300);
  });

  it("page_hidden 与 submit 都是边界（隐藏期间不计停留）", () => {
    const events = [
      ev("question_focus", at(0), { questionId: "q1" }),
      hintOpen(at(100), "q1"),
      ev("page_hidden", at(150)),
      ev("page_visible", at(400)),
      ev("question_blur", at(500), { questionId: "q1" }),
    ];
    const metrics = computeAttemptTraceMetrics(events, { q1: 500 });
    expect(metrics.q1?.hintDwellSec).toBe(50);
  });
});

describe("inkEditCount / fullscreenUsed", () => {
  it("四计数求和；全屏用过即 true", () => {
    const events = [
      ev("ink_edit_batch", at(10), {
        questionId: "q1",
        erase: 2,
        undo: 1,
        redo: 0,
        clear: 0,
      }),
      ev("ink_edit_batch", at(20), {
        questionId: "q1",
        erase: 0,
        undo: 0,
        redo: 3,
        clear: 1,
      }),
      ev("ink_fullscreen", at(30), { questionId: "q1", on: true }),
      ev("ink_fullscreen", at(60), { questionId: "q1", on: false }),
    ];
    const metrics = computeAttemptTraceMetrics(events, { q1: 60 });
    expect(metrics.q1?.inkEditCount).toBe(7);
    expect(metrics.q1?.fullscreenUsed).toBe(true);
  });

  it("全屏进出（on=false 收尾）不算 fullscreenUsed", () => {
    const events = [
      ev("ink_fullscreen", at(10), { questionId: "q1", on: false }),
    ];
    const metrics = computeAttemptTraceMetrics(events, { q1: 5 });
    expect(metrics.q1?.fullscreenUsed).toBe(false);
  });
});

describe("offlineShare", () => {
  it("net_offline ∩ focus ÷ activeSec（分母外部传入权威值）", () => {
    const events = [
      ev("question_focus", at(0), { questionId: "q1" }),
      ev("net_offline", at(100)),
      ev("net_online", at(300)),
      ev("question_blur", at(600), { questionId: "q1" }),
    ];
    // activeSec 权威值（与 focus∩visible 同口径，此处 600s）
    const metrics = computeAttemptTraceMetrics(events, { q1: 600 });
    expect(metrics.q1?.offlineShare).toBeCloseTo(200 / 600, 5);
  });

  it("离线段落在 focus 之外不计；activeSec=0 时 share=0（防除零）", () => {
    const events = [
      ev("net_offline", at(0)),
      ev("net_online", at(100)),
      ev("question_focus", at(200), { questionId: "q1" }),
      ev("question_blur", at(300), { questionId: "q1" }),
    ];
    const metrics = computeAttemptTraceMetrics(events, { q1: 100 });
    expect(metrics.q1?.offlineShare).toBe(0);
    const zero = computeAttemptTraceMetrics(
      [ev("question_focus", at(0), { questionId: "q9" })],
      { q9: 0 },
    );
    expect(zero.q9?.offlineShare).toBe(0);
  });
});

describe("reviewedSolution", () => {
  it("交卷后 host=result 的 solution open 记为复盘；交卷前/其他指令不算", () => {
    const events = [
      ev("question_focus", at(0), { questionId: "q1" }),
      ev("submit", at(100)),
      ev("directive_interact", at(200), {
        host: "result",
        attemptId: "a1",
        questionId: "q1",
        name: "solution",
        action: "open",
        index: 0,
      }),
      // q2 只有关闭事件（未展开过）：不算复盘
      ev("directive_interact", at(250), {
        host: "result",
        attemptId: "a1",
        questionId: "q2",
        name: "solution",
        action: "close",
        index: 1,
      }),
      // q3 的 open 在交卷前（异常时序）：不算
      ev("directive_interact", at(50), {
        host: "result",
        attemptId: "a1",
        questionId: "q3",
        name: "solution",
        action: "open",
        index: 2,
      }),
    ];
    const metrics = computeAttemptTraceMetrics(events, {});
    expect(metrics.q1?.reviewedSolution).toBe(true);
    expect(metrics.q2?.reviewedSolution).toBe(false);
    expect(metrics.q3?.reviewedSolution).toBe(false);
  });
});

describe("综合与边界", () => {
  it("一题完整指标：先想后开提示、看过详解、手写反复并全屏", () => {
    const events = [
      ev("question_focus", at(0), { questionId: "q1" }),
      ev("ink_stroke_batch", at(30), { questionId: "q1", strokes: 1 }),
      ev("ink_edit_batch", at(40), {
        questionId: "q1",
        erase: 1,
        undo: 0,
        redo: 0,
        clear: 0,
      }),
      ev("ink_fullscreen", at(50), { questionId: "q1", on: true }),
      hintOpen(at(120), "q1"),
      ev("question_blur", at(200), { questionId: "q1" }),
      ev("submit", at(300)),
      ev("directive_interact", at(400), {
        host: "result",
        attemptId: "a1",
        questionId: "q1",
        name: "solution",
        action: "open",
        index: 0,
      }),
    ];
    const metrics = computeAttemptTraceMetrics(events, { q1: 200 });
    expect(metrics.q1).toMatchObject({
      timeToFirstHintSec: 120,
      hintDwellSec: 80,
      inkEditCount: 1,
      fullscreenUsed: true,
      reviewedSolution: true,
    });
    expect(metrics.q1?.offlineShare).toBe(0);
  });

  it("空事件流返回空对象（优雅降级）", () => {
    expect(computeAttemptTraceMetrics([], {})).toEqual({});
  });
});

import { describe, expect, it } from "vitest";
import {
  computePerQuestionActiveSec,
  countAnswerChanges,
  type TimelineEvent,
} from "./active-time.ts";

/**
 * 每题有效用时计算的全套时间规则用例（T2.10 验收项核心）。
 * 规则口径（实现与测试共同锁定，详见 active-time.ts 文档）：
 * - question_focus 起计时、question_blur 停；
 * - 焦点期间 page_hidden → 停止累计，page_visible 恢复（hidden 区间不计时）；
 *   hidden 后没有 visible 直接 blur/submit → 只计到 hidden 时刻（兜底）；
 * - 跨题 focus 隐式 blur 前一题（按事件序列顺序）；
 * - 重复 focus 同题忽略（不重置起点）；
 * - submit 截止：之后的事件（迟到的 blur 等）一律不再累计；
 * - 序列结尾仍聚焦（无 blur/submit）→ 计到最后一个事件的 clientTs；
 * - 每题累计毫秒后四舍五入到秒（Math.round）。
 */

const S = 1000; // 秒 → 毫秒
const T0 = 1_769_000_000_000; // 任意基准毫秒时刻

/** 便捷构造（毫秒偏移量；questionId 缺省时整字段不带，兼容 exactOptionalPropertyTypes） */
function ev(type: string, atSec: number, questionId?: string): TimelineEvent {
  const base: TimelineEvent = { type, clientTs: T0 + atSec * S };
  return questionId === undefined
    ? base
    : { ...base, questionId };
}

describe("computePerQuestionActiveSec：基础与取整", () => {
  it("focus → blur：满段计时", () => {
    const out = computePerQuestionActiveSec([
      ev("attempt_start", 0),
      ev("question_focus", 1, "q1"),
      ev("question_blur", 11, "q1"),
    ]);
    expect(out).toEqual({ q1: 10 });
  });

  it("毫秒取整口径：累计毫秒后四舍五入（1500ms→2s、1400ms→1s）", () => {
    // 两题用不同基准时刻，避免同毫秒 focus 的排序歧义（真实场景不会同刻切题）
    const out = computePerQuestionActiveSec([
      { type: "question_focus", clientTs: T0, questionId: "a" },
      { type: "question_blur", clientTs: T0 + 1500, questionId: "a" },
      { type: "question_focus", clientTs: T0 + 10_000, questionId: "b" },
      { type: "question_blur", clientTs: T0 + 11_400, questionId: "b" },
    ]);
    expect(out).toEqual({ a: 2, b: 1 });
  });

  it("同题多段累计：前后两段相加", () => {
    const out = computePerQuestionActiveSec([
      ev("question_focus", 0, "q1"),
      ev("question_blur", 10, "q1"),
      ev("question_focus", 100, "q1"),
      ev("question_blur", 115, "q1"),
    ]);
    expect(out).toEqual({ q1: 25 });
  });

  it("重复 focus 同题：忽略，不重置起点", () => {
    const out = computePerQuestionActiveSec([
      ev("question_focus", 0, "q1"),
      ev("question_focus", 5, "q1"),
      ev("question_blur", 10, "q1"),
    ]);
    expect(out).toEqual({ q1: 10 });
  });

  it("blur 非当前聚焦题 / 序列外 blur：忽略", () => {
    const out = computePerQuestionActiveSec([
      ev("question_blur", 1, "q1"), // 无 focus 前置
      ev("question_focus", 2, "q1"),
      ev("question_blur", 3, "q9"), // 非当前题
      ev("question_blur", 12, "q1"),
    ]);
    expect(out).toEqual({ q1: 10 });
  });

  it("question_view 不参与计时；未聚焦过的题不出现", () => {
    const out = computePerQuestionActiveSec([
      ev("question_view", 1, "q1"),
      ev("question_view", 2, "q2"),
      ev("question_focus", 3, "q1"),
      ev("question_blur", 8, "q1"),
    ]);
    expect(out).toEqual({ q1: 5 });
  });

  it("空序列 / 无焦点事件 → 空结果", () => {
    expect(computePerQuestionActiveSec([])).toEqual({});
    expect(
      computePerQuestionActiveSec([
        ev("attempt_start", 0),
        ev("question_view", 1, "q1"),
      ]),
    ).toEqual({});
  });
});

describe("computePerQuestionActiveSec：page_hidden 规则（验收项）", () => {
  it("焦点期间 hidden → visible 的区间不计时", () => {
    const out = computePerQuestionActiveSec([
      ev("question_focus", 0, "q1"),
      ev("page_hidden", 10),
      ev("page_visible", 40),
      ev("question_blur", 50, "q1"),
    ]);
    expect(out).toEqual({ q1: 20 }); // 0–10 + 40–50
  });

  it("hidden 后没有 visible 直接 blur：只计到 hidden 时刻（兜底）", () => {
    const out = computePerQuestionActiveSec([
      ev("question_focus", 0, "q1"),
      ev("page_hidden", 10),
      ev("question_blur", 50, "q1"),
    ]);
    expect(out).toEqual({ q1: 10 });
  });

  it("hidden 后没有 visible 直接 submit：同样只计到 hidden", () => {
    const out = computePerQuestionActiveSec([
      ev("question_focus", 0, "q1"),
      ev("page_hidden", 10),
      ev("submit", 50),
    ]);
    expect(out).toEqual({ q1: 10 });
  });

  it("未聚焦时 hidden/visible：忽略，不影响后续", () => {
    const out = computePerQuestionActiveSec([
      ev("page_hidden", 0),
      ev("page_visible", 5),
      ev("question_focus", 6, "q1"),
      ev("question_blur", 16, "q1"),
    ]);
    expect(out).toEqual({ q1: 10 });
  });

  it("孤立的 page_visible（无 hidden 前置）：忽略", () => {
    const out = computePerQuestionActiveSec([
      ev("question_focus", 0, "q1"),
      ev("page_visible", 5),
      ev("question_blur", 10, "q1"),
    ]);
    expect(out).toEqual({ q1: 10 });
  });

  it("hidden 区间内切换到另一题：旧题计到 hidden，新题从 visible 起计", () => {
    const out = computePerQuestionActiveSec([
      ev("question_focus", 0, "q1"),
      ev("page_hidden", 10),
      ev("question_focus", 20, "q2"),
      ev("page_visible", 30),
      ev("question_blur", 40, "q2"),
    ]);
    expect(out).toEqual({ q1: 10, q2: 10 });
  });

  it("hidden 区间内的 blur 不累计时间（防御：隐藏中不应有交互）", () => {
    const out = computePerQuestionActiveSec([
      ev("question_focus", 0, "q1"),
      ev("page_hidden", 10),
      ev("question_blur", 25, "q1"),
      ev("page_visible", 30),
    ]);
    expect(out).toEqual({ q1: 10 });
  });

  it("多次 hidden/visible 交替，均不计时", () => {
    const out = computePerQuestionActiveSec([
      ev("question_focus", 0, "q1"),
      ev("page_hidden", 5),
      ev("page_visible", 15),
      ev("page_hidden", 20),
      ev("page_visible", 100),
      ev("question_blur", 105, "q1"),
    ]);
    expect(out).toEqual({ q1: 15 }); // 0–5 + 15–20 + 100–105
  });
});

describe("computePerQuestionActiveSec：切换与截止", () => {
  it("跨题 focus 隐式 blur 前一题（按序列顺序）", () => {
    const out = computePerQuestionActiveSec([
      ev("question_focus", 0, "q1"),
      ev("question_focus", 8, "q2"),
      ev("question_blur", 20, "q2"),
    ]);
    expect(out).toEqual({ q1: 8, q2: 12 });
  });

  it("连续切换多题：每题计到下一题的 focus 时刻", () => {
    const out = computePerQuestionActiveSec([
      ev("question_focus", 0, "q1"),
      ev("question_focus", 10, "q2"),
      ev("question_focus", 25, "q3"),
      ev("question_blur", 30, "q3"),
    ]);
    expect(out).toEqual({ q1: 10, q2: 15, q3: 5 });
  });

  it("submit 截止：之后的事件（迟到的 blur/focus）不再累计", () => {
    const out = computePerQuestionActiveSec([
      ev("question_focus", 0, "q1"),
      ev("submit", 30),
      ev("question_blur", 60, "q1"),
      ev("question_focus", 70, "q2"),
      ev("question_blur", 80, "q2"),
    ]);
    expect(out).toEqual({ q1: 30 });
  });

  it("submit 时仍在焦点（无 blur）：计到 submit 时刻", () => {
    const out = computePerQuestionActiveSec([
      ev("question_focus", 0, "q1"),
      ev("submit", 42),
    ]);
    expect(out).toEqual({ q1: 42 });
  });

  it("序列结尾仍聚焦（无 blur/submit）：计到最后一个事件的 clientTs", () => {
    const out = computePerQuestionActiveSec([
      ev("question_focus", 0, "q1"),
      ev("answer_change", 12, "q1"),
      ev("question_view", 13, "q2"),
    ]);
    expect(out).toEqual({ q1: 13 });
  });
});

describe("computePerQuestionActiveSec：输入预处理", () => {
  it("乱序输入按 clientTs 排序后处理（结果与有序一致）", () => {
    const ordered = [
      ev("question_focus", 0, "q1"),
      ev("page_hidden", 10),
      ev("page_visible", 40),
      ev("question_focus", 50, "q2"),
      ev("question_blur", 60, "q2"),
    ];
    const shuffled = [...ordered].reverse();
    expect(computePerQuestionActiveSec(shuffled)).toEqual(
      computePerQuestionActiveSec(ordered),
    );
  });

  it("未知事件类型与缺 questionId 的 focus：忽略不报错（优雅降级）", () => {
    const out = computePerQuestionActiveSec([
      { type: "future_event", clientTs: T0 },
      { type: "question_focus", clientTs: T0 }, // 缺 questionId：整条忽略
      ev("question_focus", 1, "q1"),
      ev("question_blur", 6, "q1"),
    ]);
    expect(out).toEqual({ q1: 5 });
  });
});

describe("countAnswerChanges", () => {
  it("按题计数 answer_change；submit 后的不再计", () => {
    const out = countAnswerChanges([
      ev("answer_change", 1, "q1"),
      ev("answer_change", 2, "q1"),
      ev("answer_change", 3, "q2"),
      ev("submit", 10),
      ev("answer_change", 11, "q1"), // 迟到：不计
    ]);
    expect(out).toEqual({ q1: 2, q2: 1 });
  });

  it("无 answer_change → 空结果；其他类型不计", () => {
    expect(
      countAnswerChanges([
        ev("attempt_start", 0),
        ev("question_view", 1, "q1"),
        ev("ink_stroke_batch", 2, "q1"),
      ]),
    ).toEqual({});
  });

  it("缺 questionId 的 answer_change 忽略（防御）", () => {
    expect(
      countAnswerChanges([{ type: "answer_change", clientTs: T0 }]),
    ).toEqual({});
  });
});

describe("综合场景：一次真实作答的完整序列", () => {
  it("多题 + 中途切走 + 隐藏一次 + 交卷", () => {
    const out = computePerQuestionActiveSec([
      ev("attempt_start", 0),
      ev("question_view", 0, "q1"),
      ev("question_focus", 0, "q1"),
      ev("answer_change", 30, "q1"),
      ev("question_focus", 45, "q2"), // q1 隐式 blur：45s
      ev("page_hidden", 60), // q2 计到 60s
      ev("page_visible", 300), // 切走 4 分钟不计
      ev("question_blur", 315, "q2"), // q2 恢复后 15s
      ev("question_focus", 320, "q3"),
      ev("submit", 350), // q3 计 30s
    ]);
    expect(out).toEqual({ q1: 45, q2: 30, q3: 30 });
  });
});

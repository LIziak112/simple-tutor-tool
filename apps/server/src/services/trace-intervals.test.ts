import { describe, expect, it } from "vitest";
import {
  buildIdleIntervals,
  buildLectureVisibleIntervals,
  buildOfflineIntervals,
  type Interval,
  intersectIntervals,
  mergeIntervals,
  orderTraceEvents,
  subtractIntervals,
  type TraceEvent,
  totalIntervalMs,
} from "./trace-intervals";

/**
 * 区间运算统一工具测试（T4.0b，§5.0-D15 逐条锁定）：
 * - 排序确定性（D16）：同 clientTs 用确定的 type 优先级 tie-break；
 * - 讲义可见区间：按 viewId 分流配对 → 求并集（双标签页不叠计）→
 *   重复 hidden 忽略 → 未闭合开区间在 min(证据终点, 下一会话, idle_start,
 *   硬上限 30 分钟) 截断（Caliper gap-cap）→ 负时长 clamp 0；
 * - idle / net 区间同构；
 * - 集合运算：merge / intersect / subtract / totalMs。
 */

const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);
/** 秒级偏移的便捷时间戳 */
const at = (sec: number): number => T0 + sec * 1000;

function ev(
  type: string,
  clientTs: number,
  extra?: Partial<TraceEvent>,
): TraceEvent {
  return { type, clientTs, ...extra };
}

describe("排序确定性（D16）", () => {
  it("同 clientTs 按 type 优先级排序，与输入顺序无关", () => {
    const a = ev("lecture_visible", at(0), { viewId: "v1" });
    const b = ev("section_focus", at(0), { headingIndex: 0 });
    const ordered1 = orderTraceEvents([a, b]);
    const ordered2 = orderTraceEvents([b, a]);
    expect(ordered1.map((e) => e.type)).toEqual(ordered2.map((e) => e.type));
  });

  it("不同 clientTs 按时间升序；未知类型排在已知之后（同刻未知按字典序，仍确定）", () => {
    const ordered = orderTraceEvents([
      ev("mystery_b", at(5)),
      ev("mystery_a", at(5)),
      ev("lecture_hidden", at(10)),
      ev("lecture_visible", at(0)),
    ]);
    expect(ordered.map((e) => e.type)).toEqual([
      "lecture_visible",
      "mystery_a",
      "mystery_b",
      "lecture_hidden",
    ]);
    // 换序输入结果一致（排序整体确定，不依赖输入顺序）
    const reordered = orderTraceEvents([
      ev("mystery_a", at(5)),
      ev("mystery_b", at(5)),
      ev("lecture_visible", at(0)),
      ev("lecture_hidden", at(10)),
    ]);
    expect(reordered.map((e) => e.type)).toEqual(ordered.map((e) => e.type));
  });
});

describe("讲义可见区间（viewId 配对 + gap-cap）", () => {
  it("基础配对：visible→hidden 成一段；重复 hidden 忽略", () => {
    const events = [
      ev("lecture_visible", at(0), { viewId: "v1" }),
      ev("lecture_hidden", at(60), { viewId: "v1" }),
      ev("lecture_hidden", at(62), { viewId: "v1" }), // 双兜底双发：忽略
    ];
    expect(buildLectureVisibleIntervals(events)).toEqual([
      { start: at(0), end: at(60) },
    ]);
  });

  it("双标签页（不同 viewId）分别配对，并集不叠计（§5.0-D15）", () => {
    const events = [
      ev("lecture_visible", at(0), { viewId: "a" }),
      ev("lecture_visible", at(30), { viewId: "b" }),
      ev("lecture_hidden", at(90), { viewId: "a" }),
      ev("lecture_hidden", at(120), { viewId: "b" }),
    ];
    const merged = mergeIntervals(buildLectureVisibleIntervals(events));
    expect(merged).toEqual([{ start: at(0), end: at(120) }]);
    expect(totalIntervalMs(merged)).toBe(120_000);
  });

  it("未闭合开区间：同流后续事件为证据终点（被杀页面的保守收尾，总时长不虚高）", () => {
    const events = [
      ev("lecture_visible", at(0), { viewId: "v1" }),
      ev("section_focus", at(120), { headingIndex: 0 }),
      ev("section_focus", at(420), { headingIndex: 1 }),
      // v1 无 hidden（页面被杀）；11 分钟后新会话开始
      ev("lecture_visible", at(1140), { viewId: "v2" }),
      ev("lecture_hidden", at(1200), { viewId: "v2" }),
    ];
    const merged = mergeIntervals(buildLectureVisibleIntervals(events));
    // v1 收尾 = 下一会话开始前的最后事件（420s），不是 30 分钟硬上限
    expect(merged).toEqual([
      { start: at(0), end: at(420) },
      { start: at(1140), end: at(1200) },
    ]);
  });

  it("未闭合开区间：idle_start 截断（空闲即阅读结束）", () => {
    const events = [
      ev("lecture_visible", at(0), { viewId: "v1" }),
      ev("idle_start", at(600)),
      ev("idle_end", at(900)),
      // 无 hidden、无后续会话
    ];
    expect(buildLectureVisibleIntervals(events)).toEqual([
      { start: at(0), end: at(600) },
    ]);
  });

  it("未闭合开区间：硬上限 30 分钟（长时间静默无任何后续事件）", () => {
    const events = [ev("lecture_visible", at(0), { viewId: "v1" })];
    expect(buildLectureVisibleIntervals(events)).toEqual([
      { start: at(0), end: at(1800) },
    ]);
  });

  it("孤立 hidden（无 open）忽略；重复 visible（已开）忽略", () => {
    const events = [
      ev("lecture_hidden", at(0), { viewId: "v1" }),
      ev("lecture_visible", at(10), { viewId: "v1" }),
      ev("lecture_visible", at(20), { viewId: "v1" }),
      ev("lecture_hidden", at(30), { viewId: "v1" }),
    ];
    expect(buildLectureVisibleIntervals(events)).toEqual([
      { start: at(10), end: at(30) },
    ]);
  });
});

describe("同毫秒 visible+hidden 对（自动化轨迹回归，Opus 复测 (C)）", () => {
  /**
   * D16 规范序 hidden(0) 先于 visible(1)：同毫秒的 visible+hidden 对（页面
   * 亚毫秒生存期——真人操作不可能，自动化驱动 UI 可稳定产生）里 hidden 先到
   * 被当孤立忽略，visible 成未闭合会话，capOpenInterval 按「下一会话起点」
   * 截断 → 每组多算到下一次访问为止的幽灵停留（实测约 18s/组，永久留在
   * 学情地图里）。口径裁定：同 (viewId, clientTs) 的被忽略 hidden 与其后
   * visible 配对为 **0 时长会话**（不产生区间）——亚毫秒生存期的真实时长
   * 就是 0，幽灵 18s 是错配；不同刻的孤立 hidden 仍按原语义忽略。
   */
  it("同毫秒对成 0 时长会话：不产生区间、不产生幽灵停留", () => {
    const events = [
      // 组 1：同毫秒开合（页面即开即关），18 秒后组 2
      ev("lecture_visible", at(0), { viewId: "v1" }),
      ev("lecture_hidden", at(0), { viewId: "v1" }),
      // 组 2：真实 60 秒阅读
      ev("lecture_visible", at(18), { viewId: "v2" }),
      ev("lecture_hidden", at(78), { viewId: "v2" }),
    ];
    // 修复前：v1 被截断到下一会话起点 at(18) → 幽灵 [0,18) + [18,78) 两段
    expect(buildLectureVisibleIntervals(events)).toEqual([
      { start: at(18), end: at(78) },
    ]);
  });

  it("连续多组同毫秒对（自动化逐页访问）：全部 0 时长、互不串场", () => {
    const events = [
      ev("lecture_visible", at(0), { viewId: "a" }),
      ev("lecture_hidden", at(0), { viewId: "a" }),
      ev("lecture_visible", at(20), { viewId: "b" }),
      ev("lecture_hidden", at(20), { viewId: "b" }),
      ev("lecture_visible", at(40), { viewId: "c" }),
      ev("lecture_hidden", at(40), { viewId: "c" }),
    ];
    // 修复前：a→[0,20) b→[20,40) c→[40,30min) 三段幽灵停留
    expect(buildLectureVisibleIntervals(events)).toEqual([]);
  });

  it("不同刻的孤立 hidden 不与后续 visible 配对（原孤立忽略语义不变）", () => {
    const events = [
      ev("lecture_hidden", at(0), { viewId: "v1" }), // 时刻不同于 visible@1
      ev("lecture_visible", at(1), { viewId: "v1" }),
      ev("lecture_hidden", at(61), { viewId: "v1" }),
    ];
    expect(buildLectureVisibleIntervals(events)).toEqual([
      { start: at(1), end: at(61) },
    ]);
  });
});

describe("idle / net 区间（同构配对）", () => {
  it("idle 成对扣除区间；未闭合 idle_start 以流内最后事件收尾", () => {
    const events = [
      ev("idle_start", at(100)),
      ev("idle_end", at(200)),
      ev("idle_start", at(300)),
      ev("idle_start", at(310)), // 重复 idle_start 忽略
      ev("idle_end", at(400)),
      ev("idle_start", at(500)),
      ev("lecture_visible", at(560), { viewId: "v1" }), // 流内最后事件
    ];
    expect(buildIdleIntervals(events)).toEqual([
      { start: at(100), end: at(200) },
      { start: at(300), end: at(400) },
      { start: at(500), end: at(560) },
    ]);
  });

  it("net 区间：offline→online 成段；未闭合 offline 到流内最后事件", () => {
    const events = [
      ev("net_offline", at(0)),
      ev("net_online", at(60)),
      ev("net_offline", at(120)),
      ev("answer_change", at(180)),
    ];
    expect(buildOfflineIntervals(events)).toEqual([
      { start: at(0), end: at(60) },
      { start: at(120), end: at(180) },
    ]);
  });
});

describe("集合运算", () => {
  it("merge：相邻/重叠合并、乱序输入稳定", () => {
    const raw: Interval[] = [
      { start: at(50), end: at(80) },
      { start: at(0), end: at(30) },
      { start: at(28), end: at(52) },
    ];
    expect(mergeIntervals(raw)).toEqual([{ start: at(0), end: at(80) }]);
  });

  it("intersect：交集为空时返回空数组", () => {
    const a: Interval[] = [
      { start: at(0), end: at(50) },
      { start: at(100), end: at(150) },
    ];
    const b: Interval[] = [{ start: at(40), end: at(120) }];
    expect(intersectIntervals(a, b)).toEqual([
      { start: at(40), end: at(50) },
      { start: at(100), end: at(120) },
    ]);
    expect(intersectIntervals(a, [{ start: at(200), end: at(300) }])).toEqual(
      [],
    );
  });

  it("subtract：扣除区间", () => {
    const a: Interval[] = [{ start: at(0), end: at(100) }];
    const b: Interval[] = [
      { start: at(20), end: at(40) },
      { start: at(60), end: at(70) },
    ];
    expect(subtractIntervals(a, b)).toEqual([
      { start: at(0), end: at(20) },
      { start: at(40), end: at(60) },
      { start: at(70), end: at(100) },
    ]);
  });

  it("负时长（客户端时钟回拨防御）clamp 0：不产生负区间", () => {
    // 回拨产生的倒置区间在集合运算层被丢弃 / 计 0
    expect(mergeIntervals([{ start: at(100), end: at(50) }])).toEqual([]);
    expect(totalIntervalMs([{ start: at(100), end: at(50) }])).toBe(0);
    // 配对层：close 早于 open（时钟回拨）按孤立闭事件忽略（不产生倒置区间）
    const events = [
      ev("lecture_visible", at(100), { viewId: "v1" }),
      ev("lecture_hidden", at(50), { viewId: "v1" }),
    ];
    // 排序后 hidden@50 在前成孤立事件；visible@100 未闭合走 gap-cap（30 分钟）
    expect(buildLectureVisibleIntervals(events)).toEqual([
      { start: at(100), end: at(1900) },
    ]);
  });
});

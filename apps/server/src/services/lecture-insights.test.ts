import { analyzeLectureStructure } from "@tutor/md-dsl";
import { describe, expect, it } from "vitest";
import {
  computeLectureReadingMap,
  expectedSecOf,
  TRACE_THRESHOLDS,
} from "./lecture-insights";
import type { TraceEvent } from "./trace-intervals";

/**
 * 讲义阅读地图测试（T4.0b，方案 §4.4.2；测试先行）：
 * - (a) 每节 reached/rawDwellSec（visible∩focus）/dwellSec（再扣 idle）/expectedSec
 *   /status 四档（阈值集中配置）；
 * - (b) 每可折叠指令 hostHeadingIndex（结构分析）/opened/openCount/
 *   firstOpenOffsetSec/dwellSec/status（open→close 或节切换边界）；
 * - (c) 每 steps 容器 revealedCount/total/paceSec/status（连点跳过中位 <2s）；
 * - (d) 汇总从地图求和：readSec/sectionCoverage/foldOpenRate（分母=结构解析
 *   的可折叠指令总数）/hintOpenCount/solutionOpenCount/stepsPaceSec；
 * - 版本错位降级（lectureUpdatedAt ≠ 当前 → 只计总时长不定位；无字段回退
 *   serverTs 对比）；存量 lecture_expand 读侧归一（计入 name 计数）；
 * - 未闭合会话按区间工具的 gap-cap 收尾（此处只验地图正确消费）。
 */

const T0 = Date.UTC(2026, 9, 2, 8, 0, 0);
const at = (sec: number): number => T0 + sec * 1000;
const UPDATED_AT = "2026-10-01T00:00:00.000Z";

/** 生成指定正文字数的节（重复「读」字） */
const para = (chars: number): string => "读".repeat(chars);

/** 四节讲义：s0=100 字（exp 20s）、s1=3000 字（exp 600s，含 fold+steps）、s2=2000 字（exp 400s）、s3=400 字（exp 80s） */
const MARKDOWN = [
  "# 第1讲 有理数",
  "",
  "## 一、引言",
  "",
  para(100),
  "",
  "## 二、正文",
  "",
  ':::fold{title="拓展阅读"}',
  para(50),
  ":::",
  "",
  "::::steps",
  ":::step",
  para(40),
  ":::",
  ":::step",
  para(40),
  ":::",
  ":::step",
  para(40),
  ":::",
  "::::",
  "",
  para(3000),
  "",
  "## 三、略读节",
  "",
  para(2000),
  "",
  "## 四、收尾",
  "",
  para(400),
].join("\n");

const STRUCTURE = analyzeLectureStructure(MARKDOWN);

function ev(
  type: string,
  clientTs: number,
  extra?: Partial<TraceEvent>,
): TraceEvent {
  return { type, clientTs, ...extra };
}

function focus(clientTs: number, headingIndex: number): TraceEvent {
  return ev("lecture_section_focus", clientTs, {
    headingIndex,
    lectureUpdatedAt: UPDATED_AT,
  });
}

describe("expectedSec 与阈值配置", () => {
  it("中文约 300 字/分钟（5 字/秒），公式段打折，至少 1 秒", () => {
    expect(expectedSecOf({ textChars: 300, mathChars: 0 })).toBe(60);
    expect(expectedSecOf({ textChars: 100, mathChars: 0 })).toBe(20);
    // 100 数学字 × 0.3 = 30 字 → 6 秒
    expect(expectedSecOf({ textChars: 0, mathChars: 100 })).toBe(6);
    expect(expectedSecOf({ textChars: 0, mathChars: 0 })).toBe(1);
  });

  it("阈值集中一份（20%/50%/100%/2s/30min），不散落", () => {
    expect(TRACE_THRESHOLDS.sectionSkimMaxShare).toBe(0.2);
    expect(TRACE_THRESHOLDS.sectionReadMinShare).toBe(0.5);
    expect(TRACE_THRESHOLDS.sectionDeepMinShare).toBe(1.0);
    expect(TRACE_THRESHOLDS.stepRushMedianSec).toBe(2);
    expect(TRACE_THRESHOLDS.gapCapMs).toBe(30 * 60_000);
  });
});

describe("讲义阅读地图（单会话）", () => {
  const events: TraceEvent[] = [
    ev("lecture_visible", at(0), {
      viewId: "v1",
      lectureUpdatedAt: UPDATED_AT,
    }),
    focus(at(10), 0),
    focus(at(100), 1),
    // 折叠块展开 50 秒后收起
    ev("directive_interact", at(150), {
      host: "lecture",
      name: "fold",
      index: 1,
      action: "open",
      lectureUpdatedAt: UPDATED_AT,
    }),
    ev("directive_interact", at(180), {
      host: "lecture",
      name: "fold",
      index: 1,
      action: "close",
      lectureUpdatedAt: UPDATED_AT,
    }),
    // 阅读中挂机 60 秒（idle 扣除）
    ev("idle_start", at(200)),
    ev("idle_end", at(260)),
    // steps：两步间隔 10 秒（逐步阅读）
    ev("directive_interact", at(200), {
      host: "lecture",
      name: "steps",
      index: 2,
      action: "reveal",
      step: 2,
      lectureUpdatedAt: UPDATED_AT,
    }),
    ev("directive_interact", at(210), {
      host: "lecture",
      name: "steps",
      index: 2,
      action: "reveal",
      step: 3,
      lectureUpdatedAt: UPDATED_AT,
    }),
    focus(at(300), 2),
    focus(at(340), 3),
    ev("lecture_hidden", at(400), { viewId: "v1" }),
  ];
  const map = computeLectureReadingMap(events, STRUCTURE, {
    currentUpdatedAt: UPDATED_AT,
  });

  it("(a) 各节停留与状态四档（阈值边界）", () => {
    // s0: [10,100)=90s / exp20 → 450% 细读
    expect(map.sections[0]).toMatchObject({
      headingIndex: 0,
      reached: true,
      rawDwellSec: 90,
      dwellSec: 90,
      expectedSec: 20,
      status: "deep",
    });
    // s1: [100,300)∩visible=200s raw，扣 idle[200,260)=60 → 140 / exp(正文+折叠+步骤约 637) → 22% 部分阅读
    expect(map.sections[1]).toMatchObject({
      rawDwellSec: 200,
      dwellSec: 140,
      expectedSec: 647,
      status: "partial",
    });
    // s2: [300,340)=40s / exp400 → 10% 掠过
    expect(map.sections[2]).toMatchObject({ dwellSec: 40, status: "skimmed" });
    // s3: [340,400)=60s / exp80 → 75% 已读
    expect(map.sections[3]).toMatchObject({ dwellSec: 60, status: "read" });
  });

  it("(b) 可折叠指令：归属节、开合计数、首开偏移与停留", () => {
    expect(map.folds).toHaveLength(1);
    expect(map.folds[0]).toMatchObject({
      docIndex: 1,
      name: "fold",
      hostHeadingIndex: 1,
      opened: true,
      openCount: 1,
      firstOpenOffsetSec: 50, // 150 − 该节首次 focus(100)
      dwellSec: 30, // open→close
      status: "read", // 30 ≥ 20%·exp(10)
    });
  });

  it("(c) steps 容器：进度、节奏与状态", () => {
    expect(map.steps).toHaveLength(1);
    expect(map.steps[0]).toMatchObject({
      docIndex: 2,
      hostHeadingIndex: 1,
      revealedCount: 3,
      total: 3,
      paceSec: [10],
      status: "step-by-step",
    });
  });

  it("(d) 汇总从地图求和", () => {
    expect(map.summary).toMatchObject({
      readSec: expect.any(Number), // 各节 dwell 之和（下方单独断言）
      sectionCoverage: 1,
      foldOpenRate: 1,
      hintOpenCount: 0,
      solutionOpenCount: 0,
      degradedEventCount: 0,
    });
    expect(map.summary.totalVisibleSec).toBe(400);
    expect(map.summary.readSec).toBe(
      map.sections.reduce((sum, sec) => sum + sec.dwellSec, 0),
    );
    expect(map.summary.stepsOverallMedianPaceSec).toBe(10);
  });
});

describe("区间与降级规则", () => {
  it("未到过的节 not-reached；toc_jump 也算到达", () => {
    const events: TraceEvent[] = [
      ev("lecture_visible", at(0), { viewId: "v1" }),
      ev("lecture_toc_jump", at(5), {
        headingIndex: 3,
        lectureUpdatedAt: UPDATED_AT,
      }),
      ev("lecture_hidden", at(60), { viewId: "v1" }),
    ];
    const map = computeLectureReadingMap(events, STRUCTURE, {
      currentUpdatedAt: UPDATED_AT,
    });
    expect(map.sections.map((s) => s.reached)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(map.sections[3]?.status).toBe("skimmed"); // 到达但零停留按掠过
    expect(map.summary.sectionCoverage).toBe(0.25);
  });

  it("双标签页（viewId 并集）不叠计", () => {
    const events: TraceEvent[] = [
      ev("lecture_visible", at(0), { viewId: "a" }),
      ev("lecture_visible", at(30), { viewId: "b" }),
      focus(at(10), 0),
      ev("lecture_hidden", at(90), { viewId: "a" }),
      ev("lecture_hidden", at(120), { viewId: "b" }),
    ];
    const map = computeLectureReadingMap(events, STRUCTURE, {
      currentUpdatedAt: UPDATED_AT,
    });
    // s0 raw focus [10, 会话收尾 120) ∩ visible 并集 [0,120) = 110s（不是两页各算一遍）
    expect(map.sections[0]?.rawDwellSec).toBe(110);
    expect(map.summary.totalVisibleSec).toBe(120);
  });

  it("版本错位降级：只计总时长、不定位到条目", () => {
    const events: TraceEvent[] = [
      ev("lecture_visible", at(0), { viewId: "v1" }),
      // 旧版本事件：lectureUpdatedAt ≠ 当前
      focus(at(10), 0),
      ev("directive_interact", at(50), {
        host: "lecture",
        name: "fold",
        index: 1,
        action: "open",
        lectureUpdatedAt: "2026-09-01T00:00:00.000Z",
      }),
      ev("lecture_hidden", at(100), { viewId: "v1" }),
    ];
    const map = computeLectureReadingMap(events, STRUCTURE, {
      currentUpdatedAt: UPDATED_AT,
    });
    // 注意：本用例的 focus 构造带了 UPDATED_AT——换成错位版本再测
    expect(map.summary.degradedEventCount).toBe(1); // 只有 fold open 是旧版本
    expect(map.folds[0]?.opened).toBe(false); // 不定位
    expect(map.summary.totalVisibleSec).toBe(100); // 总时长照计
  });

  it("版本错位（section_focus 也错位）不产生节的 reached", () => {
    const events: TraceEvent[] = [
      ev("lecture_visible", at(0), { viewId: "v1" }),
      focus(at(10), 0), // 先到达（当前版本）
      ev("lecture_section_focus", at(40), {
        headingIndex: 2,
        lectureUpdatedAt: "2026-09-01T00:00:00.000Z",
      }),
      ev("lecture_hidden", at(100), { viewId: "v1" }),
    ];
    const map = computeLectureReadingMap(events, STRUCTURE, {
      currentUpdatedAt: UPDATED_AT,
    });
    expect(map.sections[2]?.reached).toBe(false);
    expect(map.summary.degradedEventCount).toBe(1);
  });

  it("无 lectureUpdatedAt 的存量事件回退 serverTs 对比判定", () => {
    const events: TraceEvent[] = [
      ev("lecture_visible", at(0), { viewId: "v1" }),
      // serverTs 晚于当前版本发布 → 视为当前版本
      ev("lecture_section_focus", at(10), {
        headingIndex: 0,
        serverTs: "2026-10-02T00:00:00.000Z",
      }),
      // serverTs 早于当前版本发布 → 降级
      ev("lecture_section_focus", at(40), {
        headingIndex: 1,
        serverTs: "2026-09-01T00:00:00.000Z",
      }),
      ev("lecture_hidden", at(100), { viewId: "v1" }),
    ];
    const map = computeLectureReadingMap(events, STRUCTURE, {
      currentUpdatedAt: UPDATED_AT,
    });
    expect(map.sections[0]?.reached).toBe(true);
    expect(map.sections[1]?.reached).toBe(false);
    expect(map.summary.degradedEventCount).toBe(1);
  });

  it("存量 lecture_expand 读侧归一为 directive_interact{open}：计入 name 计数（旧 index 口径不定位）", () => {
    const events: TraceEvent[] = [
      ev("lecture_visible", at(0), { viewId: "v1" }),
      // 旧客户端的 lecture_expand：directive=solution、旧 index 口径（折叠类为 0）
      ev("lecture_expand", at(30), {
        directive: "solution",
        index: 0,
        serverTs: "2026-10-02T00:00:00.000Z",
      }),
      ev("lecture_hidden", at(100), { viewId: "v1" }),
    ];
    const map = computeLectureReadingMap(events, STRUCTURE, {
      currentUpdatedAt: UPDATED_AT,
    });
    expect(map.summary.solutionOpenCount).toBe(1);
    expect(map.folds.every((f) => f.opened === false)).toBe(true); // 不定位到行
    expect(map.summary.degradedEventCount).toBe(0); // serverTs 判定为当前版本
  });

  it("未闭合会话：最后一节 dwell 以收尾点为终点（不依赖下一事件）", () => {
    const events: TraceEvent[] = [
      ev("lecture_visible", at(0), { viewId: "v1" }),
      focus(at(10), 0),
      ev("lecture_section_focus", at(200), {
        headingIndex: 3,
        lectureUpdatedAt: UPDATED_AT,
      }),
      // 无 hidden（被杀）：证据终点 200 → s0 = [10,200)
    ];
    const map = computeLectureReadingMap(events, STRUCTURE, {
      currentUpdatedAt: UPDATED_AT,
    });
    expect(map.sections[0]?.rawDwellSec).toBe(190);
  });
});

describe("steps 状态阶梯", () => {
  it("连点跳过（中位间隔 <2s）优先于完成度标签", () => {
    const events: TraceEvent[] = [
      ev("lecture_visible", at(0), { viewId: "v1" }),
      focus(at(10), 1),
      ev("directive_interact", at(100), {
        host: "lecture",
        name: "steps",
        index: 2,
        action: "reveal",
        step: 2,
        lectureUpdatedAt: UPDATED_AT,
      }),
      ev("directive_interact", at(101), {
        host: "lecture",
        name: "steps",
        index: 2,
        action: "reveal",
        step: 3,
        lectureUpdatedAt: UPDATED_AT,
      }),
      ev("lecture_hidden", at(200), { viewId: "v1" }),
    ];
    const map = computeLectureReadingMap(events, STRUCTURE, {
      currentUpdatedAt: UPDATED_AT,
    });
    expect(map.steps[0]).toMatchObject({
      revealedCount: 3,
      paceSec: [1],
      status: "rush-skipped",
    });
    expect(map.summary.stepsRushContainerCount).toBe(1);
  });

  it("只走一部分：未连点 → 未走完", () => {
    const events: TraceEvent[] = [
      ev("lecture_visible", at(0), { viewId: "v1" }),
      focus(at(10), 1),
      ev("directive_interact", at(100), {
        host: "lecture",
        name: "steps",
        index: 2,
        action: "reveal",
        step: 2,
        lectureUpdatedAt: UPDATED_AT,
      }),
      ev("lecture_hidden", at(200), { viewId: "v1" }),
    ];
    const map = computeLectureReadingMap(events, STRUCTURE, {
      currentUpdatedAt: UPDATED_AT,
    });
    expect(map.steps[0]?.status).toBe("incomplete"); // 1/2，pace 无样本不判连点
  });
});

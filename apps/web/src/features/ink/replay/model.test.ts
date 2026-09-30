import { describe, expect, it } from "vitest";
import {
  advancePlayhead,
  formatReplayTime,
  frameAt,
  type InkReplayModel,
  parseInkReplayData,
  REPLAY_ELEMENT_MIN_MS,
  REPLAY_INTER_STROKE_GAP_MS,
  REPLAY_MIN_DURATION_MS,
  REPLAY_SPEEDS,
  REPLAY_UNIFORM_POINT_MS,
} from "./model.ts";

/**
 * 回放纯数据层测试（T3.3 验收项）：atrament 带时间戳重演顺序 / 倍速只影响调度 /
 * 进度跳转任意时刻 / excalidraw 顺序重演 / 缺时间戳退化 / 空、坏数据不崩溃 /
 * 总时长下限拉伸（实测跟进：回放可读性下限——夹具时长须 ≥ 下限才断言绝对时刻）。
 */

/**
 * 两笔带时间戳的 atrament 文档（书写顺序：先横线后竖线）。
 * 时间戳放大 10 倍使总时长 4.76s ≥ 下限 2s，不触发拉伸（本夹具用于绝对时刻断言）。
 */
function atramentDoc() {
  return {
    engine: "atrament",
    version: 1,
    data: {
      width: 1000,
      strokes: [
        {
          tool: "pen",
          color: "#1f2328",
          weight: 4,
          points: [
            { x: 10, y: 10, p: 0.5, t: 0 },
            { x: 50, y: 10, p: 0.6, t: 1000 },
            { x: 90, y: 10, p: 0.5, t: 2000 },
            { x: 130, y: 10, p: 0.5, t: 3000 },
          ],
        },
        {
          tool: "pen",
          color: "#1f2328",
          weight: 4,
          points: [
            { x: 30, y: 20, p: 0.5, t: 0 },
            { x: 30, y: 60, p: 0.7, t: 800 },
            { x: 30, y: 99, p: 0.5, t: 1600 },
          ],
        },
      ],
    },
    updatedAt: 1748918400000,
  };
}

/** 解析成功的便捷断言（失败时给出可读错误） */
function parseOk(doc: unknown): InkReplayModel {
  const model = parseInkReplayData(doc);
  expect(model).not.toBeNull();
  return model as InkReplayModel;
}

describe("parseInkReplayData：atrament 分支", () => {
  it("合法文档解析出时间轴：第 2 笔起点 = 第 1 笔结束 + 固定笔间间隙", () => {
    const model = parseOk(atramentDoc());
    expect(model.engine).toBe("atrament");
    if (model.engine !== "atrament") return;
    expect(model.slots[0]?.startMs).toBe(0);
    expect(model.slots[1]?.startMs).toBe(3000 + REPLAY_INTER_STROKE_GAP_MS);
    expect(model.durationMs).toBe(3000 + REPLAY_INTER_STROKE_GAP_MS + 1600);
    // 点的 t 归一为本笔内非递减时刻（首点恒 0）
    expect(model.strokes[0]?.points.map((p) => p.t)).toEqual([
      0, 1000, 2000, 3000,
    ]);
    expect(model.strokes[1]?.points.map((p) => p.t)).toEqual([0, 800, 1600]);
    // 内容高度 = maxY + 上下留白，且不低于最小高度 220（夹逼生效）
    expect(model.contentHeight).toBe(Math.max(220, 99 + 80));
  });

  it("服务端测试夹具形态（width 800 等非 1000 值）宽松通过——坐标一律按逻辑宽 1000 解读", () => {
    const model = parseOk({
      engine: "atrament",
      version: 1,
      data: {
        width: 800,
        strokes: [
          {
            tool: "pen",
            color: "#1f2328",
            weight: 4,
            points: [
              { x: 12, y: 34, p: 0.5, t: 0 },
              { x: 56, y: 78, p: 0.8, t: 2500 },
            ],
          },
        ],
      },
      updatedAt: 1,
    });
    if (model.engine !== "atrament") throw new Error("engine 应为 atrament");
    expect(model.slots[0]?.pointTimesMs).toEqual([0, 2500]);
  });

  it("缺时间戳的旧数据退化为匀速（每点固定时长）", () => {
    // 200 点使总时长 2388ms ≥ 下限 2s，不触发拉伸（本用例断言退化口径的绝对值）
    const model = parseOk({
      engine: "atrament",
      version: 1,
      data: {
        strokes: [
          {
            tool: "pen",
            color: "#1f2328",
            weight: 4,
            points: Array.from({ length: 200 }, (_, i) => ({
              x: i,
              y: i,
              p: 0.5,
            })),
          },
        ],
      },
      updatedAt: 1,
    });
    if (model.engine !== "atrament") throw new Error("engine 应为 atrament");
    expect(model.slots[0]?.pointTimesMs.slice(0, 3)).toEqual([
      0,
      REPLAY_UNIFORM_POINT_MS,
      REPLAY_UNIFORM_POINT_MS * 2,
    ]);
    expect(model.slots[0]?.pointTimesMs).toHaveLength(200);
    expect(model.durationMs).toBe(REPLAY_UNIFORM_POINT_MS * 199);
  });

  it("部分点缺 t / 时间倒退：缺失沿用前一刻，倒退夹逼为非递减", () => {
    // 时间戳放大 50 倍使总时长 4500ms ≥ 下限 2s，不触发拉伸（断言归一口径绝对值）
    const model = parseOk({
      engine: "atrament",
      version: 1,
      data: {
        strokes: [
          {
            tool: "pen",
            color: "#1f2328",
            weight: 4,
            points: [
              { x: 0, y: 0, p: 0.5, t: 0 },
              { x: 1, y: 1, p: 0.5 },
              { x: 2, y: 2, p: 0.5, t: 2500 },
              { x: 3, y: 3, p: 0.5, t: 1500 },
              { x: 4, y: 4, p: 0.5, t: 4500 },
            ],
          },
        ],
      },
      updatedAt: 1,
    });
    if (model.engine !== "atrament") throw new Error("engine 应为 atrament");
    // 第 2 点缺 t → 沿用 0；第 4 点倒退（1500 < 2500）→ 夹逼到 2500；末点 4500 正常
    expect(model.slots[0]?.pointTimesMs).toEqual([0, 0, 2500, 2500, 4500]);
  });

  it("单点笔画（轻点）与零点笔画不崩溃；空笔画不占时长", () => {
    const model = parseOk({
      engine: "atrament",
      version: 1,
      data: {
        strokes: [
          {
            tool: "pen",
            color: "#1f2328",
            weight: 4,
            points: [{ x: 5, y: 5, p: 0.5, t: 0 }],
          },
          { tool: "pen", color: "#1f2328", weight: 4, points: [] },
        ],
      },
      updatedAt: 1,
    });
    if (model.engine !== "atrament") throw new Error("engine 应为 atrament");
    expect(model.durationMs).toBe(0);
    expect(frameAt(model, 0).engine).toBe("atrament");
    const frame = frameAt(model, 1000);
    if (frame.engine !== "atrament") throw new Error("frame 应为 atrament");
    // 单点笔画在其起点即完整可见；空笔画恒 0 点
    expect(frame.visiblePoints).toEqual([1, 0]);
  });

  it("tool/color/weight/p 缺失或非法给缺省值（不整体失败）", () => {
    const model = parseOk({
      engine: "atrament",
      version: 1,
      data: {
        strokes: [
          {
            points: [
              { x: 0, y: 0, p: 9, t: 0 },
              { x: 1, y: 1 },
            ],
          },
        ],
      },
      updatedAt: 1,
    });
    if (model.engine !== "atrament") throw new Error("engine 应为 atrament");
    const stroke = model.strokes[0];
    expect(stroke?.tool).toBe("pen");
    expect(stroke?.color).toBe("#1f2328");
    expect(stroke?.weight).toBe(4);
    expect(stroke?.points[0]?.p).toBe(1); // 越界压感夹逼到 [0,1]
    expect(stroke?.points[1]?.p).toBe(0.5); // 缺失压感按无压感
  });
});

describe("parseInkReplayData：excalidraw 分支", () => {
  it("elements 数组解析：freedraw 按点数加权、其余元素固定最短时长", () => {
    // 200 点使总时长 2880ms ≥ 下限 2s，不触发拉伸（本用例断言绝对时刻）
    const model = parseOk({
      engine: "excalidraw",
      version: 1,
      data: {
        scene: {
          elements: [
            { id: "a", type: "freedraw", points: new Array(200).fill(0) },
            { id: "b", type: "rectangle" },
            { id: "c", type: "text" },
          ],
        },
      },
      updatedAt: 1,
    });
    if (model.engine !== "excalidraw")
      throw new Error("engine 应为 excalidraw");
    // freedraw：200 点 × 12ms = 2400ms（> 最短时长 240）
    expect(model.slots[0]?.endMs).toBe(200 * REPLAY_UNIFORM_POINT_MS);
    // 其余元素固定最短时长，逐个顺延
    expect(model.slots[1]?.startMs).toBe(200 * REPLAY_UNIFORM_POINT_MS);
    expect(model.slots[1]?.endMs).toBe(
      200 * REPLAY_UNIFORM_POINT_MS + REPLAY_ELEMENT_MIN_MS,
    );
    expect(model.slots[2]?.startMs).toBe(
      200 * REPLAY_UNIFORM_POINT_MS + REPLAY_ELEMENT_MIN_MS,
    );
    expect(model.durationMs).toBe(
      200 * REPLAY_UNIFORM_POINT_MS + REPLAY_ELEMENT_MIN_MS * 2,
    );
  });

  it("空 elements：时长 0、帧恒空（不崩溃）", () => {
    const model = parseOk({
      engine: "excalidraw",
      version: 1,
      data: { scene: { elements: [] } },
      updatedAt: 1,
    });
    if (model.engine !== "excalidraw")
      throw new Error("engine 应为 excalidraw");
    expect(model.durationMs).toBe(0);
    const frame = frameAt(model, 500);
    if (frame.engine !== "excalidraw") throw new Error("frame 应为 excalidraw");
    expect(frame.visibleElements).toBe(0);
  });
});

describe("回放总时长下限（实测跟进：回放可读性下限）", () => {
  it("0.3s 快速书写：拉伸后总时长 ≥2s，各点时刻等比缩放、相对顺序不变", () => {
    // 单笔 3 点（0/150/300ms）总时长 300ms 不足下限 → 按下限/原时长比例拉伸
    const model = parseOk({
      engine: "atrament",
      version: 1,
      data: {
        strokes: [
          {
            tool: "pen",
            color: "#1f2328",
            weight: 4,
            points: [
              { x: 0, y: 0, p: 0.5, t: 0 },
              { x: 30, y: 0, p: 0.5, t: 150 },
              { x: 60, y: 0, p: 0.5, t: 300 },
            ],
          },
        ],
      },
      updatedAt: 1,
    });
    if (model.engine !== "atrament") throw new Error("engine 应为 atrament");
    expect(model.durationMs).toBeGreaterThanOrEqual(REPLAY_MIN_DURATION_MS);
    const scale = REPLAY_MIN_DURATION_MS / 300;
    expect(model.slots[0]?.startMs).toBe(0);
    for (const [i, original] of [0, 150, 300].entries()) {
      expect(model.slots[0]?.pointTimesMs[i]).toBeCloseTo(original * scale, 6);
      // 回写到 InkStroke 的 t 同步缩放（模型内自洽）
      expect(model.strokes[0]?.points[i]?.t).toBeCloseTo(original * scale, 6);
    }
    // 相对顺序不变：原第 2 点刚落的时刻拉伸后仍只见 2 点，进度到尾全部可见
    const mid = frameAt(model, 150 * scale);
    const end = frameAt(model, model.durationMs);
    if (mid.engine !== "atrament" || end.engine !== "atrament") {
      throw new Error("frame 应为 atrament");
    }
    expect(mid.visiblePoints).toEqual([2]);
    expect(end.visiblePoints).toEqual([3]);
  });

  it("多笔短数据：等比拉伸后笔间先后顺序与节奏保持（比例恰为整数 4，无浮点噪声）", () => {
    // 第 1 笔 0→300ms、固定间隙 160ms、第 2 笔起点 460、0→40ms → 总 500ms，
    // 拉伸比例 2000/500 = 4：所有时间戳恰为 4 倍整数，可做精确断言
    const model = parseOk({
      engine: "atrament",
      version: 1,
      data: {
        strokes: [
          {
            tool: "pen",
            color: "#1f2328",
            weight: 4,
            points: [
              { x: 0, y: 0, p: 0.5, t: 0 },
              { x: 30, y: 0, p: 0.5, t: 100 },
              { x: 60, y: 0, p: 0.5, t: 300 },
            ],
          },
          {
            tool: "pen",
            color: "#1f2328",
            weight: 4,
            points: [
              { x: 0, y: 10, p: 0.5, t: 0 },
              { x: 20, y: 10, p: 0.5, t: 40 },
            ],
          },
        ],
      },
      updatedAt: 1,
    });
    if (model.engine !== "atrament") throw new Error("engine 应为 atrament");
    expect(model.durationMs).toBe(REPLAY_MIN_DURATION_MS);
    expect(model.slots[0]?.pointTimesMs).toEqual([0, 400, 1200]);
    expect(model.slots[1]?.startMs).toBe(1840);
    expect(model.slots[1]?.pointTimesMs).toEqual([0, 160]);
    // 顺序不变：第 2 笔任何点可见 ⇒ 第 1 笔已完整（时间轴仍严格分段）
    for (let t = 0; t <= model.durationMs; t += 37) {
      const frame = frameAt(model, t);
      if (frame.engine !== "atrament") throw new Error("frame 应为 atrament");
      const [first, second] = frame.visiblePoints;
      if ((second ?? 0) > 0) expect(first).toBe(3);
      if ((first ?? 0) > 0 && (first ?? 0) < 3) expect(second).toBe(0);
    }
  });

  it("excalidraw 短数据同样拉伸：元素起止等比缩放，总时长 ≥2s", () => {
    // freedraw 30 点（360ms）+ 矩形（240ms）→ 总 600ms
    const model = parseOk({
      engine: "excalidraw",
      version: 1,
      data: {
        scene: {
          elements: [
            { id: "a", type: "freedraw", points: new Array(30).fill(0) },
            { id: "b", type: "rectangle" },
          ],
        },
      },
      updatedAt: 1,
    });
    if (model.engine !== "excalidraw")
      throw new Error("engine 应为 excalidraw");
    expect(model.durationMs).toBeGreaterThanOrEqual(REPLAY_MIN_DURATION_MS);
    const scale = REPLAY_MIN_DURATION_MS / 600;
    expect(model.slots[0]?.startMs).toBe(0);
    expect(model.slots[0]?.endMs).toBeCloseTo(360 * scale, 6);
    expect(model.slots[1]?.startMs).toBeCloseTo(360 * scale, 6);
    expect(model.slots[1]?.endMs).toBeGreaterThanOrEqual(
      REPLAY_MIN_DURATION_MS,
    );
  });

  it("0 时长（单点笔画/空元素）不强行拉伸——保持「即时完整显示」原语义", () => {
    const atrament = parseOk({
      engine: "atrament",
      version: 1,
      data: {
        strokes: [
          {
            tool: "pen",
            color: "#1f2328",
            weight: 4,
            points: [{ x: 5, y: 5, p: 0.5, t: 0 }],
          },
        ],
      },
      updatedAt: 1,
    });
    if (atrament.engine !== "atrament") throw new Error("engine 应为 atrament");
    expect(atrament.durationMs).toBe(0);
    const excalidraw = parseOk({
      engine: "excalidraw",
      version: 1,
      data: { scene: { elements: [] } },
      updatedAt: 1,
    });
    if (excalidraw.engine !== "excalidraw")
      throw new Error("engine 应为 excalidraw");
    expect(excalidraw.durationMs).toBe(0);
  });
});

describe("parseInkReplayData：坏数据返回 null（组件走降级）", () => {
  it.each([
    ["null", null],
    ["数组", [1, 2]],
    [
      "未知 engine",
      { engine: "pencilkit", version: 1, data: {}, updatedAt: 1 },
    ],
    ["version 不支持", { ...atramentDoc(), version: 2 }],
    [
      "缺 version",
      { engine: "atrament", data: atramentDoc().data, updatedAt: 1 },
    ],
    ["缺 data", { engine: "atrament", version: 1, updatedAt: 1 }],
    [
      "strokes 非数组",
      { engine: "atrament", version: 1, data: { strokes: {} }, updatedAt: 1 },
    ],
    [
      "笔画缺 points",
      {
        engine: "atrament",
        version: 1,
        data: { strokes: [{ tool: "pen" }] },
        updatedAt: 1,
      },
    ],
    [
      "点缺有限 x",
      {
        engine: "atrament",
        version: 1,
        data: { strokes: [{ tool: "pen", points: [{ x: Number.NaN, y: 0 }] }] },
        updatedAt: 1,
      },
    ],
    [
      "scene 缺失",
      { engine: "excalidraw", version: 1, data: {}, updatedAt: 1 },
    ],
    [
      "elements 非数组",
      {
        engine: "excalidraw",
        version: 1,
        data: { scene: { elements: "x" } },
        updatedAt: 1,
      },
    ],
    [
      "元素非对象",
      {
        engine: "excalidraw",
        version: 1,
        data: { scene: { elements: [1] } },
        updatedAt: 1,
      },
    ],
  ])("%s → null", (_name, doc) => {
    expect(parseInkReplayData(doc)).toBeNull();
  });
});

describe("frameAt：atrament 带时间戳重演", () => {
  const model = parseOk(atramentDoc());
  const S2 = 3000 + REPLAY_INTER_STROKE_GAP_MS; // 第 2 笔全局起点

  it("t=0 只见第 1 笔的起点（前段）", () => {
    const frame = frameAt(model, 0);
    if (frame.engine !== "atrament") throw new Error("frame 应为 atrament");
    expect(frame.visiblePoints).toEqual([1, 0]);
  });

  it("t 中点：第 1 笔进行到一半，第 2 笔未开始", () => {
    const frame = frameAt(model, 1500);
    if (frame.engine !== "atrament") throw new Error("frame 应为 atrament");
    expect(frame.visiblePoints).toEqual([2, 0]);
  });

  it("笔内插值按点时间戳：恰好落在点时刻含该点，早一刻不含", () => {
    const justBefore = frameAt(model, 999);
    const atPoint = frameAt(model, 1000);
    if (justBefore.engine !== "atrament" || atPoint.engine !== "atrament") {
      throw new Error("frame 应为 atrament");
    }
    expect(justBefore.visiblePoints[0]).toBe(1);
    expect(atPoint.visiblePoints[0]).toBe(2);
  });

  it("笔间间隙内：第 1 笔完整、第 2 笔未开始；到第 2 笔起点即见其首点", () => {
    const inGap = frameAt(model, S2 - 1);
    const atStart2 = frameAt(model, S2);
    if (inGap.engine !== "atrament" || atStart2.engine !== "atrament") {
      throw new Error("frame 应为 atrament");
    }
    expect(inGap.visiblePoints).toEqual([4, 0]);
    expect(atStart2.visiblePoints).toEqual([4, 1]);
  });

  it("t=总时长全部笔画完整；越界（负数/超尾）按边界夹逼", () => {
    const end = frameAt(model, model.durationMs);
    const beyond = frameAt(model, model.durationMs + 10_000);
    const negative = frameAt(model, -50);
    for (const frame of [end, beyond, negative]) {
      if (frame.engine !== "atrament") throw new Error("frame 应为 atrament");
    }
    expect((end as { visiblePoints: number[] }).visiblePoints).toEqual([4, 3]);
    expect((beyond as { visiblePoints: number[] }).visiblePoints).toEqual([
      4, 3,
    ]);
    expect((negative as { visiblePoints: number[] }).visiblePoints).toEqual([
      1, 0,
    ]);
  });

  it("进度跳转任意时刻都得到确定状态（顺序重演不跳笔）", () => {
    // 对一批任意时刻断言「第 2 笔可见 > 0 ⇒ 第 1 笔已完整」——时间轴严格分段
    for (let t = 0; t <= model.durationMs; t += 37) {
      const frame = frameAt(model, t);
      if (frame.engine !== "atrament") throw new Error("frame 应为 atrament");
      const [first, second] = frame.visiblePoints;
      if ((second ?? 0) > 0) expect(first).toBe(4);
      if ((first ?? 0) > 0 && (first ?? 0) < 4) expect(second).toBe(0);
    }
  });
});

describe("frameAt：excalidraw 顺序重演（元素逐个出现）", () => {
  // 200 点 freedraw（2400ms）+ 矩形（240ms）→ 总时长 2640ms ≥ 下限，不触发拉伸
  const model = parseOk({
    engine: "excalidraw",
    version: 1,
    data: {
      scene: {
        elements: [
          { id: "a", type: "freedraw", points: new Array(200).fill(0) },
          { id: "b", type: "rectangle" },
        ],
      },
    },
    updatedAt: 1,
  });

  it("每个元素的起点时刻整体出现，逐个累加", () => {
    const frames = [0, 2399, 2400].map((t) => {
      const f = frameAt(model, t);
      if (f.engine !== "excalidraw") throw new Error("frame 应为 excalidraw");
      return f.visibleElements;
    });
    expect(frames).toEqual([1, 1, 2]); // 首元素 t=0 即出现；到 2400（=200×12）第 2 个出现
  });
});

describe("advancePlayhead：倍速只影响调度，不影响 frameAt", () => {
  const model = parseOk(atramentDoc());
  const DURATION = model.durationMs;

  it("1× 匀速推进；2×/4× 同样真实时长推进更快", () => {
    expect(advancePlayhead(0, 100, 1, DURATION).timeMs).toBe(100);
    expect(advancePlayhead(0, 100, 2, DURATION).timeMs).toBe(200);
    expect(advancePlayhead(0, 100, 4, DURATION).timeMs).toBe(400);
  });

  it("到总时长夹逼并标记 ended；elapsed 为负按 0 处理", () => {
    const hit = advancePlayhead(DURATION - 10, 100, 1, DURATION);
    expect(hit.timeMs).toBe(DURATION);
    expect(hit.ended).toBe(true);
    expect(advancePlayhead(500, -30, 1, DURATION).timeMs).toBe(500);
    expect(advancePlayhead(500, 0, 1, DURATION).ended).toBe(false);
  });

  it("倍速换算后的绝对时刻喂 frameAt，画面与同时刻 1× 一致（调度与画面解耦）", () => {
    const at2x = advancePlayhead(0, 50, 2, DURATION).timeMs;
    const at1x = advancePlayhead(0, 100, 1, DURATION).timeMs;
    expect(at2x).toBe(at1x);
    expect(frameAt(model, at2x)).toEqual(frameAt(model, at1x));
  });

  it("倍速档位恰为 1/2/4（D12 约定）", () => {
    expect([...REPLAY_SPEEDS]).toEqual([1, 2, 4]);
  });
});

describe("formatReplayTime", () => {
  it("1 分钟内显示 0.1 秒精度；超过按「x 分 yy 秒」", () => {
    expect(formatReplayTime(0)).toBe("0.0 秒");
    expect(formatReplayTime(1234)).toBe("1.2 秒");
    expect(formatReplayTime(59_940)).toBe("59.9 秒");
    expect(formatReplayTime(60_000)).toBe("1 分");
    expect(formatReplayTime(83_000)).toBe("1 分 23 秒");
  });
});

import { describe, expect, it } from "vitest";
import {
  advancePointerMachine,
  createPointerMachineState,
  observeStylusTouch,
  type PointerMachineState,
  touchActionForInput,
} from "./pointer-machine.ts";

/** 从 state 快速构造活动指针 */
function withActive(
  state: PointerMachineState,
  pointerId: number,
  pointerType: string,
): PointerMachineState {
  return {
    ...state,
    activePointerId: pointerId,
    activePointerType: pointerType,
  };
}

/**
 * 指针生命周期状态机决策表测试（T6R.7，方案 §4.1）。
 *
 * 事件矩阵口径：
 * - 每行 = 一个输入事件在给定（模式 × 已观测笔 × 活动指针）下的唯一决策；
 * - 决策只有五种：none（忽略）/ start（开始跟踪）/ sample（采样）/
 *   commit（按已收真实采样收笔，cause 区分触发源）/ discard（丢弃活动笔段）；
 * - 不变量：一笔的生命周期内 activePointerId 只会被自己的事件或
 *   cancel/lostcapture/blur/layoutchange 收笔；收笔后同一物理手势的后续
 *   事件一律 none（不粘笔）；第二指针永不接管活动指针（auto 模式
 *   「笔取代手掌」是唯一例外，属既有防误触语义）。
 */

describe("pointer-machine：pointerdown 门控", () => {
  it("auto 模式（旧行为）：手指先落墨、笔后落时丢弃手掌笔段并接管", () => {
    let state = createPointerMachineState("auto");
    // 手指先落：落墨（旧行为兼容——首次手指触屏允许书写）
    let r = advancePointerMachine(state, {
      kind: "pointerdown",
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      inBounds: true,
    });
    expect(r.decisions).toEqual([{ action: "start", pointerId: 1 }]);
    state = r.state;
    expect(state).toMatchObject({ activePointerId: 1, penObserved: false });

    // 笔落下：丢弃手掌笔段 + 笔开始 + 置 penObserved
    r = advancePointerMachine(state, {
      kind: "pointerdown",
      pointerId: 2,
      pointerType: "pen",
      button: 0,
      inBounds: true,
    });
    expect(r.decisions).toEqual([
      { action: "discard" },
      { action: "start", pointerId: 2 },
    ]);
    expect(r.state).toMatchObject({ activePointerId: 2, penObserved: true });

    // 此后手指不再落墨（pen-only 防手掌误触）
    r = advancePointerMachine(r.state, {
      kind: "pointerdown",
      pointerId: 3,
      pointerType: "touch",
      button: 0,
      inBounds: true,
    });
    expect(r.decisions).toEqual([{ action: "none" }]);
    expect(r.state.activePointerId).toBe(2);
  });

  it("pen 模式：手指恒不落墨（=滚动），首次手指即 none；鼠标与笔可写", () => {
    const state = createPointerMachineState("pen");
    let r = advancePointerMachine(state, {
      kind: "pointerdown",
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      inBounds: true,
    });
    expect(r.decisions).toEqual([{ action: "none" }]);
    expect(r.state.activePointerId).toBeNull();

    r = advancePointerMachine(state, {
      kind: "pointerdown",
      pointerId: 4,
      pointerType: "pen",
      button: 0,
      inBounds: true,
    });
    expect(r.decisions).toEqual([{ action: "start", pointerId: 4 }]);

    r = advancePointerMachine(state, {
      kind: "pointerdown",
      pointerId: 5,
      pointerType: "mouse",
      button: 0,
      inBounds: true,
    });
    expect(r.decisions).toEqual([{ action: "start", pointerId: 5 }]);
  });

  it("finger 模式：手指可写；笔落下不丢弃活动手指笔段（第二指针不接管）", () => {
    let state = createPointerMachineState("finger");
    let r = advancePointerMachine(state, {
      kind: "pointerdown",
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      inBounds: true,
    });
    expect(r.decisions).toEqual([{ action: "start", pointerId: 1 }]);
    state = r.state;

    // 手指书写中笔轻点：不接管、不丢弃（finger 模式没有手掌丢弃语义）
    r = advancePointerMachine(state, {
      kind: "pointerdown",
      pointerId: 2,
      pointerType: "pen",
      button: 0,
      inBounds: true,
    });
    expect(r.decisions).toEqual([{ action: "none" }]);
    expect(r.state.activePointerId).toBe(1);
  });

  it("第二指针不接管活动指针：auto 手指/手指、pen 模式笔/笔、鼠标在途时新指针", () => {
    // auto 模式未见过笔：第一手指活动，第二手指被忽略（不再覆盖活动指针）
    const auto = withActive(createPointerMachineState("auto"), 1, "touch");
    expect(
      advancePointerMachine(auto, {
        kind: "pointerdown",
        pointerId: 2,
        pointerType: "touch",
        button: 0,
        inBounds: true,
      }).decisions,
    ).toEqual([{ action: "none" }]);

    // pen 模式：活动笔书写中第二支笔落下 → 忽略
    const penState = withActive(createPointerMachineState("pen"), 7, "pen");
    expect(
      advancePointerMachine(penState, {
        kind: "pointerdown",
        pointerId: 8,
        pointerType: "pen",
        button: 0,
        inBounds: true,
      }).decisions,
    ).toEqual([{ action: "none" }]);

    // 鼠标在途（auto）：任何第二指针（含笔）不接管——只有「笔取代手掌」例外
    const mouseActive = withActive(
      createPointerMachineState("auto"),
      9,
      "mouse",
    );
    expect(
      advancePointerMachine(mouseActive, {
        kind: "pointerdown",
        pointerId: 10,
        pointerType: "pen",
        button: 0,
        inBounds: true,
      }).decisions,
    ).toEqual([{ action: "none" }]);
    expect(mouseActive.activePointerId).toBe(9);
  });

  it("非主键（右键等）不写；越界指针不开始，但 auto 模式笔的观测副作用仍生效", () => {
    const auto = createPointerMachineState("auto");
    // 手掌先落在写（auto）
    const palm = withActive(auto, 1, "touch");
    // 越界的笔：丢弃手掌笔段 + 置 penObserved，但不 start（与既有适配器行为一致）
    const r = advancePointerMachine(palm, {
      kind: "pointerdown",
      pointerId: 2,
      pointerType: "pen",
      button: 0,
      inBounds: false,
    });
    expect(r.decisions).toEqual([{ action: "discard" }]);
    expect(r.state).toMatchObject({ activePointerId: null, penObserved: true });

    // 右键：none，且不置 penObserved
    const fresh = createPointerMachineState("auto");
    const r2 = advancePointerMachine(fresh, {
      kind: "pointerdown",
      pointerId: 3,
      pointerType: "pen",
      button: 2,
      inBounds: true,
    });
    expect(r2.decisions).toEqual([{ action: "none" }]);
    expect(r2.state.penObserved).toBe(false);
  });

  it("同一 pointerId 重复 pointerdown（异常序列）不重入", () => {
    const state = withActive(createPointerMachineState("auto"), 1, "pen");
    const r = advancePointerMachine(state, {
      kind: "pointerdown",
      pointerId: 1,
      pointerType: "pen",
      button: 0,
      inBounds: true,
    });
    // 活动指针重按：视为延续，不产生新 start
    expect(r.decisions).toEqual([{ action: "none" }]);
    expect(r.state.activePointerId).toBe(1);
  });
});

describe("pointer-machine：采样与收笔", () => {
  it("只有活动指针的 move 采样；他人 move 与空闲期 move 均忽略", () => {
    const state = withActive(createPointerMachineState("pen"), 4, "pen");
    expect(
      advancePointerMachine(state, { kind: "pointermove", pointerId: 4 })
        .decisions,
    ).toEqual([{ action: "sample", pointerId: 4 }]);
    expect(
      advancePointerMachine(state, { kind: "pointermove", pointerId: 5 })
        .decisions,
    ).toEqual([{ action: "none" }]);
    expect(
      advancePointerMachine(createPointerMachineState("pen"), {
        kind: "pointermove",
        pointerId: 4,
      }).decisions,
    ).toEqual([{ action: "none" }]);
  });

  it("pointerup：活动指针收笔（up），非活动指针 none（不粘笔）", () => {
    const state = withActive(createPointerMachineState("auto"), 1, "pen");
    const r = advancePointerMachine(state, { kind: "pointerup", pointerId: 1 });
    expect(r.decisions).toEqual([
      { action: "commit", pointerId: 1, cause: "up" },
    ]);
    expect(r.state.activePointerId).toBeNull();
    // 收笔后的同指针 up/move：none
    expect(
      advancePointerMachine(r.state, { kind: "pointerup", pointerId: 1 })
        .decisions,
    ).toEqual([{ action: "none" }]);
    expect(
      advancePointerMachine(state, { kind: "pointerup", pointerId: 2 })
        .decisions,
    ).toEqual([{ action: "none" }]);
    expect(state.activePointerId).toBe(1);
  });

  it("pointercancel：按真实已收采样收笔（cause=cancel），不伪造终点；后续同指针事件全 none", () => {
    const state = withActive(createPointerMachineState("pen"), 3, "pen");
    const r = advancePointerMachine(state, {
      kind: "pointercancel",
      pointerId: 3,
    });
    expect(r.decisions).toEqual([
      { action: "commit", pointerId: 3, cause: "cancel" },
    ]);
    expect(r.state.activePointerId).toBeNull();
    // 取消后同一手势的 move/up 到来：不粘笔、不再延伸
    for (const ev of [
      { kind: "pointermove", pointerId: 3 },
      { kind: "pointerup", pointerId: 3 },
    ] as const) {
      const after = advancePointerMachine(r.state, ev);
      expect(after.decisions).toEqual([{ action: "none" }]);
    }
  });

  it("lostpointercapture：活动指针收笔；up 后补发的 lostcapture 无效", () => {
    const state = withActive(createPointerMachineState("auto"), 2, "touch");
    const r = advancePointerMachine(state, {
      kind: "lostpointercapture",
      pointerId: 2,
    });
    expect(r.decisions).toEqual([
      { action: "commit", pointerId: 2, cause: "lostpointercapture" },
    ]);
    // 正常序列：up 先收笔，随后浏览器补发 lostpointercapture → none（不双收）
    const again = advancePointerMachine(r.state, {
      kind: "lostpointercapture",
      pointerId: 2,
    });
    expect(again.decisions).toEqual([{ action: "none" }]);
    // 非活动指针的 lostcapture：none
    expect(
      advancePointerMachine(state, {
        kind: "lostpointercapture",
        pointerId: 99,
      }).decisions,
    ).toEqual([{ action: "none" }]);
  });

  it("窗口失焦（blur）：活动笔段按已收采样收笔；空闲时 none", () => {
    const state = withActive(createPointerMachineState("finger"), 1, "touch");
    expect(advancePointerMachine(state, { kind: "blur" }).decisions).toEqual([
      { action: "commit", pointerId: 1, cause: "blur" },
    ]);
    expect(
      advancePointerMachine(createPointerMachineState("finger"), {
        kind: "blur",
      }).decisions,
    ).toEqual([{ action: "none" }]);
  });

  it("布局变化（旋转/resize）：在途一笔先收笔（cause=layoutchange）再换坐标变换；空闲时 none", () => {
    const state = withActive(createPointerMachineState("pen"), 5, "pen");
    const r = advancePointerMachine(state, { kind: "layoutchange" });
    expect(r.decisions).toEqual([
      { action: "commit", pointerId: 5, cause: "layoutchange" },
    ]);
    expect(r.state.activePointerId).toBeNull();
    // 同一物理手势 resize 后的 move：丢弃（新坐标不混入旧笔画）
    expect(
      advancePointerMachine(r.state, { kind: "pointermove", pointerId: 5 })
        .decisions,
    ).toEqual([{ action: "none" }]);
    expect(
      advancePointerMachine(createPointerMachineState("pen"), {
        kind: "layoutchange",
      }).decisions,
    ).toEqual([{ action: "none" }]);
  });
});

describe("pointer-machine：stylus 触摸观测与 touch-action 策略", () => {
  it("observeStylusTouch：auto 模式置 penObserved；pen/finger 模式无状态变化", () => {
    const auto = observeStylusTouch(createPointerMachineState("auto"));
    expect(auto.penObserved).toBe(true);
    expect(observeStylusTouch(auto).penObserved).toBe(true); // 幂等
    expect(
      observeStylusTouch(createPointerMachineState("pen")).penObserved,
    ).toBe(false);
    expect(
      observeStylusTouch(createPointerMachineState("finger")).penObserved,
    ).toBe(false);
  });

  it("touchActionForInput：模式 × scroll 工具的三态矩阵", () => {
    // auto（旧行为）：未见笔 none（手指直接书写）；见过笔/滚动工具 pan-y
    expect(touchActionForInput("auto", false, false)).toBe("none");
    expect(touchActionForInput("auto", true, false)).toBe("pan-y");
    expect(touchActionForInput("auto", false, true)).toBe("pan-y");
    // pen：手指恒滚动（pan-y），scroll 工具同
    expect(touchActionForInput("pen", false, false)).toBe("pan-y");
    expect(touchActionForInput("pen", true, true)).toBe("pan-y");
    // finger：手指书写（none）；scroll 工具仍放行滚动
    expect(touchActionForInput("finger", false, false)).toBe("none");
    expect(touchActionForInput("finger", true, false)).toBe("none");
    expect(touchActionForInput("finger", false, true)).toBe("pan-y");
  });
});

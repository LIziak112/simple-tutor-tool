import { describe, expect, it } from "vitest";
import {
  advancePointerMachine,
  createPointerMachineState,
  isSampleMove,
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

  it("finger 模式：手指可写；笔落下先收笔手指笔段再接管（自愈，不丢弃已收点）", () => {
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

    // 手指书写中笔轻点：finger 模式没有手掌丢弃语义——按自愈收笔（保留
    // 手指笔段已收点）后笔接管
    r = advancePointerMachine(state, {
      kind: "pointerdown",
      pointerId: 2,
      pointerType: "pen",
      button: 0,
      inBounds: true,
    });
    expect(r.decisions).toEqual([
      { action: "commit", pointerId: 1, cause: "superseded" },
      { action: "start", pointerId: 2 },
    ]);
  });

  it("第二指针/同 id 重按＝收尾丢失自愈：先 commit(superseded) 再 start 新笔（复审①）", () => {
    // auto 模式未见过笔：第一手指在途，第二手指落下 → 在途笔收笔 + 新笔开始
    const auto = withActive(createPointerMachineState("auto"), 1, "touch");
    expect(
      advancePointerMachine(auto, {
        kind: "pointerdown",
        pointerId: 2,
        pointerType: "touch",
        button: 0,
        inBounds: true,
      }).decisions,
    ).toEqual([
      { action: "commit", pointerId: 1, cause: "superseded" },
      { action: "start", pointerId: 2 },
    ]);

    // pen 模式：活动笔书写中第二支笔落下 → 同样自愈接管（Scribble 抢占形态）
    const penState = withActive(createPointerMachineState("pen"), 7, "pen");
    const r = advancePointerMachine(penState, {
      kind: "pointerdown",
      pointerId: 8,
      pointerType: "pen",
      button: 0,
      inBounds: true,
    });
    expect(r.decisions).toEqual([
      { action: "commit", pointerId: 7, cause: "superseded" },
      { action: "start", pointerId: 8 },
    ]);
    expect(r.state.activePointerId).toBe(8);

    // 鼠标在途（auto）时笔落下：自愈收笔鼠标笔段后笔接管（不再忽略）
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
    ).toEqual([
      { action: "commit", pointerId: 9, cause: "superseded" },
      { action: "start", pointerId: 10 },
    ]);
  });

  it("同 id 重复 down＝重开（commit + start，语义定案）；capture 丢失后新 down 恢复书写（角D）", () => {
    // 同 id 重复 down：旧版「覆盖重开」语义的统一定案＝收笔已收点后重开
    const same = withActive(createPointerMachineState("auto"), 1, "pen");
    expect(
      advancePointerMachine(same, {
        kind: "pointerdown",
        pointerId: 1,
        pointerType: "pen",
        button: 0,
        inBounds: true,
      }).decisions,
    ).toEqual([
      { action: "commit", pointerId: 1, cause: "superseded" },
      { action: "start", pointerId: 1 },
    ]);

    // capture 丢失（up/cancel/lostcapture 全部未达）后鼠标再 down：不锁死，
    // 恢复后的正常序列（move 采样、up 收笔）照常工作
    const recovered = advancePointerMachine(
      withActive(createPointerMachineState("auto"), 3, "pen"),
      {
        kind: "pointerdown",
        pointerId: 99,
        pointerType: "mouse",
        button: 0,
        inBounds: true,
      },
    );
    expect(recovered.decisions).toEqual([
      { action: "commit", pointerId: 3, cause: "superseded" },
      { action: "start", pointerId: 99 },
    ]);
    expect(
      advancePointerMachine(recovered.state, {
        kind: "pointermove",
        pointerId: 99,
      }).decisions,
    ).toEqual([{ action: "sample", pointerId: 99 }]);
    expect(
      advancePointerMachine(recovered.state, {
        kind: "pointerup",
        pointerId: 99,
      }).decisions,
    ).toEqual([{ action: "commit", pointerId: 99, cause: "up" }]);
  });

  it("自愈越界变体：在途笔被收笔（superseded）但越界新笔不开始（解锁≠必写）", () => {
    const r = advancePointerMachine(
      withActive(createPointerMachineState("pen"), 4, "pen"),
      {
        kind: "pointerdown",
        pointerId: 5,
        pointerType: "pen",
        button: 0,
        inBounds: false,
      },
    );
    expect(r.decisions).toEqual([
      { action: "commit", pointerId: 4, cause: "superseded" },
    ]);
    expect(r.state.activePointerId).toBeNull();
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

  // 同 id 重复 down 的语义已并入「第二指针/同 id 重按＝收尾丢失自愈」用例
  //（复审①定案：重开＝commit(superseded)+start），不再单列。
});

describe("pointer-machine：采样与收笔", () => {
  it("isSampleMove 与 advance(pointermove) 严格等价（状态×id 网格 property，复审⑦）", () => {
    const states: PointerMachineState[] = [
      createPointerMachineState("auto"),
      { ...createPointerMachineState("auto"), penObserved: true },
      createPointerMachineState("pen"),
      createPointerMachineState("finger"),
      withActive(createPointerMachineState("auto"), 5, "pen"),
      withActive(createPointerMachineState("auto"), 5, "touch"),
      withActive(createPointerMachineState("pen"), 7, "pen"),
      withActive(createPointerMachineState("finger"), 9, "touch"),
      withActive(createPointerMachineState("finger"), 9, "mouse"),
    ];
    for (const state of states) {
      for (const pointerId of [-1, 0, 5, 7, 9, 11]) {
        const r = advancePointerMachine(state, {
          kind: "pointermove",
          pointerId,
        });
        // 守卫 ⇔ 决策含 sample；且 pointermove 不产生状态转移（同引用）
        expect(isSampleMove(state, pointerId)).toBe(
          r.decisions.some((d) => d.action === "sample"),
        );
        expect(r.state).toBe(state);
      }
    }
  });

  it("鼠标任何模式恒可写：finger×mouse 与 auto+penObserved×mouse 两格（复审⑦补口）", () => {
    for (const state of [
      createPointerMachineState("finger"),
      { ...createPointerMachineState("auto"), penObserved: true },
    ]) {
      expect(
        advancePointerMachine(state, {
          kind: "pointerdown",
          pointerId: 1,
          pointerType: "mouse",
          button: 0,
          inBounds: true,
        }).decisions,
      ).toEqual([{ action: "start", pointerId: 1 }]);
    }
  });

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

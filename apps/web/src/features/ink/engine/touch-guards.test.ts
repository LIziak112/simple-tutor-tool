import { describe, expect, it, vi } from "vitest";
import { anyStylusTouch, createTouchGuards } from "./touch-guards.ts";

/** jsdom 没有 TouchEvent 构造器：用普通事件加上两张触点表 */
function touchEvent(changed: string[], all: string[] = changed): TouchEvent {
  const event = new Event("touchstart", { cancelable: true });
  Object.defineProperty(event, "changedTouches", {
    value: changed.map((touchType) => ({ touchType })),
  });
  Object.defineProperty(event, "touches", {
    value: all.map((touchType) => ({ touchType })),
  });
  return event as unknown as TouchEvent;
}

describe("触点表里有没有笔", () => {
  it("逐个触点看，不只看第一个；缺表或空表都算没有", () => {
    expect(anyStylusTouch([{ touchType: "direct" }])).toBe(false);
    expect(
      anyStylusTouch([{ touchType: "direct" }, { touchType: "stylus" }]),
    ).toBe(true);
    expect(anyStylusTouch([{}])).toBe(false);
    expect(anyStylusTouch([])).toBe(false);
    expect(anyStylusTouch(undefined)).toBe(false);
  });
});

describe("触摸与误触防护", () => {
  it("touchstart：只有手指时不拦截、不通知；新落下的是笔，或笔已经在屏上，都拦截并通知", () => {
    const onStylus = vi.fn();
    const guards = createTouchGuards(onStylus);

    const finger = touchEvent(["direct"]);
    guards.onTouchStart(finger);
    expect(finger.defaultPrevented).toBe(false);
    expect(onStylus).not.toHaveBeenCalled();

    // 手掌先落、笔第二个落下：changedTouches 里才有笔
    const penSecond = touchEvent(["stylus"], ["direct", "stylus"]);
    guards.onTouchStart(penSecond);
    expect(penSecond.defaultPrevented).toBe(true);
    expect(onStylus).toHaveBeenCalledTimes(1);

    // 笔先落、手掌后落：changedTouches 只有手掌，但 touches 里有笔
    const palmSecond = touchEvent(["direct"], ["stylus", "direct"]);
    guards.onTouchStart(palmSecond);
    expect(palmSecond.defaultPrevented).toBe(true);
    expect(onStylus).toHaveBeenCalledTimes(2);
  });

  it("touchmove：触点里有笔才拦截，不重复通知", () => {
    const onStylus = vi.fn();
    const guards = createTouchGuards(onStylus);
    const finger = touchEvent(["direct"]);
    guards.onTouchMove(finger);
    expect(finger.defaultPrevented).toBe(false);
    const pen = touchEvent(["stylus"]);
    guards.onTouchMove(pen);
    expect(pen.defaultPrevented).toBe(true);
    expect(onStylus).not.toHaveBeenCalled();
  });

  it("长按菜单与选中文字一律拦截", () => {
    const guards = createTouchGuards(() => {});
    const menu = new Event("contextmenu", { cancelable: true });
    guards.onContextMenu(menu);
    expect(menu.defaultPrevented).toBe(true);
    const select = new Event("selectstart", { cancelable: true });
    guards.onSelectStart(select);
    expect(select.defaultPrevented).toBe(true);
  });
});

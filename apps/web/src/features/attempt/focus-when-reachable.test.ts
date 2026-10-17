import { afterEach, describe, expect, it, vi } from "vitest";
import { focusWhenReachable } from "./focus-when-reachable";

/**
 * 跳题聚焦重试（webkit E2E「130题长作业」reload 后 toBeFocused 稳定失败的根因）：
 * reload 后材料核对未完成时题卡列表带 inert（作答保护，AGENTS.md「材料核对
 * 成功前不解除作答保护」），focus() 静默失败且无重试，焦点永不落题卡。
 * jsdom 未实现 inert 的聚焦拦截，用 inert 属性 + 一次性 focus mock 模拟
 * 「保护未解除时聚焦被吞」，断言仅在保护期内重试、解除后落焦。
 */

const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

describe("focusWhenReachable", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("聚焦成功时立即落地，不排重试帧", () => {
    const target = document.createElement("button");
    document.body.append(target);
    const focus = vi.spyOn(target, "focus");
    focusWhenReachable(target);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(target);
  });

  it("作答保护（inert 子树）内聚焦被吞时按帧重试，保护解除后落焦", async () => {
    const guard = document.createElement("div");
    const target = document.createElement("button");
    guard.setAttribute("inert", "");
    guard.append(target);
    document.body.append(guard);
    const focus = vi.spyOn(target, "focus");
    // 前两次模拟 inert 下 focus 静默失败（焦点不动）
    focus.mockImplementationOnce(() => {});
    focus.mockImplementationOnce(() => {});
    focusWhenReachable(target);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(target);
    // 第一次重试仍处于保护内且仍被吞（两次 mock 失败；rAF 实时器到达顺序
    // 受负载影响，中间计数只断言下界）。随后解除保护，链在下一帧落焦。
    await vi.waitFor(() =>
      expect(focus.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    guard.removeAttribute("inert");
    await vi.waitFor(() => expect(document.activeElement).toBe(target));
    expect(focus.mock.calls.length).toBeGreaterThanOrEqual(3);
    const settled = focus.mock.calls.length;
    await nextFrame();
    // 落焦后链终止：不再有新的 focus 调用
    expect(focus).toHaveBeenCalledTimes(settled);
  });

  it("保护外的聚焦失败不重试，不抢焦点", async () => {
    const target = document.createElement("button");
    document.body.append(target);
    const focus = vi.spyOn(target, "focus");
    focus.mockImplementationOnce(() => {});
    focusWhenReachable(target);
    expect(focus).toHaveBeenCalledTimes(1);
    await nextFrame();
    await nextFrame();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(target);
  });

  it("新跳题取代仍在重试的旧目标，旧链不再抢焦点", async () => {
    const guard = document.createElement("div");
    const stale = document.createElement("button");
    guard.setAttribute("inert", "");
    guard.append(stale);
    const fresh = document.createElement("button");
    document.body.append(guard, fresh);
    const staleFocus = vi.spyOn(stale, "focus").mockImplementation(() => {});
    focusWhenReachable(stale);
    expect(staleFocus).toHaveBeenCalledTimes(1);
    focusWhenReachable(fresh);
    expect(document.activeElement).toBe(fresh);
    await nextFrame();
    await nextFrame();
    // 旧链已被取代：不再尝试，焦点保持在新的目标上
    expect(staleFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(fresh);
  });

  it("目标缺失时不抛错、不重试", () => {
    expect(() => focusWhenReachable(null)).not.toThrow();
    expect(() => focusWhenReachable(undefined)).not.toThrow();
  });
});

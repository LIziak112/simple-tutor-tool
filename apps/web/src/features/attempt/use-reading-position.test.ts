import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReadingPosition } from "./use-reading-position";

let session: { origin: string; studentId: string } | null;
const key = (student = "a", attempt = "attempt", origin = "http://test") =>
  `attempt-reading:${JSON.stringify([origin, student, attempt])}`;
let cards: { current: Map<string, HTMLLIElement> };
let scroll: ReturnType<
  typeof vi.fn<(x: number | ScrollToOptions, y?: number) => void>
>;
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  session = { origin: "http://test", studentId: "a" };
  const element = document.createElement("li");
  element.innerHTML = '<article tabindex="-1"></article>';
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    top: 300,
    bottom: 700,
    height: 400,
  } as DOMRect);
  cards = { current: new Map([["q2", element]]) };
  scroll = vi.fn<(x: number | ScrollToOptions, y?: number) => void>();
  vi.spyOn(window, "scrollTo").mockImplementation(scroll);
});
vi.mock("@/features/annotation/use-annotation-record", () => ({
  useAnnotationSessionRef: () => session,
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const advance = () => act(() => vi.advanceTimersByTime(1000));
describe("学生阅读位置恢复", () => {
  it("稳定后按相对题头偏移恢复一次，不抢输入焦点", () => {
    localStorage.setItem(
      key(),
      JSON.stringify({ questionId: "q2", offset: -20 }),
    );
    const onCurrent = vi.fn();
    renderHook(() =>
      useReadingPosition("attempt", cards, onCurrent, vi.fn(), 0),
    );
    expect(scroll).not.toHaveBeenCalled();
    advance();
    expect(scroll).toHaveBeenCalledExactlyOnceWith({
      top: 256,
      behavior: "instant",
    });
    expect(onCurrent).toHaveBeenCalledWith("q2");
    advance();
    expect(scroll).toHaveBeenCalledTimes(1);
  });
  it.each(["wheel", "touchstart", "pointerdown", "keydown"])(
    "%s先发生则取消待执行恢复",
    (event) => {
      localStorage.setItem(
        key(),
        JSON.stringify({ questionId: "q2", offset: 0 }),
      );
      renderHook(() =>
        useReadingPosition("attempt", cards, vi.fn(), vi.fn(), 0),
      );
      act(() => window.dispatchEvent(new Event(event)));
      advance();
      expect(scroll).not.toHaveBeenCalled();
    },
  );
  it("只保存可见题和相对偏移，学生、部署、练习及未绑定身份不串记录", () => {
    const onCurrent = vi.fn();
    const { rerender } = renderHook(
      ({ id }) => useReadingPosition(id, cards, onCurrent, vi.fn(), 0),
      {
        initialProps: { id: "attempt" },
      },
    );
    act(() => window.dispatchEvent(new Event("scroll")));
    advance();
    expect(JSON.parse(localStorage.getItem(key()) ?? "null")).toEqual({
      questionId: "q2",
      offset: 236,
    });
    session = { origin: "http://other", studentId: "b" };
    rerender({ id: "other" });
    expect(scroll).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new Event("scroll")));
    advance();
    expect(
      localStorage.getItem(key("b", "other", "http://other")),
    ).not.toBeNull();
    session = null;
    rerender({ id: "other" });
    act(() => window.dispatchEvent(new Event("scroll")));
    advance();
    expect(localStorage.length).toBe(2);
  });
  it("资源未就绪不提前恢复；死线到点按现状对齐一次", () => {
    const element = cards.current.get("q2");
    element?.insertAdjacentHTML(
      "beforeend",
      '<div data-slot="question-surface"><span role="status">加载同</span></div>',
    );
    localStorage.setItem(
      key(),
      JSON.stringify({ questionId: "q2", offset: 0 }),
    );
    const { unmount } = renderHook(() =>
      useReadingPosition("attempt", cards, vi.fn(), vi.fn(), 0),
    );
    act(() => vi.advanceTimersByTime(4000));
    // 死线前资源未就绪：不提前对位（稳定门仍生效）
    expect(scroll).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(2000));
    // 死线到点仍未就绪：按当前几何立即对齐一次（300 - 64 - 0 = 236），
    // 不再弃恢复把学生晾在顶部
    expect(scroll).toHaveBeenCalledExactlyOnceWith({
      top: 236,
      behavior: "instant",
    });
    element?.querySelector("span")?.remove();
    advance();
    // 资源此后就绪：不再第二次跳页
    expect(scroll).toHaveBeenCalledTimes(1);
    unmount();
    advance();
    expect(scroll).toHaveBeenCalledTimes(1);
  });
  it("过期题号、损坏存储和存储失败不影响作答", () => {
    localStorage.setItem(
      key(),
      JSON.stringify({ questionId: "removed", offset: 0 }),
    );
    const { unmount } = renderHook(() =>
      useReadingPosition("attempt", cards, vi.fn(), vi.fn(), 0),
    );
    advance();
    expect(scroll).not.toHaveBeenCalled();
    unmount();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("不可用");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("不可用");
    });
    expect(() =>
      renderHook(() =>
        useReadingPosition("attempt", cards, vi.fn(), vi.fn(), 0),
      ),
    ).not.toThrow();
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(advance).not.toThrow();
  });
  it("草稿同步等旁路状态不阻止稳定题面恢复", () => {
    cards.current
      .get("q2")
      ?.insertAdjacentHTML(
        "beforeend",
        '<span role="status">草稿等待同步</span>',
      );
    localStorage.setItem(
      key(),
      JSON.stringify({ questionId: "q2", offset: 0 }),
    );
    renderHook(() => useReadingPosition("attempt", cards, vi.fn(), vi.fn(), 0));
    advance();
    expect(scroll).toHaveBeenCalledTimes(1);
  });
  it("关闭页面立即保存最新滚动位置，不等待防抖计时", () => {
    renderHook(() => useReadingPosition("attempt", cards, vi.fn(), vi.fn(), 0));
    const element = cards.current.get("q2");
    if (!element) throw new Error("缺少题卡夹具");
    vi.mocked(element.getBoundingClientRect).mockReturnValue({
      top: 100,
      bottom: 500,
      height: 400,
    } as DOMRect);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(JSON.parse(localStorage.getItem(key()) ?? "null")).toEqual({
      questionId: "q2",
      offset: 36,
    });
  });
  it("身份绑定较晚时，也不抢走此前已开始操作的用户", () => {
    localStorage.setItem(
      key(),
      JSON.stringify({ questionId: "q2", offset: -20 }),
    );
    session = null;
    const onCurrent = vi.fn();
    const { rerender } = renderHook(() =>
      useReadingPosition("attempt", cards, onCurrent, vi.fn(), 0),
    );
    act(() => window.dispatchEvent(new Event("wheel")));
    session = { origin: "http://test", studentId: "a" };
    rerender();
    advance();
    expect(scroll).not.toHaveBeenCalled();
  });
});

describe("阅读位置死线兜底", () => {
  it("死线到点仍未稳定也完成对齐，不再弃恢复", () => {
    localStorage.setItem(
      key(),
      JSON.stringify({ questionId: "q2", offset: 20 }),
    );
    const li = document.createElement("li");
    // 永不完的图（jsdom 不加载）：ready 恒 false → 稳定门恒不满足
    li.innerHTML = '<article tabindex="-1"></article><img src="pending.png" />';
    vi.spyOn(li, "getBoundingClientRect").mockReturnValue({
      top: 300,
      bottom: 700,
      height: 400,
    } as DOMRect);
    cards.current = new Map([["q2", li]]);
    renderHook(() => useReadingPosition("attempt", cards, vi.fn(), vi.fn(), 0));
    expect(scroll).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(6000));
    // 5s 死线到点：按最后几何立即对齐（300 - 64 - 20 = 216），不再晾在顶部
    expect(scroll).toHaveBeenCalledExactlyOnceWith({
      top: 216,
      behavior: "instant",
    });
  });
});

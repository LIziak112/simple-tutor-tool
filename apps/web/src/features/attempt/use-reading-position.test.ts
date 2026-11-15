import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@/test/render-with-portal";
import {
  createReadingPositionCapture,
  registerReadingCard,
} from "./reading-position-capture";
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
  it("同数量题卡替换导致位置不单调时，按实际位置重新捕获", () => {
    const rect = (top: number) => ({ top, bottom: top + 80 }) as DOMRect;
    const first = document.createElement("li");
    const last = document.createElement("li");
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue(rect(100));
    vi.spyOn(last, "getBoundingClientRect").mockReturnValue(rect(10_000));
    const registered = new Map([
      ["first", first],
      ["last", last],
    ]);
    const capture = createReadingPositionCapture();
    expect(capture(registered, 64, 768, false)).toEqual({
      questionId: "first",
      offset: 36,
    });
    const moved = document.createElement("li");
    vi.spyOn(moved, "getBoundingClientRect").mockReturnValue(rect(76));
    registerReadingCard(registered, "last", moved);
    expect(capture(registered, 64, 768, true)).toEqual({
      questionId: "last",
      offset: 12,
    });
    expect(capture(registered, 64, 768, true)).toEqual({
      questionId: "last",
      offset: 12,
    });
  });

  it("百题卷小幅滚动只测量可见题卡和边界，远跳仍找准当前题", () => {
    let offset = 0;
    const measured: number[] = [];
    cards.current = new Map(
      Array.from({ length: 100 }, (_, index) => {
        const element = document.createElement("li");
        vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => {
          measured.push(index);
          return {
            top: index * 100 - offset,
            bottom: (index + 1) * 100 - offset,
          } as DOMRect;
        });
        return [`q${index}`, element];
      }),
    );
    const onCurrent = vi.fn();
    renderHook(() =>
      useReadingPosition("attempt", cards, onCurrent, vi.fn(), 0),
    );
    expect(measured).toHaveLength(100);
    measured.length = 0;
    offset = 35;
    act(() => window.dispatchEvent(new Event("scroll")));
    advance();
    expect(onCurrent).toHaveBeenLastCalledWith("q1");
    expect(measured.length).toBeLessThan(12);

    offset = 9100;
    act(() => window.dispatchEvent(new Event("scroll")));
    advance();
    expect(onCurrent).toHaveBeenLastCalledWith("q92");
  });

  it("普通挂载与切换练习不沿用答题卡开合的锚点", () => {
    const onCurrent = vi.fn();
    const requestMount = vi.fn();
    const { result, rerender } = renderHook(
      ({ id, version }) =>
        useReadingPosition(id, cards, onCurrent, requestMount, version),
      { initialProps: { id: "attempt", version: 0 } },
    );
    rerender({ id: "attempt", version: 1 });
    advance();
    expect(scroll).not.toHaveBeenCalled();
    act(() => result.current("q2"));
    const element = cards.current.get("q2");
    if (!element) throw new Error("缺少题卡夹具");
    vi.mocked(element.getBoundingClientRect).mockReturnValue({
      top: 370,
      bottom: 770,
      height: 400,
    } as DOMRect);
    rerender({ id: "other", version: 2 });
    advance();
    expect(scroll).not.toHaveBeenCalled();
  });

  it.each([null, "wheel", "touchstart", "pointerdown", "keydown"])(
    "答题卡开合后补偿延迟挂载；后续 %s 操作取消补偿",
    (interrupt) => {
      const onCurrent = vi.fn();
      const requestMount = vi.fn();
      const { result, rerender } = renderHook(
        ({ version }) =>
          useReadingPosition(
            "attempt",
            cards,
            onCurrent,
            requestMount,
            version,
          ),
        { initialProps: { version: 0 } },
      );
      act(() => result.current("q2"));
      if (interrupt) act(() => window.dispatchEvent(new Event(interrupt)));
      const element = cards.current.get("q2");
      if (!element) throw new Error("缺少题卡夹具");
      vi.mocked(element.getBoundingClientRect).mockReturnValue({
        top: 370,
        bottom: 770,
        height: 400,
      } as DOMRect);
      rerender({ version: 1 });
      advance();
      if (interrupt) expect(scroll).not.toHaveBeenCalled();
      else
        expect(scroll).toHaveBeenCalledExactlyOnceWith({
          top: 70,
          behavior: "instant",
        });
    },
  );

  it("邻题连续挂载不应反复延期对齐；用户接管后仍停止补偿", () => {
    const onCurrent = vi.fn();
    const requestMount = vi.fn();
    const { result, rerender } = renderHook(
      ({ version }) =>
        useReadingPosition("attempt", cards, onCurrent, requestMount, version),
      { initialProps: { version: 0 } },
    );
    act(() => result.current("q2"));
    const element = cards.current.get("q2");
    if (!element) throw new Error("缺少题卡夹具");
    vi.mocked(element.getBoundingClientRect).mockReturnValue({
      top: 370,
      bottom: 770,
      height: 400,
    } as DOMRect);
    for (const version of [1, 2, 3]) {
      rerender({ version });
      act(() => vi.advanceTimersByTime(51));
    }
    expect(scroll).toHaveBeenCalledExactlyOnceWith({
      top: 70,
      behavior: "instant",
    });
    act(() => window.dispatchEvent(new Event("keydown")));
    vi.mocked(element.getBoundingClientRect).mockReturnValue({
      top: 440,
      bottom: 840,
      height: 400,
    } as DOMRect);
    rerender({ version: 4 });
    advance();
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("待执行挂载补偿在切换练习和卸载时取消", () => {
    const onCurrent = vi.fn();
    const requestMount = vi.fn();
    const element = cards.current.get("q2");
    if (!element) throw new Error("缺少题卡夹具");
    const rect = vi.mocked(element.getBoundingClientRect);
    const { result, rerender, unmount } = renderHook(
      ({ id, version }) =>
        useReadingPosition(id, cards, onCurrent, requestMount, version),
      { initialProps: { id: "attempt", version: 0 } },
    );
    act(() => result.current("q2"));
    rerender({ id: "attempt", version: 1 });
    act(() => vi.advanceTimersByTime(50));
    rerender({ id: "other", version: 0 });
    const afterSwitch = rect.mock.calls.length;
    act(() => vi.advanceTimersByTime(200));
    expect(rect).toHaveBeenCalledTimes(afterSwitch);
    expect(scroll).not.toHaveBeenCalled();
    act(() => result.current("q2"));
    rerender({ id: "other", version: 1 });
    act(() => vi.advanceTimersByTime(50));
    unmount();
    const afterUnmount = rect.mock.calls.length;
    act(() => vi.advanceTimersByTime(200));
    expect(rect).toHaveBeenCalledTimes(afterUnmount);
    expect(scroll).not.toHaveBeenCalled();
  });

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

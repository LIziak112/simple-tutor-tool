import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLessonReadingPosition } from "./use-lesson-reading-position";

/**
 * 讲练页阅读位置（#16910）：按作答卷保存/恢复「读到哪一节/哪道题」。
 * - 恢复：锚点几何稳定后按相对工具栏偏移对齐一次，用户先操作则让出；
 * - 保存：滚动防抖只写可见锚点，离页/卸载立即落盘；
 * - 隔离：不同作答卷（再做一次 = 新卷）互不串记录；损坏存储静默降级。
 */

const key = (attempt = "attempt") => `lesson-reading:${attempt}`;

function rect(top: number, height = 100): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 100,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

let cards: { current: Map<string, HTMLElement> };
let scroll: ReturnType<typeof vi.fn<(options?: ScrollToOptions) => void>>;
let header: HTMLElement;
let heading: HTMLElement;
let card: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  document.body.innerHTML = "";
  header = document.createElement("nav");
  header.dataset.slot = "lesson-header";
  header.getBoundingClientRect = () => rect(0, 56);
  heading = document.createElement("h2");
  heading.getBoundingClientRect = () => rect(100);
  const md = document.createElement("section");
  md.dataset.lessonMd = "";
  md.appendChild(heading);
  card = document.createElement("article");
  card.getBoundingClientRect = () => rect(300, 400);
  document.body.append(header, md, card);
  cards = { current: new Map([["q2", card]]) };
  scroll = vi.fn<(options?: ScrollToOptions) => void>();
  vi.spyOn(window, "scrollTo").mockImplementation(
    scroll as unknown as typeof window.scrollTo,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const advance = (ms = 1000) => act(() => vi.advanceTimersByTime(ms));

describe("讲练阅读位置恢复", () => {
  it("几何稳定后按相对工具栏偏移恢复一次", () => {
    localStorage.setItem(
      key(),
      JSON.stringify({ anchor: "q:q2", offset: -20 }),
    );
    renderHook(() => useLessonReadingPosition({ attemptId: "attempt", cards }));
    expect(scroll).not.toHaveBeenCalled();
    advance();
    expect(scroll).toHaveBeenCalledExactlyOnceWith({
      top: 264,
      behavior: "instant",
    });
    advance();
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("目录标题也是锚点（无题/零题讲练页可续读）", () => {
    localStorage.setItem(key(), JSON.stringify({ anchor: "h:0", offset: 0 }));
    renderHook(() => useLessonReadingPosition({ attemptId: "attempt", cards }));
    advance();
    expect(scroll).toHaveBeenCalledExactlyOnceWith({
      top: 44,
      behavior: "instant",
    });
  });

  it.each(["wheel", "touchstart", "pointerdown", "keydown"])(
    "%s 先发生则取消待执行恢复",
    (event) => {
      localStorage.setItem(
        key(),
        JSON.stringify({ anchor: "q:q2", offset: 0 }),
      );
      renderHook(() =>
        useLessonReadingPosition({ attemptId: "attempt", cards }),
      );
      act(() => window.dispatchEvent(new Event(event)));
      advance();
      expect(scroll).not.toHaveBeenCalled();
    },
  );

  it("锚点已消失（讲练内容更新）不跳页", () => {
    localStorage.setItem(
      key(),
      JSON.stringify({ anchor: "q:removed", offset: 0 }),
    );
    renderHook(() => useLessonReadingPosition({ attemptId: "attempt", cards }));
    advance(6000);
    expect(scroll).not.toHaveBeenCalled();
  });
});

describe("讲练阅读位置保存", () => {
  it("滚动防抖只写可见锚点与相对偏移", () => {
    card.getBoundingClientRect = () => rect(40, 400);
    const { unmount } = renderHook(() =>
      useLessonReadingPosition({ attemptId: "attempt", cards }),
    );
    act(() => window.dispatchEvent(new Event("scroll")));
    advance();
    expect(JSON.parse(localStorage.getItem(key()) ?? "null")).toEqual({
      anchor: "q:q2",
      offset: -16,
    });
    unmount();
  });

  it("不同作答卷互不串记录；未写过的卷不恢复", () => {
    card.getBoundingClientRect = () => rect(40, 400);
    const { rerender } = renderHook(
      ({ attemptId }) => useLessonReadingPosition({ attemptId, cards }),
      { initialProps: { attemptId: "attempt" } },
    );
    act(() => window.dispatchEvent(new Event("scroll")));
    advance();
    expect(localStorage.getItem(key("attempt"))).not.toBeNull();
    rerender({ attemptId: "next" });
    advance();
    expect(scroll).not.toHaveBeenCalled();
    expect(localStorage.getItem(key("next"))).toBeNull();
  });

  it("损坏存储与存储失败不影响作答", () => {
    localStorage.setItem(key(), "{not json");
    const { unmount } = renderHook(() =>
      useLessonReadingPosition({ attemptId: "attempt", cards }),
    );
    advance();
    expect(scroll).not.toHaveBeenCalled();
    unmount();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => {
      act(() => window.dispatchEvent(new Event("pagehide")));
    }).not.toThrow();
  });
});

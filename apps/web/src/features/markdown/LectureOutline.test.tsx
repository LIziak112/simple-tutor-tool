import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { LectureOutline } from "./LectureOutline";
import type { OutlineItem } from "./outline";

const items: OutlineItem[] = [
  { id: "a", text: "第一章", depth: 2 },
  { id: "b", text: "当前小节", depth: 3 },
  { id: "c", text: "第二章", depth: 2 },
];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(currentIndex: number | null = 1, itemTop = 500) {
  const scrollRef = createRef<HTMLDivElement>();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const top =
        this instanceof HTMLButtonElement
          ? itemTop - (scrollRef.current?.scrollTop ?? 0)
          : 100;
      return {
        top,
        bottom: top + 40,
        height: 40,
        left: 0,
        right: 100,
        width: 100,
        x: 0,
        y: top,
        toJSON: () => ({}),
      };
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
  const onNavigate = vi.fn();
  const view = (index: number | null) => (
    <div ref={scrollRef}>
      <LectureOutline
        items={items}
        currentIndex={index}
        onNavigate={onNavigate}
        scrollContainerRef={scrollRef}
      />
    </div>
  );
  const result = render(view(currentIndex));
  return { ...result, scrollRef, view };
}

it("展开当前章后，将当前小节中心对齐目录容器中心且不抢焦点", () => {
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  const { scrollRef } = setup();
  expect(screen.getByRole("button", { name: "当前小节" })).toBeVisible();
  expect(scrollRef.current?.scrollTop).toBe(270);
  expect(document.activeElement).toBe(input);
  input.remove();
});

it.each([
  [0, 110, 0],
  [2, 1500, 700],
])("首尾条目在合法滚动范围内尽量居中：%s", (index, top, expected) => {
  const { scrollRef } = setup(index, top);
  expect(scrollRef.current?.scrollTop).toBe(expected);
});

it("同一小节重渲染保留手动滚动，新小节才重新居中", () => {
  const { scrollRef, rerender, view } = setup();
  if (!scrollRef.current) throw new Error("目录未挂载");
  scrollRef.current.scrollTop = 20;
  rerender(view(1));
  expect(scrollRef.current.scrollTop).toBe(20);
  rerender(view(2));
  expect(scrollRef.current.scrollTop).toBe(270);
});

it("没有当前项时不调整滚动位置", () => {
  const { scrollRef } = setup(null);
  expect(scrollRef.current?.scrollTop).toBe(0);
});

it("当前小节被手动收起时以所属章作为定位点", () => {
  const { scrollRef } = setup();
  if (!scrollRef.current) throw new Error("目录未挂载");
  scrollRef.current.scrollTop = 20;
  fireEvent.click(screen.getByRole("button", { name: "收起第一章的子目录" }));
  expect(scrollRef.current.scrollTop).toBe(270);
});

it("目录尺寸变化后重新定位，卸载时停止观察", () => {
  let resize = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const { scrollRef, unmount } = setup();
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  act(() => resize());
  expect(scrollRef.current?.scrollTop).toBe(320);
  unmount();
  expect(disconnect).toHaveBeenCalled();
});

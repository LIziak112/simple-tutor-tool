import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePaperPosition } from "./use-paper-position";

afterEach(() => vi.restoreAllMocks());

function setup(top = 200) {
  const article = document.createElement("article");
  article.style.scrollMarginTop = "76px";
  document.body.append(article);
  let currentTop = top;
  vi.spyOn(article, "getBoundingClientRect").mockImplementation(
    () => ({ top: currentTop }) as DOMRect,
  );
  article.scrollIntoView = vi.fn();
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const hook = renderHook(() => usePaperPosition({ current: article }));
  return {
    article,
    hook,
    move(next: number) {
      currentTop = next;
    },
    flush() {
      while (frames.length) frames.shift()?.(0);
    },
    destroy() {
      hook.unmount();
      article.remove();
    },
  };
}

it("切题布局移位且题干出屏才对齐顶部", async () => {
  const h = setup();
  await act(async () => {
    await h.hook.result.current(async () => {
      h.move(-300);
      return true;
    });
  });
  h.flush();
  expect(h.article.scrollIntoView).toHaveBeenCalledWith({
    block: "start",
    behavior: "instant",
  });
  h.destroy();
});

it.each([
  { before: 200, after: 100 },
  { before: -100, after: -100 },
])("题干可见或位置未变时不抢滚动：%j", async ({ before, after }) => {
  const h = setup(before);
  await act(async () => {
    await h.hook.result.current(async () => {
      h.move(after);
      return true;
    });
  });
  h.flush();
  expect(h.article.scrollIntoView).not.toHaveBeenCalled();
  h.destroy();
});

it.each(["失败", "用户滚动", "卸载"])("%s 后不执行迟到的定位", async (kind) => {
  const h = setup();
  await act(async () => {
    await h.hook.result.current(async () => {
      h.move(-300);
      if (kind === "用户滚动") window.dispatchEvent(new Event("wheel"));
      return kind !== "失败";
    });
  });
  if (kind === "卸载") h.hook.unmount();
  h.flush();
  expect(h.article.scrollIntoView).not.toHaveBeenCalled();
  h.destroy();
});

it("打开后立即收起取消待执行的定位", async () => {
  const h = setup();
  await act(async () => {
    await h.hook.result.current(async () => {
      h.move(-300);
      return true;
    });
    await h.hook.result.current(async () => true, false);
  });
  h.flush();
  expect(h.article.scrollIntoView).not.toHaveBeenCalled();
  h.destroy();
});

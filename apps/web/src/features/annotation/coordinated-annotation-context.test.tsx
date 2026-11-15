import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { InkToolboxInit } from "@/features/ink/engine/toolbox.ts";
import { bindInkProfileAccount } from "@/features/ink/ink-profile-store";
import {
  CoordinatedAnnotationProvider,
  createAnnotationToolbox,
  useCoordinatedAnnotation,
} from "./coordinated-annotation-context";

function mount(initialToolbox?: InkToolboxInit) {
  return renderHook(() => useCoordinatedAnnotation(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <CoordinatedAnnotationProvider
        {...(initialToolbox ? { initialToolbox } : {})}
      >
        {children}
      </CoordinatedAnnotationProvider>
    ),
  });
}

beforeEach(() => {
  bindInkProfileAccount(null);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  bindInkProfileAccount(null);
});

it("没有 Provider 时为 null，由消费方回退到自己的工具箱", () => {
  expect(
    renderHook(() => useCoordinatedAnnotation()).result.current,
  ).toBeNull();
});

it("没有账号：协同工具箱只在这一次作答里，缺省红色细笔", () => {
  const first = mount();
  expect(first.result.current?.toolbox).toEqual(createAnnotationToolbox());
  act(() =>
    first.result.current?.setToolbox(
      createAnnotationToolbox({ pen: { color: "blue" }, active: "eraser" }),
    ),
  );
  expect(first.result.current?.toolbox.pen.color).toBe("blue");
  first.unmount();
  expect(mount().result.current?.toolbox).toEqual(createAnnotationToolbox());
  expect(localStorage.length).toBe(0);
});

it("有账号：各工具的设置记在本机，下一次作答还在；当前工具不记", () => {
  bindInkProfileAccount({ role: "student", id: "s-1" });
  const first = mount();
  act(() =>
    first.result.current?.setToolbox(
      createAnnotationToolbox({
        active: "eraser",
        pen: { color: "blue", size: "thick" },
        eraser: { mode: "partial", size: "large" },
      }),
    ),
  );
  expect(first.result.current?.toolbox.active).toBe("eraser");
  first.unmount();

  expect(mount().result.current?.toolbox).toEqual(
    createAnnotationToolbox({
      pen: { color: "blue", size: "thick" },
      eraser: { mode: "partial", size: "large" },
    }),
  );
  // 测试缝 initialToolbox：当前工具照它给的，各工具的设置以记住的为准
  expect(
    mount({ active: "highlighter", pen: { color: "green" } }).result.current
      ?.toolbox,
  ).toEqual(
    createAnnotationToolbox({
      active: "highlighter",
      pen: { color: "blue", size: "thick" },
      eraser: { mode: "partial", size: "large" },
    }),
  );
});

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { DEFAULT_INK_PROFILE_CONFIG } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InkEngine, InkToolConfig } from "./engine";
import { bindInkProfileAccount, selectInkProfile } from "./ink-profile-store";
import { PaperEditor } from "./PaperEditor";

/** 只有工具栏的纸（不挂书写面），书写面用一个只记 setTool 的替身 */
function paper(label: string) {
  const setTool = vi.fn<(tool: InkToolConfig) => void>();
  const engine = {
    setTool,
    canUndo: () => false,
    canRedo: () => false,
  } as unknown as InkEngine;
  const element = (
    <PaperEditor
      key={label}
      label={label}
      engineRef={{ current: engine }}
      onDocChange={() => undefined}
      inputEnabled
      mountPad={false}
      clearLabel="清空"
      onClearRequest={() => undefined}
    />
  );
  const toolbar = () => screen.getByRole("toolbar", { name: `${label}工具栏` });
  return {
    element,
    setTool,
    lastTool: () => setTool.mock.lastCall?.[0],
    button: (name: string) => within(toolbar()).getByRole("button", { name }),
  };
}

/** 打开当前工具的面板选一项，再收起 */
function choose(panel: string, option: string) {
  const dialog = screen.getByRole("dialog", { name: panel });
  fireEvent.click(within(dialog).getByRole("radio", { name: option }));
  fireEvent.keyDown(dialog, { key: "Escape" });
}

const profile = (color: "black" | "blue" | "red", size: "thin" | "thick") => ({
  id: crypto.randomUUID(),
  name: `${color}-${size}`,
  revision: 1,
  updatedAt: "now",
  config: { ...DEFAULT_INK_PROFILE_CONFIG, color, size },
});

beforeEach(() => {
  bindInkProfileAccount(null);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  bindInkProfileAccount(null);
});

describe("PaperEditor 工具箱记忆", () => {
  it("没有账号：每张纸各管各的", () => {
    const one = paper("第 1 题草稿纸");
    const two = paper("第 2 题草稿纸");
    render(
      <>
        {one.element}
        {two.element}
      </>,
    );
    fireEvent.click(one.button("笔"));
    choose("笔设置", "绿");
    expect(one.lastTool()).toEqual({
      type: "pen",
      color: "green",
      size: "medium",
    });
    expect(two.lastTool()).toEqual({
      type: "pen",
      color: "black",
      size: "medium",
    });
    expect(localStorage.length).toBe(0);
  });

  it("有账号：一张纸上改的设置，另一张纸立即跟上；重新打开还在，当前工具回到笔", () => {
    bindInkProfileAccount({ role: "student", id: "s-1" });
    const one = paper("第 1 题草稿纸");
    const two = paper("第 2 题草稿纸");
    const view = render(
      <>
        {one.element}
        {two.element}
      </>,
    );
    fireEvent.click(one.button("笔"));
    choose("笔设置", "绿");
    expect(one.lastTool()).toEqual({
      type: "pen",
      color: "green",
      size: "medium",
    });
    expect(two.lastTool()).toEqual({
      type: "pen",
      color: "green",
      size: "medium",
    });

    // 橡皮改成局部擦除：另一张纸的当前工具还是笔，但它的橡皮也已经是局部
    fireEvent.click(one.button("橡皮"));
    fireEvent.click(one.button("橡皮"));
    choose("橡皮设置", "局部");
    expect(one.lastTool()).toEqual({
      type: "eraser",
      mode: "partial",
      size: "medium",
    });
    expect(two.button("笔")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(two.button("橡皮"));
    expect(two.lastTool()).toEqual({
      type: "eraser",
      mode: "partial",
      size: "medium",
    });

    view.unmount();
    const again = paper("第 3 题草稿纸");
    render(again.element);
    expect(again.button("笔")).toHaveAttribute("aria-pressed", "true");
    expect(again.lastTool()).toEqual({
      type: "pen",
      color: "green",
      size: "medium",
    });
    fireEvent.click(again.button("橡皮"));
    expect(again.lastTool()).toEqual({
      type: "eraser",
      mode: "partial",
      size: "medium",
    });
  });

  it("笔感设置换了颜色粗细：笔以设置为准，之前在工具栏里选的作废", () => {
    bindInkProfileAccount({ role: "student", id: "s-1" });
    act(() => selectInkProfile(profile("blue", "thick")));
    const one = paper("第 1 题草稿纸");
    const view = render(one.element);
    expect(one.lastTool()).toEqual({
      type: "pen",
      color: "blue",
      size: "thick",
    });
    fireEvent.click(one.button("笔"));
    choose("笔设置", "绿");
    expect(one.lastTool()).toEqual({
      type: "pen",
      color: "green",
      size: "thick",
    });

    act(() => selectInkProfile(profile("red", "thin")));
    expect(one.lastTool()).toEqual({ type: "pen", color: "red", size: "thin" });

    // 换回原来的设置、重新打开：还是设置里的蓝色，绿色不再冒出来
    act(() => selectInkProfile(profile("blue", "thick")));
    view.unmount();
    const again = paper("第 2 题草稿纸");
    render(again.element);
    expect(again.lastTool()).toEqual({
      type: "pen",
      color: "blue",
      size: "thick",
    });
  });
});

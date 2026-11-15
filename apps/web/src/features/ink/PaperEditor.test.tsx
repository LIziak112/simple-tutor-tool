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
import type { InkDoc, InkEngine, InkToolConfig } from "./engine";
import { INK_PEN_COLORS } from "./engine/types.ts";
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

describe("PaperEditor 纸面不可写", () => {
  it("选项面板开着时纸面变成不可写：面板收起、工具栏停用；恢复可写后不自己弹开", () => {
    const engine = {
      setTool: () => undefined,
      canUndo: () => false,
      canRedo: () => false,
    } as unknown as InkEngine;
    const editor = (inputEnabled: boolean) => (
      <PaperEditor
        label="手写答题区"
        engineRef={{ current: engine }}
        onDocChange={() => undefined}
        inputEnabled={inputEnabled}
        mountPad={false}
        clearLabel="清空"
        onClearRequest={() => undefined}
      />
    );
    const view = render(editor(true));
    const pen = () => screen.getByRole("button", { name: "笔" });
    fireEvent.click(pen());
    expect(screen.getByRole("dialog", { name: "笔设置" })).toBeInTheDocument();

    // 面板挂在 body 上，不随工具栏一起失效：要跟着收起
    view.rerender(editor(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pen()).toBeDisabled();

    view.rerender(editor(true));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pen()).toBeEnabled();
  });
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

/**
 * 挂着真实书写面（引擎、书写面都是真的；jsdom 没有 canvas 2d，只把绘制换成
 * 空操作）：看实际落到正文里的是什么，而不是工具栏下发了什么。
 */
describe("PaperEditor 挂着书写面：笔感设置变化后，实际落笔和工具栏一致", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      function (this: HTMLCanvasElement) {
        // 属性照记、方法全是空操作
        return new Proxy<Record<string | symbol, unknown>>(
          {},
          {
            get: (target, key) =>
              key in target ? target[key] : () => undefined,
          },
        ) as unknown as CanvasRenderingContext2D;
      },
    );
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(300);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(200);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function mountPaper() {
    const engineRef: { current: InkEngine | null } = { current: null };
    const view = render(
      <PaperEditor
        label="第 1 题草稿纸"
        engineRef={engineRef}
        onDocChange={() => undefined}
        inputEnabled
        clearLabel="清空"
        onClearRequest={() => undefined}
      />,
    );
    const toolbar = screen.getByRole("toolbar", {
      name: "第 1 题草稿纸工具栏",
    });
    return {
      button: (name: string) => within(toolbar).getByRole("button", { name }),
      /** 用笔从一点拖到另一点（CSS 像素） */
      drag(from: [number, number], to: [number, number]) {
        // 书写面按新的笔感设置重建时画布会换一张：每次现找
        const canvas = view.container.querySelector(
          "canvas[data-slot=ink-canvas]",
        );
        if (!(canvas instanceof HTMLCanvasElement))
          throw new Error("画布未挂载");
        const fire = (type: string, at: [number, number], buttons: number) =>
          canvas.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerId: 1,
              pointerType: "pen",
              isPrimary: true,
              button: 0,
              buttons,
              pressure: 0.5,
              clientX: at[0],
              clientY: at[1],
            }),
          );
        act(() => {
          fire("pointerdown", from, 1);
          fire(
            "pointermove",
            [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2],
            1,
          );
          fire("pointermove", to, 1);
          fire("pointerup", to, 0);
        });
      },
      /** 正文里现有各笔的颜色 */
      colors() {
        const engine = engineRef.current;
        if (engine === null) throw new Error("书写面未就绪");
        const doc = engine.getData() as InkDoc<"atrament">;
        return doc.data.strokes.map((stroke) => stroke.color);
      },
    };
  }

  it("设置里只改了手感、颜色粗细没变：记住的那支笔继续算数，落笔还是工具栏上的颜色", () => {
    bindInkProfileAccount({ role: "student", id: "s-1" });
    const base = profile("blue", "thick");
    act(() => selectInkProfile(base));
    const paper = mountPaper();
    fireEvent.click(paper.button("笔"));
    choose("笔设置", "绿");
    paper.drag([20, 20], [80, 20]);
    expect(paper.colors()).toEqual([INK_PEN_COLORS.green]);

    // 后台把这份笔感设置的平滑度改了：书写面按新设置重建
    act(() =>
      selectInkProfile({
        ...base,
        revision: 2,
        config: { ...base.config, smoothing: 0.6 },
      }),
    );
    expect(
      paper.button("笔").querySelector('[data-slot="ink-tool-color"]'),
    ).toHaveStyle({ backgroundColor: INK_PEN_COLORS.green });
    paper.drag([20, 60], [80, 60]);
    expect(paper.colors()).toEqual([
      INK_PEN_COLORS.green,
      INK_PEN_COLORS.green,
    ]);
  });

  it("当前是橡皮时设置里换了笔的颜色：仍然是橡皮，不会悄悄变回笔", () => {
    bindInkProfileAccount({ role: "student", id: "s-1" });
    act(() => selectInkProfile(profile("blue", "thick")));
    const paper = mountPaper();
    paper.drag([20, 20], [80, 20]);
    expect(paper.colors()).toEqual([INK_PEN_COLORS.blue]);
    fireEvent.click(paper.button("橡皮"));

    act(() => selectInkProfile(profile("red", "thin")));
    expect(paper.button("橡皮")).toHaveAttribute("aria-pressed", "true");
    // 竖着划过那一笔：是橡皮就擦掉它，是笔就多出一笔
    paper.drag([50, 5], [50, 40]);
    expect(paper.colors()).toEqual([]);
  });
});

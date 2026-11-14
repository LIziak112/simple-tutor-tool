import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  createInkToolbox,
  type InkToolboxInit,
  type InkToolboxState,
} from "../engine/toolbox.ts";
import { INK_HIGHLIGHTER_COLORS } from "../engine/types.ts";
import { InkToolbar, type InkToolbarProps } from "./InkToolbar.tsx";
import { INK_HIGHLIGHTER_SWATCH } from "./tool-labels.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type HarnessProps = Partial<
  Omit<InkToolbarProps, "toolbox" | "onToolboxChange">
> & {
  init?: InkToolboxInit;
  onChange?: (next: InkToolboxState) => void;
};

/** 受控宿主：像真实宿主一样持有工具箱状态，并把每次变更报给 onChange */
function Harness({ init, onChange, ...props }: HarnessProps) {
  const [toolbox, setToolbox] = useState(() => createInkToolbox(init));
  return (
    <InkToolbar
      label="测试纸"
      canUndo
      canRedo
      onUndo={() => undefined}
      onRedo={() => undefined}
      onClearRequest={() => undefined}
      {...props}
      toolbox={toolbox}
      onToolboxChange={(next) => {
        onChange?.(next);
        setToolbox(next);
      }}
    />
  );
}

const button = (name: string) => screen.getByRole("button", { name });

describe("InkToolbar 工具切换与选项面板", () => {
  it("缺省提供笔、橡皮、撤销、重做、更多，当前工具按下", () => {
    render(<Harness />);
    const toolbar = screen.getByRole("toolbar", { name: "测试纸工具栏" });
    expect(
      within(toolbar)
        .getAllByRole("button")
        .map((el) => el.getAttribute("aria-label")),
    ).toEqual(["笔", "橡皮", "撤销", "重做", "更多操作（测试纸）"]);
    expect(button("笔")).toHaveAttribute("aria-pressed", "true");
    expect(button("橡皮")).toHaveAttribute("aria-pressed", "false");
  });

  it("点未选中的工具只切换工具，不弹出选项面板", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(button("橡皮"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toMatchObject({ active: "eraser" });
    expect(button("橡皮")).toHaveAttribute("aria-pressed", "true");
    expect(button("笔")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("再点一次当前工具才弹出它的选项面板，且不改工具箱", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(button("笔"));
    const panel = screen.getByRole("dialog", { name: "笔设置" });
    expect(onChange).not.toHaveBeenCalled();
    expect(button("笔")).toHaveAttribute("aria-expanded", "true");
    const colors = within(panel).getByRole("radiogroup", { name: "颜色" });
    expect(
      within(colors)
        .getAllByRole("radio")
        .map((el) => el.getAttribute("aria-label")),
    ).toEqual(["黑", "蓝", "红", "绿", "橙", "紫"]);
    const sizes = within(panel).getByRole("radiogroup", { name: "粗细" });
    expect(
      within(sizes)
        .getAllByRole("radio")
        .map((el) => el.getAttribute("aria-label")),
    ).toEqual(["极细", "细", "中", "粗", "特粗"]);
    expect(within(colors).getByRole("radio", { name: "黑" })).toBeChecked();
    expect(within(sizes).getByRole("radio", { name: "中" })).toBeChecked();
  });

  it("在面板里选颜色、粗细：只改笔的设置，面板不收起，可以连着调", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(button("笔"));
    fireEvent.click(screen.getByRole("radio", { name: "蓝" }));
    expect(onChange).toHaveBeenLastCalledWith(
      createInkToolbox({ pen: { color: "blue" } }),
    );
    expect(screen.getByRole("dialog", { name: "笔设置" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "蓝" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "特粗" }));
    expect(onChange).toHaveBeenLastCalledWith(
      createInkToolbox({ pen: { color: "blue", size: "heavy" } }),
    );
    expect(screen.getByRole("dialog", { name: "笔设置" })).toBeInTheDocument();
  });

  it("橡皮的面板调大小，切到橡皮后再点才出现", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(button("橡皮"));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(button("橡皮"));
    const panel = screen.getByRole("dialog", { name: "橡皮设置" });
    const sizes = within(panel).getByRole("radiogroup", { name: "大小" });
    expect(within(sizes).getByRole("radio", { name: "中" })).toBeChecked();
    fireEvent.click(within(sizes).getByRole("radio", { name: "大" }));
    expect(onChange).toHaveBeenLastCalledWith(
      createInkToolbox({ active: "eraser", eraser: { size: "large" } }),
    );
  });

  it("Escape 收起面板并把焦点还给工具按钮", async () => {
    render(<Harness />);
    const pen = button("笔");
    pen.focus();
    fireEvent.click(pen);
    const panel = screen.getByRole("dialog", { name: "笔设置" });
    await waitFor(() =>
      expect(panel.contains(document.activeElement)).toBe(true),
    );
    fireEvent.keyDown(document.activeElement ?? panel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(pen).toHaveFocus());
    expect(pen).toHaveAttribute("aria-expanded", "false");
  });

  it("面板打开时点别的工具：面板收起并切到那个工具", async () => {
    render(<Harness />);
    fireEvent.click(button("笔"));
    expect(screen.getByRole("dialog", { name: "笔设置" })).toBeInTheDocument();
    const eraser = button("橡皮");
    // 真实点击 = pointerdown（面板据此判定点在外面）+ click
    await act(async () => {
      fireEvent.pointerDown(eraser);
      fireEvent.click(eraser);
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(eraser).toHaveAttribute("aria-pressed", "true");
  });

  it.each(["pen", "mouse", "touch"] as const)(
    "面板开着直接在纸上落笔（%s）：按下当即收起，不等抬笔后的 click",
    async (pointerType) => {
      render(
        <div>
          <Harness />
          <canvas data-testid="paper" />
        </div>,
      );
      fireEvent.click(button("笔"));
      expect(
        screen.getByRole("dialog", { name: "笔设置" }),
      ).toBeInTheDocument();
      // 面板里、工具栏里按下都不收（工具栏按钮自己处理开合）
      fireEvent.pointerDown(screen.getByRole("radio", { name: "蓝" }), {
        pointerType,
      });
      fireEvent.pointerDown(button("撤销"), { pointerType });
      expect(
        screen.getByRole("dialog", { name: "笔设置" }),
      ).toBeInTheDocument();
      // 纸面上只有 pointerdown：拖动书写要到抬笔才有 click，手指拖动则根本没有
      fireEvent.pointerDown(screen.getByTestId("paper"), { pointerType });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    },
  );

  it("宿主把当前工具换走：面板收起，换回来也不会自己弹开", () => {
    const props = {
      label: "测试纸",
      canUndo: true,
      canRedo: true,
      onUndo: () => undefined,
      onRedo: () => undefined,
      onClearRequest: () => undefined,
      onToolboxChange: () => undefined,
    };
    const pen = createInkToolbox();
    const { rerender } = render(<InkToolbar {...props} toolbox={pen} />);
    fireEvent.click(button("笔"));
    expect(screen.getByRole("dialog", { name: "笔设置" })).toBeInTheDocument();
    rerender(
      <InkToolbar
        {...props}
        toolbox={createInkToolbox({ active: "eraser" })}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<InkToolbar {...props} toolbox={pen} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button("笔")).toHaveAttribute("aria-expanded", "false");
  });

  it("工具按钮的色点跟着笔色走", () => {
    render(<Harness init={{ pen: { color: "red" } }} />);
    const dot = button("笔").querySelector('[data-slot="ink-tool-color"]');
    expect(dot).toHaveStyle({ backgroundColor: "#dc2626" });
    expect(
      button("橡皮").querySelector('[data-slot="ink-tool-color"]'),
    ).toBeNull();
  });
});

describe("InkToolbar 宿主可配置项", () => {
  it("tools 决定出现哪些工具及顺序；没有可调项的工具不带面板", () => {
    const onChange = vi.fn();
    render(
      <Harness
        tools={["pen", "highlighter", "eraser", "scroll"]}
        onChange={onChange}
      />,
    );
    const toolbar = screen.getByRole("toolbar", { name: "测试纸工具栏" });
    expect(
      within(toolbar)
        .getAllByRole("button")
        .slice(0, 4)
        .map((el) => el.getAttribute("aria-label")),
    ).toEqual(["笔", "荧光笔", "橡皮", "滚动"]);
    expect(button("滚动")).not.toHaveAttribute("aria-haspopup");
    fireEvent.click(button("滚动"));
    expect(onChange).toHaveBeenLastCalledWith(
      createInkToolbox({ active: "scroll" }),
    );
    fireEvent.click(button("滚动"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("toolOptions=false：工具只切换，不出面板也不带色点；可改工具名", () => {
    render(
      <Harness
        tools={["pen", "eraser", "scroll"]}
        toolOptions={false}
        toolLabels={{ scroll: "选择" }}
      />,
    );
    fireEvent.click(button("笔"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      button("笔").querySelector('[data-slot="ink-tool-color"]'),
    ).toBeNull();
    expect(button("选择")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "滚动" })).toBeNull();
  });

  it("撤销、重做按可用性禁用，点击转发给宿主", () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    render(<Harness canUndo canRedo={false} onUndo={onUndo} onRedo={onRedo} />);
    expect(button("重做")).toBeDisabled();
    fireEvent.click(button("撤销"));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).not.toHaveBeenCalled();
  });

  it("更多菜单：宿主菜单项在前，清空在后且走宿主的确认流程", () => {
    const onClearRequest = vi.fn();
    const onExtra = vi.fn();
    render(
      <Harness
        clearLabel="清空草稿纸"
        moreTitle="更多（布局、清空）"
        onClearRequest={onClearRequest}
        menuExtras={
          <DropdownMenuItem onSelect={onExtra}>布局：左右分栏</DropdownMenuItem>
        }
      />,
    );
    const more = button("更多操作（测试纸）");
    expect(more).toHaveAttribute("title", "更多（布局、清空）");
    fireEvent.keyDown(more, { key: "ArrowDown" });
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(
      ["布局：左右分栏", "清空草稿纸"],
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "清空草稿纸" }));
    expect(onClearRequest).toHaveBeenCalledTimes(1);
    expect(onExtra).not.toHaveBeenCalled();
  });

  it("disabled：工具、撤销重做、更多全部禁用，已打开的面板收起，恢复后不自己弹开", () => {
    const { rerender } = render(<Harness />);
    fireEvent.click(button("笔"));
    expect(screen.getByRole("dialog", { name: "笔设置" })).toBeInTheDocument();
    rerender(<Harness disabled />);
    expect(screen.queryByRole("dialog")).toBeNull();
    for (const el of screen.getAllByRole("button")) expect(el).toBeDisabled();
    rerender(<Harness />);
    expect(button("笔")).toBeEnabled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("fingerToggle 与 children 都留在工具栏里（children 在最后）", () => {
    render(
      <Harness
        fingerToggle={<button type="button">手指书写</button>}
        moreLabel="更多标画操作"
      >
        <button type="button">完成标画</button>
      </Harness>,
    );
    const toolbar = screen.getByRole("toolbar", { name: "测试纸工具栏" });
    expect(
      within(toolbar)
        .getAllByRole("button")
        .map((el) => el.getAttribute("aria-label") ?? el.textContent),
    ).toEqual([
      "笔",
      "橡皮",
      "撤销",
      "重做",
      "手指书写",
      "更多标画操作",
      "完成标画",
    ]);
  });
});

describe("InkToolbar 窄屏：重做收进更多菜单", () => {
  /** 可手动触发的 ResizeObserver，配合下面的尺寸桩模拟真实布局 */
  function stubLayout() {
    const callbacks: ResizeObserverCallback[] = [];
    class FakeResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const layout = { stripScroll: 0, stripClient: 0, rootClient: 0, pill: 0 };
    const isStrip = (el: Element) =>
      el.getAttribute("data-slot") === "ink-toolbar-tools";
    const isRoot = (el: Element) =>
      el.getAttribute("data-slot") === "ink-toolbar";
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return isStrip(this) ? layout.stripScroll : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        if (isStrip(this)) return layout.stripClient;
        return isRoot(this) ? layout.rootClient : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const width =
          this.parentElement && isRoot(this.parentElement) ? layout.pill : 0;
        return new DOMRect(0, 0, width, 44);
      },
    );
    const resize = () =>
      act(() => {
        for (const callback of callbacks) callback([], {} as ResizeObserver);
      });
    return { layout, resize };
  }

  it("工具区被挤（内容比可视宽）时，重做从工具栏移进更多菜单，功能不变", () => {
    const { layout, resize } = stubLayout();
    const onRedo = vi.fn();
    Object.assign(layout, { stripScroll: 90, stripClient: 60 });
    render(<Harness onRedo={onRedo} />);
    expect(screen.queryByRole("button", { name: "重做" })).toBeNull();
    fireEvent.keyDown(button("更多操作（测试纸）"), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("menuitem", { name: "重做" }));
    expect(onRedo).toHaveBeenCalledTimes(1);

    // 变宽但富余不到一个按钮位：不放回，免得放回去又被挤走来回跳
    Object.assign(layout, {
      stripScroll: 90,
      stripClient: 90,
      rootClient: 300,
      pill: 260,
    });
    resize();
    expect(screen.queryByRole("button", { name: "重做" })).toBeNull();

    // 富余够一个按钮位：放回工具栏
    Object.assign(layout, { rootClient: 320 });
    resize();
    expect(button("重做")).toBeEnabled();
  });

  it("菜单里的重做同样按可用性禁用", () => {
    const { layout } = stubLayout();
    Object.assign(layout, { stripScroll: 90, stripClient: 60 });
    render(<Harness canRedo={false} />);
    fireEvent.keyDown(button("更多操作（测试纸）"), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "重做" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});

describe("工具栏展示色", () => {
  it("荧光笔色块与落笔颜色是同一组 RGB（只差透明度）", () => {
    for (const [key, rgba] of Object.entries(INK_HIGHLIGHTER_COLORS)) {
      const rgb = rgba.replace(/^rgba\((.+),\s*[\d.]+\)$/, "rgb($1)");
      expect(
        INK_HIGHLIGHTER_SWATCH[key as keyof typeof INK_HIGHLIGHTER_SWATCH],
      ).toBe(rgb);
    }
  });
});

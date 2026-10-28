import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { MaterialSplitHandle } from "./MaterialSplitHandle";

describe("MaterialSplitHandle 中缝拖拽 Handle", () => {
  it("呈现 role=separator 与无障碍属性（35%~65%）", () => {
    const containerRef = createRef<HTMLDivElement>();
    const onRatioChange = vi.fn();

    render(
      <div ref={containerRef} style={{ width: 1000 }}>
        <MaterialSplitHandle
          ratio={50}
          onRatioChange={onRatioChange}
          containerRef={containerRef}
        />
      </div>,
    );

    const handle = screen.getByRole("separator", {
      name: "调整材料与题目分栏比例",
    });
    expect(handle).toBeInTheDocument();
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuenow", "50");
    expect(handle).toHaveAttribute("aria-valuemin", "35");
    expect(handle).toHaveAttribute("aria-valuemax", "65");
    expect(handle).toHaveAttribute("data-ratio", "50");
  });

  it("键盘方向键微调与 Home/End 极值约束", () => {
    const containerRef = createRef<HTMLDivElement>();
    const onRatioChange = vi.fn();

    const { rerender } = render(
      <div ref={containerRef}>
        <MaterialSplitHandle
          ratio={50}
          onRatioChange={onRatioChange}
          containerRef={containerRef}
        />
      </div>,
    );

    const handle = screen.getByRole("separator");

    // 左箭头：减 1%
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onRatioChange).toHaveBeenLastCalledWith(49);

    // 右箭头：加 1%
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onRatioChange).toHaveBeenLastCalledWith(51);

    // Shift + 左箭头：减 5%
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(onRatioChange).toHaveBeenLastCalledWith(45);

    // Shift + 右箭头：加 5%
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(onRatioChange).toHaveBeenLastCalledWith(55);

    // Home：直接落到下限 35%
    fireEvent.keyDown(handle, { key: "Home" });
    expect(onRatioChange).toHaveBeenLastCalledWith(35);

    // End：直接落到上限 65%
    fireEvent.keyDown(handle, { key: "End" });
    expect(onRatioChange).toHaveBeenLastCalledWith(65);

    // 下限边界不可穿透（当前为 35% 时再按左箭头保持 35%）
    rerender(
      <div ref={containerRef}>
        <MaterialSplitHandle
          ratio={35}
          onRatioChange={onRatioChange}
          containerRef={containerRef}
        />
      </div>,
    );
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onRatioChange).toHaveBeenLastCalledWith(35);

    // 上限边界不可穿透（当前为 65% 时再按右箭头保持 65%）
    rerender(
      <div ref={containerRef}>
        <MaterialSplitHandle
          ratio={65}
          onRatioChange={onRatioChange}
          containerRef={containerRef}
        />
      </div>,
    );
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onRatioChange).toHaveBeenLastCalledWith(65);
  });

  it("指针拖拽按容器宽度换算比例并限制在 35%~65%", () => {
    const containerRef = createRef<HTMLDivElement>();
    const onRatioChange = vi.fn();

    render(
      <div ref={containerRef}>
        <MaterialSplitHandle
          ratio={50}
          onRatioChange={onRatioChange}
          containerRef={containerRef}
        />
      </div>,
    );

    const handle = screen.getByRole("separator");

    // 模拟容器布局矩形：宽 1000px，left 0
    if (containerRef.current) {
      vi.spyOn(containerRef.current, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        right: 1000,
        bottom: 800,
        width: 1000,
        height: 800,
        x: 0,
        y: 0,
        toJSON: () => {},
      });
    }

    // 指针捕获模拟
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();

    // pointerdown 开启拖拽
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 500 });
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1);

    // pointermove 移动到 400px (40%)
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400 });
    expect(onRatioChange).toHaveBeenLastCalledWith(40);

    // pointermove 移动到 600px (60%)
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 600 });
    expect(onRatioChange).toHaveBeenLastCalledWith(60);

    // pointermove 移动到 200px（低于 35%）-> 限制在 35%
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 200 });
    expect(onRatioChange).toHaveBeenLastCalledWith(35);

    // pointermove 移动到 800px（高于 65%）-> 限制在 65%
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 800 });
    expect(onRatioChange).toHaveBeenLastCalledWith(65);

    // pointerup 结束拖拽
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it("拖拽期间设置全局 col-resize 与 user-select: none，并在 window 上平滑响应与清理", () => {
    const containerRef = createRef<HTMLDivElement>();
    const onRatioChange = vi.fn();

    render(
      <div ref={containerRef}>
        <MaterialSplitHandle
          ratio={50}
          onRatioChange={onRatioChange}
          containerRef={containerRef}
        />
      </div>,
    );

    const handle = screen.getByRole("separator");
    if (containerRef.current) {
      vi.spyOn(containerRef.current, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        right: 1000,
        bottom: 800,
        width: 1000,
        height: 800,
        x: 0,
        y: 0,
        toJSON: () => {},
      });
    }

    // 按下拖拽
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 500 });
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    // 窗口级指针移动（例如快速滑出 handle 边界）
    fireEvent(window, new PointerEvent("pointermove", { clientX: 420 }));
    expect(onRatioChange).toHaveBeenLastCalledWith(42);

    // 窗口级释放
    fireEvent(window, new PointerEvent("pointerup"));
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("未传 containerRef 时自动寻径父级 [data-layout='compare'] 容器换算百分比", () => {
    const onRatioChange = vi.fn();

    render(
      <ol data-layout="compare" style={{ width: 1000 }}>
        <li>
          <MaterialSplitHandle ratio={50} onRatioChange={onRatioChange} />
        </li>
      </ol>,
    );

    const compareContainer = screen.getByRole("list");
    vi.spyOn(compareContainer, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    const handle = screen.getByRole("separator");
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 580 });
    expect(onRatioChange).toHaveBeenLastCalledWith(58);
    fireEvent.pointerUp(handle, { pointerId: 1 });
  });
});

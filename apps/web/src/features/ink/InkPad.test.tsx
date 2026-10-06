import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InkChangeReason,
  InkDoc,
  InkEngine,
  InkInputMode,
  InkToolConfig,
} from "./engine/index.ts";
import {
  getSessionInputPreference,
  resetSessionInputPreference,
} from "./input-preference.ts";

/**
 * <InkPad> 工具栏交互测试。
 * jsdom 没有 canvas 2d context，无法实例化真实适配器——引擎模块整体 mock
 * （真实引擎的纯数据层单测见 engine/*.test.ts；输入层接线见
 * atrament-adapter.test.ts，手感须 iPad 真机验证）。
 */

const mockSetTool = vi.fn();
const mockUndo = vi.fn();
const mockRedo = vi.fn();
const mockClear = vi.fn();
const mockDestroy = vi.fn();
const mockSetInputMode = vi.fn();
let emitChange: ((doc: InkDoc, reason: InkChangeReason) => void) | null = null;
let mockCanUndo = false;
let mockCanRedo = false;
/** T6R.9：捕获 create 收到的选项（background 透传断言） */
let lastCreateOpts:
  | { background?: string; height?: number; inputMode?: string }
  | undefined;

vi.mock("./engine/index.ts", () => ({
  create: (_container: HTMLElement, opts: unknown) => {
    lastCreateOpts = opts as typeof lastCreateOpts;
    const engine: InkEngine = {
      getData: () => {
        throw new Error("测试未使用");
      },
      load: () => undefined,
      exportPng: () => Promise.reject(new Error("测试未使用")),
      undo: mockUndo,
      redo: mockRedo,
      clear: mockClear,
      setTool: (tool: InkToolConfig) => mockSetTool(tool),
      setInputMode: (mode: InkInputMode) => mockSetInputMode(mode),
      on: (
        event: string,
        cb: (doc: InkDoc, reason: InkChangeReason) => void,
      ) => {
        if (event === "change") emitChange = cb;
        return () => {
          emitChange = null;
        };
      },
      canUndo: () => mockCanUndo,
      canRedo: () => mockCanRedo,
      destroy: mockDestroy,
    };
    return engine;
  },
}));

import { InkPad } from "./InkPad.tsx";

function emptyDoc(): InkDoc<"atrament"> {
  return {
    engine: "atrament",
    version: 1,
    data: { width: 1000, strokes: [] },
    updatedAt: 1,
  };
}

beforeEach(() => {
  emitChange = null;
  mockCanUndo = false;
  mockCanRedo = false;
  resetSessionInputPreference();
  vi.clearAllMocks();
  lastCreateOpts = undefined;
});

afterEach(() => {
  cleanup();
  resetSessionInputPreference();
});

describe("<InkPad> 工具栏", () => {
  it("渲染笔/荧光笔/橡皮/滚动与撤销/重做/清空；撤销重做初始禁用", () => {
    render(<InkPad />);
    // 触发一次 change 后按钮才可用；初始态撤销/重做禁用
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重做" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "清空画布" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "颜色：蓝" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "粗细：粗" }),
    ).toBeInTheDocument();
  });

  it("change 解锁撤销/重做：点击转发到引擎", () => {
    render(<InkPad />);
    expect(emitChange).not.toBeNull();
    mockCanUndo = true;
    mockCanRedo = true;
    act(() => {
      emitChange?.(emptyDoc(), "stroke");
    });

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(mockUndo).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    expect(mockRedo).toHaveBeenCalledTimes(1);
  });

  it("清空需二次确认", () => {
    render(<InkPad />);
    fireEvent.click(screen.getByRole("button", { name: "清空画布" }));
    expect(mockClear).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^清空$/ }));
    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("切换工具下发 setTool；颜色与粗细随选择更新", () => {
    render(<InkPad />);
    // 初始下发默认笔（中/黑）
    expect(mockSetTool).toHaveBeenLastCalledWith({
      type: "pen",
      color: "black",
      size: "medium",
    });

    fireEvent.click(screen.getByRole("button", { name: "颜色：蓝" }));
    expect(mockSetTool).toHaveBeenLastCalledWith({
      type: "pen",
      color: "blue",
      size: "medium",
    });

    fireEvent.click(screen.getByRole("button", { name: "粗细：细" }));
    expect(mockSetTool).toHaveBeenLastCalledWith({
      type: "pen",
      color: "blue",
      size: "thin",
    });

    fireEvent.click(screen.getByRole("button", { name: /橡皮/ }));
    expect(mockSetTool).toHaveBeenLastCalledWith({ type: "eraser" });

    fireEvent.click(screen.getByRole("button", { name: /荧光笔/ }));
    expect(mockSetTool).toHaveBeenLastCalledWith({ type: "highlighter" });

    fireEvent.click(screen.getByRole("button", { name: /滚动/ }));
    expect(mockSetTool).toHaveBeenLastCalledWith({ type: "scroll" });
  });

  it("卸载时销毁引擎；onDocChange 在每次 change 上抛", () => {
    const onDocChange = vi.fn();
    const { unmount } = render(<InkPad onDocChange={onDocChange} />);
    emitChange?.(emptyDoc(), "stroke");
    expect(onDocChange).toHaveBeenCalledTimes(1);
    unmount();
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });
});

describe("<InkPad> 输入模式（T6R.7：会话共享偏好）", () => {
  it("缺省不显示「手指书写」切换，也不向引擎下发 setInputMode（旧作答零变化）", () => {
    render(<InkPad />);
    expect(
      screen.queryByRole("button", { name: /手指书写/ }),
    ).not.toBeInTheDocument();
    expect(mockSetInputMode).not.toHaveBeenCalled();
  });

  it('inputMode="session"：挂载即下发会话偏好（默认 pen）并显示切换按钮；点击切换 finger', () => {
    render(<InkPad inputMode="session" />);
    expect(mockSetInputMode).toHaveBeenLastCalledWith("pen");
    const toggle = screen.getByRole("button", { name: /手指书写/ });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);
    expect(getSessionInputPreference()).toBe("finger");
    expect(mockSetInputMode).toHaveBeenLastCalledWith("finger");
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    // 再点切回 pen
    fireEvent.click(toggle);
    expect(getSessionInputPreference()).toBe("pen");
    expect(mockSetInputMode).toHaveBeenLastCalledWith("pen");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("跨挂载偏好保持：会话已是 finger 时，新画布挂载直接下发 finger（不重新探测）", () => {
    const first = render(<InkPad inputMode="session" />);
    fireEvent.click(screen.getByRole("button", { name: /手指书写/ }));
    first.unmount();

    mockSetInputMode.mockClear();
    render(<InkPad inputMode="session" />);
    // 新挂载的画布（模拟跨题换画布）直接得到 finger，无需再次切换
    expect(mockSetInputMode).toHaveBeenCalledWith("finger");
    expect(mockSetInputMode).not.toHaveBeenCalledWith("pen");
  });

  it("多画布并存：一个画布切换，另一个已挂载画布经订阅即时同步", () => {
    render(<InkPad inputMode="session" />);
    const second = render(<InkPad inputMode="session" />);
    mockSetInputMode.mockClear();

    // 在第二个画布上切换手指书写
    fireEvent.click(
      second.getAllByRole("button", { name: /手指书写/ })[0] as HTMLElement,
    );
    expect(mockSetInputMode).toHaveBeenCalledWith("finger");
    // 两个画布的按钮都反映 finger（同一会话状态）
    for (const btn of [
      ...screen.getAllByRole("button", { name: /手指书写/ }),
    ]) {
      expect(btn).toHaveAttribute("aria-pressed", "true");
    }
  });
});

describe("<InkPad> 新草稿形态 props（T6R.9：NoteLayer 接入）", () => {
  it("background 透传引擎 create 选项；缺省不传（旧作答零变化）", () => {
    const first = render(<InkPad />);
    expect(lastCreateOpts).not.toHaveProperty("background");
    first.unmount();

    render(<InkPad inputMode="session" background="grid" />);
    expect(lastCreateOpts?.background).toBe("grid");
  });

  it("showToolbar=false：不渲染内置工具条（画布仍在）——精简工具条由外层承担", () => {
    render(<InkPad showToolbar={false} inputMode="session" />);
    expect(screen.queryByRole("toolbar")).toBeNull();
    // 画布容器仍在（受控/非全屏形态 role=img）
    expect(screen.getByRole("img", { name: "手写答题区" })).toBeInTheDocument();
    // 输入偏好的引擎下发不受工具条隐藏影响（store 两入口共用）
    expect(mockSetInputMode).toHaveBeenCalledWith("pen");
  });

  it("paperHeight 受控：容器高度恒为受控值，接近底部的笔迹不触发内部 CSS px 直增", () => {
    const view = render(<InkPad paperHeight={320} />);
    const box = screen.getByRole("img", { name: "手写答题区" });
    expect(box.style.height).toBe("320px");
    // 一笔贴近纸底（jsdom clientWidth=0，未受控时也不会加高——断言受控值不被
    // 任何路径改写；逻辑口径加高由外层 paper-geometry 负责，注记②定案）
    act(() => {
      emitChange?.(emptyDoc(), "stroke");
    });
    expect(box.style.height).toBe("320px");

    // 受控值变化（外层换算后回填）即时生效
    view.rerender(<InkPad paperHeight={560} />);
    expect(box.style.height).toBe("560px");
  });

  it("缺省形态不受影响：初始高度与工具条照旧（旧作答链路零变化）", () => {
    render(<InkPad initialHeight={280} />);
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "手写答题区" }).style.height).toBe(
      "280px",
    );
  });
});

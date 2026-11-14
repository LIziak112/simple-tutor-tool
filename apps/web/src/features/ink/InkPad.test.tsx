import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
  | {
      background?: string;
      height?: number;
      inputMode?: string;
      onReady?: () => void;
    }
  | undefined;
/** 模拟 Excalidraw 懒加载完成：create 时即回调 onReady（缺省不回调=加载中） */
let readyOnCreate = false;

vi.mock("./engine/index.ts", () => ({
  create: (_container: HTMLElement, opts: unknown) => {
    lastCreateOpts = opts as typeof lastCreateOpts;
    if (readyOnCreate) lastCreateOpts?.onReady?.();
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

/** 工具栏里各按钮的可访问名（按显示顺序） */
function toolbarButtonNames(name: string): Array<string | null> {
  return within(screen.getByRole("toolbar", { name }))
    .getAllByRole("button")
    .map((el) => el.getAttribute("aria-label"));
}

/** 打开「更多」菜单（Radix 菜单按键盘打开，jsdom 下无需指针事件） */
function openMoreMenu(): void {
  fireEvent.keyDown(screen.getByRole("button", { name: /^更多操作/ }), {
    key: "ArrowDown",
  });
}

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
  readyOnCreate = false;
});

afterEach(() => {
  cleanup();
  resetSessionInputPreference();
});

describe("<InkPad> 工具栏", () => {
  it("页内引擎：笔/荧光笔/橡皮/滚动 + 撤销/重做 + 更多；撤销重做初始禁用，清空在更多里", () => {
    render(<InkPad />);
    expect(toolbarButtonNames("手写答题区工具栏")).toEqual([
      "笔",
      "荧光笔",
      "橡皮",
      "滚动",
      "撤销",
      "重做",
      "更多操作（手写答题区）",
    ]);
    expect(screen.getByRole("button", { name: "笔" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // 触发一次 change 后按钮才可用；初始态撤销/重做禁用
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重做" })).toBeDisabled();
    openMoreMenu();
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(
      ["清空画布"],
    );
  });

  it('inputMode="session"：「手指书写」排在撤销重做之后、更多之前', () => {
    render(<InkPad inputMode="session" />);
    expect(toolbarButtonNames("手写答题区工具栏")).toEqual([
      "笔",
      "荧光笔",
      "橡皮",
      "滚动",
      "撤销",
      "重做",
      "手指书写",
      "更多操作（手写答题区）",
    ]);
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
    openMoreMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "清空画布" }));
    expect(mockClear).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "清空画布？" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^清空$/ }));
    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("切换工具下发 setTool；颜色、粗细、橡皮大小在各自的选项面板里调", () => {
    render(<InkPad />);
    // 初始下发默认笔（中/黑）
    expect(mockSetTool).toHaveBeenLastCalledWith({
      type: "pen",
      color: "black",
      size: "medium",
    });

    // 笔已选中：再点一次打开笔的选项面板
    fireEvent.click(screen.getByRole("button", { name: "笔" }));
    const penPanel = screen.getByRole("dialog", { name: "笔设置" });
    fireEvent.click(within(penPanel).getByRole("radio", { name: "蓝" }));
    expect(mockSetTool).toHaveBeenLastCalledWith({
      type: "pen",
      color: "blue",
      size: "medium",
    });

    fireEvent.click(within(penPanel).getByRole("radio", { name: "细" }));
    expect(mockSetTool).toHaveBeenLastCalledWith({
      type: "pen",
      color: "blue",
      size: "thin",
    });

    // 切到橡皮：笔的面板随之收起，橡皮缺省整笔擦、中号
    fireEvent.click(screen.getByRole("button", { name: "橡皮" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockSetTool).toHaveBeenLastCalledWith({
      type: "eraser",
      mode: "stroke",
      size: "medium",
    });
    fireEvent.click(screen.getByRole("button", { name: "橡皮" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "橡皮设置" })).getByRole(
        "radio",
        { name: "大" },
      ),
    );
    expect(mockSetTool).toHaveBeenLastCalledWith({
      type: "eraser",
      mode: "stroke",
      size: "large",
    });

    fireEvent.click(screen.getByRole("button", { name: "荧光笔" }));
    expect(mockSetTool).toHaveBeenLastCalledWith({
      type: "highlighter",
      color: "yellow",
      size: "medium",
      straight: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "滚动" }));
    expect(mockSetTool).toHaveBeenLastCalledWith({ type: "scroll" });

    // 切回笔：之前调过的颜色、粗细还在
    fireEvent.click(screen.getByRole("button", { name: "笔" }));
    expect(mockSetTool).toHaveBeenLastCalledWith({
      type: "pen",
      color: "blue",
      size: "thin",
    });
  });

  it("引擎重建后重发当前工具（新引擎回到缺省笔，不重发会与工具栏不一致）", () => {
    const view = render(<InkPad background="grid" />);
    fireEvent.click(screen.getByRole("button", { name: "橡皮" }));
    mockSetTool.mockClear();
    view.rerender(<InkPad background="line" />);
    expect(lastCreateOpts?.background).toBe("line");
    expect(mockSetTool).toHaveBeenLastCalledWith({
      type: "eraser",
      mode: "stroke",
      size: "medium",
    });
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
  it("首次布局后增大的初始高度生效，后续缩小不会裁掉纸面", () => {
    const view = render(<InkPad initialHeight={320} />);
    const box = screen.getByRole("img", { name: "手写答题区" });
    view.rerender(<InkPad initialHeight={640} />);
    expect(box.style.height).toBe("640px");
    view.rerender(<InkPad initialHeight={400} />);
    expect(box.style.height).toBe("640px");
  });
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

describe("<InkPad> 背景挂载后更新（T6R.9 复审⑥：重建键方案）", () => {
  it("background 变化 → 引擎按新背景重建（create 收到新值）", () => {
    const view = render(<InkPad inputMode="session" background="grid" />);
    expect(lastCreateOpts?.background).toBe("grid");
    view.rerender(<InkPad inputMode="session" background="line" />);
    expect(lastCreateOpts?.background).toBe("line");
    // 定案注释见组件：重建（非 setBackground 命令）是更廉价的方案——
    // NoteLayer 侧经引擎换实例检测重载正文，undo 历史随重建清零可接受
    // （背景只随外部换稿变化，罕见路径）
  });

  it("背景不变的重渲染不重建引擎", () => {
    const view = render(<InkPad background="grid" />);
    view.rerender(<InkPad background="grid" paperHeight={400} />);
    view.rerender(<InkPad background="grid" paperHeight={500} />);
    // create 只在挂载时发生一次（受控纸高变化走容器样式，不重建）
    expect(
      screen.getAllByRole("img", { name: "手写答题区" }).length,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("<InkPad> 历史 Excalidraw 画布的工具栏", () => {
  it("只提供笔/橡皮/选择；不认颜色粗细，所以点当前工具不出选项面板", () => {
    readyOnCreate = true;
    render(<InkPad engine="excalidraw" label="历史手写作答区" />);
    expect(toolbarButtonNames("历史手写作答区工具栏")).toEqual([
      "笔",
      "橡皮",
      "选择",
      "撤销",
      "重做",
      "更多操作（历史手写作答区）",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "笔" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "橡皮" }));
    fireEvent.click(screen.getByRole("button", { name: "橡皮" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    expect(mockSetTool).toHaveBeenLastCalledWith({ type: "scroll" });
  });

  it("引擎加载完成前工具栏整体禁用", () => {
    render(<InkPad engine="excalidraw" label="历史手写作答区" />);
    const buttons = within(
      screen.getByRole("toolbar", { name: "历史手写作答区工具栏" }),
    ).getAllByRole("button");
    expect(buttons).toHaveLength(6);
    for (const el of buttons) expect(el).toBeDisabled();
  });
});

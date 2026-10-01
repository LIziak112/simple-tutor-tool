import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InkChangeReason,
  InkDoc,
  InkEngine,
  InkToolConfig,
} from "./engine/index.ts";

/**
 * <InkPad> 工具栏交互测试。
 * jsdom 没有 canvas 2d context，无法实例化真实适配器——引擎模块整体 mock
 * （真实引擎的纯数据层单测见 engine/*.test.ts；输入层须 iPad 真机验证）。
 */

const mockSetTool = vi.fn();
const mockUndo = vi.fn();
const mockRedo = vi.fn();
const mockClear = vi.fn();
const mockDestroy = vi.fn();
let emitChange: ((doc: InkDoc, reason: InkChangeReason) => void) | null = null;
let mockCanUndo = false;
let mockCanRedo = false;

vi.mock("./engine/index.ts", () => ({
  create: (_container: HTMLElement, _opts: unknown) => {
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
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
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

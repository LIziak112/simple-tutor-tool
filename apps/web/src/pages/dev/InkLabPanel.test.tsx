import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InkChangeReason,
  InkDoc,
  InkEngine,
  InkToolConfig,
} from "@/features/ink/engine/index.ts";

/**
 * <InkLabPanel> 组件测试（T6R.1）：
 * - 能力探测面板逐项渲染 支持/不支持/未知（禁止 UA 推断，这里只验证呈现）；
 * - 真机场景清单 12 项、勾选与备注持久化到 localStorage；
 * - 预算试验三态（未运行空态 / 运行结果 / 错误）；
 * - 合成书写台注入：有 PointerEvent 的环境跑通，没有的显示错误态。
 *
 * jsdom 没有 canvas 2d，引擎模块整体 mock（真实引擎行为见 engine/*.test.ts
 * 与真机闸门）。
 */

const mockLoad = vi.fn();
const mockClear = vi.fn();

function emptyDoc(): InkDoc<"atrament"> {
  return {
    engine: "atrament",
    version: 1,
    data: { width: 1000, strokes: [] },
    updatedAt: 0,
  };
}

vi.mock("@/features/ink/engine/index.ts", () => ({
  // 模拟真实适配器的挂载副作用：容器内放一个 canvas 供指针注入查询
  create: (container: HTMLElement) => {
    const canvas = document.createElement("canvas");
    canvas.setAttribute("data-slot", "ink-canvas");
    container.appendChild(canvas);
    const engine: InkEngine = {
      getData: () => emptyDoc(),
      load: mockLoad,
      exportPng: () =>
        Promise.resolve(new Blob(["png-bytes"], { type: "image/png" })),
      undo: () => undefined,
      redo: () => undefined,
      clear: mockClear,
      setTool: (_tool: InkToolConfig) => undefined,
      on:
        (
          _event: "change",
          _cb: (doc: InkDoc, reason: InkChangeReason) => void,
        ) =>
        () =>
          undefined,
      canUndo: () => false,
      canRedo: () => false,
      destroy: () => undefined,
    };
    return engine;
  },
}));

import { InkLabPanel } from "./InkLabPanel.tsx";

const STORAGE_KEY = "t6r1-real-device-checklist.v1";

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("<InkLabPanel> 能力探测面板", () => {
  it("六项探测逐项渲染，状态只用 支持/不支持/未知（协议显示实际值）", () => {
    render(<InkLabPanel />);
    for (const label of [
      "页面协议",
      "getCoalescedEvents",
      "pointerrawupdate",
      "Ink API",
      "canvas desynchronized",
      "剪贴板",
    ]) {
      expect(screen.getByText(label, { exact: false })).toBeInTheDocument();
    }
    // jsdom 默认 http:
    expect(screen.getByText("http:")).toBeInTheDocument();
    // 至少渲染出一个三态文案
    const panel = screen
      .getByText("页面协议", { exact: false })
      .closest("section");
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toMatch(/(支持|不支持|未知)/);
  });
});

describe("<InkLabPanel> 真机场景清单", () => {
  it("标题明示待用户真机实测，渲染 12 项场景", () => {
    render(<InkLabPanel />);
    expect(screen.getByText(/待用户真机实测/)).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(12);
    // 空态文案
    expect(screen.getByText(/尚无场景完成实测/)).toBeInTheDocument();
  });

  it("勾选立即写、备注防抖写 localStorage，重挂载后恢复", () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(<InkLabPanel />);
      const boxes = screen.getAllByRole("checkbox");
      fireEvent.click(boxes[0] as HTMLInputElement);
      // 勾选低频：立即持久化
      let saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as {
        done: boolean;
        note: string;
      }[];
      expect(saved[0]?.done).toBe(true);

      const notes = screen.getAllByRole("textbox");
      fireEvent.change(notes[1] as HTMLTextAreaElement, {
        target: { value: "HTTPS 下掌先落未误触" },
      });
      // 备注逐键高频：500ms 防抖后落盘
      act(() => {
        vi.advanceTimersByTime(500);
      });
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as {
        done: boolean;
        note: string;
      }[];
      expect(saved[1]?.note).toBe("HTTPS 下掌先落未误触");

      unmount();
      cleanup();
      render(<InkLabPanel />);
      expect(
        (screen.getAllByRole("checkbox")[0] as HTMLInputElement).checked,
      ).toBe(true);
      expect(
        (screen.getAllByRole("textbox")[1] as HTMLTextAreaElement).value,
      ).toBe("HTTPS 下掌先落未误触");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("<InkLabPanel> 预算试验", () => {
  it("初始为空态（尚未运行）", () => {
    render(<InkLabPanel budgetRungs={[3, 6]} />);
    expect(screen.getByText(/尚未运行/)).toBeInTheDocument();
  });

  it("运行后输出阶梯结果与触线结论", async () => {
    render(<InkLabPanel budgetRungs={[3, 6]} />);
    fireEvent.change(screen.getByLabelText("预算每笔点数"), {
      target: { value: "8" },
    });
    fireEvent.click(screen.getByRole("button", { name: /运行预算试验/ }));
    await waitFor(
      () => expect(screen.getByText(/触线结论/)).toBeInTheDocument(),
      { timeout: 10000 },
    );
    // 两级阶梯的笔数出现在结果表
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("6")).toBeInTheDocument();
    // 小阶梯不应触暂定线
    expect(screen.getByText(/未触任何暂定预算线/)).toBeInTheDocument();
  });
});

describe("<InkLabPanel> 合成书写台", () => {
  it("注入按钮产出结果或明确错误（三态接住）", async () => {
    render(<InkLabPanel />);
    fireEvent.change(screen.getByLabelText("注入笔数"), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByLabelText("注入每笔点数"), {
      target: { value: "6" },
    });
    fireEvent.click(screen.getByRole("button", { name: /注入合成笔迹/ }));
    if (typeof PointerEvent !== "undefined") {
      await waitFor(
        () => expect(screen.getByText(/注入完成/)).toBeInTheDocument(),
        {
          timeout: 10000,
        },
      );
      expect(mockClear).toHaveBeenCalled();
    } else {
      await waitFor(
        () =>
          expect(screen.getByText(/不支持 PointerEvent/)).toBeInTheDocument(),
        { timeout: 10000 },
      );
    }
  });

  it("对照 load 注入产出重绘耗时报告", async () => {
    render(<InkLabPanel />);
    fireEvent.click(screen.getByRole("button", { name: /对照：load 注入/ }));
    await waitFor(
      () => expect(screen.getByText(/load 注入完成/)).toBeInTheDocument(),
      { timeout: 10000 },
    );
    expect(mockLoad).toHaveBeenCalled();
  });
});

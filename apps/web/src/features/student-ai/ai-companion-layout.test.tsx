import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { stubElementWidth } from "@/test/stub-element-width";
import {
  AI_COMPANION_DOCK_MIN_WIDTH,
  AI_COMPANION_NAV_EXPAND_MIN_WIDTH,
  type AiCompanionLayoutController,
  type AiCompanionLayoutEditor,
  useAiCompanionLayout,
} from "./ai-companion-layout";

/**
 * SAI-19 伴学栏布局控制器（B10 必须先测 1/2/5 的状态机层）：
 * - 开/关 AI、开/关左答题卡、再开 AI：恢复状态遵守用户主动选择；
 * - 打开前对当前题收笔并等本机落盘，失败不改变任何布局状态；
 * - 宽屏 dock / 窄屏独立面板基于实测可用宽度切换，旋转/分屏/软键盘
 *   序列下主区与 AI 面板不互相挤爆（覆盖态随空间回补解除）。
 * 组件壳、键盘与 identity 集成见 AiCompanionRail.test.tsx 与
 * attempt/AttemptWorkspace.ai-rail.test.tsx。
 */

/** 宽度桩：可控的当前宽度值（offsetWidth 与 getBoundingClientRect 同步） */
let width: ReturnType<typeof stubElementWidth>;
const setWidth = (next: number) => width.setWidth(next);

interface FakeEditor extends AiCompanionLayoutEditor {
  flush: Mock<AiCompanionLayoutEditor["flush"]>;
}

const captured: { controller: AiCompanionLayoutController | null } = {
  controller: null,
};

function Harness({
  editor,
  currentQuestionId = "q1",
}: {
  editor: FakeEditor | null;
  currentQuestionId?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const controller = useAiCompanionLayout({
    containerRef: ref,
    editor,
    currentQuestionId,
  });
  captured.controller = controller;
  return (
    <div ref={ref}>
      <span data-testid="ai-state">
        {controller.suspended
          ? "suspended"
          : controller.open
            ? controller.mode
            : "closed"}
      </span>
      <span data-testid="nav-state">
        {controller.navigatorCollapsed ? "collapsed" : "open"}
      </span>
      {controller.error && <p role="alert">{controller.error}</p>}
    </div>
  );
}

const stateOf = () => ({
  ai: screen.getByTestId("ai-state").textContent,
  nav: screen.getByTestId("nav-state").textContent,
});
const openPanel = async () =>
  act(async () => {
    return await captured.controller?.openPanel();
  });
const closePanel = () =>
  act(() => {
    captured.controller?.closePanel();
  });
const toggleNav = () =>
  act(() => {
    captured.controller?.toggleNavigator();
  });

beforeEach(() => {
  width = stubElementWidth();
  captured.controller = null;
});
afterEach(() => width.restore());

describe("SAI-19 伴学栏布局控制器", () => {
  it("必须先测①：开/关 AI、开/关左答题卡、再开 AI——恢复状态遵守用户主动选择", async () => {
    const editor = { flush: vi.fn(async () => {}) };
    render(<Harness editor={editor} />);
    // 宽屏：空间充足，开 AI 不动答题卡
    expect(await openPanel()).toBe(true);
    expect(stateOf()).toEqual({ ai: "dock", nav: "open" });
    closePanel();
    expect(stateOf()).toEqual({ ai: "closed", nav: "open" });

    // 中宽：空间不足自动收起并记录原状态；关闭后恢复
    setWidth(AI_COMPANION_DOCK_MIN_WIDTH + 100);
    expect(await openPanel()).toBe(true);
    expect(stateOf()).toEqual({ ai: "dock", nav: "collapsed" });
    closePanel();
    expect(stateOf()).toEqual({ ai: "closed", nav: "open" });

    // 再开 AI 再次收起；用户在覆盖期间主动展开＝另行操作：窄空间互斥，
    // AI 面板让位为独立面板（§7.2），关闭后不代为收起答题卡
    expect(await openPanel()).toBe(true);
    expect(stateOf()).toEqual({ ai: "dock", nav: "collapsed" });
    toggleNav();
    expect(stateOf()).toEqual({ ai: "panel", nav: "open" });
    closePanel();
    expect(stateOf()).toEqual({ ai: "closed", nav: "open" });

    // 让位后用户又收起答题卡：空间让出，AI 回 dock，折叠归用户所有
    expect(await openPanel()).toBe(true);
    expect(stateOf()).toEqual({ ai: "dock", nav: "collapsed" });
    toggleNav();
    expect(stateOf()).toEqual({ ai: "panel", nav: "open" });
    toggleNav();
    expect(stateOf()).toEqual({ ai: "dock", nav: "collapsed" });
    closePanel();
    expect(stateOf()).toEqual({ ai: "closed", nav: "collapsed" });
    // 复原：用户重新展开，进入下一段空间回补场景
    toggleNav();
    expect(stateOf()).toEqual({ ai: "closed", nav: "open" });

    // 让位期间空间回补（拖宽/转回横屏）：AI 回 dock，答题卡保持用户展开
    expect(await openPanel()).toBe(true);
    toggleNav();
    expect(stateOf()).toEqual({ ai: "panel", nav: "open" });
    setWidth(AI_COMPANION_NAV_EXPAND_MIN_WIDTH + 100);
    expect(stateOf()).toEqual({ ai: "dock", nav: "open" });
    closePanel();
    expect(stateOf()).toEqual({ ai: "closed", nav: "open" });

    // 用户自己在 AI 关闭时收起答题卡：开/关 AI 都不代为展开
    toggleNav();
    expect(stateOf()).toEqual({ ai: "closed", nav: "collapsed" });
    expect(await openPanel()).toBe(true);
    expect(stateOf()).toEqual({ ai: "dock", nav: "collapsed" });
    closePanel();
    expect(stateOf()).toEqual({ ai: "closed", nav: "collapsed" });
  });

  it("必须先测②：打开前对当前题收笔等本机落盘；落盘失败布局不变并如实报错", async () => {
    const editor: FakeEditor = {
      flush: vi.fn(async () => {
        throw new Error("本机稿写入失败");
      }),
    };
    render(<Harness editor={editor} />);
    expect(await openPanel()).toBe(false);
    expect(editor.flush).toHaveBeenCalledWith("q1");
    // 布局完全不变：AI 未开、答题卡维持原状。undo/笔迹保留不在本层断言
    // （mock editor 无从观测）：由组合层「不重挂」+ SAI-10 flush 契约测试
    // （AttemptEditorContext「不改变编辑状态、不销毁控制器」）共同保证。
    expect(stateOf()).toEqual({ ai: "closed", nav: "open" });
    expect(screen.getByRole("alert")).toHaveTextContent("本机稿写入失败");

    // 落盘恢复后重开成功，且错误提示清除
    editor.flush.mockImplementation(async () => {});
    expect(await openPanel()).toBe(true);
    expect(stateOf()).toEqual({ ai: "dock", nav: "open" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("无编辑器上下文或无当前题时直接打开（没有可收笔的对象）", async () => {
    const { rerender } = render(<Harness editor={null} />);
    expect(await openPanel()).toBe(true);
    closePanel();
    rerender(<Harness editor={null} currentQuestionId={null} />);
    expect(await openPanel()).toBe(true);
    expect(stateOf().ai).toBe("dock");
  });

  it("必须先测⑤：宽屏→分屏→窄屏→软键盘序列的模式与覆盖迁移；空间回补解除覆盖", async () => {
    const editor = { flush: vi.fn(async () => {}) };
    render(<Harness editor={editor} />);
    expect(await openPanel()).toBe(true);
    expect(stateOf()).toEqual({ ai: "dock", nav: "open" });

    // 分屏（仍够 dock 但不够答题卡展开）：收答题卡让位
    setWidth(AI_COMPANION_NAV_EXPAND_MIN_WIDTH - 100);
    expect(stateOf()).toEqual({ ai: "dock", nav: "collapsed" });

    // 窄屏：退为独立面板；题面与 AI 不再共享一行
    setWidth(AI_COMPANION_DOCK_MIN_WIDTH - 100);
    expect(stateOf().ai).toBe("panel");

    // 软键盘（可见视窗高度变化）不改变宽度判定
    const viewport = new EventTarget();
    Object.assign(viewport, { height: 400, offsetTop: 0, scale: 1 });
    vi.stubGlobal("visualViewport", viewport);
    viewport.dispatchEvent(new Event("resize"));
    expect(stateOf().ai).toBe("panel");
    vi.unstubAllGlobals();

    // 回到宽屏：面板回到 dock，覆盖解除、答题卡恢复（用户未另行操作）
    setWidth(AI_COMPANION_NAV_EXPAND_MIN_WIDTH + 100);
    expect(stateOf()).toEqual({ ai: "dock", nav: "open" });

    // 关闭后回到最初状态
    closePanel();
    expect(stateOf()).toEqual({ ai: "closed", nav: "open" });
  });

  it("模式阈值基于实测可用宽度：dock 下限与答题卡展开下限各自生效", async () => {
    const editor = { flush: vi.fn(async () => {}) };
    render(<Harness editor={editor} />);
    setWidth(AI_COMPANION_DOCK_MIN_WIDTH);
    expect(await openPanel()).toBe(true);
    expect(stateOf().ai).toBe("dock");
    closePanel();
    setWidth(AI_COMPANION_DOCK_MIN_WIDTH - 1);
    expect(await openPanel()).toBe(true);
    expect(stateOf().ai).toBe("panel");
    closePanel();
    setWidth(AI_COMPANION_NAV_EXPAND_MIN_WIDTH);
    expect(await openPanel()).toBe(true);
    expect(stateOf().nav).toBe("open");
    closePanel();
    setWidth(AI_COMPANION_NAV_EXPAND_MIN_WIDTH - 1);
    expect(await openPanel()).toBe(true);
    expect(stateOf().nav).toBe("collapsed");
  });

  it("打开 AI 时正在书写：flush 在布局变化之前发生（先收笔后重排）", async () => {
    const order: string[] = [];
    const editor = {
      flush: vi.fn(async () => {
        order.push("flush");
      }),
    };
    render(<Harness editor={editor} />);
    await openPanel();
    order.push("opened");
    expect(order).toEqual(["flush", "opened"]);
  });

  it("题卡离屏时暂时收起，回到可见区域恢复；手动关闭后不再自动打开", async () => {
    const editor = { flush: vi.fn(async () => {}) };
    render(<Harness editor={editor} />);
    expect(await openPanel()).toBe(true);
    expect(stateOf().ai).toBe("dock");

    act(() => captured.controller?.setVisible(false));
    expect(stateOf().ai).toBe("suspended");
    expect(captured.controller?.open).toBe(true);

    act(() => captured.controller?.setVisible(true));
    expect(stateOf().ai).toBe("dock");

    closePanel();
    act(() => captured.controller?.setVisible(true));
    expect(stateOf().ai).toBe("closed");
  });
});

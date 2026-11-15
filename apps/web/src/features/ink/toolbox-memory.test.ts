import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInkToolbox,
  DEFAULT_INK_TOOLBOX,
  type InkToolboxState,
} from "./engine/toolbox.ts";
import type { InkPenBase } from "./engine/types.ts";
import { bindInkProfileAccount } from "./ink-profile-store";
import {
  getRememberedTools,
  rememberInkToolbox,
  resolveRememberedToolbox,
  useRememberedToolbox,
} from "./toolbox-memory.ts";

const student = { role: "student", id: "s-1" } as const;
const storageKey = (role: string, id: string) =>
  `ownclass:ink-toolbox:${JSON.stringify([location.origin, role, id])}`;
const stored = (role: string, id: string): unknown =>
  JSON.parse(localStorage.getItem(storageKey(role, id)) ?? "null");

/** 一份和缺省处处不同的工具箱，当前工具停在橡皮上 */
const custom: InkToolboxState = {
  active: "eraser",
  pen: { color: "green", size: "heavy" },
  highlighter: { color: "pink", size: "thick", straight: true },
  eraser: { mode: "partial", size: "large" },
  shape: { kind: "ellipse" },
};
const customSettings = {
  pen: custom.pen,
  highlighter: custom.highlighter,
  eraser: custom.eraser,
  shape: custom.shape,
};

beforeEach(() => {
  bindInkProfileAccount(null);
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  // 先卸载再解绑：解绑会通知还挂着的组件
  cleanup();
  bindInkProfileAccount(null);
});

describe("工具箱记忆：存取", () => {
  it("没有账号时不记：读到 null，写了也不落盘", () => {
    expect(getRememberedTools("paper")).toBeNull();
    rememberInkToolbox("paper", custom);
    expect(getRememberedTools("paper")).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("有账号：各工具的设置落在本机，当前工具不存", () => {
    bindInkProfileAccount(student);
    expect(getRememberedTools("paper")).toEqual({});
    rememberInkToolbox("paper", custom);
    expect(stored("student", "s-1")).toEqual({
      version: 1,
      scopes: { paper: customSettings },
    });
    const first = getRememberedTools("paper");
    expect(first).toEqual(customSettings);
    // 没有变化时每次读到同一个对象（React 靠它判断要不要重画）
    expect(getRememberedTools("paper")).toBe(first);
    // 只换了当前工具：内容没变，不重写
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    rememberInkToolbox("paper", { ...custom, active: "pen" });
    expect(setItem).not.toHaveBeenCalled();
    expect(getRememberedTools("paper")).toBe(first);
  });

  it("账号、角色、场景彼此隔开", () => {
    bindInkProfileAccount(student);
    rememberInkToolbox("paper", custom);
    expect(getRememberedTools("annotation")).toEqual({});

    bindInkProfileAccount({ role: "student", id: "s-2" });
    expect(getRememberedTools("paper")).toEqual({});
    bindInkProfileAccount({ role: "teacher", id: "s-1" });
    expect(getRememberedTools("paper")).toEqual({});

    rememberInkToolbox("annotation", custom);
    expect(stored("teacher", "s-1")).toEqual({
      version: 1,
      scopes: { annotation: customSettings },
    });
    expect(stored("student", "s-1")).toEqual({
      version: 1,
      scopes: { paper: customSettings },
    });
  });

  it("退出再登录同一账号（相当于刷新页面）读回上次的设置", () => {
    bindInkProfileAccount(student);
    rememberInkToolbox("paper", custom);
    rememberInkToolbox("annotation", { ...custom, shape: { kind: "rect" } });
    bindInkProfileAccount(null);
    expect(getRememberedTools("paper")).toBeNull();
    bindInkProfileAccount({ ...student });
    expect(getRememberedTools("paper")).toEqual(customSettings);
    expect(getRememberedTools("annotation")).toEqual({
      ...customSettings,
      shape: { kind: "rect" },
    });
  });

  it.each([
    ["不是 JSON", "{oops"],
    ["版本不认", JSON.stringify({ version: 2, scopes: { paper: {} } })],
    ["不是对象", JSON.stringify(["paper"])],
    ["scopes 不是对象", JSON.stringify({ version: 1, scopes: "paper" })],
    [
      "场景里不是对象",
      JSON.stringify({ version: 1, scopes: { paper: "green" } }),
    ],
  ])("存的内容读不懂就当没记过：%s", (_name, raw) => {
    localStorage.setItem(storageKey("student", "s-1"), raw);
    bindInkProfileAccount(student);
    expect(getRememberedTools("paper")).toEqual({});
    // 之后照常能记
    rememberInkToolbox("paper", custom);
    expect(getRememberedTools("paper")).toEqual(customSettings);
  });

  it("本机存不进去（空间满、隐私模式）不报错，这一次打开期间照常生效", () => {
    bindInkProfileAccount(student);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("满了", "QuotaExceededError");
    });
    expect(() => rememberInkToolbox("paper", custom)).not.toThrow();
    expect(getRememberedTools("paper")).toEqual(customSettings);
  });

  it("本机读不出来（存储被禁用）当没记过，不报错", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("禁用", "SecurityError");
    });
    bindInkProfileAccount(student);
    expect(getRememberedTools("paper")).toEqual({});
  });

  it("另一个标签页改了，这边跟着重读", () => {
    bindInkProfileAccount(student);
    rememberInkToolbox("paper", custom);
    const key = storageKey("student", "s-1");
    const newValue = JSON.stringify({
      version: 1,
      scopes: { paper: { ...customSettings, shape: { kind: "arrow" } } },
    });
    localStorage.setItem(key, newValue);
    window.dispatchEvent(
      new StorageEvent("storage", { key, newValue, storageArea: localStorage }),
    );
    expect(getRememberedTools("paper")).toEqual({
      ...customSettings,
      shape: { kind: "arrow" },
    });
  });
});

describe("工具箱记忆：读回时逐字段校验", () => {
  it("合法字段照用，非法字段回缺省值，当前工具取缺省的", () => {
    const defaults = createInkToolbox({ pen: { color: "red", size: "thin" } });
    expect(
      resolveRememberedToolbox(
        {
          active: "eraser",
          pen: { color: "green", size: "enormous" },
          highlighter: { color: "pink", size: "thick", straight: "yes" },
          eraser: "partial",
          shape: { kind: "ellipse" },
        },
        defaults,
      ),
    ).toEqual({
      active: "pen",
      pen: { color: "green", size: "thin" },
      highlighter: { color: "pink", size: "thick", straight: false },
      eraser: DEFAULT_INK_TOOLBOX.eraser,
      shape: { kind: "ellipse" },
    });
    expect(resolveRememberedToolbox({}, defaults)).toEqual(defaults);
  });

  it("笔跟随笔感设置的场景：设置里的颜色粗细没变用记住的笔，变了用设置里的", () => {
    const profilePen = { color: "blue", size: "thin" } as const;
    const defaults = createInkToolbox({ pen: profilePen });
    const remembered = { ...customSettings, penBasis: profilePen };
    expect(
      resolveRememberedToolbox(remembered, defaults, profilePen).pen,
    ).toEqual(custom.pen);
    // 设置里换成了黑色：记住的笔不算数，其余工具照旧
    const changed = { color: "black", size: "thin" } as const;
    const next = resolveRememberedToolbox(
      remembered,
      createInkToolbox({ pen: changed }),
      changed,
    );
    expect(next.pen).toEqual(changed);
    expect(next.highlighter).toEqual(custom.highlighter);
    // 没记下当时的设置（旧数据、被改过）：同样以设置为准
    expect(
      resolveRememberedToolbox(customSettings, defaults, profilePen).pen,
    ).toEqual(profilePen);
  });
});

describe("useRememberedToolbox", () => {
  /** 笔感设置里的两种笔 */
  const black: InkPenBase = { color: "black", size: "medium" };
  const blue: InkPenBase = { color: "blue", size: "medium" };
  const paperDefaults = () => createInkToolbox();
  const annotationDefaults = () =>
    createInkToolbox({ pen: { color: "red", size: "thin" } });

  it("没有账号：和普通组件状态一样，两处互不影响", () => {
    const a = renderHook(() => useRememberedToolbox("paper", paperDefaults));
    const b = renderHook(() => useRememberedToolbox("paper", paperDefaults));
    expect(a.result.current[0]).toEqual(DEFAULT_INK_TOOLBOX);
    act(() => a.result.current[1](custom));
    expect(a.result.current[0]).toEqual(custom);
    expect(b.result.current[0]).toEqual(DEFAULT_INK_TOOLBOX);
    expect(localStorage.length).toBe(0);
    // 没有变化时工具箱是同一个对象（宿主拿它当副作用的依赖）
    const before = a.result.current[0];
    a.rerender();
    expect(a.result.current[0]).toBe(before);
  });

  it("没有账号：笔跟着笔感设置走，设置变了重新取值", () => {
    const view = renderHook(
      ({ pen }) =>
        useRememberedToolbox("paper", () => createInkToolbox({ pen }), pen),
      { initialProps: { pen: black } },
    );
    act(() =>
      view.result.current[1]({
        ...view.result.current[0],
        pen: { color: "green", size: "heavy" },
      }),
    );
    expect(view.result.current[0].pen).toEqual({
      color: "green",
      size: "heavy",
    });
    view.rerender({ pen: blue });
    expect(view.result.current[0].pen).toEqual({
      color: "blue",
      size: "medium",
    });
  });

  it("有账号：一处改了设置，同场景的另一处立即跟上；当前工具各管各的", () => {
    bindInkProfileAccount(student);
    const a = renderHook(() => useRememberedToolbox("paper", paperDefaults));
    const b = renderHook(() => useRememberedToolbox("paper", paperDefaults));
    const other = renderHook(() =>
      useRememberedToolbox("annotation", annotationDefaults),
    );
    const otherBefore = other.result.current[0];
    act(() => a.result.current[1](custom));
    expect(a.result.current[0]).toEqual(custom);
    expect(b.result.current[0]).toEqual({ ...custom, active: "pen" });
    // 别的场景不受影响，连对象都没换
    expect(other.result.current[0]).toBe(otherBefore);
    expect(other.result.current[0].pen).toEqual({ color: "red", size: "thin" });

    // 只切当前工具：另一处不动
    const bBefore = b.result.current[0];
    act(() => a.result.current[1]({ ...custom, active: "highlighter" }));
    expect(a.result.current[0].active).toBe("highlighter");
    expect(b.result.current[0]).toBe(bBefore);
  });

  it("有账号：重新挂载后设置还在，当前工具回到缺省", () => {
    bindInkProfileAccount(student);
    const first = renderHook(() =>
      useRememberedToolbox("paper", paperDefaults),
    );
    act(() => first.result.current[1](custom));
    first.unmount();
    const again = renderHook(() =>
      useRememberedToolbox("paper", paperDefaults),
    );
    expect(again.result.current[0]).toEqual({ ...custom, active: "pen" });
  });

  it("先挂载、后绑定账号（刷新页面时就是这个顺序）：绑定后读到记忆", () => {
    bindInkProfileAccount(student);
    rememberInkToolbox("paper", custom);
    bindInkProfileAccount(null);
    const view = renderHook(() => useRememberedToolbox("paper", paperDefaults));
    expect(view.result.current[0]).toEqual(DEFAULT_INK_TOOLBOX);
    act(() => bindInkProfileAccount({ ...student }));
    expect(view.result.current[0]).toEqual({ ...custom, active: "pen" });
    // 退出登录：回到只在本组件里的状态，不再写盘
    act(() => bindInkProfileAccount(null));
    act(() =>
      view.result.current[1]({
        ...DEFAULT_INK_TOOLBOX,
        shape: { kind: "rect" },
      }),
    );
    expect(view.result.current[0].shape).toEqual({ kind: "rect" });
    expect(stored("student", "s-1")).toEqual({
      version: 1,
      scopes: { paper: customSettings },
    });
  });

  it("笔感设置里的颜色粗细变了：记住的笔作废，换回原设置也不复活", () => {
    bindInkProfileAccount(student);
    const view = renderHook(
      ({ pen }) =>
        useRememberedToolbox("paper", () => createInkToolbox({ pen }), pen),
      { initialProps: { pen: black } },
    );
    act(() => view.result.current[1](custom));
    expect(view.result.current[0].pen).toEqual(custom.pen);
    expect(getRememberedTools("paper")).toEqual({
      ...customSettings,
      penBasis: black,
    });

    view.rerender({ pen: blue });
    expect(view.result.current[0].pen).toEqual(blue);
    // 其余工具照旧
    expect(view.result.current[0].highlighter).toEqual(custom.highlighter);
    expect(getRememberedTools("paper")).toEqual({
      highlighter: custom.highlighter,
      eraser: custom.eraser,
      shape: custom.shape,
    });

    view.rerender({ pen: black });
    expect(view.result.current[0].pen).toEqual(black);
  });

  it("圈画场景缺省红色细笔，和草稿纸各记各的", () => {
    bindInkProfileAccount(student);
    const paper = renderHook(() =>
      useRememberedToolbox("paper", paperDefaults),
    );
    const annotation = renderHook(() =>
      useRememberedToolbox("annotation", annotationDefaults),
    );
    act(() => paper.result.current[1](custom));
    expect(annotation.result.current[0]).toEqual(annotationDefaults());
    act(() =>
      annotation.result.current[1]({
        ...annotation.result.current[0],
        pen: { color: "blue", size: "thick" },
      }),
    );
    expect(paper.result.current[0].pen).toEqual(custom.pen);
    expect(stored("student", "s-1")).toEqual({
      version: 1,
      scopes: {
        paper: customSettings,
        annotation: {
          pen: { color: "blue", size: "thick" },
          highlighter: DEFAULT_INK_TOOLBOX.highlighter,
          eraser: DEFAULT_INK_TOOLBOX.eraser,
          shape: DEFAULT_INK_TOOLBOX.shape,
        },
      },
    });
  });
});

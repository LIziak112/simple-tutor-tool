import { render, screen } from "@testing-library/react";
import type { AttemptContextMaterial } from "@tutor/contract";
import { describe, expect, it, vi } from "vitest";
import { QuestionMaterialsAnchor } from "./QuestionMaterialsAnchor";

/**
 * P1-2 题级材料锚（solo 题的 ::ref 材料入口）：与题行同为单元 ol 的兄弟
 * li（不包裹题行——树位纪律同 QuestionGroupAnchor）；材料常驻自然阅读，
 * reveal 信号滚入 + 恢复已读偏移 + 焦点可达；多版本徽标经 MaterialPanel
 * 同源标注。本文件覆盖结构/reveal/隐藏；「context 后到不重挂题卡」的树位
 * 不变量由 attempt-context-session 集成测试按 DOM 身份直测。
 */

function material(
  id: string,
  overrides: Partial<AttemptContextMaterial> = {},
): AttemptContextMaterial {
  return {
    id,
    contentMd: `材料 ${id} 正文，含公式 $x^2+y^2$。`,
    anchors: [],
    slots: [],
    mediaPaths: [],
    sourceVersion: 1,
    ...overrides,
  };
}

describe("QuestionMaterialsAnchor（题级材料锚）", () => {
  it("材料面板常驻渲染（本题材料语义、公式经同一 markdown 管线）；data-question-id 标记归属", () => {
    render(
      <QuestionMaterialsAnchor
        questionId="q-9"
        materials={[material("m-solo", { title: "给定资料" })]}
      />,
    );
    const anchor = document.querySelector(
      '[data-slot="question-materials-anchor"]',
    );
    expect(anchor?.getAttribute("data-question-id")).toBe("q-9");
    const panel = screen.getByLabelText("共享材料：给定资料");
    expect(panel.textContent).toContain("材料 m-solo 正文");
    expect(document.querySelector(".katex")).not.toBeNull();
  });

  it("reveal 信号：滚入材料区、恢复已读偏移并聚焦（键盘可达）", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const scrollBy = vi.fn();
    window.scrollBy = scrollBy as typeof window.scrollBy;
    const { rerender } = render(
      <QuestionMaterialsAnchor
        questionId="q-9"
        materials={[material("m-solo")]}
        readingKey="attempt-1|q:q-9"
      />,
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender(
      <QuestionMaterialsAnchor
        questionId="q-9"
        materials={[material("m-solo")]}
        readingKey="attempt-1|q:q-9"
        revealSignal={1}
      />,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    // stack 形态（无列内滚动）恢复偏移走 window.scrollBy（记录 0 时跳过）
    expect(scrollBy).not.toHaveBeenCalled();
    const region = document.querySelector('[data-slot="question-materials"]');
    expect(region).toHaveFocus();
  });

  it("hidden 不改 DOM 结构（单题态外层隐藏，控制器不卸载）；消费侧 className 合并（compare 网格跨两列）", () => {
    const { rerender } = render(
      <QuestionMaterialsAnchor
        questionId="q-9"
        materials={[material("m-solo")]}
        hidden
      />,
    );
    const anchor = document.querySelector(
      '[data-slot="question-materials-anchor"]',
    );
    expect(anchor?.hasAttribute("hidden")).toBe(true);
    rerender(
      <QuestionMaterialsAnchor
        questionId="q-9"
        materials={[material("m-solo")]}
        className="min-w-0 xl:col-span-2"
      />,
    );
    expect(anchor?.className.includes("xl:col-span-2")).toBe(true);
  });

  it("当提供 onSplitRatioChange 时渲染分栏拖拽 Handle 并支持分栏比例", () => {
    const onSplitRatioChange = vi.fn();
    render(
      <QuestionMaterialsAnchor
        questionId="q-9"
        materials={[material("m-solo")]}
        attemptId="att-1"
        splitRatio={45}
        onSplitRatioChange={onSplitRatioChange}
      />,
    );
    const handleContainer = document.querySelector(
      '[data-slot="question-split-handle-container"]',
    );
    expect(handleContainer).not.toBeNull();
    const handle = screen.getByRole("separator", {
      name: "调整材料与题目分栏比例",
    });
    expect(handle.getAttribute("aria-valuenow")).toBe("45");
  });
});

describe("题级材料分栏独立滚动与切题联动（2026-10-27 需求）", () => {
  it("分栏网格生效（列表模式）时题级材料列获得视口级独立滚动端口与滚动隔离，把手容器同栏粘性", () => {
    render(
      <QuestionMaterialsAnchor
        questionId="q-9"
        materials={[material("m-solo")]}
        splitRatio={50}
        onSplitRatioChange={() => {}}
      />,
    );
    const section = document.querySelector(
      '[data-slot="question-materials"]',
    ) as HTMLElement;
    expect(section.className).toContain("lg:sticky");
    expect(section.className).toContain("lg:max-h-");
    expect(section.className).toContain("lg:overflow-y-auto");
    expect(section.className).toContain("lg:overscroll-contain");
    expect(section.className).toContain("isolate");
    const handleContainer = document.querySelector(
      '[data-slot="question-split-handle-container"]',
    );
    expect(handleContainer?.className).toContain("lg:sticky");
  });

  it("显式跳题信号且目标为本题时平滑回顶；他题信号/重复信号/不可滚动不触发", () => {
    const props = {
      questionId: "q-9",
      materials: [material("m-solo")],
      splitRatio: 50,
      onSplitRatioChange: () => {},
    };
    const { rerender } = render(
      <QuestionMaterialsAnchor
        {...props}
        jumpSignal={{ questionId: "q-8", seq: 1 }}
      />,
    );
    const section = document.querySelector(
      '[data-slot="question-materials"]',
    ) as HTMLElement;
    const scrollTo = vi.fn();
    section.scrollTo = scrollTo;
    Object.defineProperty(section, "scrollHeight", {
      value: 900,
      configurable: true,
    });
    Object.defineProperty(section, "clientHeight", {
      value: 308,
      configurable: true,
    });

    // 显式跳到本题 → 平滑回顶
    rerender(
      <QuestionMaterialsAnchor
        {...props}
        jumpSignal={{ questionId: "q-9", seq: 2 }}
      />,
    );
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });

    // 跳到其他题 → 本列不动（C 口径）
    scrollTo.mockClear();
    rerender(
      <QuestionMaterialsAnchor
        {...props}
        jumpSignal={{ questionId: "q-8", seq: 3 }}
      />,
    );
    expect(scrollTo).not.toHaveBeenCalled();

    // 不可滚动（材料短于视口）时跳题不动材料
    Object.defineProperty(section, "scrollHeight", {
      value: 120,
      configurable: true,
    });
    rerender(
      <QuestionMaterialsAnchor
        {...props}
        jumpSignal={{ questionId: "q-9", seq: 4 }}
      />,
    );
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

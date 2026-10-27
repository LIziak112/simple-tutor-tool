import { fireEvent, render, screen, within } from "@testing-library/react";
import type {
  AttemptContextGroup,
  AttemptContextMaterial,
} from "@tutor/contract";
import { describe, expect, it, vi } from "vitest";
import { MaterialPanel } from "./MaterialPanel";
import { QuestionGroupAnchor } from "./QuestionGroupAnchor";

/**
 * TT-08a / QM-08 题组锚与材料面板组件测试：锚点是题行的**兄弟**（组头 +
 * 材料列，不包裹题行——审查 P1 修复的树位不变量由 attempt-context-session
 * 集成测试按 DOM 身份直测）；本文件覆盖结构语义、compare 分组呈现类、
 * 属性更新不换 DOM 实例（真实身份断言，替代旧「重查 contains」空转形态）、
 * 「查看材料」reveal 与阅读位置保留、memo 默认比较纪律。
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

function groupOf(
  overrides: Partial<AttemptContextGroup> = {},
): AttemptContextGroup {
  return {
    id: "grp-1",
    introMd: "",
    materialRefs: [],
    questionIds: [],
    sourceVersion: 1,
    ...overrides,
  };
}

describe("QuestionGroupAnchor", () => {
  it("组头呈现标题/label/公共说明；材料经同一 markdown 管线渲染（公式 + 中文）", () => {
    render(
      <QuestionGroupAnchor
        group={groupOf({
          title: "资料分析",
          label: "1～5",
          introMd: "阅读材料回答 **下列各题**。",
          materialRefs: [{ material: "m1" }],
          questionIds: ["q1", "q2"],
        })}
        materials={[material("m1")]}
        questionCount={2}
      />,
    );
    const header = screen.getByLabelText("题组：资料分析");
    expect(within(header).getByText("1～5")).toBeInTheDocument();
    expect(within(header).getByText("下列各题")).toBeInTheDocument();
    const panel = screen.getByLabelText("共享材料");
    // 标题缺省回退「材料」（MaterialPanel 细项）；公式经 KaTeX 实渲染
    expect(document.querySelector(".katex")).not.toBeNull();
    expect(panel.textContent).toContain("材料 m1 正文");
  });

  it("标题缺省回退「题组」/「材料」；零材料组不渲染材料列与共用提示", () => {
    render(<QuestionGroupAnchor group={groupOf()} materials={[]} />);
    expect(screen.getByLabelText("题组")).toBeInTheDocument();
    expect(screen.queryByLabelText("本组共享材料")).toBeNull();
    expect(screen.queryByText("共用下方材料作答")).toBeNull();
  });

  it("compare 分组呈现类：锚点 xl:contents 展开——组头跨两列、材料列占首列并跨本卷组题数（min-w-0 不溢出）", () => {
    render(
      <QuestionGroupAnchor
        group={groupOf({ materialRefs: [{ material: "m1" }] })}
        materials={[material("m1")]}
        questionCount={3}
      />,
    );
    const anchor = document.querySelector(
      '[data-slot="question-group-anchor"]',
    );
    expect(anchor?.className.includes("xl:contents")).toBe(true);
    const header = document.querySelector(
      '[data-slot="question-group-header"]',
    );
    expect(header?.className.includes("xl:col-span-2")).toBe(true);
    const materials = document.querySelector('[data-slot="group-materials"]');
    // 窄容器不变量：材料列 min-w-0（不撑出整页横向溢出）；首列 + 跨行数经
    // CSS 变量传入（消费侧单元 ol 的 compare 网格项）
    expect(materials?.className.includes("min-w-0")).toBe(true);
    expect(materials?.className.includes("xl:col-start-1")).toBe(true);
    expect(
      materials?.className.includes("xl:[grid-row:span_var(--qg-row-span)]"),
    ).toBe(true);
    expect(
      (materials as HTMLElement | null)?.style.getPropertyValue(
        "--qg-row-span",
      ),
    ).toBe("3");
    // 审查 P2-2：reveal 滚入目标让出粘性顶栏（与题卡/结果卡 scroll-mt 同款
    // 约定值；jsdom 测不出遮挡，静态判定类存在——组头是零材料组的回落目标）
    const scrollMargin =
      "scroll-mt-[calc(var(--attempt-header-height,64px)+16px)]";
    expect(materials?.className.includes(scrollMargin)).toBe(true);
    expect(header?.className.includes(scrollMargin)).toBe(true);
  });

  it("属性更新不换 DOM 实例（真实身份断言）：reveal 信号递增/材料增删前后组头与材料列节点 .toBe 保持", () => {
    // jsdom 无 scrollIntoView（reveal 信号触发的滚入用）
    Element.prototype.scrollIntoView = () => {};
    const group = groupOf({ materialRefs: [{ material: "m1" }] });
    const { rerender } = render(
      <QuestionGroupAnchor
        group={group}
        materials={[material("m1")]}
        readingKey="attempt-1|grp-1"
        revealSignal={1}
      />,
    );
    // rerender 前持有节点引用，后比身份（审查 P2-3：重查 contains 恒真，
    // 守不住不重挂不变量——真实形态是实例身份比较）
    const headerBefore = document.querySelector(
      '[data-slot="question-group-header"]',
    );
    const materialsBefore = document.querySelector(
      '[data-slot="group-materials"]',
    );
    rerender(
      <QuestionGroupAnchor
        group={group}
        materials={[material("m1"), material("m2")]}
        readingKey="attempt-1|grp-1"
        revealSignal={2}
      />,
    );
    expect(document.querySelector('[data-slot="question-group-header"]')).toBe(
      headerBefore,
    );
    expect(document.querySelector('[data-slot="group-materials"]')).toBe(
      materialsBefore,
    );
  });

  it("hidden 收起锚点不换实例；恢复后仍是同一节点（单题态仅隐藏不卸载）", () => {
    const group = groupOf();
    const { rerender } = render(
      <QuestionGroupAnchor group={group} materials={[]} hidden={false} />,
    );
    const anchor = document.querySelector(
      '[data-slot="question-group-anchor"]',
    );
    rerender(
      <QuestionGroupAnchor group={group} materials={[]} hidden={true} />,
    );
    expect(anchor?.hasAttribute("hidden")).toBe(true);
    // hidden 的 display:none 不被 xl:contents 抵消（锚点挂 non-contents 类）
    expect(anchor?.className.includes("xl:contents")).toBe(false);
    rerender(
      <QuestionGroupAnchor group={group} materials={[]} hidden={false} />,
    );
    expect(document.querySelector('[data-slot="question-group-anchor"]')).toBe(
      anchor,
    );
  });

  it("reveal 信号：材料列滚入 + 恢复会话内已读偏移 + 焦点落材料列", () => {
    const scrollIntoView = vi.fn();
    const scrollBy = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    window.scrollBy = scrollBy;
    const group = groupOf({ materialRefs: [{ material: "m1" }] });
    const materials = [material("m1")];
    const { rerender } = render(
      <QuestionGroupAnchor
        group={group}
        materials={materials}
        readingKey="attempt-1|grp-1"
        revealSignal={1}
      />,
    );
    expect(scrollIntoView).toHaveBeenCalled();
    // jsdom 无布局：stack 分支走 window.scrollBy（无已读偏移时不调用）
    expect(scrollBy).not.toHaveBeenCalled();
    const materialsColumn = document.querySelector(
      '[data-slot="group-materials"]',
    );
    expect(materialsColumn).toBe(document.activeElement);
    // 模拟已读偏移后再 reveal：恢复滚动
    rerender(
      <QuestionGroupAnchor
        group={group}
        materials={materials}
        readingKey="attempt-1|grp-1"
        revealSignal={2}
      />,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("memo 默认比较：相同属性不重渲染，信号/hidden 变化照常更新", () => {
    const group = groupOf();
    const { rerender } = render(
      <QuestionGroupAnchor group={group} materials={[]} hidden={false} />,
    );
    const before = document.querySelector(
      '[data-slot="question-group-anchor"]',
    );
    rerender(
      <QuestionGroupAnchor group={group} materials={[]} hidden={false} />,
    );
    // 同 props 保持同一 DOM 实例
    expect(document.querySelector('[data-slot="question-group-anchor"]')).toBe(
      before,
    );
    rerender(
      <QuestionGroupAnchor group={group} materials={[]} hidden={true} />,
    );
    expect(
      document
        .querySelector('[data-slot="question-group-anchor"]')
        ?.hasAttribute("hidden"),
    ).toBe(true);
  });
});

describe("material-reading-position（会话内阅读位置保留）", () => {
  it("记录/读取/非法值防御", async () => {
    const { materialReadingOffsetOf, noteMaterialReadingOffset } = await import(
      "./material-reading-position"
    );
    expect(materialReadingOffsetOf("attempt-1|grp-x")).toBe(0);
    noteMaterialReadingOffset("attempt-1|grp-x", 320);
    expect(materialReadingOffsetOf("attempt-1|grp-x")).toBe(320);
    noteMaterialReadingOffset("attempt-1|grp-x", -5);
    noteMaterialReadingOffset("attempt-1|grp-x", Number.NaN);
    expect(materialReadingOffsetOf("attempt-1|grp-x")).toBe(320);
  });
});

describe("MaterialPanel", () => {
  it("长表/公式内容正常渲染且作用域类存在（局部滚动 CSS 锚点）", () => {
    const content = [
      "统计表：",
      "",
      "| 年份 | 增长率 |",
      "| --- | --- |",
      "| 2024 | $8.2\\%$ |",
      "| 2025 | $9.1\\%$ |",
      "",
      "长正文 English mixed 中文。",
    ].join("\n");
    render(<MaterialPanel material={material("m1", { contentMd: content })} />);
    const scope = document.querySelector(".material-reading");
    expect(scope).not.toBeNull();
    expect(document.querySelector(".katex")).not.toBeNull();
    expect(scope?.textContent).toContain("2024");
    expect(scope?.textContent).toContain("English mixed 中文");
  });

  it("显式标题与缺省标题回退", () => {
    const { rerender } = render(
      <MaterialPanel material={material("m1", { title: "表 1" })} />,
    );
    expect(screen.getByText("表 1")).toBeInTheDocument();
    rerender(<MaterialPanel material={material("m2")} />);
    expect(screen.getByText("材料")).toBeInTheDocument();
  });
});

it("题组标题的公共条件渲染公式与强调，不显示 Markdown 定界符", () => {
  render(
    <QuestionGroupAnchor
      group={groupOf({
        title: "**已知数列** $a_{n+1}=2a_n+1$，回答两问。",
        label: "1–2",
      })}
      materials={[]}
      questionCount={2}
    />,
  );
  expect(document.querySelector("strong")).toHaveTextContent("已知数列");
  expect(document.querySelector(".katex")).not.toBeNull();
  expect(screen.getByText("1–2")).toBeInTheDocument();
});

describe("QuestionGroupAnchor 题组材料排版模式切换（左右分栏 vs 列表形式）", () => {
  it("提供 onLayoutModeChange 且有材料时，渲染排版单选按钮组并支持交互切换", () => {
    const onLayoutModeChange = vi.fn();
    render(
      <QuestionGroupAnchor
        group={groupOf({ materialRefs: [{ material: "m1" }] })}
        materials={[material("m1")]}
        layoutMode="split"
        onLayoutModeChange={onLayoutModeChange}
        onSplitRatioChange={vi.fn()}
      />,
    );
    const radioGroup = screen.getByRole("radiogroup", {
      name: "题组材料排版方式",
    });
    expect(radioGroup).toBeInTheDocument();

    const splitRadio = screen.getByRole("radio", { name: "左右分栏" });
    const stackRadio = screen.getByRole("radio", { name: "列表形式" });
    expect(splitRadio).toHaveAttribute("aria-checked", "true");
    expect(stackRadio).toHaveAttribute("aria-checked", "false");

    fireEvent.click(stackRadio);
    expect(onLayoutModeChange).toHaveBeenCalledWith("stack");
  });

  it("layoutMode 为 stack 时，锚点降级为普通流布局且不渲染中缝拖拽 Handle", () => {
    render(
      <QuestionGroupAnchor
        group={groupOf({ materialRefs: [{ material: "m1" }] })}
        materials={[material("m1")]}
        layoutMode="stack"
        onLayoutModeChange={vi.fn()}
        onSplitRatioChange={vi.fn()}
      />,
    );
    const anchor = document.querySelector(
      '[data-slot="question-group-anchor"]',
    );
    expect(anchor?.className.includes("xl:contents")).toBe(false);
    expect(anchor?.className.includes("lg:contents")).toBe(false);

    // 中缝 Handle 容器不渲染
    expect(
      document.querySelector('[data-slot="group-split-handle-container"]'),
    ).toBeNull();

    // 文案更新为材料在下方
    expect(screen.getByText("共用下方材料作答")).toBeInTheDocument();
  });

  it("排版单选组支持键盘方向键无障碍切换模式，且 split 模式下 header 恒跨满列", () => {
    const onLayoutModeChange = vi.fn();
    render(
      <QuestionGroupAnchor
        group={groupOf({ materialRefs: [{ material: "m1" }] })}
        materials={[material("m1")]}
        layoutMode="split"
        onLayoutModeChange={onLayoutModeChange}
        onSplitRatioChange={vi.fn()}
      />,
    );
    const radioGroup = screen.getByRole("radiogroup", {
      name: "题组材料排版方式",
    });
    fireEvent.keyDown(radioGroup, { key: "ArrowRight" });
    expect(onLayoutModeChange).toHaveBeenCalledWith("stack");

    fireEvent.keyDown(radioGroup, { key: "ArrowLeft" });
    expect(onLayoutModeChange).toHaveBeenCalledWith("split");

    const header = document.querySelector(
      '[data-slot="question-group-header"]',
    );
    expect(header?.className).toContain("lg:col-span-full");
    expect(header?.className).toContain("xl:col-span-full");
  });
});

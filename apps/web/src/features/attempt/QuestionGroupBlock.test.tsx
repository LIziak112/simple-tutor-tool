import { render, screen } from "@testing-library/react";
import type {
  AttemptContextGroup,
  AttemptContextMaterial,
} from "@tutor/contract";
import { describe, expect, it, vi } from "vitest";
import { AiCompareActiveContext } from "@/features/student-ai/ai-companion-layout";
import { MaterialPanel } from "./MaterialPanel";
import { QuestionGroupBlock } from "./QuestionGroupBlock";

/**
 * TT-08a / QM-08 组块与材料面板组件测试：
 * 结构语义（组头/材料/子题列）、宽窄布局与 AI 对照回退（纯 CSS 切换不重挂）、
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

describe("QuestionGroupBlock", () => {
  it("组头呈现标题/label/公共说明；材料经同一 markdown 管线渲染（公式 + 中文）", () => {
    render(
      <QuestionGroupBlock
        group={groupOf({
          title: "资料分析",
          label: "1～5",
          introMd: "阅读材料回答 **下列各题**。",
          materialRefs: [{ material: "m1" }],
        })}
        materials={[material("m1")]}
      >
        <p>子题占位</p>
      </QuestionGroupBlock>,
    );
    expect(screen.getByText("资料分析")).toBeInTheDocument();
    expect(screen.getByText("1～5")).toBeInTheDocument();
    expect(screen.getByText("下列各题")).toBeInTheDocument();
    expect(screen.getByText("子题占位")).toBeInTheDocument();
    const panel = screen.getByLabelText("共享材料");
    // 标题缺省回退「材料」（MaterialPanel 细项）；公式经 KaTeX 实渲染
    expect(document.querySelector(".katex")).not.toBeNull();
    expect(panel.textContent).toContain("材料 m1 正文");
  });

  it("标题缺省回退「题组」/「材料」；零材料组不渲染材料列与共用提示", () => {
    render(
      <QuestionGroupBlock group={groupOf()} materials={[]}>
        <p>子题占位</p>
      </QuestionGroupBlock>,
    );
    expect(screen.getByText("题组")).toBeInTheDocument();
    expect(screen.queryByLabelText("本组共享材料")).toBeNull();
    expect(screen.queryByText("共用下方材料作答")).toBeNull();
  });

  it("默认 compare 布局（xl 双栏 + 材料列 min-w-0）；AI 对照激活回退 stack", () => {
    const group = groupOf({ materialRefs: [{ material: "m1" }] });
    const materials = [material("m1")];
    const { rerender } = render(
      <QuestionGroupBlock group={group} materials={materials}>
        <p>子题占位</p>
      </QuestionGroupBlock>,
    );
    const body = document.querySelector('[data-slot="question-group-body"]');
    expect(body?.getAttribute("data-layout")).toBe("compare");
    expect(body?.className).toContain(
      "xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]",
    );
    // 窄容器不变量：双栏列与材料列都带 min-w-0（不撑出整页横向溢出）
    expect(
      document
        .querySelector('[data-slot="group-materials"]')
        ?.className.includes("min-w-0"),
    ).toBe(true);
    rerender(
      <AiCompareActiveContext.Provider value={true}>
        <QuestionGroupBlock group={group} materials={materials}>
          <p>子题占位</p>
        </QuestionGroupBlock>
      </AiCompareActiveContext.Provider>,
    );
    expect(
      document
        .querySelector('[data-slot="question-group-body"]')
        ?.getAttribute("data-layout"),
    ).toBe("stack");
    expect(
      document
        .querySelector('[data-slot="question-group-body"]')
        ?.className.includes("xl:grid-cols"),
    ).toBe(false);
  });

  it("布局切换（compare→stack）不重挂子树——子组件身份稳定（不重挂题面纪律）", () => {
    const group = groupOf({ materialRefs: [{ material: "m1" }] });
    const materials = [material("m1")];
    let renders = 0;
    function Probe() {
      renders += 1;
      return <p>子题占位</p>;
    }
    const { rerender } = render(
      <QuestionGroupBlock group={group} materials={materials}>
        <Probe />
      </QuestionGroupBlock>,
    );
    const initial = renders;
    rerender(
      <AiCompareActiveContext.Provider value={true}>
        <QuestionGroupBlock group={group} materials={materials}>
          <Probe />
        </QuestionGroupBlock>
      </AiCompareActiveContext.Provider>,
    );
    // data-layout 变化经 context 触发重渲染（子组件随父重渲染合法），
    // 但 children 元素身份不变——React 复用同一 DOM 节点
    const probe = screen.getByText("子题占位");
    expect(
      document.querySelector('[data-slot="group-questions"]')?.contains(probe),
    ).toBe(true);
    expect(renders).toBeGreaterThan(initial);
  });

  it("reveal 信号：材料列滚入 + 恢复会话内已读偏移 + 焦点落材料列", () => {
    const scrollIntoView = vi.fn();
    const scrollBy = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    window.scrollBy = scrollBy;
    const group = groupOf({ materialRefs: [{ material: "m1" }] });
    const materials = [material("m1")];
    const { rerender } = render(
      <QuestionGroupBlock
        group={group}
        materials={materials}
        readingKey="attempt-1|grp-1"
        revealSignal={1}
      >
        <p>子题占位</p>
      </QuestionGroupBlock>,
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
      <QuestionGroupBlock
        group={group}
        materials={materials}
        readingKey="attempt-1|grp-1"
        revealSignal={2}
      >
        <p>子题占位</p>
      </QuestionGroupBlock>,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("memo 默认比较：相同属性不重渲染，回调/信号变化照常更新", () => {
    const group = groupOf();
    const first = (
      <QuestionGroupBlock group={group} materials={[]} hidden={false}>
        <p>子题占位</p>
      </QuestionGroupBlock>
    );
    const { rerender } = render(first);
    const before = document.querySelector('[data-slot="question-group-block"]');
    rerender(
      <QuestionGroupBlock group={group} materials={[]} hidden={false}>
        <p>子题占位</p>
      </QuestionGroupBlock>,
    );
    // 同 props（children 同一元素字面量形态）保持同一 DOM 实例
    expect(document.querySelector('[data-slot="question-group-block"]')).toBe(
      before,
    );
    rerender(
      <QuestionGroupBlock group={group} materials={[]} hidden={true}>
        <p>子题占位</p>
      </QuestionGroupBlock>,
    );
    expect(
      document
        .querySelector('[data-slot="question-group-block"]')
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

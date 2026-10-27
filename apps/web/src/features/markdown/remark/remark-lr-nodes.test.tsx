import { render } from "@testing-library/react";
import { questionNodesOf } from "@tutor/md-dsl";
import { describe, expect, it } from "vitest";
import { RichMarkdown } from "../RichMarkdown";

/**
 * LR-5 parity 单测（LR-PR2）：渲染器打的 data-lr-node 键序列必须与
 * questionNodesOf 的题干块键序列完全一致（锚点跨「枚举 / 渲染」互认的前提，
 * 学习记录模型设计稿 §5.1/§5.2）。选项键（options/option/<n>）由
 * QuestionSurface 的 label 直打，不在本测试范围。
 */

const MD = [
  "先化简再计算：",
  "",
  "$$",
  "\\frac{1}{2} + \\frac{1}{3}",
  "$$",
  "",
  "## 二、判断",
  "",
  "- 列表项甲",
  "- 列表项乙",
  "",
  "```js",
  "let x = 1;",
  "```",
  "",
  "> 引用块内容",
  "",
  "把过程写在下方。",
].join("\n");

describe("remark-lr-nodes（LR-5 data-lr-node 打键）", () => {
  it("渲染键序列与 questionNodesOf 题干块键序列一致（含公式/标题/列表/代码/引用）", () => {
    const { container } = render(<RichMarkdown source={MD} lrNodes />);
    const domKeys = [...container.querySelectorAll("[data-lr-node]")].map(
      (el) => el.getAttribute("data-lr-node"),
    );
    const expected = questionNodesOf({ stemMd: MD })
      .filter((node) => node.key.startsWith("stem/"))
      .map((node) => node.key);
    expect(domKeys).toEqual(expected);
    // 抽查具体键：段落/公式块/列表项分别计数
    expect(domKeys).toContain("stem/p/0");
    expect(domKeys).toContain("stem/math-block/0");
    expect(domKeys).toContain("stem/list-item/0");
    expect(domKeys).toContain("stem/list-item/1");
    expect(domKeys).toContain("stem/other/0");
  });

  it("嵌套渲染不开启（缺省无键），显式开启才打键", () => {
    const { container } = render(<RichMarkdown source="只有一段。" />);
    expect(container.querySelector("[data-lr-node]")).toBeNull();
    const enabled = render(<RichMarkdown source="只有一段。" lrNodes />);
    expect(
      enabled.container.querySelector('[data-lr-node="stem/p/0"]'),
    ).not.toBeNull();
  });

  it("指令容器锚点透明：宿主不携带键，DOM 键恒为枚举键的子集", () => {
    const md = [
      "段落甲。",
      "",
      "::::hint",
      "折叠内容",
      "::::",
      "",
      "![配图](media/pic.png)",
      "",
      "段落乙。",
    ].join("\n");
    const { container } = render(<RichMarkdown source={md} lrNodes />);
    const domKeys = [...container.querySelectorAll("[data-lr-node]")].map(
      (el) => el.getAttribute("data-lr-node"),
    );
    const expected = questionNodesOf({ stemMd: md })
      .filter((node) => node.key.startsWith("stem/"))
      .map((node) => node.key);
    // 容器指令（::::hint）在枚举侧整体计 other/0，但宿主是自定义组件：
    // LR-5 守卫禁止教师属性经 hProperties 透传（防伪造键混进布局证据），
    // 宿主自身也不透传 data-* ——容器对锚点「透明」，其内部内容由
    // measureQuestionSurface 的最近带键祖先（surface root）兜底。
    expect(expected).toContain("stem/other/0");
    expect(domKeys).toEqual(expected.filter((key) => key !== "stem/other/0"));
  });
});

/**
 * fold 渲染探针（PR2 e2e 回归锁，评审 #11724 要求随 PR #24）：
 * data-lr-node 会经 sanitize 白名单存活进 readDirective 的 attrs——fold 等
 * container 指令的严格 attrs 校验曾因未知键降级为「未支持指令」。本用例锁定
 * 「开 LR 节点 + fold 容器 → title 按钮真实渲染」这条线（键序列 parity
 * 覆盖不到组件解析）。
 */
describe("fold 指令真实渲染探针（LR-5 回归锁）", () => {
  it("开 LR 节点：fold 渲染 title 按钮，不降级为未支持指令", async () => {
    const { render, screen } = await import("@testing-library/react");
    render(
      <RichMarkdown
        source={'阅读题干。\n\n:::fold{title="公开材料"}\n材料内容。\n:::'}
        lrNodes
      />,
    );
    expect(screen.queryByText("未支持指令：fold")).toBeNull();
    expect(screen.getByText("公开材料")).toBeTruthy();
  });

  it("对照：不开 LR 节点同样正常渲染（守卫不得误伤既有路径）", async () => {
    const { render, screen } = await import("@testing-library/react");
    render(
      <RichMarkdown
        source={'阅读题干。\n\n:::fold{title="公开材料"}\n材料内容。\n:::'}
      />,
    );
    expect(screen.queryByText("未支持指令：fold")).toBeNull();
    expect(screen.getByText("公开材料")).toBeTruthy();
  });
});

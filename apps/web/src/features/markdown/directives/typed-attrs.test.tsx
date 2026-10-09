import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderMd } from "../test-support/render-md";

/**
 * T7.2 宿主消费 Zod 属性解析（类型化 props）：
 * 查表命中后、传参前对业务 attrs 跑注册表 schema 的 safeParse——
 * - 缺省值由 schema 提供并传给组件（组件不再自行解析字符串/数字）；
 * - 非法属性（键合法但值非法、必填缺失、strict 拒绝的跨指令串用键）整体
 *   降级 UnknownDirective：正文保留、不抛错。
 * 全部用例走 RichMarkdown 全管线（parse → blank → 宿主 → katex → sanitize），
 * 与真实渲染同路径（sanitize 白名单先行，能到达渲染层的非法值都会遇到）。
 */

describe("T7.2 缺省值经注册表 schema 通道（组件不再自行解析）", () => {
  it("question 合法 type 缺 difficulty：难度徽章为缺省 2，题卡正常渲染", () => {
    const { container } = renderMd(
      '::::question{type=fill knowledge="有理数加法"}\n计算 $(-3)+7=$ [[4]]。\n::::',
    );
    expect(container.querySelector("[data-slot='question']")).not.toBeNull();
    expect(screen.getByRole("img", { name: "难度 2" })).toBeInTheDocument();
  });

  it('difficulty="3"（字符串数字）：coerce 为数字 3', () => {
    renderMd("::::question{type=judge difficulty=3}\n判断题干。\n::::");
    expect(screen.getByRole("img", { name: "难度 3" })).toBeInTheDocument();
  });

  it("step 缺 title：按顺序显示「第 1 步」", () => {
    renderMd("::::steps\n:::step\n先处理乘方，再算乘除。\n:::\n::::");
    expect(screen.getByText("第 1 步")).toBeInTheDocument();
  });

  it("step 带 title：显示标题本身，不再显示「第 1 步」", () => {
    renderMd(':::step{title="去括号"}\n先处理乘方，再算乘除。\n:::');
    expect(screen.getByText("去括号")).toBeInTheDocument();
    expect(screen.queryByText("第 1 步")).toBeNull();
  });

  it("mark 缺 color：yellow 高亮", () => {
    const { container } = renderMd("句子里的 :mark[关键词] 高亮。");
    const mark = container.querySelector("mark");
    expect(mark).not.toBeNull();
    expect(mark?.className).toContain("bg-yellow-200");
  });

  it("mark color=red：红色高亮", () => {
    const { container } = renderMd("注意 :mark[系数的符号]{color=red}。");
    const mark = container.querySelector("mark");
    expect(mark).not.toBeNull();
    expect(mark?.className).toContain("bg-red-200");
  });
});

describe("T7.2 非法属性降级（UnknownDirective，正文完整，不抛错）", () => {
  it("question difficulty=abc：整题降级，题干正文保留", () => {
    const { container } = renderMd(
      "::::question{type=judge difficulty=abc}\n判断题正文必须保留。\n::::",
    );
    expect(container.querySelector("[data-slot='question']")).toBeNull();
    expect(container).toHaveTextContent("判断题正文必须保留。");
    expect(container).toHaveTextContent("未支持指令：question");
  });

  it("mark color=purple：行内降级且文字保留", () => {
    const { container } = renderMd("这里的 :mark[重点]{color=purple} 保留。");
    expect(container.querySelector("mark")).toBeNull();
    expect(container).toHaveTextContent("重点");
    expect(container).toHaveTextContent("未支持指令：mark");
  });

  it("graph 缺必填 fn：降级而非渲染缺参占位", () => {
    const { container } = renderMd('::graph{range="-3,3"}');
    expect(container.querySelector("[data-slot='graph']")).toBeNull();
    expect(container).not.toHaveTextContent("缺少 fn 属性");
    expect(container).toHaveTextContent("未支持指令：graph");
  });

  it("image 缺必填 src：降级而非渲染路径缺失占位", () => {
    const { container } = renderMd('::image{alt="示意图"}');
    expect(container.querySelector("img")).toBeNull();
    expect(container).not.toHaveTextContent("图片路径缺失");
    expect(container).toHaveTextContent("未支持指令：image");
  });

  it("白名单键跨指令串用（:::hint{color=red}）：strict 拒绝，正文未经点击即完整可见", () => {
    const { container } = renderMd(":::hint{color=red}\n提示正文保留。\n:::");
    // 正常 hint 是折叠块：内容默认不在 DOM。降级后 UnknownDirective 直出正文。
    expect(container).toHaveTextContent("提示正文保留。");
    expect(container).toHaveTextContent("未支持指令：hint");
  });
});

describe("T7.2 合法语义回归（抽样）", () => {
  it("image 合法属性：src 归一化、alt、width 样式不变", () => {
    const { container } = renderMd(
      '::image{src="blobs/media/9af3.png" alt="数轴" width="60%"}',
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("/blobs/media/9af3.png");
    expect(img?.getAttribute("alt")).toBe("数轴");
    expect(img?.style.width).toBe("60%");
  });

  it("box 的 .warning 样式类变体与 title 不变", () => {
    const { container } = renderMd(
      ':::box{.warning title="易错点"}\n除法不满足结合律。\n:::',
    );
    const callout = container.querySelector("[data-slot='callout']");
    expect(callout).not.toBeNull();
    expect(callout?.className).toContain("border-amber-400");
    expect(screen.getByText("易错点")).toBeInTheDocument();
  });

  it("fold 缺 title：折叠标签为缺省「详情」", () => {
    renderMd(":::fold\n折叠内容。\n:::");
    expect(screen.getByText("详情")).toBeInTheDocument();
  });
});

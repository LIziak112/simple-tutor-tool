import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  DirectiveContainerHost,
  DirectiveLeafHost,
  DirectiveTextHost,
} from "./directives";
import { renderMd } from "./test-support/render-md";

/**
 * RichMarkdown 组件测试（T1.8 验收项）：
 * 公式渲染、填空空框、选择题任务列表、fold 折叠、steps 逐步揭晓、
 * hint/answer/solution 预览折叠、题卡编号、未知指令降级、XSS 防护。
 */

describe("RichMarkdown：公式渲染（KaTeX）", () => {
  it("行内与块级公式渲染为 KaTeX 输出，而不是原始 $…$ 文本", () => {
    const { container } = renderMd(
      "行内公式 $x^2+1$ 与块级公式：\n\n$$E=mc^2$$",
    );
    const katexNodes = container.querySelectorAll(".katex");
    expect(katexNodes.length).toBe(2);
    // 原始定界符不应以文本形式残留在页面上
    expect(container.textContent).not.toContain("$x^2");
    expect(container.textContent).not.toContain("$$E=mc^2$$");
  });

  it("KaTeX 输出经过 sanitize 后仍保留排版所需的 class 与内联 style（strut）", () => {
    const { container } = renderMd("分数 $\\frac{1}{2}$");
    const katex = container.querySelector(".katex");
    expect(katex).not.toBeNull();
    // strut 靠内联 style 控制行高/垂直对齐，被剥掉说明 sanitize 误伤 KaTeX
    const strut = container.querySelector(".strut");
    expect(strut).not.toBeNull();
    expect(strut?.getAttribute("style")).toContain("height");
  });

  it("KaTeX 渲染输出的字号类与所导入的 katex CSS 选择器一致（版本错配回归）", () => {
    // rehype-katex 自带的 katex 生成 HTML（含 sizing/katex-sizing 等字号类），
    // RichMarkdown 顶部 import 的 katex.min.css 提供对应选择器。两者若解析到
    // 不同大版本的 katex 包（曾出现 0.16 渲染 + 0.18 CSS：0.18 把 .sizing 改名
    // .katex-sizing），选择器对不上，上下标字号不缩小——jsdom 不应用 CSS，
    // 只能显式比对「渲染输出的类名」与「CSS 里的选择器」两边口径一致。
    const { container } = renderMd("$m_{30,30}$");
    const subEl = Array.from(
      container.querySelectorAll<HTMLElement>(".msupsub span"),
    ).find(
      (el) =>
        el.className.includes("reset-size6") && el.className.includes("size3"),
    );
    expect(subEl, "下标内容应带 reset-size6 size3 字号类").toBeDefined();
    const sizingToken = subEl?.className
      .split(/\s+/)
      .find((token) => token === "sizing" || token === "katex-sizing");
    expect(sizingToken, "字号容器类应为 sizing 或 katex-sizing").toBeDefined();
    // 从本文件解析 katex 包（与 RichMarkdown 的 css 导入同一实例）读 CSS
    const cssPath = createRequire(import.meta.url).resolve(
      "katex/dist/katex.min.css",
    );
    const css = readFileSync(cssPath, "utf-8");
    expect(
      css,
      "导入的 katex CSS 应包含渲染输出字号类的选择器（渲染 JS 与 CSS 版本错配）",
    ).toContain(`.katex .${sizingToken}.reset-size6.size3`);
  });
});

describe("RichMarkdown：填空标记 [[…]]", () => {
  it("[[答案]] 渲染为空填空框，答案文本不出现在页面上", () => {
    const { container } = renderMd("计算：$(-3)+7=$ [[4]]。");
    const blanks = container.querySelectorAll('[data-testid="blank"]');
    expect(blanks.length).toBe(1);
    expect(screen.queryByText(/(^|\s)4(\s|。|$)/)).toBeNull();
    expect(container.textContent).not.toContain("[[4]]");
  });

  it("等价答案 [[0.5|1/2]] 渲染为一个空框，两种答案文本均不显示", () => {
    const { container } = renderMd("写等价形式：[[0.5|1/2]]");
    expect(container.querySelectorAll('[data-testid="blank"]').length).toBe(1);
    expect(container.textContent).not.toContain("0.5");
    expect(container.textContent).not.toContain("1/2");
  });

  it("$…$ 数学环境内的 [[…]] 不识别为填空（与 md-dsl 解析器规则一致）", () => {
    const { container } = renderMd("记号 $a_{[[1]]}$ 与作答空位 [[2]]。");
    expect(container.querySelectorAll('[data-testid="blank"]').length).toBe(1);
    // 数学环境内的标记按原文保留在 KaTeX 注释里，而不是被吃掉
    expect(container.textContent).toContain("[[1]]");
  });
});

describe("RichMarkdown：选择题任务列表", () => {
  it("- [ ] / - [x] 渲染为复选框，正确项被勾选", () => {
    const { container } = renderMd(
      "下列正确的是（　）\n\n- [ ] 甲：$-5$\n- [x] 乙：$5$\n- [ ] 丙：$\\frac{1}{5}$",
    );
    const boxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(boxes.length).toBe(3);
    expect(boxes.filter((b) => b.checked).length).toBe(1);
    expect(screen.getByText(/乙/)).toBeInTheDocument();
  });
});

describe("RichMarkdown：fold 折叠", () => {
  it("默认收起，点击标题后展开内容", () => {
    renderMd(':::fold{title="拓展阅读"}\n内部内容ABC\n:::');
    const trigger = screen.getByRole("button", { name: /拓展阅读/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("内部内容ABC")).toBeNull();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("内部内容ABC")).toBeInTheDocument();
  });
});

describe("RichMarkdown：steps 逐步揭晓", () => {
  it("第一步默认可见，点“显示下一步”逐步展开，全部展开后按钮消失", () => {
    renderMd(
      [
        "::::steps",
        ':::step{title="第 1 步：去括号"}',
        "内容一",
        ":::",
        ":::step",
        "内容二",
        ":::",
        ":::step",
        "内容三",
        ":::",
        "::::",
      ].join("\n"),
    );
    expect(screen.getByText("内容一")).toBeInTheDocument();
    expect(screen.queryByText("内容二")).toBeNull();
    expect(screen.queryByText("内容三")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /显示下一步/ }));
    expect(screen.getByText("内容二")).toBeInTheDocument();
    // 无 title 的 step 揭晓后按顺序显示“第 N 步”（标题行含序号徽章，用正则匹配）
    expect(screen.getByText(/第 2 步/)).toBeInTheDocument();
    expect(screen.queryByText("内容三")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /显示下一步/ }));
    expect(screen.getByText("内容三")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /显示下一步/ })).toBeNull();
  });
});

describe("RichMarkdown：题目结构（question/hint/answer/solution）", () => {
  const questionSource = [
    '::::question{type=fill difficulty=3 knowledge="有理数加法"}',
    "题干：计算 $(-3)+7=$ [[4]]。",
    "",
    ":::hint",
    "提示内容H",
    ":::",
    "",
    ":::answer",
    "-3",
    ":::",
    "",
    ":::solution",
    "详解内容S",
    ":::",
    "::::",
  ].join("\n");

  it("题卡带题号与题型标签，题目按文档顺序编号", () => {
    renderMd(
      `${questionSource}\n\n${questionSource.replace("[[4]]", "[[5]]")}`,
    );
    expect(screen.getByText("第 1 题")).toBeInTheDocument();
    expect(screen.getByText("第 2 题")).toBeInTheDocument();
    expect(screen.getAllByText("填空题").length).toBe(2);
  });

  it("hint/answer/solution 默认折叠且带标签，展开后可见内容", () => {
    renderMd(questionSource);
    const hintTrigger = screen.getByRole("button", { name: "提示 1" });
    const answerTrigger = screen.getByRole("button", { name: "最终答案" });
    const solutionTrigger = screen.getByRole("button", { name: "详解" });
    // 折叠时教师侧内容（答案/详解/提示）不可见
    expect(screen.queryByText("提示内容H")).toBeNull();
    expect(screen.queryByText("-3")).toBeNull();
    expect(screen.queryByText("详解内容S")).toBeNull();
    fireEvent.click(hintTrigger);
    fireEvent.click(answerTrigger);
    fireEvent.click(solutionTrigger);
    expect(screen.getByText("提示内容H")).toBeInTheDocument();
    expect(screen.getByText("-3")).toBeInTheDocument();
    expect(screen.getByText("详解内容S")).toBeInTheDocument();
  });

  it("难度与考点显示在题卡上", () => {
    renderMd(questionSource);
    expect(screen.getByText("考点：有理数加法")).toBeInTheDocument();
    expect(screen.getByLabelText("难度 3")).toBeInTheDocument();
  });
});

describe("RichMarkdown：版式与强调指令", () => {
  it("tip/warning/box 渲染标题与内容", () => {
    renderMd(
      [
        ':::tip{title="小技巧"}',
        "先通分。",
        ":::",
        ':::warning{title="易错点"}',
        "符号别丢。",
        ":::",
        ':::box{.warning title="注意盒"}',
        "盒子内容。",
        ":::",
      ].join("\n"),
    );
    expect(screen.getByText("小技巧")).toBeInTheDocument();
    expect(screen.getByText("先通分。")).toBeInTheDocument();
    expect(screen.getByText("易错点")).toBeInTheDocument();
    expect(screen.getByText("注意盒")).toBeInTheDocument();
    expect(screen.getByText("盒子内容。")).toBeInTheDocument();
  });

  it(":mark[…]{color=red} 渲染为行内高亮", () => {
    const { container } = renderMd(
      "注意 :mark[系数的符号]{color=red} 不能丢。",
    );
    const marked = container.querySelector("mark");
    expect(marked).not.toBeNull();
    expect(marked?.textContent).toBe("系数的符号");
    expect(marked?.className).toContain("red");
  });

  it("columns/col 分栏渲染，两栏内容都可见", () => {
    const { container } = renderMd(
      [
        "::::columns",
        ':::col{width="40%"}',
        "左栏内容。",
        ":::",
        ":::col",
        "右栏内容。",
        ":::",
        "::::",
      ].join("\n"),
    );
    const columns = container.querySelector("[data-slot='columns']");
    expect(columns).not.toBeNull();
    expect(screen.getByText("左栏内容。")).toBeInTheDocument();
    expect(screen.getByText("右栏内容。")).toBeInTheDocument();
  });

  it("::image 渲染本地图片：blobs/ 前缀归一化为根相对路径并应用宽度", () => {
    const { container } = renderMd(
      '::image{src="blobs/fig-1.png" width="60%"}',
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    // 服务端不变量：契约 src 前加 / 即根相对伺服 URL
    expect(img?.getAttribute("src")).toBe("/blobs/fig-1.png");
    expect(img).toHaveStyle({ width: "60%" });
  });

  it("::image alt 透传（缺省「图片」），http(s) 绝对 URL 原样渲染", () => {
    const { container } = renderMd(
      [
        '::image{src="https://example.com/fig.png" alt="直角三角形图示"}',
        "",
        '::image{src="blobs/media/0000000000000000000000000000000000000000000000000000000000000000.png"}',
      ].join("\n"),
    );
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toHaveAttribute("src", "https://example.com/fig.png");
    expect(imgs[0]).toHaveAttribute("alt", "直角三角形图示");
    expect(imgs[1]).toHaveAttribute("alt", "图片");
  });

  it("::image 加载失败切入占位（不裂图），并提示检查 src 是否已上传", () => {
    const { container } = renderMd('::image{src="blobs/fig-1.png"}');
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("图片加载失败");
    expect(alert).toHaveTextContent("blobs/fig-1.png");
    // 失败后不再渲染 <img> 本体（不用浏览器裂图）
    expect(container.querySelector("img")).toBeNull();
  });

  it("::graph 渲染图像容器而不崩溃", () => {
    const { container } = renderMd('::graph{fn="x^2" range="-3,3"}');
    expect(container.querySelector("[data-slot='graph']")).not.toBeNull();
  });
});

describe("RichMarkdown：未知指令降级（§5.1.1(3)）", () => {
  describe.each([
    ["容器", DirectiveContainerHost],
    ["块", DirectiveLeafHost],
    ["行内", DirectiveTextHost],
  ] as const)("%s宿主", (_label, Host) => {
    it.each(["constructor", "toString", "__proto__"])(
      "未注册的原型名称 %s 降级且保留正文",
      (name) => {
        // __proto__ 不被 remark-directive 识别，直接测宿主避免把普通文本当成降级。
        const { container } = render(
          <Host node={{ properties: { directive: name } }}>
            <strong>正文必须保留</strong>
          </Host>,
        );
        expect(container.querySelector("strong")).toHaveTextContent(
          "正文必须保留",
        );
        expect(container).toHaveTextContent(`未支持指令：${name}`);
      },
    );
  });

  it.each(["constructor", "toString"])(
    "原型名称 %s 在完整 Markdown 管线的三种写法中均降级",
    (name) => {
      const { container } = renderMd(
        `:::${name}\n容器正文\n:::\n\n::${name}[块正文]\n\n句中 :${name}[行内正文]。`,
      );
      expect(container).toHaveTextContent("容器正文");
      expect(container).toHaveTextContent("块正文");
      expect(container).toHaveTextContent("行内正文");
      expect(
        screen.getAllByText(new RegExp(`未支持指令：${name}`)),
      ).toHaveLength(3);
    },
  );

  it("未知容器指令显示内部文字与“未支持指令”标注，不崩溃", () => {
    renderMd(':::mystery{title="x"}\n内部文字XYZ\n:::');
    expect(screen.getByText("内部文字XYZ")).toBeInTheDocument();
    expect(screen.getByText("未支持指令：mystery")).toBeInTheDocument();
  });

  it("未知块指令与行内指令同样降级显示其文字", () => {
    renderMd("::hints[先想想法则]\n\n句子里的 :magic[重点] 词。");
    expect(screen.getByText("先想想法则")).toBeInTheDocument();
    expect(screen.getByText("重点")).toBeInTheDocument();
  });
});

describe("RichMarkdown：XSS 防护（rehype-sanitize）", () => {
  it.each([
    "javascript:alert(1)",
    "vbscript:msgbox(1)",
    "data:image/png;base64,AAAA",
  ])("自动推导白名单后，图片危险协议 %s 仍被剥除", (src) => {
    const { container } = renderMd(`::image{src="${src}"}\n\n正文保留。`);
    expect(container.querySelector("img")).toBeNull();
    // T7.2：危险协议被 sanitize 剥除后 src 缺失，注册表 schema 判必填
    // 缺失 → 整体降级 UnknownDirective（比占位提示更强的失败关闭）
    expect(container).toHaveTextContent("未支持指令：image");
    expect(container).toHaveTextContent("正文保留。");
  });

  it("schema 的 id/class 键不会改变既有锚点与样式类通道", () => {
    const { container } = renderMd(
      ':::box{#toc-id .warning title="提示盒"}\n正文\n:::',
    );
    expect(container.querySelector("[id]")).toBeNull();
    expect(container.querySelector("[data-slot='callout']")).toHaveClass(
      "border-amber-400",
    );
    expect(container).toHaveTextContent("提示盒");
    expect(container).toHaveTextContent("正文");
  });

  it("<script> 与 <img onerror> 不进入 DOM，javascript: 链接被清除", () => {
    const { container } = renderMd(
      [
        "<script>alert(1)</script>",
        "",
        '<img src="x" onerror="alert(2)" />',
        "",
        "[点我](javascript:alert(3))",
        "",
        "正常文字保留。",
      ].join("\n"),
    );
    // script 元素不存在，alert 文本也不残留
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("alert");
    // 原始 HTML（含 onerror 的 img）被整体丢弃
    expect(container.querySelector("img")).toBeNull();
    // javascript: 协议链接被清除（a 标签若保留则不带危险 href）
    const links = container.querySelectorAll("a");
    for (const link of links) {
      expect(link.getAttribute("href") ?? "").not.toContain("javascript");
    }
    expect(screen.getByText("正常文字保留。")).toBeInTheDocument();
  });

  it("指令属性中的危险值不会成为可执行内容（onerror 等属性被剥除）", () => {
    const { container } = renderMd(
      ':::tip{title="t"}\n内容\n:::\n\n::image{src="x" onerror="alert(9)"}',
    );
    expect(screen.getByText("内容")).toBeInTheDocument();
    const img = container.querySelector("img");
    if (img) {
      expect(img.getAttribute("onerror")).toBeNull();
    }
    expect(container.querySelector("script")).toBeNull();
  });
});

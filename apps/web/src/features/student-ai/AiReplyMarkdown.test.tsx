import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AiReplyMarkdown } from "./AiReplyMarkdown";
import {
  AI_REPLY_MAX_FORMULA_CHARS,
  AI_REPLY_RENDER_MAX_BYTES,
  AI_REPLY_RENDER_MAX_NODES,
} from "./ai-reply-security";

/**
 * SAI-21 先测③：AI 回复专用受限渲染——XSS/危险 URL/远程像素/交互
 * directive/超大公式不执行、不阻塞题面；超限给可解释失败。
 * 复用既有 Markdown/KaTeX 管线（rich-markdown 排版与 KaTeX 白名单单源），
 * 但不放行指令宿主、图片与任意协议链接；普通 Markdown 交互语义不受影响
 * （后者由 RichMarkdown 既有测试族锁定，见完成条件 2）。
 */

describe("AiReplyMarkdown 受限渲染（SAI-21 先测③）", () => {
  it("正常 Markdown（列表/粗体/行内与块级公式）照常渲染，公式走 KaTeX", () => {
    const { container } = render(
      <AiReplyMarkdown
        source={
          "- 第一步：移项\n- 第二步：代入\n\n设 $x+1=2$，则 $x=1$。\n\n$$\\frac{1}{2}$$"
        }
      />,
    );
    expect(container.querySelectorAll("li").length).toBe(2);
    expect(container.querySelectorAll(".katex").length).toBe(3);
    expect(container.querySelector(".katex-error")).toBeNull();
  });

  it("原始 HTML 脚本不执行：script/onerror 均不进入 DOM，无 alert 调用", () => {
    const alert = vi.fn();
    vi.stubGlobal("alert", alert);
    const { container } = render(
      <AiReplyMarkdown
        source={
          '正常内容\n\n<script>alert("xss")</script>\n\n<img src=x onerror=alert(1)>\n\n结尾内容'
        }
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(container.textContent).toContain("正常内容");
    expect(container.textContent).toContain("结尾内容");
    expect(alert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("危险协议链接不可点击：javascript:/data: 降级为普通文字（无 a[href]）", () => {
    const { container } = render(
      <AiReplyMarkdown
        source={
          "[点我](javascript:alert(1)) 以及 [数据](data:text/html,<script>)"
        }
      />,
    );
    // 清洗层丢弃协议 → 无任何可点击链接，文字保留可读
    expect(container.querySelectorAll("a[href]")).toHaveLength(0);
    expect(container.textContent).toContain("点我");
    expect(container.textContent).toContain("数据");
  });

  it("安全外链保留并可点击（noopener 防反向标签页劫持）", () => {
    const { container } = render(
      <AiReplyMarkdown source={"[参考资料](https://example.com/docs)"} />,
    );
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/docs");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });

  it("远程像素不发出网络请求：Markdown 图片替换为占位说明，无 img 节点", () => {
    const { container } = render(
      <AiReplyMarkdown
        source={"![追踪像素](https://tracker.example/pixel.png)\n\n正文继续"}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    // 零加载面补强：无 srcset、无内联 style 的 url() 背景加载通道
    expect(container.querySelector("[srcset]")).toBeNull();
    expect(container.querySelector("[style*='url(']")).toBeNull();
    expect(container.textContent).toContain("图片不显示");
    expect(container.textContent).toContain("正文继续");
  });

  it("协议变体不绕过：大小写/制表符/HTML 实体编码的 javascript 均降级为普通文字", () => {
    const { container } = render(
      <AiReplyMarkdown
        source={
          "[大小写](JaVaScRiPt:alert(1)) 与 [制表符](java\tscript:alert(1)) 与 [实体](&#9;javascript:alert(1))"
        }
      />,
    );
    // 清洗层按「首个冒号前的完整片段」提协议比对（空白不剥离）——三种
    // 变体提取到的协议串都不在 http/https/mailto 白名单，href 全部丢弃
    expect(container.querySelectorAll("a[href]")).toHaveLength(0);
    expect(container.textContent).toContain("大小写");
    expect(container.textContent).toContain("制表符");
    expect(container.textContent).toContain("实体");
  });

  it("KaTeX 危险命令不执行：\\href/\\includegraphics 不产链接与图片加载（trust 未开）", () => {
    const { container } = render(
      <AiReplyMarkdown
        source={
          "$\\href{https://evil.example}{点我}$ 与 $\\includegraphics[width=1em]{https://evil.example/x.png}$"
        }
      />,
    );
    // KaTeX 默认 trust=false：\href/\includegraphics 按未知/禁用命令渲染
    // 为错误文本，不产出任何 anchor / img / 外链属性
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[src]")).toBeNull();
    // xlink:href 属性名含冒号，非法 CSS 属性选择器——按属性名扫描断言更全
    const xlink = Array.from(container.querySelectorAll("*")).filter((el) =>
      Array.from(el.attributes).some((attr) => attr.name.includes("xlink")),
    );
    expect(xlink).toHaveLength(0);
  });

  it("原始 HTML 注入面全丢弃：svg onload/form/iframe/details ontoggle 不进 DOM", () => {
    const { container } = render(
      <AiReplyMarkdown
        source={
          '<svg onload="alert(1)"><path d="M0,0"/></svg>\n\n<form action="https://evil.example"><input type="text"></form>\n\n<iframe src="https://evil.example"></iframe>\n\n<details open ontoggle="alert(1)">内容</details>'
        }
      />,
    );
    // 白名单里的 svg 仅服务 KaTeX 公式输出；raw HTML 在 remark-rehype 阶段
    // 即被丢弃（未开 allowDangerousHtml），sanitize 是第二层纵深防御
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("[ontoggle]")).toBeNull();
    expect(container.querySelector("[onload]")).toBeNull();
    expect(container.querySelectorAll("input").length).toBe(0);
  });

  it("GFM autolink 走同一清洗：https 裸链成链并带 noopener，危险裸文本不成链", () => {
    const { container } = render(
      <AiReplyMarkdown
        source={"访问 https://example.com/page 看看\n\njavascript:alert(1) 只是文字"}
      />,
    );
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1); // javascript: 裸文本不被 autolink（GFM 只识别 http(s)/www/mailto）
    expect(links[0]?.getAttribute("href")).toBe("https://example.com/page");
    expect(links[0]?.getAttribute("rel")).toContain("noopener");
  });

  it("交互 directive 不执行：渲染为普通文本，无指令宿主/交互组件", () => {
    const { container } = render(
      <AiReplyMarkdown
        source={':::steps\n第一步…\n:::\n\n::graph{src="evil.js"}\n\n[[填空]]'}
      />,
    );
    expect(container.querySelector("directive-container")).toBeNull();
    expect(container.querySelector("directive-leaf")).toBeNull();
    expect(container.querySelector("directive-text")).toBeNull();
    // DSL 指令按普通文本呈现（学生可见原文，不是可执行块）
    expect(container.textContent).toContain(":::steps");
    expect(container.textContent).toContain('::graph{src="evil.js"}');
    expect(container.textContent).toContain("[[填空]]");
  });

  it("超大公式给可解释失败，不抛错不渲染公式（不阻塞题面）", () => {
    const big = `x=${"1+".repeat(Math.ceil(AI_REPLY_MAX_FORMULA_CHARS / 2))}1`;
    const { container } = render(
      <AiReplyMarkdown source={`先看结论。\n\n$${big}$`} />,
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("过长公式");
    // 失败提示之外组件不崩溃，题面（兄弟内容）不受影响
    expect(container.textContent).not.toContain("先看结论。"); // 整体替换为失败说明
  });

  it("字节超限给可解释失败：不进入解析管线", () => {
    const huge = "a".repeat(AI_REPLY_RENDER_MAX_BYTES + 1);
    const { container } = render(<AiReplyMarkdown source={huge} />);
    expect(screen.getByRole("alert").textContent).toContain("过长");
    expect(container.querySelectorAll("p").length).toBe(1);
  });

  it("节点超限给可解释失败：海量列表不进入渲染", () => {
    const many = Array.from(
      { length: Math.ceil(AI_REPLY_RENDER_MAX_NODES / 2) },
      (_, index) => `- 项目 ${index}`,
    ).join("\n");
    const { container } = render(<AiReplyMarkdown source={many} />);
    expect(screen.getByRole("alert").textContent).toContain("过多");
    expect(container.querySelectorAll("li").length).toBe(0);
  });
});

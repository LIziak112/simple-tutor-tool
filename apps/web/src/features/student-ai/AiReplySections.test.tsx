import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AiReplyMarkdown } from "./AiReplyMarkdown";

it("点击分节原地展开，首节默认展开，全文链接定义与公式保留", () => {
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  const { container } = render(
    <AiReplyMarkdown
      source={
        "# 总标题\n\n引言\n\n## 先观察\n第一段\n\n### 小提示\n保留子标题\n\n## 再计算\n$1+1=2$ 与 [参考][ref]\n\n[ref]: https://example.com"
      }
    />,
  );
  const sections = container.querySelectorAll("details[data-ai-section]");
  expect(sections).toHaveLength(2);
  expect(sections[0]).toHaveAttribute("open");
  expect(sections[1]).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText("再计算"));
  expect(sections[1]).toHaveAttribute("open");
  expect(screen.getByRole("link", { name: "参考" })).toHaveAttribute(
    "href",
    "https://example.com",
  );
  expect(container.querySelector(".katex")).not.toBeNull();
  expect(screen.getByText("引言")).toBeVisible();
  expect(scroll).not.toHaveBeenCalled();
});

it("代码和引用里的标题不分节，无标题全文可读", () => {
  const { container } = render(
    <AiReplyMarkdown
      source={"正文\n\n```md\n## 代码标题\n```\n\n> ## 引用标题\n\n结尾"}
    />,
  );
  expect(container.querySelector("details[data-ai-section]")).toBeNull();
  expect(screen.getByText("结尾")).toBeVisible();
});

it("重复标题独立展开，展开全部与收起其余保留第一节", () => {
  const { container } = render(
    <AiReplyMarkdown source={"## 同名\n一\n\n## 同名\n二\n\n## 末节\n三"} />,
  );
  const sections = container.querySelectorAll("details[data-ai-section]");
  expect(new Set(Array.from(sections, (s) => s.id)).size).toBe(3);
  fireEvent.click(screen.getByRole("button", { name: "展开全部" }));
  expect(container.querySelectorAll("details[open]")).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "收起其余" }));
  expect(container.querySelectorAll("details[open]")).toHaveLength(1);
});

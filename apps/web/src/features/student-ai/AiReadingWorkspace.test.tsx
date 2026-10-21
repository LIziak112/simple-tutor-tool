import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AiReadingWorkspace } from "./AiReadingWorkspace";

function Harness() {
  const [text, setText] = useState("保留我的追问");
  return (
    <>
      <article data-testid="paper">原纸面</article>
      <AiReadingWorkspace>
        <div className="ai-reply-markdown">
          <h2>先试一步</h2>
          <p>先观察已知条件</p>
          <h3>检查方向</h3>
        </div>
        <label>
          追问
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
      </AiReadingWorkspace>
    </>
  );
}

describe("专注阅读", () => {
  it("只挂载一份正文与输入，退出恢复焦点和编辑内容，纸面节点不变", async () => {
    render(<Harness />);
    const paper = screen.getByTestId("paper");
    const entry = screen.getByRole("button", { name: "专注阅读" });
    fireEvent.click(entry);
    const dialog = await screen.findByRole("dialog");
    expect(screen.getAllByRole("textbox", { hidden: true })).toHaveLength(1);
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "新增疑问" },
    });
    expect(
      await within(dialog).findByRole("button", { name: "回复目录 · 2 节" }),
    ).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭弹层" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("textbox")).toHaveValue("新增疑问");
    expect(entry).toHaveFocus();
    expect(screen.getByTestId("paper")).toBe(paper);
  });
  it("目录只来源于真实标题，重复标题仍有不同定位", async () => {
    const { container } = render(
      <AiReadingWorkspace>
        <div className="ai-reply-markdown">
          <h2>重复</h2>
          <h2>重复</h2>
        </div>
      </AiReadingWorkspace>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "回复目录 · 2 节" }),
    );
    expect(
      screen
        .getByRole("navigation", { name: "回复目录" })
        .querySelectorAll("button"),
    ).toHaveLength(2);
    const headings = container.querySelectorAll("h2");
    expect(headings[0]?.id).not.toBe(headings[1]?.id);
  });
  it("目录可展开收起，跳转避让实际顶栏并把焦点交给目标标题", async () => {
    render(<Harness />);
    const toggle = await screen.findByRole("button", {
      name: "回复目录 · 2 节",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("navigation", { name: "回复目录" })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const heading = screen.getByRole("heading", { name: "检查方向" });
    heading.scrollIntoView = vi.fn();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "回复目录" })).getByRole(
        "button",
        { name: "检查方向" },
      ),
    );
    expect(heading.style.scrollMarginTop).toBe(
      "calc(var(--attempt-header-height, 64px) + 16px)",
    );
    expect(heading.scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "instant",
    });
    expect(heading).toHaveFocus();
    fireEvent.click(toggle);
    expect(screen.queryByRole("navigation", { name: "回复目录" })).toBeNull();
  });
  it("专注阅读的标题只避让弹层内边距，不继承作答顶栏高度", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "专注阅读" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(
        within(dialog).getByRole("heading", { name: "检查方向" }).style
          .scrollMarginTop,
      ).toBe("1rem"),
    );
  });
});

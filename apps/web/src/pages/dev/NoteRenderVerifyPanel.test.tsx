import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoteRenderVerifyPanel } from "@/pages/dev/NoteRenderVerifyPanel";

/**
 * 渲染验证面板冒烟测试（T6R.6）：jsdom 无 2d canvas，九项检查必然全部
 * 失败——冒烟确认：面板可挂载、按钮可触发、失败行带错误文案呈现（不崩溃、
 * 不静默吞错）。像素级真实检查在 Playwright E2E（e2e/note-render.spec.ts）。
 */
describe("<NoteRenderVerifyPanel> 冒烟", () => {
  it("挂载即见按钮；jsdom 无 canvas 时十项检查以失败行 + 文案呈现", async () => {
    render(<NoteRenderVerifyPanel />);
    const button = screen.getByRole("button", { name: /运行渲染验证/ });
    expect(button).toBeEnabled();

    fireEvent.click(button);
    // 检查链逐项落败（jsdom getContext("2d") 为 null → 渲染器中文错误）
    const failRows = await waitFor(() => {
      const rows = screen
        .getAllByRole("listitem")
        .filter((li) => li.dataset.verdict === "fail");
      expect(rows).toHaveLength(10);
      return rows;
    });
    // 失败文案透出渲染器的中文错误（不静默）
    expect(failRows[0]).toHaveTextContent(/canvas 2d/);
    // 汇总计数行：0/9 通过
    expect(screen.getByText("0/10 通过")).toBeInTheDocument();
  });
});

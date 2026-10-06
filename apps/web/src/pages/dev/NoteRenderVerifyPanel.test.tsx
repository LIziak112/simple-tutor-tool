import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  NOTE_RENDER_CHECK_IDS,
  NoteRenderVerifyPanel,
} from "@/pages/dev/NoteRenderVerifyPanel";

/**
 * 渲染验证面板冒烟测试（T6R.6）：jsdom 无 2d canvas，检查链必然全部
 * 失败——冒烟确认：面板可挂载、按钮可触发、失败行带错误文案呈现（不崩溃、
 * 不静默吞错）；行数与汇总计数由面板导出的 id 名单推导（复审⑩：计数单轨，
 * 面板增删检查不需要改这里）。像素级真实检查在 Playwright E2E
 * （e2e/note-render.spec.ts）。
 */
describe("<NoteRenderVerifyPanel> 冒烟", () => {
  it(`挂载即见按钮；jsdom 无 canvas 时 ${NOTE_RENDER_CHECK_IDS.length} 项检查以失败行 + 文案呈现`, async () => {
    render(<NoteRenderVerifyPanel />);
    const button = screen.getByRole("button", { name: /运行渲染验证/ });
    expect(button).toBeEnabled();

    fireEvent.click(button);
    // 检查链逐项落败（jsdom getContext("2d") 为 null → 渲染器中文错误）
    const failRows = await waitFor(() => {
      const rows = screen
        .getAllByRole("listitem")
        .filter((li) => li.dataset.verdict === "fail");
      expect(rows).toHaveLength(NOTE_RENDER_CHECK_IDS.length);
      return rows;
    });
    // 失败文案透出渲染器的中文错误（不静默）
    expect(failRows[0]).toHaveTextContent(/canvas 2d/);
    // 汇总计数行：0/N 通过（N 由名单推导）
    expect(
      screen.getByText(`0/${NOTE_RENDER_CHECK_IDS.length} 通过`),
    ).toBeInTheDocument();
  });
});

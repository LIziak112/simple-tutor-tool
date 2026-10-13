import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PaperPresentation } from "./PaperPresentation";

it("仅全屏时挂载参考题面，收起时避免每题重复渲染公式与图片", () => {
  const view = (fullscreen: boolean) => (
    <PaperPresentation
      fullscreen={fullscreen}
      label="纸面"
      onClose={() => undefined}
      context={<p>参考题面</p>}
    >
      <canvas />
    </PaperPresentation>
  );
  const { rerender } = render(view(false));
  expect(screen.queryByText("参考题面")).toBeNull();
  rerender(view(true));
  expect(screen.getByText("参考题面")).toBeVisible();
});

it("全屏仅改变纸面外框，连续十次切换不替换画布", () => {
  const close = vi.fn();
  const view = (fullscreen: boolean) => (
    <PaperPresentation fullscreen={fullscreen} label="本题草稿" onClose={close}>
      <canvas data-testid="paper-canvas" />
    </PaperPresentation>
  );
  const { rerender } = render(view(false));
  const canvas = screen.getByTestId("paper-canvas");
  for (let index = 0; index < 10; index++) {
    rerender(view(true));
    expect(screen.getByRole("dialog", { name: "本题草稿" })).toContainElement(
      canvas,
    );
    rerender(view(false));
    expect(screen.getByTestId("paper-canvas")).toBe(canvas);
  }
});

it("全屏锁背景、约束焦点，Esc退出后还原焦点与滚动样式", () => {
  const close = vi.fn();
  const view = (fullscreen: boolean) => (
    <>
      <button type="button">全屏入口</button>
      <PaperPresentation
        fullscreen={fullscreen}
        label="本题草稿"
        onClose={close}
      >
        <button type="button">末工具</button>
      </PaperPresentation>
    </>
  );
  const { rerender, unmount } = render(view(false));
  const trigger = screen.getByText("全屏入口");
  trigger.focus();
  expect(trigger).toHaveFocus();
  rerender(view(true));
  expect(trigger).toHaveAttribute("inert");
  expect(document.body.style.overflow).toBe("hidden");
  expect(screen.getByRole("button", { name: "退出全屏" })).toHaveFocus();
  screen.getByText("末工具").focus();
  fireEvent.keyDown(window, { key: "Tab" });
  expect(screen.getByRole("button", { name: "退出全屏" })).toHaveFocus();
  fireEvent.keyDown(window, { key: "Escape", isComposing: true });
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
  rerender(view(false));
  expect(trigger).not.toHaveAttribute("inert");
  expect(trigger).toHaveFocus();
  expect(document.body.style.overflow).toBe("");
  unmount();
});

it("嵌套清空确认弹窗优先处理Esc，不能顺带退出全屏", () => {
  const close = vi.fn();
  render(
    <PaperPresentation fullscreen label="纸面" onClose={close}>
      <div role="dialog" data-state="open" aria-label="清空确认">
        确认
      </div>
    </PaperPresentation>,
  );
  fireEvent.keyDown(window, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
});

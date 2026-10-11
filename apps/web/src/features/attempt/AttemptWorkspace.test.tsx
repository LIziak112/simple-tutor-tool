import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AttemptWorkspace } from "./AttemptWorkspace";

vi.mock("@/features/student/student-workspace-layout", () => ({
  useStudentWorkspace: vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

it("软键盘缩小可见视窗时隐藏非编辑底栏，失焦恢复且清理监听", () => {
  const viewport = new EventTarget();
  Object.assign(viewport, { height: 400, offsetTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", viewport);
  const { container, unmount } = render(
    <AttemptWorkspace>
      <input aria-label="答案" />
      <div data-slot="attempt-bottom-bar">底栏</div>
    </AttemptWorkspace>,
  );
  const root = container.querySelector('[data-slot="attempt-workspace"]');
  const input = screen.getByRole("textbox", { name: "答案" });
  fireEvent.focusIn(input);
  expect(root).toHaveAttribute("data-keyboard-open", "true");
  fireEvent.focusOut(input);
  expect(root).toHaveAttribute("data-keyboard-open", "false");
  const remove = vi.spyOn(viewport, "removeEventListener");
  unmount();
  expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
});

it("缩放而非键盘不隐藏底栏", () => {
  const viewport = new EventTarget();
  Object.assign(viewport, { height: 400, offsetTop: 0, scale: 2 });
  vi.stubGlobal("visualViewport", viewport);
  const { container } = render(
    <AttemptWorkspace>
      <input aria-label="答案" />
    </AttemptWorkspace>,
  );
  fireEvent.focusIn(screen.getByRole("textbox"));
  expect(container.firstChild).toHaveAttribute("data-keyboard-open", "false");
});

it("作答栏替换为标画栏后重新测量底部避让高度", async () => {
  const height = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return { height: this.dataset.height === "96" ? 96 : 64 } as DOMRect;
    });
  const { container, rerender } = render(
    <AttemptWorkspace>
      <div key="answer" data-slot="attempt-bottom-bar">
        作答栏
      </div>
    </AttemptWorkspace>,
  );
  const root = container.firstElementChild as HTMLElement;
  expect(root.style.getPropertyValue("--attempt-footer-height")).toBe("64px");
  rerender(
    <AttemptWorkspace>
      <div key="draw" data-slot="attempt-bottom-bar" data-height="96">
        标画栏
      </div>
    </AttemptWorkspace>,
  );
  await waitFor(() =>
    expect(root.style.getPropertyValue("--attempt-footer-height")).toBe("96px"),
  );
  height.mockRestore();
});

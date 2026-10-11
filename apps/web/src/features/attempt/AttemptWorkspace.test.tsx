import { fireEvent, render, screen } from "@testing-library/react";
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

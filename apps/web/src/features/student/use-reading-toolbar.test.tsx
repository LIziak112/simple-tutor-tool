import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useReadingToolbar } from "./use-reading-toolbar";

function Toolbar({ blocked = false }: { blocked?: boolean }) {
  const toolbar = useReadingToolbar({ blocked });
  return (
    <>
      <header ref={toolbar.ref} data-reading-hidden={toolbar.hidden}>
        <button type="button">返回</button>
      </header>
      <p>正文</p>
    </>
  );
}

function scroll(y: number, user = true) {
  if (user) fireEvent.wheel(document.body, { deltaY: y - window.scrollY });
  vi.stubGlobal("scrollY", y);
  fireEvent.scroll(window);
}

beforeEach(() => {
  vi.stubGlobal("scrollY", 0);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("窄屏向下累计滚动收起、轻微回摆不展开，反向超过阈值展开", () => {
  render(<Toolbar />);
  const header = screen.getByRole("banner");
  scroll(120);
  expect(header).toHaveAttribute("data-reading-hidden", "true");
  scroll(115);
  expect(header).toHaveAttribute("data-reading-hidden", "true");
  scroll(106);
  expect(header).toHaveAttribute("data-reading-hidden", "false");
});

it("自动跳题不收起导航，页首与回弹保持展开", () => {
  render(<Toolbar />);
  scroll(200, false);
  expect(screen.getByRole("banner")).toHaveAttribute(
    "data-reading-hidden",
    "false",
  );
  scroll(250);
  scroll(-5);
  expect(screen.getByRole("banner")).toHaveAttribute(
    "data-reading-hidden",
    "false",
  );
});

it("点击跳转会清除滚动惯性授权，内层滚动不收起导航", () => {
  render(<Toolbar />);
  fireEvent.wheel(document.body, { deltaY: 100 });
  fireEvent.pointerDown(document.body);
  scroll(200, false);
  expect(screen.getByRole("banner")).toHaveAttribute(
    "data-reading-hidden",
    "false",
  );
  fireEvent.scroll(screen.getByText("正文"));
  expect(screen.getByRole("banner")).toHaveAttribute(
    "data-reading-hidden",
    "false",
  );
});

it("手写锁定期间不触发隐藏，导航聚焦可找回", () => {
  const { rerender } = render(<Toolbar blocked />);
  scroll(180);
  expect(screen.getByRole("banner")).toHaveAttribute(
    "data-reading-hidden",
    "false",
  );
  rerender(<Toolbar />);
  scroll(240);
  expect(screen.getByRole("banner")).toHaveAttribute(
    "data-reading-hidden",
    "true",
  );
  act(() => screen.getByRole("button").focus());
  expect(screen.getByRole("banner")).toHaveAttribute(
    "data-reading-hidden",
    "false",
  );
});

it("弹层、文本输入及画布触摸不隐藏导航", () => {
  const { rerender } = render(
    <>
      <Toolbar />
      <div role="dialog">目录</div>
    </>,
  );
  scroll(180);
  expect(screen.getByRole("banner")).toHaveAttribute(
    "data-reading-hidden",
    "false",
  );
  rerender(
    <>
      <Toolbar />
      <input aria-label="答案" />
      <canvas data-testid="paper" />
    </>,
  );
  act(() => screen.getByRole("textbox").focus());
  scroll(240);
  expect(screen.getByRole("banner")).toHaveAttribute(
    "data-reading-hidden",
    "false",
  );
  act(() => screen.getByRole("textbox").blur());
  fireEvent.pointerDown(document.body);
  fireEvent.touchMove(screen.getByTestId("paper"));
  scroll(300, false);
  expect(screen.getByRole("banner")).toHaveAttribute(
    "data-reading-hidden",
    "false",
  );
});

it("隐藏后出现编辑错误时立即找回提示", async () => {
  const { container } = render(<Toolbar />);
  scroll(180);
  const header = screen.getByRole("banner");
  expect(header).toHaveAttribute("data-reading-hidden", "true");
  await act(async () => {
    const notice = document.createElement("p");
    notice.setAttribute("role", "alert");
    notice.textContent = "保存失败";
    container.querySelector("header")?.append(notice);
  });
  expect(header).toHaveAttribute("data-reading-hidden", "false");
});

it("滚动经过未聚焦输入框仍属于阅读，实际聚焦输入才锁定导航", () => {
  render(
    <>
      <Toolbar />
      <input aria-label="未聚焦答案" />
    </>,
  );
  fireEvent.wheel(screen.getByRole("textbox"), { deltaY: 180 });
  scroll(180, false);
  expect(screen.getByRole("banner")).toHaveAttribute(
    "data-reading-hidden",
    "true",
  );
  act(() => screen.getByRole("textbox").focus());
  scroll(240);
  expect(screen.getByRole("banner")).toHaveAttribute(
    "data-reading-hidden",
    "false",
  );
});

it("桌面不自动隐藏，卸载清理滚动监听", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  const remove = vi.spyOn(window, "removeEventListener");
  const { unmount } = render(<Toolbar />);
  scroll(180);
  expect(screen.getByRole("banner")).toHaveAttribute(
    "data-reading-hidden",
    "false",
  );
  unmount();
  expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
  remove.mockRestore();
});

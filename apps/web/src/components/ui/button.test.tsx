import { createRef, type MouseEvent } from "react";
import { Link, MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render-with-portal";
import { Button } from "./button";

it("忙碌呈现保留固定名称，禁用仍由调用方控制", () => {
  const click = vi.fn();
  const { rerender } = render(
    <Button busy onClick={click}>
      保存更改
    </Button>,
  );
  const button = screen.getByRole("button", { name: "保存更改" });
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(click).toHaveBeenCalledTimes(1);
  rerender(
    <Button busy disabled onClick={click}>
      保存更改
    </Button>,
  );
  fireEvent.click(button);
  expect(click).toHaveBeenCalledTimes(1);
  rerender(<Button onClick={click}>保存更改</Button>);
  expect(button).not.toHaveAttribute("aria-busy");
});

it("asChild 保留实际链接、ref 与两层事件，忙碌不替换链接", () => {
  const ref = createRef<HTMLButtonElement>();
  const click = vi.fn();
  const childClick = vi.fn((event: MouseEvent<HTMLAnchorElement>) =>
    event.preventDefault(),
  );
  render(
    <MemoryRouter>
      <Button asChild busy ref={ref} onClick={click}>
        <Link to="/s/home" onClick={childClick}>
          返回首页
        </Link>
      </Button>
    </MemoryRouter>,
  );
  const link = screen.getByRole("link", { name: "返回首页" });
  expect(ref.current).toBe(link);
  expect(link).toHaveAttribute("href", "/s/home");
  expect(link).toHaveAttribute("aria-busy", "true");
  fireEvent.click(link);
  expect(childClick).toHaveBeenCalledTimes(1);
  expect(click).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AttemptHeader } from "./AttemptHeader";

it("返回可用，长标题限制两行，更多可查看完整标题", () => {
  const back = vi.fn();
  render(
    <AttemptHeader
      title="很长的练习标题，需要在更多里查看完整名称"
      status={<p>已保存</p>}
      onBack={back}
    >
      课程信息
    </AttemptHeader>,
  );
  expect(screen.getByRole("heading", { level: 1 })).toHaveClass("line-clamp-2");
  fireEvent.click(screen.getByRole("button", { name: "返回" }));
  expect(back).toHaveBeenCalledOnce();
  fireEvent.pointerDown(screen.getByRole("button", { name: "练习更多" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "练习信息" }));
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "很长的练习标题，需要在更多里查看完整名称",
  );
});

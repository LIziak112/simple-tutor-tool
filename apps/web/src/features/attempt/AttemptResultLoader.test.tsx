import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AttemptResultLoadBoundary } from "./AttemptResultLoader";

it("结果模块加载失败提供重新加载入口，不显示空白页", () => {
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  const retry = vi.fn();
  function Failed(): never {
    throw new Error("模块加载失败");
  }
  try {
    render(
      <AttemptResultLoadBoundary onRetry={retry}>
        <Failed />
      </AttemptResultLoadBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("结果页面加载失败");
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(retry).toHaveBeenCalledOnce();
  } finally {
    quiet.mockRestore();
  }
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorRetry } from "./ErrorRetry";

describe("ErrorRetry 组件", () => {
  it("渲染错误信息与默认重试按钮，点击触发 onRetry", () => {
    const onRetry = vi.fn();
    render(<ErrorRetry message="加载失败，请检查网络" onRetry={onRetry} />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("加载失败，请检查网络")).toBeInTheDocument();

    const button = screen.getByRole("button", { name: "重试" });
    expect(button).toBeInTheDocument();
    expect(button.className).toContain("min-h-11");

    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("支持自定义 retryLabel 与 title", () => {
    const onRetry = vi.fn();
    render(
      <ErrorRetry
        title="预览加载失败"
        message="服务器超时"
        retryLabel="重新预览"
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText("预览加载失败")).toBeInTheDocument();
    expect(screen.getByText("服务器超时")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重新预览" }),
    ).toBeInTheDocument();
  });
});

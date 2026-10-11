import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { ResultWorkspace } from "./ResultWorkspace";

it("移动题号抽屉不卸载正文，标题完整、上一下一边界正确", () => {
  render(
    <MemoryRouter>
      <ResultWorkspace
        title="长标题完整显示"
        attemptId="a1"
        questions={[]}
        released
        onBack={vi.fn()}
        backLabel="返回我的记录"
      >
        <p>保活正文</p>
      </ResultWorkspace>
    </MemoryRouter>,
  );
  expect(
    screen.getByRole("heading", { name: "长标题完整显示" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "上一题" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "打开回看题号" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByText("保活正文")).toBeInTheDocument();
});

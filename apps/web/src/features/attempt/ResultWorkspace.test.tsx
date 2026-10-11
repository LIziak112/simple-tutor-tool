import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { ResultWorkspace } from "./ResultWorkspace";

it("桌面题号栏可手动收起，开合保留定位范围和正文实例", () => {
  render(
    <MemoryRouter>
      <ResultWorkspace
        title="结果回看"
        attemptId="a2"
        questions={[]}
        released
        status="graded"
        onBack={vi.fn()}
        backLabel="返回记录"
      >
        <input aria-label="订正反思" defaultValue="保留的反思" />
      </ResultWorkspace>
    </MemoryRouter>,
  );
  const body = screen.getByRole("textbox", { name: "订正反思" });
  const range = screen.getByRole("combobox", { name: "回看定位范围" });
  fireEvent.change(range, { target: { value: "unanswered" } });
  const toggle = screen.getByRole("button", { name: "收起题号栏" });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(toggle);
  expect(screen.getByRole("button", { name: "展开题号栏" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(range).not.toBeVisible();
  expect(body).toBe(screen.getByRole("textbox", { name: "订正反思" }));
  fireEvent.click(screen.getByRole("button", { name: "展开题号栏" }));
  expect(range).toBeVisible();
  expect(range).toHaveValue("unanswered");
  expect(body).toHaveValue("保留的反思");
});

it("移动题号抽屉不卸载正文，标题完整、上一下一边界正确", () => {
  render(
    <MemoryRouter>
      <ResultWorkspace
        title="长标题完整显示"
        attemptId="a1"
        questions={[]}
        released
        status="graded"
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
  expect(screen.getByText("已批改 · 结果回看")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "打开回看题号" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByText("保活正文")).toBeInTheDocument();
});

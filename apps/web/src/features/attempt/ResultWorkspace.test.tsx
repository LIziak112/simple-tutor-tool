import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { ResultWorkspace } from "./ResultWorkspace";

it("从底栏打开答题卡，开合保留定位范围和正文实例", async () => {
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
  const header = screen.getByRole("banner");
  expect(
    within(header).getByRole("button", { name: "随手记" }),
  ).toBeInTheDocument();
  const footer = screen.getByRole("contentinfo");
  const entry = within(footer).getByRole("button", { name: "答题卡" });
  expect(screen.queryByRole("complementary", { name: "结果定位" })).toBeNull();
  fireEvent.click(entry);
  const dialog = await screen.findByRole("dialog", { name: "答题卡" });
  const range = within(dialog).getByRole("combobox", { name: "回看定位范围" });
  fireEvent.change(range, { target: { value: "unanswered" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭弹层" }));
  await waitFor(() => expect(entry).toHaveFocus());
  expect(body).toBe(screen.getByRole("textbox", { name: "订正反思" }));
  fireEvent.click(entry);
  expect(
    await screen.findByRole("combobox", { name: "回看定位范围" }),
  ).toHaveValue("unanswered");
  expect(body).toHaveValue("保留的反思");
});

it("答题卡弹层不卸载正文，标题完整、上一下一边界正确", () => {
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
  fireEvent.click(screen.getByRole("button", { name: "答题卡" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByText("保活正文")).toBeInTheDocument();
});

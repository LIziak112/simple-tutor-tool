import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { ResultQuestionTools } from "./ResultQuestionTools";

function Draft() {
  const [value, setValue] = useState("");
  return (
    <input
      aria-label="草稿备注"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}

it("草稿面板保留编辑实例：题号更新、切到更多再切回都不丢输入", () => {
  const props = {
    draft: <Draft />,
    correction: <button type="button">订正</button>,
    more: <button type="button">复习包</button>,
  };
  const { rerender } = render(
    <ResultQuestionTools questionNo={1} {...props} />,
  );
  // 折叠零挂载：未展开前面板内容不存在
  expect(screen.queryByRole("textbox", { name: "草稿备注" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "草稿" }));
  fireEvent.change(screen.getByRole("textbox", { name: "草稿备注" }), {
    target: { value: "先判断条件" },
  });
  rerender(<ResultQuestionTools questionNo={2} {...props} />);
  expect(screen.getByRole("textbox", { name: "草稿备注" })).toHaveValue(
    "先判断条件",
  );
  expect(
    screen.getByRole("region", { name: "第 2 题材料与订正" }),
  ).toBeInTheDocument();
  // 互斥切换到更多：草稿面板隐藏但保持挂载
  fireEvent.click(screen.getByRole("button", { name: "更多" }));
  expect(screen.queryByRole("textbox", { name: "草稿备注" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "草稿" }));
  expect(screen.getByRole("textbox", { name: "草稿备注" })).toHaveValue(
    "先判断条件",
  );
  expect(screen.queryAllByRole("heading")).toHaveLength(0);
});

it("订正是直达动作：常驻操作行，不折叠面板", () => {
  render(
    <ResultQuestionTools
      questionNo={1}
      draft={<div>草稿面板</div>}
      correction={<button type="button">继续订正</button>}
      more={<div>更多面板</div>}
    />,
  );
  expect(screen.getByRole("button", { name: "继续订正" })).toBeInTheDocument();
  // 订正按钮始终在行内（无 aria-expanded 折叠语义）
  expect(
    screen
      .getByRole("button", { name: "继续订正" })
      .getAttribute("aria-expanded"),
  ).toBeNull();
});

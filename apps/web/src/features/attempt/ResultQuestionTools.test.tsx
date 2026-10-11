import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { ResultQuestionTools } from "./ResultQuestionTools";

function Draft() {
  const [value, setValue] = useState("");
  return (
    <input
      aria-label="订正反思"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}

it("工具分组保留编辑实例，题号更新不丢订正反思", () => {
  const props = {
    original: <button type="button">查看原稿</button>,
    correction: <Draft />,
    more: <button type="button">复习包</button>,
  };
  const { rerender } = render(
    <ResultQuestionTools questionNo={1} {...props} />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "订正反思" }), {
    target: { value: "先判断条件" },
  });
  rerender(<ResultQuestionTools questionNo={2} {...props} />);
  expect(screen.getByRole("textbox", { name: "订正反思" })).toHaveValue(
    "先判断条件",
  );
  expect(
    screen.getByRole("region", { name: "第 2 题材料与订正" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "本次原稿" })).toBeInTheDocument();
});

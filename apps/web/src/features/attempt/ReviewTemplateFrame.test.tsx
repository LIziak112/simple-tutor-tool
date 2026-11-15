import type { AttemptResultData } from "@tutor/contract";
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render-with-portal";
import { ReviewTemplateFrame } from "./ReviewTemplateFrame";

const data = {
  attempt: { id: "attempt" },
  answersReleased: true,
  units: [],
  title: "样卷",
} as unknown as AttemptResultData;
it("切换预设、隐藏和排序只改变现有视图，不请求题目", () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  render(
    <ReviewTemplateFrame
      data={data}
      context={undefined}
      slots={{
        summary: <p>已有汇总</p>,
        questions: <p>已有题目数据</p>,
        agent_report: <p>已有报告</p>,
      }}
    />,
  );
  expect(screen.getByText("已有题目数据")).toBeVisible();
  fireEvent.change(screen.getByLabelText("复盘模板"), {
    target: { value: "exam" },
  });
  expect(screen.getByText("已有题目数据")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "调整分区" }));
  fireEvent.click(screen.getByLabelText("显示逐题列表"));
  expect(screen.getByText("已有题目数据")).not.toBeVisible();
  fireEvent.click(screen.getByLabelText("显示逐题列表"));
  fireEvent.click(screen.getByRole("button", { name: "上移逐题列表" }));
  expect(screen.getByText("已有题目数据")).toBeVisible();
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
});
it("非法模板配置回落默认并显示原因", () => {
  render(
    <ReviewTemplateFrame
      data={data}
      context={undefined}
      initialConfig={{ version: 99 }}
      slots={{ summary: <p>已有汇总</p>, questions: <p>已有题目数据</p> }}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("模板配置无效");
  expect(screen.getByLabelText("复盘模板")).toHaveValue("objective");
});

import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  QuestionDslContext,
  QuestionRenderContext,
} from "@/features/answering/question-render-context";
import { QuestionSurface } from "@/features/attempt/QuestionSurface";
import { FoldDirective, StepDirective, StepsDirective } from "./Steps";

it("题内 v4 固定展示公开折叠与步骤，题外交互不变", () => {
  const fold = (
    <FoldDirective name="fold" attrs={{ title: "公开" }} docIndex={1} index={1}>
      <p>折叠正文</p>
    </FoldDirective>
  );
  const { unmount } = render(
    <QuestionDslContext value={4}>
      {fold}
      <StepsDirective name="steps" docIndex={2} index={1}>
        <StepDirective name="step" attrs={{ title: "" }} docIndex={3} index={1}>
          第一步
        </StepDirective>
        <StepDirective name="step" attrs={{ title: "" }} docIndex={4} index={2}>
          第二步
        </StepDirective>
      </StepsDirective>
    </QuestionDslContext>,
  );
  expect(screen.getByText("折叠正文")).not.toBeNull();
  expect(screen.getByText("第二步")).not.toBeNull();
  expect(screen.queryByRole("button", { name: /显示下一步/ })).toBeNull();
  unmount();
  render(fold);
  expect(screen.queryByText("折叠正文")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "公开" }));
  expect(screen.getByText("折叠正文")).not.toBeNull();
});

it("真实题面旧版保留默认闭合并阻止改变，v4 的公开内容固定展开", () => {
  const question = {
    id: "dsl",
    type: "solve" as const,
    difficulty: 1,
    knowledge: [],
    hintCount: 0,
    stemMd:
      ':::fold{title="公开折叠"}\n正文内容\n:::\n\n::::steps\n:::step\n第一步内容\n:::\n:::step\n第二步内容\n:::\n::::',
  };
  const { unmount } = render(
    <QuestionRenderContext value={{ renderVersion: 2 }}>
      <QuestionSurface question={question} />
    </QuestionRenderContext>,
  );
  expect(screen.queryByText("正文内容")).toBeNull();
  expect(screen.queryByText("第二步内容")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "公开折叠" }));
  fireEvent.click(screen.getByRole("button", { name: /显示下一步/ }));
  expect(screen.queryByText("正文内容")).toBeNull();
  expect(screen.queryByText("第二步内容")).toBeNull();
  unmount();
  render(
    <QuestionRenderContext value={{ renderVersion: 4 }}>
      <QuestionSurface question={question} />
    </QuestionRenderContext>,
  );
  expect(screen.getByText("正文内容")).not.toBeNull();
  expect(screen.getByText("第二步内容")).not.toBeNull();
});

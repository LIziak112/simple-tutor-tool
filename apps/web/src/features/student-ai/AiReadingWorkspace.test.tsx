import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it } from "vitest";
import {
  AiReadingMemoryContext,
  AiReadingWorkspace,
} from "./AiReadingWorkspace";
import { AiReplyMarkdown } from "./AiReplyMarkdown";

it("切换展示壳后恢复展开章节，任务和消息版本相互隔离", async () => {
  const memory = new Map();
  const content = (version: string, shell: string) => (
    <AiReadingMemoryContext value={memory}>
      <div key={shell} data-ai-scroll>
        <AiReadingWorkspace readingKey={version}>
          <AiReplyMarkdown
            readingKey={version}
            source={"## 第一步\n观察条件\n\n## 第二步\n代入计算"}
          />
        </AiReadingWorkspace>
      </div>
    </AiReadingMemoryContext>
  );
  const view = render(content("task-1:v1", "inline"));
  fireEvent.click(screen.getByText("第二步"));
  await waitFor(() =>
    expect(memory.get("sections:task-1:v1")?.sections).toHaveLength(2),
  );
  view.rerender(content("task-1:v1", "dialog"));
  expect(view.container.querySelectorAll("details[open]")).toHaveLength(2);
  view.rerender(content("task-1:v2", "dialog-2"));
  expect(view.container.querySelectorAll("details[open]")).toHaveLength(1);
});

it("滚动记录节内锚点，重新挂载在新宿主恢复偏移", () => {
  const memory = new Map();
  const content = (key: string) => (
    <AiReadingMemoryContext value={memory}>
      <div key={key} data-ai-scroll>
        <AiReadingWorkspace readingKey="task">
          <div data-ai-section="step">本节内容</div>
        </AiReadingWorkspace>
      </div>
    </AiReadingMemoryContext>
  );
  const view = render(content("side"));
  const anchor = screen.getByText("本节内容");
  anchor.getBoundingClientRect = () => ({
    top: -25,
    bottom: 150,
    left: 0,
    right: 100,
    width: 100,
    height: 175,
    x: 0,
    y: -25,
    toJSON: () => ({}),
  });
  fireEvent.scroll(
    view.container.querySelector("[data-ai-scroll]") as HTMLElement,
  );
  expect(memory.get("position:task")).toEqual({ anchor: "step", offset: -25 });
  act(() => view.rerender(content("dialog")));
  expect(
    (view.container.querySelector("[data-ai-scroll]") as HTMLElement).scrollTop,
  ).toBe(25);
});

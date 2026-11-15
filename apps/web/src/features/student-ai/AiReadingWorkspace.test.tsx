import { expect, it } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/test/render-with-portal";
import {
  AiReadingMemoryContext,
  AiReadingWorkspace,
  createAiReadingMemory,
} from "./AiReadingWorkspace";
import { AiReplyMarkdown } from "./AiReplyMarkdown";

it("切换展示壳后恢复展开章节，任务和消息版本相互隔离", async () => {
  const memory = createAiReadingMemory();
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
    expect(view.container.querySelectorAll("details[open]")).toHaveLength(2),
  );
  view.rerender(content("task-1:v1", "dialog"));
  expect(view.container.querySelectorAll("details[open]")).toHaveLength(2);
  view.rerender(content("task-1:v2", "dialog-2"));
  expect(view.container.querySelectorAll("details[open]")).toHaveLength(1);
});

it("滚动记录节内锚点，重新挂载在新宿主恢复偏移", () => {
  const memory = createAiReadingMemory();
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
  expect(memory.positions.get("task")).toEqual({ anchor: "step", offset: -25 });
  act(() => view.rerender(content("dialog")));
  expect(
    (view.container.querySelector("[data-ai-scroll]") as HTMLElement).scrollTop,
  ).toBe(25);
});

it.each([false, true])(
  "异步锚点只在用户尚未滚动时恢复（已滚动 %s）",
  async (scrolled) => {
    const memory = createAiReadingMemory();
    memory.positions.set("task", { anchor: "step", offset: -25 });
    const content = (ready: boolean) => (
      <AiReadingMemoryContext value={memory}>
        <div data-ai-scroll>
          <AiReadingWorkspace readingKey="task">
            <div data-ai-reading-block="intro">题目</div>
            {ready && <div data-ai-section="step">本节内容</div>}
          </AiReadingWorkspace>
        </div>
      </AiReadingMemoryContext>
    );
    const view = render(content(false));
    const host = view.container.querySelector(
      "[data-ai-scroll]",
    ) as HTMLElement;
    expect(host.scrollTop).toBe(0);
    if (scrolled) {
      host.scrollTop = 12;
      fireEvent.scroll(host);
    }
    await act(async () => view.rerender(content(true)));
    expect(host.scrollTop).toBe(scrolled ? 12 : 25);
  },
);

it("同一消息版本在两个展示壳中共享章节开合", () => {
  const memory = createAiReadingMemory();
  const view = render(
    <AiReadingMemoryContext value={memory}>
      {["inline", "dialog"].map((shell) => (
        <section key={shell} aria-label={shell} data-ai-scroll>
          <AiReplyMarkdown
            readingKey="task:v1"
            source={"## 第一步\n观察条件\n\n## 第二步\n代入计算"}
          />
        </section>
      ))}
    </AiReadingMemoryContext>,
  );
  fireEvent.click(
    within(screen.getByRole("region", { name: "inline" })).getByRole("button", {
      name: "展开全部",
    }),
  );
  expect(view.container.querySelectorAll("details[open]")).toHaveLength(4);
});

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  AttemptEditorProvider,
  useAttemptEditor,
} from "./AttemptEditorContext";

function Controls({ finish }: { finish: () => Promise<void> }) {
  const editor = useAttemptEditor();
  if (!editor) throw new Error("测试缺少会话");
  return (
    <>
      <output>{editor.active?.questionId ?? "作答"}</output>
      <button
        type="button"
        onClick={() => {
          editor.register("q1", finish);
          void editor.request({ questionId: "q1", kind: "annotation" });
        }}
      >
        甲
      </button>
      <button
        type="button"
        onClick={() =>
          void editor.request({ questionId: "q2", kind: "scratch" })
        }
      >
        乙
      </button>
      <button type="button" onClick={() => void editor.request(null)}>
        退出
      </button>
    </>
  );
}
it("130题按题订阅编辑状态，仅原题与新题更新；只读操作方不跟随模式重渲染", async () => {
  const renders = new Map<string, number>();
  function Probe({ id }: { id: string | null }) {
    const editor = useAttemptEditor(id);
    const key = id ?? "commands";
    renders.set(key, (renders.get(key) ?? 0) + 1);
    return <span>{editor?.active?.questionId ?? key}</span>;
  }
  render(
    <AttemptEditorProvider>
      <Controls finish={async () => {}} />
      <Probe id={null} />
      {Array.from({ length: 130 }, (_, index) => `q${index + 1}`).map((id) => (
        <Probe key={id} id={id} />
      ))}
    </AttemptEditorProvider>,
  );
  const before = new Map(renders);
  fireEvent.click(screen.getByText("甲"));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("q1"),
  );
  expect(renders.get("q1")).toBeGreaterThan(before.get("q1") ?? 0);
  for (const [key, count] of before)
    if (key !== "q1") expect(renders.get(key)).toBe(count);
  const afterFirst = new Map(renders);
  fireEvent.click(screen.getByText("乙"));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("q2"),
  );
  expect(renders.get("q2")).toBeGreaterThan(afterFirst.get("q2") ?? 0);
  for (const [key, count] of afterFirst)
    if (key !== "q1" && key !== "q2") expect(renders.get(key)).toBe(count);
});
it("按题订阅方在事件中能读取其他题当前编辑者，不需要整卷重渲染", async () => {
  function OtherQuestion() {
    const editor = useAttemptEditor("q2");
    return (
      <button
        type="button"
        onClick={() => {
          if (editor?.getActive()?.kind === "annotation")
            void editor.request(null);
        }}
      >
        其他题作答
      </button>
    );
  }
  const finish = vi.fn(async () => undefined);
  render(
    <AttemptEditorProvider>
      <Controls finish={finish} />
      <OtherQuestion />
    </AttemptEditorProvider>,
  );
  fireEvent.click(screen.getByText("甲"));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("q1"),
  );
  fireEvent.click(screen.getByText("其他题作答"));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("作答"),
  );
  expect(finish).toHaveBeenCalledOnce();
});
it("切题先结束原笔并落盘，完成前不挂第二个编辑者", async () => {
  let resolve: (() => void) | undefined;
  const finish = vi.fn(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  render(
    <AttemptEditorProvider>
      <Controls finish={finish} />
    </AttemptEditorProvider>,
  );
  fireEvent.click(screen.getByText("甲"));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("q1"),
  );
  fireEvent.click(screen.getByText("乙"));
  expect(finish).toHaveBeenCalledOnce();
  expect(screen.getByRole("status")).toHaveTextContent("q1");
  await act(async () => resolve?.());
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("q2"),
  );
});
it("落盘失败保留原编辑者和错误，不能静默切走", async () => {
  render(
    <AttemptEditorProvider>
      <Controls
        finish={async () => {
          throw new Error("本机写入失败");
        }}
      />
    </AttemptEditorProvider>,
  );
  fireEvent.click(screen.getByText("甲"));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("q1"),
  );
  fireEvent.click(screen.getByText("乙"));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("本机写入失败"),
  );
  expect(screen.getByRole("status")).toHaveTextContent("q1");
});
it("Esc退出保留稿；输入法组合时Esc不退出", async () => {
  const finish = vi.fn(async () => undefined);
  render(
    <AttemptEditorProvider>
      <Controls finish={finish} />
    </AttemptEditorProvider>,
  );
  fireEvent.click(screen.getByText("甲"));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("q1"),
  );
  fireEvent.keyDown(window, { key: "Escape", isComposing: true });
  expect(screen.getByRole("status")).toHaveTextContent("q1");
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("作答"),
  );
  expect(finish).toHaveBeenCalledOnce();
});

it("迟到的准备结果被取消，不能重新打开已退出的编辑者", async () => {
  let resolve: ((value: boolean) => void) | undefined;
  let signal: AbortSignal | undefined;
  function PrepareControls() {
    const editor = useAttemptEditor();
    return (
      <>
        <output>{editor?.active?.questionId ?? "作答"}</output>
        <button
          type="button"
          onClick={() =>
            void editor?.request(
              { questionId: "slow", kind: "annotation" },
              async (current) => {
                signal = current;
                return new Promise<boolean>((done) => {
                  resolve = done;
                });
              },
            )
          }
        >
          准备
        </button>
        <button type="button" onClick={() => void editor?.request(null)}>
          取消
        </button>
      </>
    );
  }
  render(
    <AttemptEditorProvider>
      <PrepareControls />
    </AttemptEditorProvider>,
  );
  fireEvent.click(screen.getByText("准备"));
  fireEvent.click(screen.getByText("取消"));
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve?.(true));
  expect(screen.getByRole("status")).toHaveTextContent("作答");
});

it("同题草稿与标画独立展开，退出标画保留草稿，切题收笔后关闭旧草稿", async () => {
  const finishPaper = vi.fn(async () => undefined);
  function Papers() {
    const editor = useAttemptEditor();
    return (
      <>
        <output aria-label="展开纸面">
          {editor?.paper?.questionId ?? "收起"}
        </output>
        <button
          type="button"
          onClick={() => {
            editor?.register("q1", finishPaper, "scratch");
            void editor?.requestPaper({ questionId: "q1", kind: "scratch" });
          }}
        >
          草稿
        </button>
        <button type="button" onClick={() => void editor?.requestPaper(null)}>
          收纸
        </button>
      </>
    );
  }
  render(
    <AttemptEditorProvider>
      <Controls finish={async () => {}} />
      <Papers />
    </AttemptEditorProvider>,
  );
  fireEvent.click(screen.getByText("草稿"));
  await waitFor(() =>
    expect(screen.getByLabelText("展开纸面")).toHaveTextContent("q1"),
  );
  fireEvent.click(screen.getByText("甲"));
  await waitFor(() =>
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("q1"),
  );
  expect(screen.getByLabelText("展开纸面")).toHaveTextContent("q1");
  expect(finishPaper).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText("退出"));
  await waitFor(() =>
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("作答"),
  );
  expect(screen.getByLabelText("展开纸面")).toHaveTextContent("q1");
  fireEvent.click(screen.getByText("乙"));
  await waitFor(() =>
    expect(screen.getByLabelText("展开纸面")).toHaveTextContent("收起"),
  );
  expect(finishPaper).toHaveBeenCalledTimes(3);
});

it("草稿落盘失败时不能切题或收起，标画退出不隐藏纸面", async () => {
  function Papers() {
    const editor = useAttemptEditor();
    return (
      <>
        <output aria-label="展开纸面">
          {editor?.paper?.questionId ?? "收起"}
        </output>
        <button
          type="button"
          onClick={() => {
            editor?.register(
              "q1",
              async () => {
                throw new Error("草稿写入失败");
              },
              "scratch",
            );
            void editor?.requestPaper({ questionId: "q1", kind: "scratch" });
          }}
        >
          草稿
        </button>
        <button type="button" onClick={() => void editor?.requestPaper(null)}>
          收纸
        </button>
      </>
    );
  }
  render(
    <AttemptEditorProvider>
      <Controls finish={async () => {}} />
      <Papers />
    </AttemptEditorProvider>,
  );
  fireEvent.click(screen.getByText("草稿"));
  await waitFor(() =>
    expect(screen.getByLabelText("展开纸面")).toHaveTextContent("q1"),
  );
  fireEvent.click(screen.getByText("乙"));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("草稿写入失败"),
  );
  expect(screen.getByLabelText("展开纸面")).toHaveTextContent("q1");
  fireEvent.click(screen.getByText("收纸"));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("草稿写入失败"),
  );
  expect(screen.getByLabelText("展开纸面")).toHaveTextContent("q1");
});

it("只有纸面展开时Esc收起纸面，同题标画仍可独立收起", async () => {
  function Paper() {
    const editor = useAttemptEditor();
    return (
      <>
        <output>{editor?.paper?.questionId ?? "收起"}</output>
        <button
          type="button"
          onClick={() =>
            void editor?.requestPaper({ questionId: "q1", kind: "scratch" })
          }
        >
          草稿
        </button>
      </>
    );
  }
  render(
    <AttemptEditorProvider>
      <Paper />
    </AttemptEditorProvider>,
  );
  fireEvent.click(screen.getByText("草稿"));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("q1"),
  );
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("收起"),
  );
});

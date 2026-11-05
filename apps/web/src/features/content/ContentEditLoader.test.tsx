import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ContentEditLoader } from "./ContentEditLoader";

const editor = vi.hoisted(() => ({
  pending: null as Promise<void> | null,
  failed: false,
}));
vi.mock("./ContentEditSheet", () => {
  function Body({ id, onClose }: { id: string; onClose: () => void }) {
    if (editor.failed) throw new Error("模拟编辑模块失败");
    if (editor.pending) throw editor.pending;
    return (
      <div role="dialog" aria-label="当前编辑器">
        <p>{id}</p>
        <button type="button" onClick={onClose}>
          关闭编辑
        </button>
      </div>
    );
  }
  return {
    QuestionEditSheet: ({
      questionId,
      onClose,
    }: {
      questionId: string;
      onClose: () => void;
    }) => <Body id={questionId} onClose={onClose} />,
    LectureEditSheet: ({
      lectureId,
      onClose,
    }: {
      lectureId: string;
      onClose: () => void;
    }) => <Body id={lectureId} onClose={onClose} />,
  };
});

afterEach(() => {
  editor.failed = false;
  editor.pending = null;
  vi.restoreAllMocks();
});

it("加载中可关闭，卸载后的迟到模块不重新打开抽屉", async () => {
  let release: (() => void) | undefined;
  editor.pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const close = vi.fn();
  const view = render(
    <ContentEditLoader kind="question" id="q1" onClose={close} />,
  );
  expect(
    await screen.findByRole("dialog", { name: "正在加载编辑器…" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(close).toHaveBeenCalledOnce();
  view.unmount();
  await act(async () => {
    editor.pending = null;
    release?.();
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("失败保留重试与关闭入口，重试后恢复当前编辑目标", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  editor.failed = true;
  render(
    <ContentEditLoader
      kind="lecture"
      id="lecture-2"
      onClose={() => undefined}
    />,
  );
  expect(
    await screen.findByRole("dialog", { name: "编辑器加载失败" }),
  ).toBeInTheDocument();
  editor.failed = false;
  fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  expect(
    await screen.findByRole("dialog", { name: "当前编辑器" }),
  ).toHaveTextContent("lecture-2");
});

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoComposer } from "./MemoComposer";
import { enqueueMemo } from "./memo-outbox";

/**
 * 记录端入队失败的恢复路径（审查修复 #104-02 第二轮）：
 * - 文字：放回输入框 + 红字说明（页面测试已覆盖文字路径，这里只钉媒体路径）；
 * - 语音 / 图片 / 手写没有输入框可放回：整条（含 Blob）留在本页给「重新保存」，
 *   重发复用同一 clientId（服务端幂等，响应丢失重发不成两条），成功后提示消失。
 */

vi.mock("./memo-outbox", () => ({
  enqueueMemo: vi.fn(),
}));

const mockedEnqueue = vi.mocked(enqueueMemo);

beforeEach(() => {
  mockedEnqueue.mockReset();
});

afterEach(() => {
  cleanup();
});

async function pickImage(): Promise<void> {
  const file = new File([new Uint8Array([1, 2, 3])], "p.png", {
    type: "image/png",
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText("选择或拍摄图片"), {
      target: { files: [file] },
    });
  });
}

async function click(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

describe("MemoComposer：媒体随笔入队失败后可重新保存", () => {
  it("重试旧图片成功后保留正在编辑的新稿和标签", async () => {
    const onQueued = vi.fn();
    mockedEnqueue.mockRejectedValueOnce(new Error("本机保存失败"));
    render(<MemoComposer onQueued={onQueued} />);
    await pickImage();
    fireEvent.change(screen.getByLabelText("随笔内容"), {
      target: { value: "另一条未保存的随笔" },
    });
    fireEvent.change(screen.getByLabelText("标签"), {
      target: { value: "新标签" },
    });
    mockedEnqueue.mockResolvedValueOnce("saved");
    await click("重新保存");
    expect(screen.getByLabelText("随笔内容")).toHaveValue("另一条未保存的随笔");
    expect(screen.getByLabelText("标签")).toHaveValue("新标签");
    expect(onQueued).not.toHaveBeenCalled();
  });

  it("两张图片分别保存失败时，各自保留重新保存入口", async () => {
    mockedEnqueue.mockRejectedValue(new Error("本机保存失败"));
    render(<MemoComposer />);
    await pickImage();
    await pickImage();
    expect(screen.getAllByRole("button", { name: "重新保存" })).toHaveLength(2);
  });

  it("文字随笔原样重试沿用第一次提交的键和记录时间", async () => {
    mockedEnqueue.mockRejectedValueOnce(new Error("响应丢失"));
    render(<MemoComposer />);
    fireEvent.change(screen.getByLabelText("随笔内容"), {
      target: { value: "一条文字" },
    });
    await click("保存");
    mockedEnqueue.mockResolvedValueOnce("saved");
    await click("保存");
    expect(mockedEnqueue).toHaveBeenCalledTimes(2);
    expect(mockedEnqueue.mock.calls[1]?.[0]).toEqual(
      mockedEnqueue.mock.calls[0]?.[0],
    );
  });

  it("图片入队失败：提示带「重新保存」，点它用同一 clientId 重发；成功后提示消失并回调 onQueued", async () => {
    const onQueued = vi.fn();
    mockedEnqueue.mockRejectedValueOnce(
      new Error(
        "本机保存失败，暂时也传不上去：这条还没有存下来，请联网后重新保存",
      ),
    );
    render(<MemoComposer onQueued={onQueued} />);
    fireEvent.change(screen.getByLabelText("随笔内容"), {
      target: { value: "配图说明" },
    });
    await pickImage();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("本机保存失败");
    expect(alert).toHaveTextContent("这张图片还在本页");
    expect(onQueued).not.toHaveBeenCalled();
    expect(mockedEnqueue).toHaveBeenCalledTimes(1);
    const first = mockedEnqueue.mock.calls[0]?.[0];
    expect(first?.kind).toBe("image");
    expect(first?.text).toBe("配图说明");
    expect(typeof first?.clientId).toBe("string");

    mockedEnqueue.mockResolvedValueOnce(first?.clientId ?? "");
    await click("重新保存");
    await vi.waitFor(() => expect(onQueued).toHaveBeenCalledTimes(1));
    expect(mockedEnqueue).toHaveBeenCalledTimes(2);
    const second = mockedEnqueue.mock.calls[1]?.[0];
    // 同一条：clientId / recordedAt / Blob / 文字全部一致，命中服务端幂等键
    expect(second?.clientId).toBe(first?.clientId);
    expect(second?.recordedAt).toBe(first?.recordedAt);
    expect(second?.blob).toBe(first?.blob);
    expect(second?.text).toBe("配图说明");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("重新保存再次失败：提示仍在、还能再试；文字路径不出现「重新保存」", async () => {
    mockedEnqueue.mockRejectedValue(new Error("本机保存失败，暂时也传不上去"));
    render(<MemoComposer />);
    await pickImage();
    await screen.findByRole("button", { name: "重新保存" });
    await click("重新保存");
    await vi.waitFor(() => expect(mockedEnqueue).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("button", { name: "重新保存" }),
    ).toBeInTheDocument();
    expect(mockedEnqueue.mock.calls[1]?.[0].clientId).toBe(
      mockedEnqueue.mock.calls[0]?.[0].clientId,
    );

    cleanup();
    mockedEnqueue.mockReset();
    mockedEnqueue.mockRejectedValueOnce(new Error("本机保存失败"));
    render(<MemoComposer />);
    fireEvent.change(screen.getByLabelText("随笔内容"), {
      target: { value: "一条文字" },
    });
    await click("保存");
    expect(await screen.findByRole("alert")).toHaveTextContent("本机保存失败");
    expect(screen.getByLabelText("随笔内容")).toHaveValue("一条文字");
    expect(screen.queryByRole("button", { name: "重新保存" })).toBeNull();
  });
});

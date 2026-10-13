import { renderHook } from "@testing-library/react";
import type { InkDoc } from "@tutor/contract";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  INK_UPLOAD_DEBOUNCE_MS,
  type InkSyncResult,
  type InkUploadHooks,
  isInkDocEmpty,
  useInkUpload,
} from "./use-ink-upload";

/**
 * 笔迹上传状态机测试（T2.8）：防抖上传、交卷 flush、失败重试语义。
 * putAttemptInkApi 与 gzip 全部 mock（jsdom 无 CompressionStream 与 canvas），
 * 引擎用可编程 stub（exportPng 返回固定 Blob）。
 */

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  putAttemptInkApi: vi.fn(async () => ({
    questionId: "q1",
    inkId: "ink-1",
    strokeCount: 1,
    width: 100,
    height: 50,
    updatedAt: "2026-09-27T00:00:00.000Z",
  })),
}));

// gzip mock：返回原文字节（服务端兼容原始 JSON）
vi.mock("@/features/ink/gzip", () => ({
  gzipOrRaw: async (text: string) => new TextEncoder().encode(text),
}));
vi.mock("@/features/ink/render-ink-snapshot", () => ({
  renderInkSnapshot: vi.fn(
    async () => new Blob([new Uint8Array([0x89, 0x50])], { type: "image/png" }),
  ),
}));

import { putAttemptInkApi } from "@/lib/api";

const putMock = vi.mocked(putAttemptInkApi);

function emptyDoc(): InkDoc {
  return {
    engine: "atrament",
    version: 1,
    data: { width: 1000, strokes: [] },
    updatedAt: 1,
  };
}

function docWith(strokes: number, updatedAt = 2): InkDoc {
  return {
    engine: "atrament",
    version: 1,
    data: {
      width: 1000,
      strokes: Array.from({ length: strokes }, () => ({
        tool: "pen" as const,
        color: "#000",
        weight: 4,
        points: [{ x: 1, y: 1, p: 0.5, t: 0 }],
      })),
    },
    updatedAt,
  };
}

/** 上传只依赖固定文档与回执，不再绑定编辑器实例。 */
function setup(hooks?: InkUploadHooks) {
  return renderHook(() => useInkUpload("att-1", "q1", hooks)).result;
}

beforeEach(() => {
  putMock.mockReset();
  putMock.mockResolvedValue({
    questionId: "q1",
    inkId: "ink-1",
    strokeCount: 1,
    width: 100,
    height: 50,
    updatedAt: "2026-09-27T00:00:00.000Z",
  });
  vi.useFakeTimers();
});

describe("isInkDocEmpty", () => {
  it("atrament 看 strokes 数；excalidraw 看 elements 数", () => {
    expect(isInkDocEmpty(emptyDoc())).toBe(true);
    expect(isInkDocEmpty(docWith(2))).toBe(false);
    expect(
      isInkDocEmpty({
        engine: "excalidraw",
        version: 1,
        data: { scene: { elements: [] } },
        updatedAt: 1,
      }),
    ).toBe(true);
  });
});

describe("防抖上传", () => {
  it("重试复用上传标识和字节，成功后下一稿使用新服务端基线", async () => {
    putMock.mockRejectedValueOnce(new Error("回执丢失"));
    putMock.mockResolvedValue({
      questionId: "q1",
      inkId: "ink-1",
      strokeCount: 1,
      width: 100,
      height: 50,
      updatedAt: "2026-10-13",
      revision: 5,
    });
    const result = setup();
    await act(async () => {
      result.current.controller.setBaseRevision?.(4);
      result.current.onDocChange(docWith(1));
      expect(await result.current.controller.flush()).toBe(false);
      expect(await result.current.controller.flush()).toBe(true);
      result.current.onDocChange(docWith(2));
      expect(await result.current.controller.flush()).toBe(true);
    });
    expect(putMock.mock.calls[0]?.[4]).toEqual(putMock.mock.calls[1]?.[4]);
    expect(putMock.mock.calls[0]?.[4]?.baseRevision).toBe(4);
    expect(putMock.mock.calls[2]?.[4]?.baseRevision).toBe(5);
  });
  it("flush 等待在途上传，并继续追平期间新增的稿，不把正常上传误报失败", async () => {
    let complete: (() => void) | undefined;
    putMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () =>
            resolve({
              questionId: "q1",
              inkId: "ink-1",
              strokeCount: 1,
              width: 100,
              height: 50,
              updatedAt: "2026-10-13",
            });
        }),
    );
    const result = setup();
    let first = Promise.resolve(false);
    let second = Promise.resolve(false);
    await act(async () => {
      result.current.onDocChange(docWith(1));
      first = result.current.controller.flush();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      result.current.onDocChange(docWith(2));
      second = result.current.controller.flush();
      complete?.();
      expect(await first).toBe(true);
      expect(await second).toBe(true);
    });
    expect(putMock).toHaveBeenCalledTimes(2);
    expect(result.current.controller.isDirty()).toBe(false);
  });
  it("笔迹变化后 2 秒防抖窗内合并为一次 PUT；参数含 gzip 字节与 PNG", async () => {
    const result = setup();
    act(() => {
      result.current.onDocChange(docWith(1));
    });
    act(() => {
      result.current.onDocChange(docWith(2));
    });
    expect(putMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INK_UPLOAD_DEBOUNCE_MS);
    });
    expect(putMock).toHaveBeenCalledTimes(1);
    // 只传最后一次的 doc（防抖合并）
    const args = putMock.mock.calls[0];
    expect(args?.[0]).toBe("att-1");
    expect(args?.[1]).toBe("q1");
    const strokesBlob = args?.[2];
    expect(strokesBlob).toBeInstanceOf(Blob);
  });

  it("无变化时 flush 是 no-op 成功（从未书写的题不阻塞交卷）", async () => {
    const result = setup();
    let ok = true;
    await act(async () => {
      ok = await result.current.controller.flush();
    });
    expect(ok).toBe(true);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("flush：清掉防抖定时器立即上传，成功返回 true", async () => {
    const result = setup();
    act(() => {
      result.current.onDocChange(docWith(3));
    });
    let ok = false;
    await act(async () => {
      ok = await result.current.controller.flush();
    });
    expect(ok).toBe(true);
    expect(putMock).toHaveBeenCalledTimes(1);
    // flush 后 dirty 清空：再次 flush 不重复上传
    await act(async () => {
      ok = await result.current.controller.flush();
    });
    expect(ok).toBe(true);
    expect(putMock).toHaveBeenCalledTimes(1);
  });

  it("上传失败：flush 返回 false（阻止交卷）、saveFailed 置位；恢复后可重试成功", async () => {
    putMock.mockRejectedValueOnce(new Error("network"));
    const result = setup();
    act(() => {
      result.current.onDocChange(docWith(1));
    });
    let ok = true;
    await act(async () => {
      ok = await result.current.controller.flush();
    });
    expect(ok).toBe(false);
    expect(result.current.saveFailed).toBe(true);
    // 网络恢复后重试（再次 flush）
    let retry = false;
    await act(async () => {
      retry = await result.current.controller.flush();
    });
    expect(retry).toBe(true);
    expect(result.current.saveFailed).toBe(false);
  });

  it("引擎已销毁仍能从固定矢量生成快照并上传", async () => {
    const result = setup();
    act(() => {
      result.current.onDocChange(docWith(1));
    });
    let ok = true;
    await act(async () => {
      ok = await result.current.controller.flush();
    });
    expect(ok).toBe(true);
    expect(result.current.controller.isDirty()).toBe(false);
  });
});

// ---------- T2.9：增量同步 sync / resync / hooks ----------

describe("sync()（草稿同步循环入口）", () => {
  it("无待传文档 → synced（不发包）", async () => {
    const result = setup();
    let outcome: InkSyncResult = "deferred";
    await act(async () => {
      outcome = await result.current.controller.sync();
    });
    expect(outcome).toBe("synced");
    expect(putMock).not.toHaveBeenCalled();
  });

  it("有待传 + 引擎可用 + 上传成功 → synced，onSynced 带本次上传的 doc", async () => {
    const onSynced = vi.fn();
    const result = setup({ onSynced });
    act(() => {
      result.current.onDocChange(docWith(2));
    });
    let outcome: InkSyncResult = "deferred";
    await act(async () => {
      outcome = await result.current.controller.sync();
    });
    expect(outcome).toBe("synced");
    expect(putMock).toHaveBeenCalledTimes(1);
    expect(onSynced).toHaveBeenCalledWith(docWith(2));
    expect(result.current.controller.isDirty()).toBe(false);
  });

  it("题卡收起后同步不依赖活画布", async () => {
    const result = setup();
    act(() => {
      result.current.onDocChange(docWith(1));
    });
    let outcome: InkSyncResult = "synced";
    await act(async () => {
      outcome = await result.current.controller.sync();
    });
    expect(outcome).toBe("synced");
    expect(putMock).toHaveBeenCalled();
    expect(result.current.controller.isDirty()).toBe(false);
  });

  it("上传失败 → failed，onFailed 回调（顶栏转离线）", async () => {
    putMock.mockRejectedValueOnce(new Error("network"));
    const onFailed = vi.fn();
    const result = setup({ onFailed });
    act(() => {
      result.current.onDocChange(docWith(1));
    });
    let outcome: InkSyncResult = "synced";
    await act(async () => {
      outcome = await result.current.controller.sync();
    });
    expect(outcome).toBe("failed");
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(result.current.controller.isDirty()).toBe(true);
  });
});

describe("resync()（本地较新恢复的补传入口）", () => {
  it("把文档放入待传并进 2 秒防抖；到期上传成功触发 onSynced", async () => {
    const onSynced = vi.fn();
    const result = setup({ onSynced });
    act(() => {
      result.current.controller.resync(docWith(3));
    });
    expect(putMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INK_UPLOAD_DEBOUNCE_MS);
    });
    expect(putMock).toHaveBeenCalledTimes(1);
    expect(onSynced).toHaveBeenCalledWith(docWith(3));
  });
});

import { renderHook } from "@testing-library/react";
import type { InkDoc } from "@tutor/contract";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InkEngine } from "@/features/ink/engine/index.ts";
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

vi.mock("@/lib/api", () => ({
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

import { putAttemptInkApi } from "@/lib/api";

const putMock = vi.mocked(putAttemptInkApi);

/** 可编程引擎 stub：exportPng 成功/失败可控 */
function makeEngine(options: { pngFails?: boolean } = {}): InkEngine {
  const doc = emptyDoc();
  return {
    getData: () => doc,
    load: () => undefined,
    exportPng: () =>
      options.pngFails
        ? Promise.reject(new Error("导出失败"))
        : Promise.resolve(
            new Blob([new Uint8Array([0x89, 0x50])], { type: "image/png" }),
          ),
    undo: () => undefined,
    redo: () => undefined,
    clear: () => undefined,
    setTool: () => undefined,
    on: () => () => undefined,
    canUndo: () => false,
    canRedo: () => false,
    destroy: () => undefined,
  };
}

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

/** 包一层 hook（engine 引用可替换）；hooks 透传给 useInkUpload */
function setup(
  engine: InkEngine | null,
  hooks?: InkUploadHooks,
) {
  const ref = { current: engine };
  return renderHook(() =>
    useInkUpload("att-1", "q1", () => ref.current, hooks),
  ).result;
}

beforeEach(() => {
  putMock.mockClear();
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
  it("笔迹变化后 2 秒防抖窗内合并为一次 PUT；参数含 gzip 字节与 PNG", async () => {
    const result = setup(makeEngine());
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
    const result = setup(makeEngine());
    let ok = true;
    await act(async () => {
      ok = await result.current.controller.flush();
    });
    expect(ok).toBe(true);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("flush：清掉防抖定时器立即上传，成功返回 true", async () => {
    const result = setup(makeEngine());
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
    const result = setup(makeEngine());
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

  it("引擎已销毁（退出全屏后未及时上传的边缘态）：flush 失败保留待传文档", async () => {
    const result = setup(null); // 引擎 getter 恒为 null（已销毁）
    act(() => {
      result.current.onDocChange(docWith(1));
    });
    let ok = true;
    await act(async () => {
      ok = await result.current.controller.flush();
    });
    expect(ok).toBe(false);
    // 待传文档保留：重开对应作答区（引擎恢复）后重试可成功
    expect(result.current.controller.isDirty()).toBe(true);
  });
});

// ---------- T2.9：增量同步 sync / resync / hooks ----------

describe("sync()（草稿同步循环入口）", () => {
  it("无待传文档 → synced（不发包）", async () => {
    const result = setup(makeEngine());
    let outcome: InkSyncResult = "deferred";
    await act(async () => {
      outcome = await result.current.controller.sync();
    });
    expect(outcome).toBe("synced");
    expect(putMock).not.toHaveBeenCalled();
  });

  it("有待传 + 引擎可用 + 上传成功 → synced，onSynced 带本次上传的 doc", async () => {
    const onSynced = vi.fn();
    const result = setup(makeEngine(), { onSynced });
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

  it("有待传但引擎不可用（题卡收起）→ deferred：不发 PUT、保留待传", async () => {
    const result = setup(null);
    act(() => {
      result.current.onDocChange(docWith(1));
    });
    let outcome: InkSyncResult = "synced";
    await act(async () => {
      outcome = await result.current.controller.sync();
    });
    expect(outcome).toBe("deferred");
    expect(putMock).not.toHaveBeenCalled();
    expect(result.current.controller.isDirty()).toBe(true);
  });

  it("上传失败 → failed，onFailed 回调（顶栏转离线）", async () => {
    putMock.mockRejectedValueOnce(new Error("network"));
    const onFailed = vi.fn();
    const result = setup(makeEngine(), { onFailed });
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
    const result = setup(makeEngine(), { onSynced });
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

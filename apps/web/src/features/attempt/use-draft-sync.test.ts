import { act, renderHook } from "@testing-library/react";
import type { StudentAnswer } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAttemptAnswerApi } from "@/lib/api";
import { draftStore, installDraftBackend, memoryBackend } from "./draft-store";
import { DRAFT_SYNC_INTERVAL_MS, useDraftSync } from "./use-draft-sync";
import type { InkSyncResult, InkUploadController } from "./use-ink-upload";

/**
 * 草稿同步引擎测试（T2.9）：10 秒定时 / visibilitychange / 断网不 PUT /
 * online 恢复补发 / 相同内容不重复 PUT / 三态状态机 / deferred 笔迹保持保存中。
 * idb-keyval 用注入的内存后端替代；答案 PUT mock @/lib/api。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    saveAttemptAnswerApi: vi.fn(async () => ({
      questionId: "q1",
      changeCount: 1,
    })),
  };
});

const mockedSave = vi.mocked(saveAttemptAnswerApi);

const judge: StudentAnswer = { kind: "judge", value: true };

/** 伪造的笔迹上传 controller */
function fakeInkController(
  dirty: boolean,
  outcome: InkSyncResult,
): InkUploadController {
  return {
    flush: async () => outcome !== "failed",
    isDirty: () => dirty,
    sync: async () => outcome,
    resync: () => undefined,
  };
}

function setupHook(
  serverDrafts: Record<string, StudentAnswer> = {},
  controllers = new Map<string, InkUploadController>(),
) {
  const ref = { current: controllers };
  return renderHook(() => useDraftSync("att-1", serverDrafts, ref));
}

let onLineSpy: ReturnType<typeof vi.spyOn>;

function setOnline(online: boolean): void {
  onLineSpy.mockReturnValue(online);
}

beforeEach(() => {
  installDraftBackend(memoryBackend());
  vi.useFakeTimers();
  mockedSave.mockReset();
  mockedSave.mockResolvedValue({ questionId: "q1", changeCount: 1 });
  onLineSpy = vi.spyOn(Navigator.prototype, "onLine", "get");
  onLineSpy.mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("进入答题页：合并恢复", () => {
  it("本地较新的答案合并进 recoveredDrafts 并立即补传（PUT）→ 状态已保存", async () => {
    draftStore.saveAnswer("att-1", "q1", judge);
    const { result } = setupHook({});
    // 合并 + 触发同步都是异步链
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.recoveredDrafts).toEqual({ q1: judge });
    expect(mockedSave).toHaveBeenCalledWith("att-1", "q1", judge);
    expect(result.current.status.state).toBe("saved");
    expect(
      result.current.status.state === "saved" && result.current.status.savedAt,
    ).toBeGreaterThan(0);
  });

  it("本地为空、服务端有草稿 → recoveredDrafts=服务端内容且不 PUT", async () => {
    const { result } = setupHook({ q1: judge });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.recoveredDrafts).toEqual({ q1: judge });
    expect(mockedSave).not.toHaveBeenCalled();
    expect(result.current.status.state).toBe("saved");
  });
});

describe("增量同步时机", () => {
  it("每 10 秒定时触发：到点把指纹不同的答案 PUT 出去", async () => {
    const { result } = setupHook({});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      draftStore.saveAnswer("att-1", "q2", { kind: "choice", index: 1 });
      result.current.noteLocalWrite();
    });
    expect(mockedSave).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_SYNC_INTERVAL_MS);
    });
    expect(mockedSave).toHaveBeenCalledWith("att-1", "q2", {
      kind: "choice",
      index: 1,
    });
  });

  it("visibilitychange 切后台：立即同步（不等 10 秒）并落盘", async () => {
    setupHook({});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      draftStore.saveAnswer("att-1", "q1", judge);
    });
    // jsdom 默认 visible，改为 hidden 后派发事件
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(mockedSave).toHaveBeenCalledWith("att-1", "q1", judge);
  });

  it("相同内容不重复 PUT：同步成功后再过 10 秒不再发包", async () => {
    setupHook({});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      draftStore.saveAnswer("att-1", "q1", judge);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_SYNC_INTERVAL_MS);
    });
    expect(mockedSave).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_SYNC_INTERVAL_MS * 3);
    });
    expect(mockedSave).toHaveBeenCalledTimes(1);
  });
});

describe("断网与恢复", () => {
  it("断网（navigator.onLine=false）：继续写本地、不 PUT、状态转离线", async () => {
    const { result } = setupHook({});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    setOnline(false);
    act(() => {
      draftStore.saveAnswer("att-1", "q1", judge);
      result.current.noteLocalWrite();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_SYNC_INTERVAL_MS);
    });
    expect(mockedSave).not.toHaveBeenCalled();
    expect(result.current.status.state).toBe("offline");
    // 本地写入不受网络影响
    expect(await draftStore.loadDraft("att-1")).toMatchObject({
      answers: { q1: judge },
    });
  });

  it("offline 事件（Wi-Fi 断开）→ 离线态；online 事件 → 自动补发并回到已保存", async () => {
    const { result } = setupHook({});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      draftStore.saveAnswer("att-1", "q1", judge);
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current.status.state).toBe("offline");
    setOnline(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_SYNC_INTERVAL_MS);
    });
    expect(mockedSave).not.toHaveBeenCalled();
    // 网络恢复
    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockedSave).toHaveBeenCalledWith("att-1", "q1", judge);
    expect(result.current.status.state).toBe("saved");
  });

  it("PUT 失败 → 离线态；下一轮定时重试成功 → 已保存", async () => {
    mockedSave.mockRejectedValueOnce(new Error("server 500"));
    const { result } = setupHook({});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      draftStore.saveAnswer("att-1", "q1", judge);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_SYNC_INTERVAL_MS);
    });
    expect(result.current.status.state).toBe("offline");
    // 内容仍在本地（离线已存本机的底气）
    expect((await draftStore.loadDraft("att-1"))?.answers.q1).toEqual(judge);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_SYNC_INTERVAL_MS);
    });
    expect(result.current.status.state).toBe("saved");
    expect(mockedSave).toHaveBeenCalledTimes(2);
  });
});

describe("状态机三态", () => {
  it("noteLocalWrite→保存中；noteSyncFailed→离线；noteLocalWrite 不解除离线", async () => {
    const { result } = setupHook({});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      result.current.noteLocalWrite();
    });
    expect(result.current.status.state).toBe("saving");
    act(() => {
      result.current.noteSyncFailed();
    });
    expect(result.current.status.state).toBe("offline");
    act(() => {
      result.current.noteLocalWrite();
    });
    expect(result.current.status.state).toBe("offline");
  });

  it("noteAnswerSynced 且内容全干净 → 已保存（带时间）", async () => {
    const { result } = setupHook({});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      draftStore.saveAnswer("att-1", "q1", judge);
      result.current.noteLocalWrite();
    });
    await act(async () => {
      result.current.noteAnswerSynced("q1", judge);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status.state).toBe("saved");
  });
});

describe("笔迹上传通道联动", () => {
  it("controller.deferred（引擎不可用）：不判失败，状态保持保存中、不误报离线", async () => {
    const controllers = new Map<string, InkUploadController>([
      ["q-ink", fakeInkController(true, "deferred")],
    ]);
    const { result } = setupHook({}, controllers);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // 真实链路里恢复补传/书写一笔都会 noteLocalWrite（进入保存中）
    act(() => {
      result.current.noteLocalWrite();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_SYNC_INTERVAL_MS);
    });
    expect(result.current.status.state).toBe("saving");
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("controller.failed → 离线态；下一轮恢复 → 已保存", async () => {
    const controllers = new Map<string, InkUploadController>([
      ["q-ink", fakeInkController(true, "failed")],
    ]);
    const { result } = setupHook({}, controllers);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_SYNC_INTERVAL_MS);
    });
    expect(result.current.status.state).toBe("offline");
    controllers.set("q-ink", fakeInkController(false, "synced"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_SYNC_INTERVAL_MS);
    });
    expect(result.current.status.state).toBe("saved");
  });
});

import type { NoteVersionReceipt } from "@tutor/contract";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docOf, stroke } from "@/features/notes/note-fixtures";
import {
  bindNoteSession,
  NOTE_SYNC_DEBOUNCE_MS,
  resetNoteSession,
} from "@/features/notes/note-sync";
import {
  installNoteBackend,
  memoryNoteBackend,
  peekNoteRecord,
  writeNoteDoc,
} from "@/features/notes/note-store";
import { useNoteRecord } from "@/features/notes/use-note-record";

/**
 * useNoteRecord 订阅测试（T6R.8）：未绑定会话 standby、写入→上传→回执的
 * 状态重渲染、卸载后作业仍完成（会话级服务，组件仅订阅）、切账号视图
 * 隔离。上传出网经 api mock 观察。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    putNoteDocumentApi: vi.fn(),
  };
});

const { putNoteDocumentApi } = await import("@/lib/api");
const putMock = vi.mocked(putNoteDocumentApi);

const SESSION = { origin: "https://tutor.example", studentId: "student-a" };
const SESSION_B = { origin: "https://tutor.example", studentId: "student-b" };
const SCOPE = { attemptId: "att-1", questionId: "p1-q1", phase: "scratch" } as const;

const DOC_A = docOf([stroke([[10, 10], [40, 40]])]);

const RECEIPT: NoteVersionReceipt = {
  noteId: "22222222-2222-4222-8222-222222222222",
  revision: 1,
  versionId: "33333333-3333-4333-8333-333333333333",
  hash: "a".repeat(64),
  savedAt: "2026-10-06T00:00:00.000Z",
};

function renderProbe(
  attemptId = SCOPE.attemptId,
  questionId = SCOPE.questionId,
): { current: () => ReturnType<typeof useNoteRecord>; unmount: () => void } {
  let latest: ReturnType<typeof useNoteRecord> = null;
  function Probe() {
    latest = useNoteRecord(attemptId, questionId);
    return null;
  }
  const { unmount } = render(<Probe />);
  return { current: () => latest, unmount };
}

beforeEach(() => {
  vi.useFakeTimers();
  installNoteBackend(memoryNoteBackend());
  resetNoteSession();
  putMock.mockReset().mockResolvedValue(RECEIPT);
});

afterEach(() => {
  resetNoteSession();
  vi.useRealTimers();
});

describe("useNoteRecord（T6R.8）", () => {
  it("会话未绑定 → standby（null）", () => {
    const probe = renderProbe();
    expect(probe.current()).toBeNull();
    probe.unmount();
  });

  it("订阅写入→上传→回执：dirty→uploading→synced 重渲染；四维总览可见", async () => {
    const probe = renderProbe();
    bindNoteSession(SESSION);
    expect(probe.current()).toBeNull(); // 记录尚未创建
    act(() => {
      writeNoteDoc(SESSION, SCOPE, DOC_A);
    });
    let view = probe.current();
    expect(view?.doc?.ink.strokes.length).toBe(1);
    expect(view?.overview.server).toBe("dirty");
    expect(view?.overview.evidence).toBe("none");
    // 防抖到期 → 上传中
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS - 1);
    });
    expect(putMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    view = probe.current();
    // 回执已落地（mock 即时成功）：synced + 本机已存
    expect(view?.overview.server).toBe("synced");
    expect(view?.overview.local).toBe("saved");
    expect(view?.baseRevision).toBe(1);
    expect(peekNoteRecord(SESSION, SCOPE)?.pending).toBeNull();
    probe.unmount();
  });

  it("卸载后已授权作业仍完成（收起题卡/路由切换）", async () => {
    bindNoteSession(SESSION);
    act(() => {
      writeNoteDoc(SESSION, SCOPE, DOC_A);
    });
    const probe = renderProbe();
    probe.unmount(); // 组件消失
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    });
    expect(putMock.mock.calls.length).toBe(1); // 上传照常完成
    const record = peekNoteRecord(SESSION, SCOPE);
    expect(record?.baseRevision).toBe(1);
    expect(record?.pending).toBeNull();
  });

  it("切账号：新会话视图不读旧账号记录", async () => {
    bindNoteSession(SESSION);
    act(() => {
      writeNoteDoc(SESSION, SCOPE, DOC_A);
    });
    bindNoteSession(SESSION_B);
    const probe = renderProbe();
    expect(probe.current()).toBeNull(); // B 名下无记录（键前缀隔离）
    probe.unmount();
  });
});

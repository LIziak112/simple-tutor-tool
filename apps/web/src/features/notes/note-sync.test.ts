import type { NoteVersionReceipt } from "@tutor/contract";
import { noteDocSchema } from "@tutor/contract";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docOf, stroke } from "@/features/notes/note-fixtures";
import {
  getNoteRecord,
  installNoteBackend,
  memoryNoteBackend,
  type NoteStoreBackend,
  peekNoteRecord,
} from "@/features/notes/note-store";

/**
 * 会话同步队列（T6R.8，方案 §6.2）测试：2s 防抖+10s 最大等待、单文档单
 * 在途（A 回执不清 B）、退避与幂等重试（同 mutationId 重放）、重进补传、
 * 409 冲突保留两份（多标签页/跨设备同机制：服务端 head 已进）、403/404
 * 终态、413 内容拒、清空=空稿上传、恢复在线/可见补传、切账号隔离与中止。
 * putNoteDocumentApi 以 vi.fn 替换（真实客户端组装已由 api-note-put.test
 * 覆盖）；可控时钟 vi.useFakeTimers；后端内存注入（重载模拟=重装同一后端）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    putNoteDocumentApi: vi.fn(),
    fetchStudentNoteDocumentApi: vi.fn(),
  };
});

import { ApiError, fetchStudentNoteDocumentApi, putNoteDocumentApi } from "@/lib/api";
import {
  bindNoteSession,
  flushNoteSync,
  NOTE_SYNC_BACKOFF_BASE_MS,
  NOTE_SYNC_DEBOUNCE_MS,
  NOTE_SYNC_MAX_WAIT_MS,
  resetNoteSession,
  resolveNoteConflictKeepCloud,
  resolveNoteConflictKeepLocal,
} from "@/features/notes/note-sync";
import { writeNoteDoc } from "@/features/notes/note-store";

const putMock = vi.mocked(putNoteDocumentApi);

const SESSION = { origin: "https://tutor.example", studentId: "student-a" };
const SESSION_B = { origin: "https://tutor.example", studentId: "student-b" };
const SCOPE = { attemptId: "att-1", questionId: "p1-q1", phase: "scratch" } as const;

const DOC_A = docOf([stroke([[10, 10], [40, 40]])]);
const DOC_B = docOf([stroke([[10, 10], [40, 40]]), stroke([[50, 50], [80, 80]])]);
const DOC_EMPTY = docOf([]);

function receiptOf(revision: number): NoteVersionReceipt {
  return {
    noteId: "22222222-2222-4222-8222-222222222222",
    revision,
    versionId: `33333333-3333-4333-8333-3333333333${String(revision).padStart(2, "0")}`,
    hash: `${"a".repeat(63)}${revision}`,
    savedAt: "2026-10-06T00:00:00.000Z",
  };
}

/** 解上传 body（gzip 魔数判断，兼容 jsdom 无压缩回退的原始 JSON） */
async function bodyDoc(blob: Blob): Promise<{ ink: { strokes: unknown[] } }> {
  const buf = Buffer.from(await blob.arrayBuffer());
  const raw =
    buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
  return JSON.parse(raw.toString("utf8")) as { ink: { strokes: unknown[] } };
}

/** 上传参数便捷取用（mock.calls[i]） */
function callOf(i: number) {
  const call = putMock.mock.calls[i];
  if (call === undefined) throw new Error(`put 第 ${i} 次调用不存在`);
  return {
    meta: call[3],
    signal: call[4] as AbortSignal | undefined,
    blob: call[2],
  };
}

/** 挂起一次 PUT（手动放行），用于在途窗口内制造并发写/切账号 */
function deferredPut() {
  let resolve!: (r: NoteVersionReceipt) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<NoteVersionReceipt>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  putMock.mockImplementationOnce(() => promise);
  return { resolve, reject };
}

function conflictError(revision: number) {
  return new ApiError(
    "NOTE_REVISION_CONFLICT",
    "草稿已在别处保存了更新的版本",
    409,
    {
      _current: {
        noteId: "22222222-2222-4222-8222-222222222222",
        revision,
        versionId: "55555555-5555-4555-8555-555555555555",
        hash: "c".repeat(64),
        serverSavedAt: "2026-10-06T02:00:00.000Z",
      },
    },
  );
}

let backend: NoteStoreBackend;

beforeEach(() => {
  vi.useFakeTimers();
  backend = memoryNoteBackend();
  installNoteBackend(backend);
  resetNoteSession();
  putMock.mockReset();
  bindNoteSession(SESSION);
});

afterEach(() => {
  resetNoteSession();
});

describe("note-sync：调度（防抖与最大等待）", () => {
  it("2s 停笔防抖：1999ms 不发、到 2s 发一次（baseRevision=0 起步）", async () => {
    putMock.mockResolvedValue(receiptOf(1));
    writeNoteDoc(SESSION, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS - 1);
    expect(putMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(putMock.mock.calls.length).toBe(1);
    expect(callOf(0).meta.baseRevision).toBe(0);
    const record = await getNoteRecord(SESSION, SCOPE);
    expect(record?.pending).toBeNull(); // 回执落地清 pending
    expect(record?.baseRevision).toBe(1);
    expect(peekNoteRecord(SESSION, SCOPE)?.conflict).toBeNull();
  });

  it("持续书写仍触发最大等待：防抖一直被重置，10s 强制上传最新稿", async () => {
    putMock.mockResolvedValue(receiptOf(1));
    // 每 1.5s 写一笔（防抖恒被重置）；doc 逐笔累积笔画
    for (let i = 1; i <= 7; i++) {
      writeNoteDoc(
        SESSION,
        SCOPE,
        docOf(
          Array.from({ length: i }, (_, k) => stroke([[0, 0], [10, k + 1]])),
        ),
      );
      await vi.advanceTimersByTimeAsync(1500);
    }
    // t=10.5s：最大等待（首笔 t=0 +10s）已触发
    expect(putMock.mock.calls.length).toBe(1);
    const body = await bodyDoc(callOf(0).blob);
    expect(body.ink.strokes.length).toBe(7); // 传的是最新稿
  });

  it("清空也同步：空稿作为新版本上传（覆盖语义，非取消同步）", async () => {
    putMock.mockResolvedValueOnce(receiptOf(1)).mockResolvedValueOnce(receiptOf(2));
    writeNoteDoc(SESSION, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect((await bodyDoc(callOf(0).blob)).ink.strokes.length).toBe(1);
    writeNoteDoc(SESSION, SCOPE, DOC_EMPTY);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(2);
    expect((await bodyDoc(callOf(1).blob)).ink.strokes.length).toBe(0);
    expect(callOf(1).meta.baseRevision).toBe(1); // 基于 A 的回执续传
  });
});

describe("note-sync：单文档单在途（A 回执不清 B）", () => {
  it("A 在途时写 B：A 回执只确认 A，B 仍 dirty 随后带新 baseRevision 上传", async () => {
    const hang = deferredPut();
    writeNoteDoc(SESSION, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(1);
    const mutationA = callOf(0).meta.mutationId;
    // A 在途期间写 B
    writeNoteDoc(SESSION, SCOPE, DOC_B);
    hang.resolve(receiptOf(1));
    await vi.advanceTimersByTimeAsync(0);
    const record = peekNoteRecord(SESSION, SCOPE);
    expect(record?.baseRevision).toBe(1); // A 的 head 已推进
    expect(record?.pending?.mutationId).not.toBe(mutationA); // B 未被清
    // B 的防抖到期后上传：baseRevision=A 回执、mutationId=B 的新值
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(2);
    expect(callOf(1).meta.baseRevision).toBe(1);
    expect(callOf(1).meta.mutationId).not.toBe(mutationA);
    expect((await bodyDoc(callOf(1).blob)).ink.strokes.length).toBe(2);
  });

  it("在途期间最大等待到期不并发第二个请求（全局串行队列兜底）", async () => {
    putMock.mockResolvedValue(receiptOf(2)); // 后续调用（B）正常回执
    const hang = deferredPut();
    writeNoteDoc(SESSION, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS); // A 在途
    writeNoteDoc(SESSION, SCOPE, DOC_B);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_MAX_WAIT_MS); // 最大等待也到期
    expect(putMock.mock.calls.length).toBe(1); // 仍单在途
    hang.resolve(receiptOf(1));
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS); // B 防抖
    expect(putMock.mock.calls.length).toBe(2);
  });
});

describe("note-sync：重试、退避与幂等", () => {
  it("网络失败退避重试：同 mutationId 重放（幂等），间隔 1s→2s→4s", async () => {
    putMock
      .mockRejectedValueOnce(new Error("连不上服务器"))
      .mockRejectedValueOnce(new Error("连不上服务器"))
      .mockRejectedValueOnce(new Error("连不上服务器"))
      .mockResolvedValue(receiptOf(1));
    writeNoteDoc(SESSION, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS); // t=2s 首传失败
    expect(putMock.mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_BACKOFF_BASE_MS - 1); // t<3s
    expect(putMock.mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1); // t=3s 第一次退避重试
    expect(putMock.mock.calls.length).toBe(2);
    await vi.advanceTimersByTimeAsync(2 * NOTE_SYNC_BACKOFF_BASE_MS); // t=5s
    expect(putMock.mock.calls.length).toBe(3);
    await vi.advanceTimersByTimeAsync(4 * NOTE_SYNC_BACKOFF_BASE_MS); // t=9s 成功
    expect(putMock.mock.calls.length).toBe(4);
    const ids = putMock.mock.calls.map((c) => c[3].mutationId);
    expect(new Set(ids).size).toBe(1); // 幂等：同 mutationId 重放
    expect(peekNoteRecord(SESSION, SCOPE)?.pending).toBeNull();
  });

  it("重进后补传：重载（内存清空、IDB 保留）发现 pending 自动续传", async () => {
    writeNoteDoc(SESSION, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(0); // 落盘
    const mutationBefore = peekNoteRecord(SESSION, SCOPE)?.pending?.mutationId;
    putMock.mockResolvedValue(receiptOf(1));
    // 模拟重进：同一后端重装（清内存缓存，数据仍在），重绑会话触发扫描
    resetNoteSession();
    installNoteBackend(backend);
    bindNoteSession(SESSION);
    expect(putMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(1);
    expect(callOf(0).meta.mutationId).toBe(mutationBefore); // 落盘的幂等键续用
    expect(peekNoteRecord(SESSION, SCOPE)?.baseRevision).toBe(1);
  });

  it("恢复在线/可见主动补传：不等退避计时器", async () => {
    putMock.mockRejectedValueOnce(new Error("网络中断")).mockResolvedValue(receiptOf(1));
    writeNoteDoc(SESSION, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS); // 首传失败，退避 1s
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(putMock.mock.calls.length).toBe(2); // 在线即补传，未到退避点
    expect(peekNoteRecord(SESSION, SCOPE)?.pending).toBeNull();

    // 可见恢复同机制
    putMock.mockRejectedValueOnce(new Error("网络中断")).mockResolvedValue(receiptOf(2));
    writeNoteDoc(SESSION, SCOPE, DOC_B);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(putMock.mock.calls.length).toBe(4);
  });

  it("flushNoteSync：防抖未到也立即补传（交卷/切后台入口，T6R.10 用）", async () => {
    putMock.mockResolvedValue(receiptOf(1));
    writeNoteDoc(SESSION, SCOPE, DOC_A);
    await flushNoteSync();
    expect(putMock.mock.calls.length).toBe(1);
    expect(peekNoteRecord(SESSION, SCOPE)?.pending).toBeNull();
  });
});

describe("note-sync：冲突与终态", () => {
  it("409 NOTE_REVISION_CONFLICT → conflict 态保留两份副本、停止自动重试", async () => {
    putMock.mockRejectedValueOnce(conflictError(2));
    writeNoteDoc(SESSION, SCOPE, DOC_B);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(1);
    const record = peekNoteRecord(SESSION, SCOPE);
    expect(record?.conflict?.current.revision).toBe(2);
    expect(record?.conflict?.localDoc).toBeDefined(); // 本地副本
    expect(record?.doc).toBeDefined(); // 工作稿仍在
    expect(record?.pending).not.toBeNull(); // 待传保留（裁决后复用）
    // 30s 内不再自动重试
    await vi.advanceTimersByTimeAsync(30_000);
    expect(putMock.mock.calls.length).toBe(1);
  });

  it("多标签页/跨设备同机制：服务端 head 已进（rev1）→ 本地 base0 上传 409 保留两份", async () => {
    // 服务端已有他人（另一标签页/设备）的 rev1
    putMock.mockRejectedValueOnce(conflictError(1));
    writeNoteDoc(SESSION, SCOPE, DOC_B); // 本地从 0 起步（未见过 rev1）
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    const record = peekNoteRecord(SESSION, SCOPE);
    expect(record?.conflict?.current.revision).toBe(1);
    expect(record?.conflict?.localDoc).toEqual(DOC_B);
  });

  it("403/404 → denied 终态：保本地、停自动重试、后续写入也不复活", async () => {
    putMock.mockRejectedValueOnce(
      new ApiError("FORBIDDEN", "已无权限访问该练习", 403),
    );
    writeNoteDoc(SESSION, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    const record = peekNoteRecord(SESSION, SCOPE);
    expect(record?.denied?.kind).toBe("access");
    expect(record?.pending).not.toBeNull(); // 本地保留
    writeNoteDoc(SESSION, SCOPE, DOC_B); // 权限终态粘住：新写也不自动上传
    await vi.advanceTimersByTimeAsync(60_000);
    expect(putMock.mock.calls.length).toBe(1);
  });

  it("409 ALREADY_SUBMITTED（交卷后迟到 PUT）→ denied(access) 终态", async () => {
    putMock.mockRejectedValueOnce(
      new ApiError("ALREADY_SUBMITTED", "已交卷，原稿已固定", 409),
    );
    writeNoteDoc(SESSION, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect(peekNoteRecord(SESSION, SCOPE)?.denied?.kind).toBe("access");
  });

  it("413 NOTE_LIMIT_EXCEEDED → denied(content)：新内容重新可传", async () => {
    putMock
      .mockRejectedValueOnce(
        new ApiError("NOTE_LIMIT_EXCEEDED", "草稿超出大小预算", 413),
      )
      .mockResolvedValue(receiptOf(1));
    writeNoteDoc(SESSION, SCOPE, DOC_B);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect(peekNoteRecord(SESSION, SCOPE)?.denied?.kind).toBe("content");
    // 用户擦掉部分笔画后新写：新 pending 复活自动上传
    writeNoteDoc(SESSION, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(2);
    expect(peekNoteRecord(SESSION, SCOPE)?.denied).toBeNull();
    expect(peekNoteRecord(SESSION, SCOPE)?.pending).toBeNull();
  });

  it("冲突裁决 keepLocal：对齐云端 revision 后同 mutationId 重传成功", async () => {
    putMock
      .mockRejectedValueOnce(conflictError(2))
      .mockResolvedValue(receiptOf(3));
    writeNoteDoc(SESSION, SCOPE, DOC_B);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    const mutation = peekNoteRecord(SESSION, SCOPE)?.pending?.mutationId;
    await resolveNoteConflictKeepLocal(SESSION, SCOPE);
    await vi.advanceTimersByTimeAsync(0);
    expect(putMock.mock.calls.length).toBe(2);
    expect(callOf(1).meta.baseRevision).toBe(2); // 对齐云端摘要
    expect(callOf(1).meta.mutationId).toBe(mutation); // 幂等键复用
    expect(peekNoteRecord(SESSION, SCOPE)?.conflict).toBeNull();
    expect(peekNoteRecord(SESSION, SCOPE)?.pending).toBeNull();
  });

  it("冲突裁决 keepCloud：拉云端稿为工作稿、清 pending、不再上传", async () => {
    vi.mocked(fetchStudentNoteDocumentApi).mockResolvedValue(
      noteDocSchema.parse(DOC_A),
    );
    putMock.mockRejectedValueOnce(conflictError(2));
    writeNoteDoc(SESSION, SCOPE, DOC_B);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    await resolveNoteConflictKeepCloud(SESSION, SCOPE);
    const record = peekNoteRecord(SESSION, SCOPE);
    expect(record?.conflict).toBeNull();
    expect(record?.pending).toBeNull();
    expect(record?.doc).toEqual(DOC_A); // 云端稿成为工作稿
    await vi.advanceTimersByTimeAsync(30_000);
    expect(putMock.mock.calls.length).toBe(1); // 不再上传
  });
});

describe("note-sync：账号切换与登出隔离", () => {
  it("切账号：旧会话在途被中止、回执被忽略、新账号不读不续传旧数据", async () => {
    const hang = deferredPut();
    writeNoteDoc(SESSION, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    const signal = callOf(0).signal;
    // 切到账号 B：立即失效旧会话
    bindNoteSession(SESSION_B);
    expect(signal?.aborted).toBe(true); // 中止在途
    hang.resolve(receiptOf(1)); // A 的迟到回执
    await vi.advanceTimersByTimeAsync(60_000);
    expect(putMock.mock.calls.length).toBe(1); // A 不再续传
    const recordA = peekNoteRecord(SESSION, SCOPE);
    expect(recordA?.baseRevision).toBe(0); // 迟到回执未落地
    expect(recordA?.pending).not.toBeNull(); // 本地稿保留（不静默删）
    // 新账号读不到 A 的记录（键前缀隔离）
    expect(await getNoteRecord(SESSION_B, SCOPE)).toBeNull();
  });

  it("登出（resetNoteSession）：清监听与计时器，旧会话不再有任何上传", async () => {
    putMock.mockRejectedValue(new Error("网络中断"));
    writeNoteDoc(SESSION, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS); // 首传失败
    resetNoteSession();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(putMock.mock.calls.length).toBe(1); // 退避/在线触发全部失效
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(putMock.mock.calls.length).toBe(1);
  });
});

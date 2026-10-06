import { gunzipSync } from "node:zlib";
import type { NoteVersionReceipt } from "@tutor/contract";
import { noteDocSchema } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docOf, stroke } from "@/features/notes/note-fixtures";
import {
  getNoteRecord,
  installNoteBackend,
  memoryNoteBackend,
  type NoteStoreBackend,
  peekNoteRecord,
  writeNoteDoc,
} from "@/features/notes/note-store";
import {
  DOC_A,
  DOC_B,
  DOC_EMPTY,
  receiptOf,
  SCOPE,
  SESSION_A,
  SESSION_B,
} from "@/features/notes/note-test-utils";

/**
 * 会话同步队列（T6R.8，方案 §6.2）测试：2s 防抖+10s 最大等待、单文档单
 * 在途（A 回执不清 B）、退避与幂等重试（同 mutationId 重放）、重进补传、
 * 409 冲突保留两份（多标签页/跨设备同机制：服务端 head 已进）与 MISMATCH
 * 无摘要裁决、403/404 终态、413 内容拒、清空=空稿上传、恢复在线/可见补传、
 * 切账号隔离与中止。
 * putNoteDocumentApi 以 vi.fn 替换（真实客户端组装已由 api-note-put.test
 * 覆盖）；可控时钟 vi.useFakeTimers；后端内存注入（重载模拟=重装同一后端）。
 * 共用夹具/回执工厂在 note-test-utils（复审⑪）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    putNoteDocumentApi: vi.fn(),
    fetchStudentNoteDocumentApi: vi.fn(),
  };
});

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
import {
  ApiError,
  fetchStudentNoteDocumentApi,
  putNoteDocumentApi,
} from "@/lib/api";

const putMock = vi.mocked(putNoteDocumentApi);

/** 解上传 body（gzip 魔数判断，兼容 jsdom 无压缩回退的原始 JSON） */
async function bodyDoc(blob: Blob): Promise<{ ink: { strokes: unknown[] } }> {
  const buf = Buffer.from(await blob.arrayBuffer());
  const raw = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
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
  bindNoteSession(SESSION_A);
});

afterEach(() => {
  resetNoteSession();
});

describe("note-sync：调度（防抖与最大等待）", () => {
  it("2s 停笔防抖：1999ms 不发、到 2s 发一次（baseRevision=0 起步）", async () => {
    putMock.mockResolvedValue(receiptOf(1));
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS - 1);
    expect(putMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(putMock.mock.calls.length).toBe(1);
    expect(callOf(0).meta.baseRevision).toBe(0);
    const record = await getNoteRecord(SESSION_A, SCOPE);
    expect(record?.pending).toBeNull(); // 回执落地清 pending
    expect(record?.baseRevision).toBe(1);
    expect(peekNoteRecord(SESSION_A, SCOPE)?.conflict).toBeNull();
  });

  it("持续书写仍触发最大等待：防抖一直被重置，10s 强制上传最新稿", async () => {
    putMock.mockResolvedValue(receiptOf(1));
    // 每 1.5s 写一笔（防抖恒被重置）；doc 逐笔累积笔画
    for (let i = 1; i <= 7; i++) {
      writeNoteDoc(
        SESSION_A,
        SCOPE,
        docOf(
          Array.from({ length: i }, (_, k) =>
            stroke([
              [0, 0],
              [10, k + 1],
            ]),
          ),
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
    putMock
      .mockResolvedValueOnce(receiptOf(1))
      .mockResolvedValueOnce(receiptOf(2));
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect((await bodyDoc(callOf(0).blob)).ink.strokes.length).toBe(1);
    writeNoteDoc(SESSION_A, SCOPE, DOC_EMPTY);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(2);
    expect((await bodyDoc(callOf(1).blob)).ink.strokes.length).toBe(0);
    expect(callOf(1).meta.baseRevision).toBe(1); // 基于 A 的回执续传
  });
});

describe("note-sync：单文档单在途（A 回执不清 B）", () => {
  it("A 在途时写 B：A 回执只确认 A，B 仍 dirty 随后带新 baseRevision 上传", async () => {
    const hang = deferredPut();
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(1);
    const mutationA = callOf(0).meta.mutationId;
    // A 在途期间写 B
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    hang.resolve(receiptOf(1));
    await vi.advanceTimersByTimeAsync(0);
    const record = peekNoteRecord(SESSION_A, SCOPE);
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
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS); // A 在途
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
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
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS); // t=2s 首传失败
    expect(putMock.mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_BACKOFF_BASE_MS - 1); // t<3s
    expect(putMock.mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1); // t=3s 第一次退避重试
    expect(putMock.mock.calls.length).toBe(2);
    await vi.advanceTimersByTimeAsync(2 * NOTE_SYNC_BACKOFF_BASE_MS); // t=5s
    expect(putMock.mock.calls.length).toBe(3);
    // 复审③：t=5s~9s 之间退避不得被防抖击穿（uploading 翻转等通知不再
    // 重挂防抖）——t=6.9s 仍只有 3 次，第三次重试必须等到 t=9s
    await vi.advanceTimersByTimeAsync(1.9 * NOTE_SYNC_BACKOFF_BASE_MS);
    expect(putMock.mock.calls.length).toBe(3);
    await vi.advanceTimersByTimeAsync(4 * NOTE_SYNC_BACKOFF_BASE_MS - 1.9 * NOTE_SYNC_BACKOFF_BASE_MS); // t=9s 成功
    expect(putMock.mock.calls.length).toBe(4);
    const ids = putMock.mock.calls.map((c) => c[3].mutationId);
    expect(new Set(ids).size).toBe(1); // 幂等：同 mutationId 重放
    expect(peekNoteRecord(SESSION_A, SCOPE)?.pending).toBeNull();
  });

  it("持续书写 25s 至少触发两次强制上传点（复审⑥：完成即重锚下一窗口）", async () => {
    putMock.mockResolvedValue(receiptOf(99));
    // 每 1.5s 写一笔，防抖恒被内容写入重置——唯一上传时机是最大等待
    for (let i = 1; i <= 17; i++) {
      writeNoteDoc(
        SESSION_A,
        SCOPE,
        docOf(
          Array.from({ length: i }, (_, k) => stroke([[0, 0], [10, k + 1]])),
        ),
      );
      await vi.advanceTimersByTimeAsync(1500);
    }
    // t=25.5s：强刷点 t=10s 与重锚后的 t≈20.5s 各至少一次
    expect(putMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(peekNoteRecord(SESSION_A, SCOPE)?.baseRevision).toBe(99); // 末次回执已落地
  });

  it("重进后补传：重载（内存清空、IDB 保留）发现 pending 自动续传", async () => {
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(0); // 落盘
    const mutationBefore = peekNoteRecord(SESSION_A, SCOPE)?.pending
      ?.mutationId;
    putMock.mockResolvedValue(receiptOf(1));
    // 模拟重进：同一后端重装（清内存缓存，数据仍在），重绑会话触发扫描
    resetNoteSession();
    installNoteBackend(backend);
    bindNoteSession(SESSION_A);
    expect(putMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(1);
    expect(callOf(0).meta.mutationId).toBe(mutationBefore); // 落盘的幂等键续用
    expect(peekNoteRecord(SESSION_A, SCOPE)?.baseRevision).toBe(1);
  });

  it("恢复在线/可见主动补传：不等退避计时器", async () => {
    putMock
      .mockRejectedValueOnce(new Error("网络中断"))
      .mockResolvedValue(receiptOf(1));
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS); // 首传失败，退避 1s
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(putMock.mock.calls.length).toBe(2); // 在线即补传，未到退避点
    expect(peekNoteRecord(SESSION_A, SCOPE)?.pending).toBeNull();

    // 可见恢复同机制
    putMock
      .mockRejectedValueOnce(new Error("网络中断"))
      .mockResolvedValue(receiptOf(2));
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(putMock.mock.calls.length).toBe(4);
  });

  it("flushNoteSync：防抖未到也立即补传（交卷/切后台入口，T6R.10 用）", async () => {
    putMock.mockResolvedValue(receiptOf(1));
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await flushNoteSync();
    expect(putMock.mock.calls.length).toBe(1);
    expect(peekNoteRecord(SESSION_A, SCOPE)?.pending).toBeNull();
  });
});

describe("note-sync：冲突与终态", () => {
  it("409 NOTE_REVISION_CONFLICT → conflict 态保留两份副本、停止自动重试", async () => {
    putMock.mockRejectedValueOnce(conflictError(2));
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(1);
    const record = peekNoteRecord(SESSION_A, SCOPE);
    expect(record?.conflict?.current?.revision).toBe(2);
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
    writeNoteDoc(SESSION_A, SCOPE, DOC_B); // 本地从 0 起步（未见过 rev1）
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    const record = peekNoteRecord(SESSION_A, SCOPE);
    expect(record?.conflict?.current?.revision).toBe(1);
    expect(record?.conflict?.localDoc).toEqual(DOC_B);
  });

  it("403/404 → denied 终态：保本地、停自动重试、后续写入也不复活", async () => {
    putMock.mockRejectedValueOnce(
      new ApiError("FORBIDDEN", "已无权限访问该练习", 403),
    );
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    const record = peekNoteRecord(SESSION_A, SCOPE);
    expect(record?.denied?.kind).toBe("access");
    expect(record?.pending).not.toBeNull(); // 本地保留
    writeNoteDoc(SESSION_A, SCOPE, DOC_B); // 权限终态粘住：新写也不自动上传
    await vi.advanceTimersByTimeAsync(60_000);
    expect(putMock.mock.calls.length).toBe(1);
  });

  it("409 ALREADY_SUBMITTED（交卷后迟到 PUT）→ denied(access) 终态", async () => {
    putMock.mockRejectedValueOnce(
      new ApiError("ALREADY_SUBMITTED", "已交卷，原稿已固定", 409),
    );
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect(peekNoteRecord(SESSION_A, SCOPE)?.denied?.kind).toBe("access");
  });

  it("413 NOTE_LIMIT_EXCEEDED → denied(content)：新内容重新可传", async () => {
    putMock
      .mockRejectedValueOnce(
        new ApiError("NOTE_LIMIT_EXCEEDED", "草稿超出大小预算", 413),
      )
      .mockResolvedValue(receiptOf(1));
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect(peekNoteRecord(SESSION_A, SCOPE)?.denied?.kind).toBe("content");
    // 用户擦掉部分笔画后新写：新 pending 复活自动上传
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(2);
    expect(peekNoteRecord(SESSION_A, SCOPE)?.denied).toBeNull();
    expect(peekNoteRecord(SESSION_A, SCOPE)?.pending).toBeNull();
  });

  it("冲突裁决 keepLocal：对齐云端 revision 后同 mutationId 重传成功", async () => {
    putMock
      .mockRejectedValueOnce(conflictError(2))
      .mockResolvedValue(receiptOf(3));
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    const mutation = peekNoteRecord(SESSION_A, SCOPE)?.pending?.mutationId;
    await resolveNoteConflictKeepLocal(SESSION_A, SCOPE);
    await vi.advanceTimersByTimeAsync(0);
    expect(putMock.mock.calls.length).toBe(2);
    expect(callOf(1).meta.baseRevision).toBe(2); // 对齐云端摘要
    expect(callOf(1).meta.mutationId).toBe(mutation); // 幂等键复用（REVISION_CONFLICT：被拒未落库，重放是干净 CAS 写）
    expect(peekNoteRecord(SESSION_A, SCOPE)?.conflict).toBeNull();
    expect(peekNoteRecord(SESSION_A, SCOPE)?.pending).toBeNull();
  });

  it("MISMATCH 冲突无云端摘要：keepLocal 重铸 mutationId 重传成功（不死循环）", async () => {
    putMock
      .mockRejectedValueOnce(
        new ApiError(
          "NOTE_MUTATION_MISMATCH",
          "同一上传标识已对应不同正文",
          409,
        ),
      )
      .mockResolvedValue(receiptOf(2));
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    const mutationBefore = peekNoteRecord(SESSION_A, SCOPE)?.pending
      ?.mutationId;
    const record = peekNoteRecord(SESSION_A, SCOPE);
    expect(record?.conflict?.current).toBeNull(); // 服务端状态未知：无摘要
    await resolveNoteConflictKeepLocal(SESSION_A, SCOPE);
    await vi.advanceTimersByTimeAsync(0);
    expect(putMock.mock.calls.length).toBe(2); // 重传成功，未循环回 MISMATCH
    expect(callOf(1).meta.mutationId).not.toBe(mutationBefore); // 幂等键已重铸
    expect(callOf(1).meta.baseRevision).toBe(0); // 无摘要可对齐：维持本地已知
    expect(peekNoteRecord(SESSION_A, SCOPE)?.conflict).toBeNull();
    expect(peekNoteRecord(SESSION_A, SCOPE)?.pending).toBeNull();
  });

  it("keepCloud 拉取在途期间的新写不被云端稿覆盖（复审⑤）", async () => {
    let releaseFetch: (doc: unknown) => void = () => {};
    vi.mocked(fetchStudentNoteDocumentApi).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFetch = (doc: unknown) => resolve(doc);
        }),
    );
    putMock
      .mockRejectedValueOnce(conflictError(2))
      .mockResolvedValue(receiptOf(3));
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS); // 409 → conflict
    const resolving = resolveNoteConflictKeepCloud(SESSION_A, SCOPE);
    await Promise.resolve(); // fetch 已挂起
    writeNoteDoc(SESSION_A, SCOPE, DOC_EMPTY); // 裁决拉取在途期间用户清空重写
    releaseFetch(noteDocSchema.parse(DOC_A)); // 云端稿（A 内容）返回
    await resolving;
    const record = peekNoteRecord(SESSION_A, SCOPE);
    expect(record?.conflict).toBeNull(); // 分歧已消解
    expect(record?.doc.ink.strokes.length).toBe(0); // 新写（空稿）胜出，云端 A 不覆盖
    expect(record?.pending).not.toBeNull(); // 新 pending 保留
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(2); // 新写继续上传
    expect((await bodyDoc(callOf(1).blob)).ink.strokes.length).toBe(0);
    expect(callOf(1).meta.baseRevision).toBe(2); // head 已对齐冲突摘要
  });

  it("冲突裁决 keepCloud：拉云端稿为工作稿、清 pending、不再上传", async () => {
    vi.mocked(fetchStudentNoteDocumentApi).mockResolvedValue(
      noteDocSchema.parse(DOC_A),
    );
    putMock.mockRejectedValueOnce(conflictError(2));
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    await resolveNoteConflictKeepCloud(SESSION_A, SCOPE);
    const record = peekNoteRecord(SESSION_A, SCOPE);
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
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    const signal = callOf(0).signal;
    // 切到账号 B：立即失效旧会话
    bindNoteSession(SESSION_B);
    expect(signal?.aborted).toBe(true); // 中止在途
    hang.resolve(receiptOf(1)); // A 的迟到回执
    await vi.advanceTimersByTimeAsync(60_000);
    expect(putMock.mock.calls.length).toBe(1); // A 不再续传
    const recordA = peekNoteRecord(SESSION_A, SCOPE);
    expect(recordA?.baseRevision).toBe(0); // 迟到回执未落地
    expect(recordA?.pending).not.toBeNull(); // 本地稿保留（不静默删）
    // 新账号读不到 A 的记录（键前缀隔离）
    expect(await getNoteRecord(SESSION_B, SCOPE)).toBeNull();
  });

  it("登出（resetNoteSession）：清监听与计时器，旧会话不再有任何上传", async () => {
    putMock.mockRejectedValue(new Error("网络中断"));
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS); // 首传失败
    resetNoteSession();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(putMock.mock.calls.length).toBe(1); // 退避/在线触发全部失效
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(putMock.mock.calls.length).toBe(1);
  });
});

describe("note-sync：flushNoteSync 结果摘要（复审④）", () => {
  it("逐键如实返回 synced/denied/backoff（T6R.10 交卷判定口径）", async () => {
    const scopeDenied = { ...SCOPE, questionId: "p1-q2" };
    const scopeBackoff = { ...SCOPE, questionId: "p1-q3" };
    putMock.mockImplementation(async (_a, qid: string) => {
      if (qid === SCOPE.questionId) return receiptOf(1);
      if (qid === scopeDenied.questionId)
        throw new ApiError("FORBIDDEN", "已无权限访问该练习", 403);
      throw new Error("网络中断");
    });
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    writeNoteDoc(SESSION_A, scopeDenied, DOC_A);
    writeNoteDoc(SESSION_A, scopeBackoff, DOC_A);
    const results = await flushNoteSync();
    expect(results[`${SCOPE.attemptId}:${SCOPE.questionId}:scratch`]).toBe(
      "synced",
    );
    expect(
      results[`${SCOPE.attemptId}:${scopeDenied.questionId}:scratch`],
    ).toBe("denied");
    expect(
      results[`${SCOPE.attemptId}:${scopeBackoff.questionId}:scratch`],
    ).toBe("backoff");
    // 本地稿在 denied/backoff 两键均保留
    expect(peekNoteRecord(SESSION_A, scopeDenied)?.pending).not.toBeNull();
    expect(peekNoteRecord(SESSION_A, scopeBackoff)?.pending).not.toBeNull();
  });
});

describe("note-sync：PUT 超时与中止身份（复审⑦⑬）", () => {
  it("单次 PUT 30s 超时→按网络错误退避重试（同 mutationId 幂等）", async () => {
    // 模拟真实 fetch：收到 abort 以 signal.reason 拒绝（超时 reason 是普通
    // Error，经分诊走退避；jsdom 无 reason 支持时兜底普通 Error 同效）
    putMock
      .mockImplementationOnce(
        (_a, _q, _b, _m, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              const reason = (signal as AbortSignal & { reason?: unknown })
                .reason;
              reject(
                reason instanceof Error
                  ? reason
                  : new Error("aborted without reason"),
              );
            });
          }),
      )
      .mockResolvedValue(receiptOf(1));
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS); // 首传在途
    expect(putMock.mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000 - 1); // 超时前不动作
    expect(putMock.mock.calls.length).toBe(1);
    // t=32s：超时中止释放串行队列——期间（t=10s）最大等待已把强刷重试
    // 排进队列（复审⑥），挂死请求一释放立即重试并成功
    await vi.advanceTimersByTimeAsync(1);
    expect(putMock.mock.calls.length).toBe(2);
    expect(callOf(1).meta.mutationId).toBe(callOf(0).meta.mutationId); // 幂等重放
    expect(peekNoteRecord(SESSION_A, SCOPE)?.pending).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000); // 成功后无更多重试
    expect(putMock.mock.calls.length).toBe(2);
  });

  it("AbortError（主动中止）→丢弃：不重试、不落任何状态", async () => {
    putMock.mockRejectedValueOnce(
      Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      }),
    );
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
    expect(putMock.mock.calls.length).toBe(1);
    const record = peekNoteRecord(SESSION_A, SCOPE);
    await vi.advanceTimersByTimeAsync(60_000); // 无退避、无任何重试
    expect(putMock.mock.calls.length).toBe(1);
    expect(peekNoteRecord(SESSION_A, SCOPE)?.pending?.mutationId).toBe(
      record?.pending?.mutationId, // 状态原样
    );
    expect(peekNoteRecord(SESSION_A, SCOPE)?.denied).toBeNull();
    expect(peekNoteRecord(SESSION_A, SCOPE)?.conflict).toBeNull();
  });
});

describe("note-sync：分诊矩阵（复审⑧⑪）——服务端错误码全集", () => {
  it("逐码落到正确状态（conflict/denied 两类/retry）", async () => {
    const cases: Array<{
      name: string;
      err: () => unknown;
      want:
        | "conflict"
        | "conflict-no-current"
        | "denied-access"
        | "denied-content"
        | "dirty";
    }> = [
      {
        name: "409 REVISION_CONFLICT 带 _current",
        err: () => conflictError(2),
        want: "conflict",
      },
      {
        name: "409 REVISION_CONFLICT 缺 _current（服务端契约违约→可诊断退避）",
        err: () => new ApiError("NOTE_REVISION_CONFLICT", "冲突", 409),
        want: "dirty",
      },
      {
        name: "409 MUTATION_MISMATCH（无摘要）",
        err: () => new ApiError("NOTE_MUTATION_MISMATCH", "异文重放", 409),
        want: "conflict-no-current",
      },
      {
        name: "409 ALREADY_SUBMITTED",
        err: () => new ApiError("ALREADY_SUBMITTED", "已交卷", 409),
        want: "denied-access",
      },
      {
        name: "403 FORBIDDEN",
        err: () => new ApiError("FORBIDDEN", "无权限", 403),
        want: "denied-access",
      },
      {
        name: "404 NOTE_NOT_FOUND",
        err: () => new ApiError("NOTE_NOT_FOUND", "不存在", 404),
        want: "denied-access",
      },
      {
        name: "400 NOTE_VALIDATION_FAILED",
        err: () => new ApiError("NOTE_VALIDATION_FAILED", "正文形状错误", 400),
        want: "denied-content",
      },
      {
        name: "400 VALIDATION_ERROR（统一壳元信息校验→内容拒）",
        err: () => new ApiError("VALIDATION_ERROR", "元信息不合法", 400),
        want: "denied-content",
      },
      {
        name: "413 NOTE_LIMIT_EXCEEDED",
        err: () => new ApiError("NOTE_LIMIT_EXCEEDED", "超预算", 413),
        want: "denied-content",
      },
      {
        name: "401 UNAUTHORIZED（会话过期→退避；重登录 bind 复活）",
        err: () => new ApiError("UNAUTHORIZED", "未登录", 401),
        want: "dirty",
      },
      {
        name: "500 内部错误",
        err: () => new ApiError("INTERNAL_ERROR", "内部错误", 500),
        want: "dirty",
      },
    ];
    for (const c of cases) {
      installNoteBackend(memoryNoteBackend());
      resetNoteSession();
      putMock.mockReset().mockRejectedValue(c.err());
      bindNoteSession(SESSION_A);
      writeNoteDoc(SESSION_A, SCOPE, DOC_A);
      await vi.advanceTimersByTimeAsync(NOTE_SYNC_DEBOUNCE_MS);
      const record = peekNoteRecord(SESSION_A, SCOPE);
      switch (c.want) {
        case "conflict":
          expect(record?.conflict?.current?.revision, c.name).toBe(2);
          break;
        case "conflict-no-current":
          expect(record?.conflict?.current, c.name).toBeNull();
          break;
        case "denied-access":
          expect(record?.denied?.kind, c.name).toBe("access");
          break;
        case "denied-content":
          expect(record?.denied?.kind, c.name).toBe("content");
          break;
        default:
          expect(record?.conflict, c.name).toBeNull();
          expect(record?.denied, c.name).toBeNull();
          expect(record?.pending, c.name).not.toBeNull();
      }
    }
  });
});

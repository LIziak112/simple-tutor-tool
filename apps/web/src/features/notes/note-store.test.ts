import type { NoteHeadData, NoteVersionReceipt } from "@tutor/contract";
import { noteDocSchema } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  draftStore,
  installDraftBackend,
  memoryBackend,
} from "@/features/attempt/draft-store";
import { docOf, stroke } from "@/features/notes/note-fixtures";
import {
  applyServerHead,
  applyServerLoad,
  applyUploadConflict,
  applyUploadDenied,
  applyUploadReceipt,
  deriveNoteStatusOverview,
  deriveServerState,
  getNoteDoc,
  getNoteRecord,
  getNoteView,
  installNoteBackend,
  listPendingNotes,
  memoryNoteBackend,
  type NoteLocalRecord,
  type NoteStoreBackend,
  noteKeyOf,
  resetNoteStoreForTest,
  setUploading,
  subscribeNoteStore,
  writeNoteDoc,
} from "@/features/notes/note-store";

/**
 * 草稿本地仓（T6R.8）测试：独立 IDB 库 tutor-notes、键含部署实例/学生/
 * attempt/题/phase、串行持久化队列（事务完成才确认 + 合并未执行写入）、
 * doc+pending 同一事务原子写、恢复 load 不算编辑（NoteDoc 相等比较不回传）、
 * 交卷 clearDraft 不删 notes、quota/IDB 失败准确显示、服务端状态派生。
 * jsdom 无 IDB：手写内存后端注入（仓库既有 draft-store/event-queue 惯例，
 * 不引 fake-indexeddb 新依赖——真实 IDB 行为由 E2E/真机覆盖，见任务报告）。
 */

const SESSION_A = { origin: "https://tutor.example", studentId: "student-a" };
const SESSION_B = { origin: "https://tutor.example", studentId: "student-b" };
const SCOPE = {
  attemptId: "att-1",
  questionId: "p1-q1",
  phase: "scratch",
} as const;

const DOC_A = docOf([
  stroke([
    [10, 10],
    [40, 40],
  ]),
]);
const DOC_B = docOf([
  stroke([
    [10, 10],
    [40, 40],
  ]),
  stroke([
    [50, 50],
    [80, 80],
  ]),
]);
const DOC_EMPTY = docOf([]);

const RECEIPT_1: NoteVersionReceipt = {
  noteId: "22222222-2222-4222-8222-222222222222",
  revision: 1,
  versionId: "33333333-3333-4333-8333-333333333333",
  hash: "a".repeat(64),
  savedAt: "2026-10-06T00:00:00.000Z",
};

function headOf(overrides: Partial<NoteHeadData> = {}): NoteHeadData {
  return {
    note: {
      noteId: RECEIPT_1.noteId,
      attemptId: SCOPE.attemptId,
      questionId: SCOPE.questionId,
      questionRevisionId: "qrev-1",
      phase: "scratch",
      revision: 1,
      currentVersionId: RECEIPT_1.versionId,
      serverSavedAt: RECEIPT_1.savedAt,
    },
    images: [],
    evidence: null,
    ...overrides,
  };
}

/** 取记录（缺失即测试前置失败） */
async function recordOf(
  session: typeof SESSION_A,
  scope: typeof SCOPE,
): Promise<NoteLocalRecord> {
  const record = await getNoteRecord(session, scope);
  if (record === null) throw new Error("记录不存在（测试前置失败）");
  return record;
}

/** 取待传 mutationId（无待传即测试前置失败） */
async function pendingMutationIdOf(
  session: typeof SESSION_A,
  scope: typeof SCOPE,
): Promise<string> {
  const mutationId = (await recordOf(session, scope)).pending?.mutationId;
  if (mutationId === undefined) throw new Error("无待传版本（测试前置失败）");
  return mutationId;
}

/** 受控后端：每笔 set 挂起至测试放行（验「事务完成才确认」与合并写） */
interface GatedCall {
  key: string;
  value: unknown;
  release: () => void;
}

function releaseCall(calls: GatedCall[], index: number): void {
  const call = calls[index];
  if (call === undefined)
    throw new Error(`set 第 ${index} 笔不存在（测试前置失败）`);
  call.release();
}

function callDoc(calls: GatedCall[], index: number): unknown {
  const call = calls[index];
  if (call === undefined)
    throw new Error(`set 第 ${index} 笔不存在（测试前置失败）`);
  return (call.value as { doc: unknown }).doc;
}

function strokesOf(doc: unknown): number {
  return (doc as { ink: { strokes: unknown[] } }).ink.strokes.length;
}

function gatedBackend() {
  const store = new Map<string, unknown>();
  const setCalls: Array<{
    key: string;
    value: unknown;
    release: () => void;
  }> = [];
  const backend: NoteStoreBackend = {
    get: async (key) => store.get(key),
    keys: async (prefix) =>
      Array.from(store.keys()).filter((k) => k.startsWith(prefix)),
    set: (key, value) =>
      new Promise<void>((resolve) => {
        setCalls.push({
          key,
          value,
          release: () => {
            store.set(key, value);
            resolve();
          },
        });
      }),
  };
  return { backend, setCalls };
}

beforeEach(() => {
  installNoteBackend(memoryNoteBackend());
});

afterEach(() => {
  resetNoteStoreForTest();
});

describe("note-store：串行持久化队列（T6R.8）", () => {
  it("写入即入队、事务完成才确认 local=saved", async () => {
    const { backend: gated, setCalls } = gatedBackend();
    installNoteBackend(gated);
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    expect(setCalls.length).toBe(1);
    expect((await getNoteRecord(SESSION_A, SCOPE))?.local).toBe("saving");
    releaseCall(setCalls, 0);
    await vi.waitFor(async () => {
      const r = await getNoteRecord(SESSION_A, SCOPE);
      if (r?.local !== "saved") throw new Error("not saved yet");
    });
  });

  it("事务进行中的多笔写入合并为单笔落盘（最终 doc 为最新）", async () => {
    const { backend: gated, setCalls } = gatedBackend();
    installNoteBackend(gated);
    writeNoteDoc(SESSION_A, SCOPE, DOC_A); // 事务①挂起中
    writeNoteDoc(SESSION_A, SCOPE, DOC_B); // 事务②③在①期间到达
    writeNoteDoc(SESSION_A, SCOPE, DOC_EMPTY);
    expect(setCalls.length).toBe(1); // 串行：①未完成不启②
    releaseCall(setCalls, 0);
    await vi.waitFor(() => expect(setCalls.length).toBe(2)); // B 与空稿合并成一笔
    const firstDoc = callDoc(setCalls, 0);
    const secondDoc = callDoc(setCalls, 1);
    // 合并后落的是最新（空稿），B 不单独成笔
    expect(strokesOf(firstDoc)).toBe(1);
    expect(strokesOf(secondDoc)).toBe(0);
    releaseCall(setCalls, 1);
    await vi.waitFor(async () => {
      const r = await getNoteRecord(SESSION_A, SCOPE);
      if (r?.local !== "saved") throw new Error("not saved yet");
    });
  });
});

describe("note-store：键与隔离", () => {
  it("键含部署实例/学生/attempt/题/phase 五元；跨学生互不可见", async () => {
    const keyA = noteKeyOf(SESSION_A, SCOPE);
    const keyB = noteKeyOf(SESSION_B, SCOPE);
    const keyOtherPhase = noteKeyOf(SESSION_A, {
      ...SCOPE,
      phase: "correction",
    });
    const keyOtherOrigin = noteKeyOf(
      { ...SESSION_A, origin: "https://backup.example" },
      SCOPE,
    );
    expect(new Set([keyA, keyB, keyOtherPhase, keyOtherOrigin]).size).toBe(4);

    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    expect(await getNoteRecord(SESSION_A, SCOPE)).not.toBeNull();
    // B 会话读不到 A 的记录（键前缀不同即隔离）
    expect(await getNoteRecord(SESSION_B, SCOPE)).toBeNull();
    // 前缀扫描也只列出本会话
    expect(await listPendingNotes(SESSION_B)).toEqual([]);
    const pendingA = await listPendingNotes(SESSION_A);
    expect(pendingA.length).toBe(1);
    expect(pendingA[0]?.scope).toEqual(SCOPE);
  });
});

describe("note-store：原子写与读出物化", () => {
  it("doc 与待传版本描述同一次 set 写入（同一记录＝同一事务）", async () => {
    const { backend: gated, setCalls } = gatedBackend();
    installNoteBackend(gated);
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await vi.waitFor(() => expect(setCalls.length).toBe(1));
    const value = setCalls[0]?.value as {
      doc: { ink: { strokes: unknown[] } };
      pending: { mutationId: string; doc: { ink: { strokes: unknown[] } } };
    };
    // 同一值里同时有正文与待传描述；mutationId 为 UUID 形态
    expect(value.doc.ink.strokes.length).toBe(1);
    expect(value.pending).not.toBeNull();
    expect(value.pending.doc.ink.strokes.length).toBe(1);
    expect(value.pending.mutationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("读出经 parse 物化默认高度/背景（NoteDocInput 写入口径）", async () => {
    // 缺省 paperHeightLogical/background 的输入（旧 InkDoc 读入形态）
    writeNoteDoc(SESSION_A, SCOPE, {
      version: 1,
      ink: {
        width: 1000,
        strokes: [
          stroke([
            [5, 5],
            [6, 6],
          ]),
        ],
      },
    });
    const doc = await getNoteDoc(SESSION_A, SCOPE);
    expect(doc?.paperHeightLogical).toBe(800);
    expect(doc?.background).toBe("grid");
  });
});

describe("note-store：恢复 load 不算编辑", () => {
  it("applyServerLoad 播种服务端稿：无 pending、不推进 editedAt、派生 synced", async () => {
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    // 先确认本地写入（清 pending），再测 load
    await applyUploadReceipt(
      SESSION_A,
      SCOPE,
      await pendingMutationIdOf(SESSION_A, SCOPE),
      RECEIPT_1,
    );
    const before = await recordOf(SESSION_A, SCOPE);
    const editedAtBefore = before.editedAt;
    await applyServerLoad(SESSION_A, SCOPE, DOC_B, headOf());
    const record = await recordOf(SESSION_A, SCOPE);
    expect(record.pending).toBeNull();
    expect(record.editedAt).toBe(editedAtBefore);
    expect(record.baseRevision).toBe(1);
    expect(deriveServerState(record, false)).toBe("synced");
  });

  it("load 与本地待传内容相等 → 不回传（清 pending）；不等 → 保留本地待传", async () => {
    // 本地写了 B，未上传；服务端 head 的稿内容与 B 相同（上次上传成功但回执丢失的形态）
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    const pendingBefore = (await recordOf(SESSION_A, SCOPE)).pending;
    await applyServerLoad(
      SESSION_A,
      SCOPE,
      noteDocSchema.parse(DOC_B),
      headOf(),
    );
    const record = await recordOf(SESSION_A, SCOPE);
    expect(record.pending).toBeNull();
    expect(record.baseRevision).toBe(1);
    // 相等比较基于物化后的内容：NoteDoc 与等价 NoteDocInput 判等
    expect(pendingBefore).not.toBeNull();

    // 不等：服务端另有内容，本地待传保留（不覆盖未同步本地稿）
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await applyServerLoad(SESSION_A, SCOPE, DOC_B, headOf());
    const after = await recordOf(SESSION_A, SCOPE);
    expect(after.pending).not.toBeNull();
    expect(deriveServerState(after, false)).toBe("dirty");
  });

  it("NoteDoc 相等比较：缺省与显式默认值物化后相等", async () => {
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await applyServerLoad(
      SESSION_A,
      SCOPE,
      // 显式带默认高度/背景的等价稿
      { ...DOC_A, paperHeightLogical: 800, background: "grid" },
      headOf(),
    );
    const record = await getNoteRecord(SESSION_A, SCOPE);
    expect(record?.pending).toBeNull();
  });
});

describe("note-store：回执与状态派生", () => {
  it("A 回执不清 B：mutationId 匹配才清 pending；不匹配仅推进 baseRevision", async () => {
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    const mutationA = await pendingMutationIdOf(SESSION_A, SCOPE);
    // A 在途期间写 B（pending 换成 B 的新 mutationId）
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    const mutationB = await pendingMutationIdOf(SESSION_A, SCOPE);
    expect(mutationB).not.toBe(mutationA);
    // A 的回执到达
    await applyUploadReceipt(SESSION_A, SCOPE, mutationA, RECEIPT_1);
    const record = await recordOf(SESSION_A, SCOPE);
    expect(record.pending?.mutationId).toBe(mutationB); // B 仍在
    expect(record.baseRevision).toBe(1); // head 信息已推进
    expect(deriveServerState(record, false)).toBe("dirty"); // B 未传
    setUploading(SESSION_A, SCOPE, true);
    expect(deriveServerState(record, true)).toBe("uploading");
    setUploading(SESSION_A, SCOPE, false);
    expect(deriveServerState(record, false)).toBe("dirty");
  });

  it("denied(access) 粘住（新写不复活）；denied(content) 新写清除", async () => {
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await applyUploadDenied(SESSION_A, SCOPE, "access", "已无权限");
    let record = await recordOf(SESSION_A, SCOPE);
    expect(deriveServerState(record, false)).toBe("denied");
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    record = await recordOf(SESSION_A, SCOPE);
    expect(deriveServerState(record, false)).toBe("denied");

    await applyUploadDenied(SESSION_A, SCOPE, "content", "超出预算");
    record = await recordOf(SESSION_A, SCOPE);
    expect(record.denied?.kind).toBe("content");
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    record = await recordOf(SESSION_A, SCOPE);
    expect(record.denied).toBeNull();
    expect(deriveServerState(record, false)).toBe("dirty");
  });

  it("conflict 保留两份副本（云端摘要 + 本地稿）且优先级高于 dirty", async () => {
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    const current = {
      noteId: RECEIPT_1.noteId,
      revision: 2,
      versionId: "55555555-5555-4555-8555-555555555555",
      hash: "c".repeat(64),
      serverSavedAt: "2026-10-06T02:00:00.000Z",
    };
    const mutation = await pendingMutationIdOf(SESSION_A, SCOPE);
    await applyUploadConflict(SESSION_A, SCOPE, mutation, current, "冲突");
    const record = await recordOf(SESSION_A, SCOPE);
    expect(record.conflict?.current).toEqual(current);
    expect(record.conflict?.localDoc).toBeDefined(); // 本地副本在记录里
    expect(record.doc).toBeDefined(); // 工作稿未被清
    expect(deriveServerState(record, false)).toBe("conflict");
  });
});

describe("note-store：IDB 失败与订阅", () => {
  it("落盘失败 → local=failed + 错误信息；恢复后新写重新入队", async () => {
    let fail = true;
    const inner = memoryNoteBackend();
    const flaky: NoteStoreBackend = {
      get: inner.get,
      keys: inner.keys,
      set: (key, value) => {
        if (fail) return Promise.reject(new Error("QuotaExceededError"));
        return inner.set(key, value);
      },
    };
    installNoteBackend(flaky);
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    const failed = await vi.waitFor(async () => {
      const r = await getNoteRecord(SESSION_A, SCOPE);
      if (r?.local === "failed") return r;
      throw new Error("not failed yet");
    });
    expect(failed.localError).toContain("QuotaExceededError");
    // 正文与待传仍在内存记录里（不因落盘失败丢弃）
    expect(failed.pending).not.toBeNull();
    // 恢复：存储腾出空间后，新写入重新落盘成功
    fail = false;
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    await vi.waitFor(async () => {
      const r = await getNoteRecord(SESSION_A, SCOPE);
      if (r?.local !== "saved") throw new Error("not saved yet");
    });
  });

  it("订阅：写入与回执都触发通知（供 useSyncExternalStore）", async () => {
    const events: string[] = [];
    subscribeNoteStore((key) => events.push(key));
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    const mutation = await pendingMutationIdOf(SESSION_A, SCOPE);
    await applyUploadReceipt(SESSION_A, SCOPE, mutation, RECEIPT_1);
    const key = noteKeyOf(SESSION_A, SCOPE);
    expect(events.filter((k) => k === key).length).toBeGreaterThanOrEqual(2);
  });

  it("跨键隔离：A 键变更不影响 B 键快照引用（他键不重渲染）", async () => {
    const scopeB = { ...SCOPE, questionId: "p1-q2" };
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    writeNoteDoc(SESSION_A, scopeB, DOC_B);
    const viewB1 = getNoteView(SESSION_A, scopeB);
    expect(viewB1).not.toBeNull();
    writeNoteDoc(SESSION_A, SCOPE, DOC_B); // 只有 A 键变更
    const viewB2 = getNoteView(SESSION_A, scopeB);
    expect(viewB2).toBe(viewB1); // 引用稳定：B 键缓存未失效
    writeNoteDoc(SESSION_A, scopeB, DOC_A); // B 键自身变更
    const viewB3 = getNoteView(SESSION_A, scopeB);
    expect(viewB3).not.toBe(viewB2); // 本键快照按需重建
  });
});

describe("note-store：交卷 clearDraft 不删 notes（T6R.8 验证项）", () => {
  it("clearDraft 只清 tutor-drafts；tutor-notes 记录原样保留", async () => {
    installDraftBackend(memoryBackend());
    draftStore.saveAnswer(SCOPE.attemptId, SCOPE.questionId, {
      kind: "choice",
      index: 0,
    });
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await draftStore.clearDraft(SCOPE.attemptId);
    expect(await draftStore.loadDraft(SCOPE.attemptId)).toBeNull();
    const record = await getNoteRecord(SESSION_A, SCOPE);
    expect(record).not.toBeNull();
    expect(record?.pending).not.toBeNull();
  });
});

describe("note-store：四维总览派生（T6R.5 契约注释：前端合成）", () => {
  it("images/evidence 从 lastHead 聚合；无 head 时图片待生成、证据未固定", async () => {
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    let record = await recordOf(SESSION_A, SCOPE);
    await vi.waitFor(() => {
      if (record.local !== "saved") throw new Error("not saved yet");
    });
    let overview = deriveNoteStatusOverview(record, false);
    expect(overview.local).toBe("saved");
    expect(overview.server).toBe("dirty");
    expect(overview.images).toBe("pending"); // 无 head：图片待生成
    expect(overview.evidence).toBe("none"); // 无证据行

    await applyServerHead(SESSION_A, SCOPE, headOf());
    record = await recordOf(SESSION_A, SCOPE);
    overview = deriveNoteStatusOverview(record, false);
    expect(overview.images).toBe("pending"); // head 有版本但无图：待生成
    expect(overview.evidence).toBe("none");

    await applyServerHead(SESSION_A, SCOPE, {
      ...headOf(),
      images: [
        {
          imageId: "66666666-6666-4666-8666-666666666666",
          noteVersionId: RECEIPT_1.versionId,
          spec: "thumbnail",
          pageIndex: 0,
          crop: { x: 0, y: 0, width: 1000, height: 800 },
          pixelWidth: 500,
          pixelHeight: 400,
          state: "ready",
          hash: "d".repeat(64),
        },
      ],
      evidence: {
        attemptId: SCOPE.attemptId,
        questionId: SCOPE.questionId,
        state: "frozen",
        versionId: RECEIPT_1.versionId,
        recordedAt: "2026-10-06T03:00:00.000Z",
      },
    });
    record = await recordOf(SESSION_A, SCOPE);
    overview = deriveNoteStatusOverview(record, false);
    expect(overview.images).toBe("ready");
    expect(overview.evidence).toBe("frozen");
  });

  it("空稿也是合法正文（清空=空稿版本，非删除记录）", async () => {
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    writeNoteDoc(SESSION_A, SCOPE, DOC_EMPTY);
    const record = await getNoteRecord(SESSION_A, SCOPE);
    expect(record?.pending).not.toBeNull();
    expect(record?.doc.ink.strokes.length).toBe(0);
  });
});

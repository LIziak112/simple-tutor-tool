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
  clearCorrectionRecord,
  clearNoteDeniedAccess,
  deriveNoteStatusOverview,
  deriveServerState,
  ensureNoteLoaded,
  getNoteDoc,
  getNoteRecord,
  getNoteView,
  installNoteBackend,
  listPendingNotes,
  memoryNoteBackend,
  type NoteLocalRecord,
  type NoteScope,
  type NoteSessionRef,
  type NoteStoreBackend,
  noteKeyOf,
  resetNoteStoreForTest,
  setUploading,
  subscribeNoteStore,
  writeNoteDoc,
} from "@/features/notes/note-store";
import {
  DOC_A,
  DOC_B,
  DOC_EMPTY,
  headOf,
  receiptOf,
  SCOPE,
  SESSION_A,
  SESSION_B,
  waitForLocalSaved,
} from "@/features/notes/note-test-utils";

/**
 * 草稿本地仓（T6R.8）测试：独立 IDB 库 tutor-notes、键含部署实例/学生/
 * attempt/题/phase、串行持久化队列（事务完成才确认 + 合并未执行写入）、
 * doc+pending 同一事务原子写、恢复 load 不算编辑（NoteDoc 相等比较不回传）、
 * 交卷 clearDraft 不删 notes、quota/IDB 失败准确显示、服务端状态派生。
 * jsdom 无 IDB：手写内存后端注入（仓库既有 draft-store/event-queue 惯例，
 * 不引 fake-indexeddb 新依赖——真实 IDB 行为由 E2E/真机覆盖，见任务报告）。
 * 共用夹具/回执工厂在 note-test-utils（复审⑪）。
 */

const RECEIPT_1 = receiptOf(1);

/** 取记录（缺失即测试前置失败） */
async function recordOf(
  session: NoteSessionRef,
  scope: NoteScope,
): Promise<NoteLocalRecord> {
  const record = await getNoteRecord(session, scope);
  if (record === null) throw new Error("记录不存在（测试前置失败）");
  return record;
}

/** 取待传 mutationId（无待传即测试前置失败） */
async function pendingMutationIdOf(
  session: NoteSessionRef,
  scope: NoteScope,
): Promise<string> {
  const mutationId = (await recordOf(session, scope)).pending?.mutationId;
  if (mutationId === undefined) throw new Error("无待传版本（测试前置失败）");
  return mutationId;
}

/**
 * 受控后端（复审⑭：包 memoryNoteBackend 只覆 set/get 为挂起式）：
 * set/get 挂起至测试放行（验「事务完成才确认」、合并写与读取竞态窗口）；
 * keys/落盘语义与内存后端一致。
 */
interface GatedCall {
  key: string;
  value: unknown;
  release: () => void;
}

interface GatedGet {
  key: string;
  release: (raw: unknown) => void;
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
  const inner = memoryNoteBackend();
  const setCalls: GatedCall[] = [];
  const getCalls: GatedGet[] = [];
  const backend: NoteStoreBackend = {
    getAll: inner.getAll,
    set: (key, value) =>
      new Promise<void>((resolve) => {
        setCalls.push({
          key,
          value,
          release: () => {
            void inner.set(key, value);
            resolve();
          },
        });
      }),
    get: (key) =>
      new Promise((resolve) => {
        getCalls.push({ key, release: (raw) => resolve(raw) });
      }),
  };
  return { backend, setCalls, getCalls, inner };
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
    await waitForLocalSaved(SESSION_A, SCOPE);
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
    await waitForLocalSaved(SESSION_A, SCOPE);
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
    // 前缀扫描也只列出本会话（返回收窄为 scope 数组，不泄记录活引用）
    expect(await listPendingNotes(SESSION_B)).toEqual([]);
    const pendingA = await listPendingNotes(SESSION_A);
    expect(pendingA.length).toBe(1);
    expect(pendingA[0]).toEqual(SCOPE);
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

  it("迟到回执 noteId 守卫（闸门修复 F6）：新行对齐后旧行回执到达 → 整笔丢弃，基线不被拉回旧值", async () => {
    // 旧行在途：写入生成 pending（mutationId 与旧回执对应）
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    const mutationOld = await pendingMutationIdOf(SESSION_A, SCOPE);
    // 模拟 clear→seed 对齐到新行（noteId 变化、baseRevision 2——CorrectionSection
    // 创建新订正后的形态；pending 保留=新行待传内容）
    const newRowNote = {
      ...headOf().note,
      noteId: "99999999-9999-4999-8999-999999999901",
      revision: 2,
      currentVersionId: "33333333-3333-4333-8333-333333333302",
    };
    if (newRowNote === null) throw new Error("夹具缺 note（测试前置失败）");
    await applyServerHead(SESSION_A, SCOPE, headOf({ note: newRowNote }));
    const aligned = await recordOf(SESSION_A, SCOPE);
    expect(aligned.noteId).toBe("99999999-9999-4999-8999-999999999901");
    expect(aligned.baseRevision).toBe(2);
    // 旧行的成功回执迟到：不得把基线/noteId 拉回旧行值、不得清新行的 pending
    await applyUploadReceipt(SESSION_A, SCOPE, mutationOld, RECEIPT_1);
    const after = await recordOf(SESSION_A, SCOPE);
    expect(after.noteId).toBe("99999999-9999-4999-8999-999999999901");
    expect(after.baseRevision).toBe(2);
    expect(after.pending?.mutationId).toBe(mutationOld); // 待传不被旧回执误清
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
    await applyUploadConflict(SESSION_A, SCOPE, current, "冲突");
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
      getAll: inner.getAll,
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
    await waitForLocalSaved(SESSION_A, SCOPE);
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
    await waitForLocalSaved(SESSION_A, SCOPE);
    record = await recordOf(SESSION_A, SCOPE);
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

describe("note-store：getNoteRecord 读取竞态（复审①）", () => {
  it("get 在途期间的本地写入不被「后端无值」覆盖（IDB 无值分支）", async () => {
    const { backend: gated, getCalls } = gatedBackend();
    installNoteBackend(gated);
    const pending = getNoteRecord(SESSION_A, SCOPE); // 挂起（后端将返回无记录）
    await Promise.resolve(); // get 已登记
    writeNoteDoc(SESSION_A, SCOPE, DOC_B); // 窗口内新写
    const gate = getCalls[0];
    if (gate === undefined) throw new Error("get 未挂起（测试前置失败）");
    gate.release(undefined); // 后端：无记录
    const record = await pending;
    if (record === null) throw new Error("窗口内新写被丢");
    expect(record.doc.ink.strokes.length).toBe(2); // B 保留
  });

  it("get 在途期间的本地写入不被后端旧值覆盖（IDB 有旧值分支）", async () => {
    const { backend: gated, setCalls, getCalls, inner } = gatedBackend();
    installNoteBackend(gated);
    // 先落一份旧稿 A 进后端
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    releaseCall(setCalls, 0);
    await waitForLocalSaved(SESSION_A, SCOPE);
    const oldRaw = await inner.get(noteKeyOf(SESSION_A, SCOPE));
    installNoteBackend(gated); // 清内存缓存（后端保留 A）
    const pending = getNoteRecord(SESSION_A, SCOPE);
    await Promise.resolve();
    writeNoteDoc(SESSION_A, SCOPE, DOC_B); // 窗口内新写
    const gate = getCalls[0];
    if (gate === undefined) throw new Error("get 未挂起（测试前置失败）");
    gate.release(oldRaw); // 后端返回旧值 A
    const record = await pending;
    if (record === null) throw new Error("窗口内新写被丢");
    expect(record.doc.ink.strokes.length).toBe(2); // B 胜出，旧值 A 不覆盖
  });
});

describe("note-store：备份回退 load 守卫（复审②）", () => {
  it("本地 rev5 全同步→服务端回退 rev2→重进 load：conflict 保留、doc 不被服务端稿覆盖", async () => {
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    await applyUploadReceipt(
      SESSION_A,
      SCOPE,
      await pendingMutationIdOf(SESSION_A, SCOPE),
      receiptOf(5),
    );
    const baseHead = headOf();
    if (baseHead.note === null) throw new Error("前置失败");
    const rolledBackHead = headOf({
      note: { ...baseHead.note, revision: 2 },
    });
    // 服务端回退后的稿内容是 A（rev2 时代的旧稿）
    await applyServerLoad(SESSION_A, SCOPE, DOC_A, rolledBackHead);
    const record = await recordOf(SESSION_A, SCOPE);
    expect(record.conflict).not.toBeNull(); // 回退检测置冲突
    expect(record.conflict?.current?.revision).toBe(2);
    expect(record.doc.ink.strokes.length).toBe(2); // 本地 B 稿保留，未被 A 覆盖
    expect(record.baseRevision).toBe(5); // 不回拨（对齐留待裁决）
    expect(deriveServerState(record, false)).toBe("conflict");
  });
});

describe("note-store：writeNoteDoc 断引用（复审⑩ memo 纪律）", () => {
  it("断引用纪律已让位于热路径零拷贝（复审⑬）：入参即仓内对象，交出后不得再改", async () => {
    // 旧断引用拷贝已删（书写热路径零拷贝）；本例锁定新契约——同引用入仓
    const input = { ...DOC_B };
    writeNoteDoc(SESSION_A, SCOPE, input);
    const record = await recordOf(SESSION_A, SCOPE);
    expect(record.doc).toBe(input);
    expect(record.pending?.doc).toBe(input);
  });
});

describe("note-store：ensureNoteLoaded（T6R.9 NoteLayer 挂载恢复路径）", () => {
  it("内存无记录时从后端载入并通知订阅者（视图 null → 有值）", async () => {
    // 重装同一后端模拟「刷新重进」：写入落盘后清内存缓存
    const shared = memoryNoteBackend();
    installNoteBackend(shared);
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await waitForLocalSaved(SESSION_A, SCOPE);
    installNoteBackend(shared); // 清内存（后端数据仍在）
    expect(getNoteView(SESSION_A, SCOPE)).toBeNull();

    const notified: string[] = [];
    subscribeNoteStore((key) => notified.push(key));
    await ensureNoteLoaded(SESSION_A, SCOPE);

    const view = getNoteView(SESSION_A, SCOPE);
    expect(view?.doc?.ink.strokes.length).toBe(1);
    expect(notified).toContain(noteKeyOf(SESSION_A, SCOPE));
  });

  it("无记录也完成并通知（消费方区分「尚未加载」与「本地无记录」）", async () => {
    const notified: string[] = [];
    subscribeNoteStore((key) => notified.push(key));
    await ensureNoteLoaded(SESSION_A, SCOPE);
    expect(getNoteView(SESSION_A, SCOPE)).toBeNull();
    expect(notified).toContain(noteKeyOf(SESSION_A, SCOPE));
  });

  it("已在内存：no-op 载入不重复通知", async () => {
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await waitForLocalSaved(SESSION_A, SCOPE); // 落盘完成的 saved 通知先走完
    const notified: string[] = [];
    subscribeNoteStore((key) => notified.push(key));
    await ensureNoteLoaded(SESSION_A, SCOPE);
    expect(notified).toEqual([]);
  });
});

describe("note-store：clearNoteDeniedAccess（T6R.9 手动重试入口）", () => {
  it("access 形态清除 denied、pending/正文保留；content 形态不动（新内容自愈路径）", async () => {
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await applyUploadDenied(SESSION_A, SCOPE, "access", "已无权限");
    expect((await recordOf(SESSION_A, SCOPE)).denied?.kind).toBe("access");
    const cleared = await clearNoteDeniedAccess(SESSION_A, SCOPE);
    expect(cleared).toBe(true);
    const record = await recordOf(SESSION_A, SCOPE);
    expect(record.denied).toBeNull();
    expect(record.pending).not.toBeNull(); // 待传保留：重试即补传
    expect(record.doc.ink.strokes.length).toBe(1);

    await applyUploadDenied(SESSION_A, SCOPE, "content", "内容超限");
    const clearedContent = await clearNoteDeniedAccess(SESSION_A, SCOPE);
    expect(clearedContent).toBe(false);
    expect((await recordOf(SESSION_A, SCOPE)).denied?.kind).toBe("content");
  });

  it("无 denied 时幂等返回 false（重复点击重试）", async () => {
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    expect(await clearNoteDeniedAccess(SESSION_A, SCOPE)).toBe(false);
  });
});

describe("note-store：docVersion 正文版本令牌（T6R.9 复审②：自写自载守卫数据源）", () => {
  it("record.doc 每次整体替换 +1；回执/被拒/冲突落地不动", async () => {
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    const v1 = (await recordOf(SESSION_A, SCOPE)).docVersion;
    expect(v1).toBeGreaterThan(0);
    const rec1 = await recordOf(SESSION_A, SCOPE);
    const mutationId = rec1.pending?.mutationId;
    if (mutationId === undefined) throw new Error("测试前置失败");
    await applyUploadReceipt(SESSION_A, SCOPE, mutationId, RECEIPT_1);
    expect((await recordOf(SESSION_A, SCOPE)).docVersion).toBe(v1); // 回执不换正文
    await applyUploadDenied(SESSION_A, SCOPE, "access", "x");
    expect((await recordOf(SESSION_A, SCOPE)).docVersion).toBe(v1); // 终态不换正文
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    expect((await recordOf(SESSION_A, SCOPE)).docVersion).toBe(v1 + 1);
  });

  it("服务端稿载入换正文 +1；视图暴露 docVersion", async () => {
    // 无本地待传（fresh）→ 服务端稿成为工作稿
    await applyServerLoad(SESSION_A, SCOPE, DOC_B);
    const v1 = (await recordOf(SESSION_A, SCOPE)).docVersion;
    expect(v1).toBe(1); // freshRecord(0) → 换稿 +1
    expect(getNoteView(SESSION_A, SCOPE)?.docVersion).toBe(v1);
    // 再载一次（内容不同）再 +1
    await applyServerLoad(SESSION_A, SCOPE, DOC_A);
    expect((await recordOf(SESSION_A, SCOPE)).docVersion).toBe(v1 + 1);
  });

  it("revive 持久副本保留令牌（重进不归零）", async () => {
    const shared = memoryNoteBackend();
    installNoteBackend(shared);
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await waitForLocalSaved(SESSION_A, SCOPE);
    const before = (await recordOf(SESSION_A, SCOPE)).docVersion;
    installNoteBackend(shared); // 模拟刷新：清内存
    expect((await recordOf(SESSION_A, SCOPE)).docVersion).toBe(before);
  });
});

describe("note-store：写路径增量维护与视图标量物化（T6R.9 复审⑤）", () => {
  it("写入与视图重建不触发全稿 Zod parse；载入边界仍 parse", async () => {
    const spy = vi.spyOn(noteDocSchema, "safeParse");
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    const view = getNoteView(SESSION_A, SCOPE);
    expect(view?.doc?.ink.strokes.length).toBe(2);
    expect(spy).not.toHaveBeenCalled(); // 千笔书写下视图重建零全稿 parse
    spy.mockRestore();
    // 载入边界（applyServerLoad → parseNoteDocOrThrow）保留全量收窄
    const spy2 = vi.spyOn(noteDocSchema, "safeParse");
    await applyServerLoad(SESSION_B, SCOPE, DOC_A);
    expect(spy2.mock.calls.length).toBeGreaterThanOrEqual(1);
    spy2.mockRestore();
  });

  it("视图物化补标量默认（缺省纸高/背景的写入不 NaN）", () => {
    writeNoteDoc(SESSION_A, SCOPE, {
      version: 1,
      ink: { width: 1000, strokes: [] },
    });
    const view = getNoteView(SESSION_A, SCOPE);
    expect(view?.doc?.paperHeightLogical).toBe(800);
    expect(view?.doc?.background).toBe("grid");
  });

  it("超限笔只告警不阻断书写（服务端 413 为预算权威）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fatStroke = {
      tool: "pen" as const,
      color: "#1f2328",
      weight: 4,
      points: Array.from({ length: 2001 }, (_, i) => ({
        x: i,
        y: 0,
        p: 0.5,
        t: 0,
      })),
    };
    writeNoteDoc(SESSION_A, SCOPE, {
      version: 1,
      ink: { width: 1000, strokes: [fatStroke] },
    });
    expect(warn).toHaveBeenCalled();
    // 内容保留本机（不静默丢笔），由服务端按预算裁决
    expect(getNoteView(SESSION_A, SCOPE)?.doc?.ink.strokes.length).toBe(1);
    warn.mockRestore();
  });
});

describe("note-store：reviveRecord 坏形防御（T6R.9 复审③）", () => {
  /** 直接向后端塞坏形记录（模拟历史损坏/异版本写入） */
  async function seedCorrupt(backend: NoteStoreBackend): Promise<void> {
    await backend.set(noteKeyOf(SESSION_A, SCOPE), {
      doc: { version: 1, ink: { width: 1000, strokes: "not-an-array" } },
      pending: null,
      baseRevision: 5,
    });
  }

  it("挂载路径：坏形弃壳返 null，不抛错；下次写入重建干净记录", async () => {
    const shared = memoryNoteBackend();
    await seedCorrupt(shared);
    installNoteBackend(shared);
    expect(await getNoteRecord(SESSION_A, SCOPE)).toBeNull(); // 不抛、不当存在
    writeNoteDoc(SESSION_A, SCOPE, DOC_A); // 重建
    const record = await recordOf(SESSION_A, SCOPE);
    expect(record.baseRevision).toBe(0); // 坏壳的 baseRevision 未被采信
    expect(record.doc.ink.strokes.length).toBe(1);
  });

  it("strokes 元素缺 points 数组同样弃壳", async () => {
    const shared = memoryNoteBackend();
    await shared.set(noteKeyOf(SESSION_A, SCOPE), {
      doc: { version: 1, ink: { width: 1000, strokes: [{ tool: "pen" }] } },
    });
    installNoteBackend(shared);
    expect(await getNoteRecord(SESSION_A, SCOPE)).toBeNull();
  });

  it("bind 扫描路径：坏形不抛、不进待传清单（getAll 原料直入 revive）", async () => {
    const shared = memoryNoteBackend();
    await seedCorrupt(shared);
    installNoteBackend(shared);
    await expect(listPendingNotes(SESSION_A)).resolves.toEqual([]);
  });
});

describe("note-store：回执推进 lastHead（T6R.9 复审⑦：新版本 images=[]→pending）", () => {
  it("rev1 图片 ready 的 head 后上传 rev2：images 维度随回执转 pending", async () => {
    await applyServerHead(SESSION_A, SCOPE, headOf());
    // rev1 有一张 ready 图（最小形状）
    await applyServerHead(SESSION_A, SCOPE, {
      note: headOf().note,
      images: [
        {
          imageId: "55555555-5555-4555-8555-555555555555",
          noteVersionId: headOf().note?.currentVersionId ?? "",
          spec: "thumbnail",
          pageIndex: 0,
          crop: { x: 0, y: 0, width: 1000, height: 800 },
          pixelWidth: 500,
          pixelHeight: 400,
          state: "ready",
          hash: `${"b".repeat(64)}`,
        },
      ],
      evidence: null,
      corrections: [],
      supplements: [],
    });
    expect(
      deriveNoteStatusOverview(await recordOf(SESSION_A, SCOPE), false).images,
    ).toBe("ready");
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    const mutationId = (await recordOf(SESSION_A, SCOPE)).pending?.mutationId;
    if (mutationId === undefined) throw new Error("测试前置失败");
    await applyUploadReceipt(SESSION_A, SCOPE, mutationId, receiptOf(2));
    // 回执落地：新版本尚无派生图 →「上传成功≠图片就绪」如实转 pending
    expect(
      deriveNoteStatusOverview(await recordOf(SESSION_A, SCOPE), false).images,
    ).toBe("pending");
    const head = (await recordOf(SESSION_A, SCOPE)).lastHead;
    expect(head?.note?.revision).toBe(2);
    expect(head?.note?.currentVersionId).toBe(receiptOf(2).versionId);
  });
});

describe("note-store：replaceDoc 单点与热路径（T6R.9 复审⑩⑫⑬）", () => {
  it("writeNoteDoc 返回新 docVersion（消二次 peek）", () => {
    const v1 = writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    const v2 = writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    expect(typeof v1).toBe("number");
    expect(v2).toBe(v1 + 1);
  });

  it("等长换稿也全量重算 totalPoints（undo/redo/erase/replace 等非追加形态）", async () => {
    writeNoteDoc(
      SESSION_A,
      SCOPE,
      docOf([
        stroke([
          [0, 0],
          [1, 1],
        ]),
      ]),
    ); // 1 笔 2 点
    expect((await recordOf(SESSION_A, SCOPE)).totalPoints).toBe(2);
    // 等长替换（同笔数——引擎不产生，防御口径）：重算而非沿用增量
    writeNoteDoc(SESSION_A, SCOPE, DOC_A); // 1 笔 2 点（等长）
    expect((await recordOf(SESSION_A, SCOPE)).totalPoints).toBe(2);
    // 追加：增量路径
    writeNoteDoc(SESSION_A, SCOPE, DOC_B); // 2 笔 4 点
    expect((await recordOf(SESSION_A, SCOPE)).totalPoints).toBe(4);
    // 清空（减笔）：重算归零
    writeNoteDoc(SESSION_A, SCOPE, DOC_EMPTY);
    expect((await recordOf(SESSION_A, SCOPE)).totalPoints).toBe(0);
  });

  it("物化与 Zod parse 锁步（materializeDoc 输出 ≡ parse 物化，复审⑪）", () => {
    const bare = {
      version: 1,
      ink: { width: 1000, strokes: DOC_A.ink.strokes },
    } as const;
    writeNoteDoc(SESSION_A, SCOPE, bare);
    expect(getNoteView(SESSION_A, SCOPE)?.doc).toEqual(
      noteDocSchema.parse(bare),
    );
    writeNoteDoc(SESSION_A, SCOPE, DOC_B);
    expect(getNoteView(SESSION_A, SCOPE)?.doc).toEqual(
      noteDocSchema.parse({
        version: 1,
        ink: DOC_B.ink,
        paperHeightLogical: DOC_B.paperHeightLogical,
        background: DOC_B.background,
      }),
    );
  });

  it("writeNoteDoc 不再拷贝数组层：入参对象即仓内对象（交出后不得再改）", async () => {
    const input = { ...DOC_A };
    writeNoteDoc(SESSION_A, SCOPE, input);
    const record = await recordOf(SESSION_A, SCOPE);
    expect(record.doc).toBe(input); // 同一引用（热路径零拷贝）
  });
});

describe("note-store：bind 扫描与 ensureNoteLoaded 共享（T6R.9 复审⑬消双读）", () => {
  it("扫描在途时 ensureNoteLoaded 等待共享结果，不走逐键 get", async () => {
    const shared = memoryNoteBackend();
    installNoteBackend(shared);
    writeNoteDoc(SESSION_A, SCOPE, DOC_A);
    await waitForLocalSaved(SESSION_A, SCOPE);
    installNoteBackend(shared); // 模拟刷新：清内存、后端留数据

    let gets = 0;
    const counting: NoteStoreBackend = {
      get: (key) => {
        gets += 1;
        return shared.get(key);
      },
      set: shared.set,
      getAll: shared.getAll,
    };
    installNoteBackend(counting);
    const scan = listPendingNotes(SESSION_A); // 不 await——bind 扫描在途
    await ensureNoteLoaded(SESSION_A, SCOPE); // 同 tick 竞争的挂载恢复
    await scan;
    expect(gets).toBe(0); // 键值对来自扫描的 getAll，零逐键 get
    expect(getNoteView(SESSION_A, SCOPE)?.doc?.ink.strokes.length).toBe(1);
  });
});

describe("note-store：clearCorrectionRecord（T6R.15 新开订正行的本地重置）", () => {
  /** correction 作用域（clearCorrectionRecord 的目标 phase） */
  const CORRECTION_SCOPE: NoteScope = { ...SCOPE, phase: "correction" };

  it("清旧封存行残留：pending/doc/conflict/denied/baseRevision/noteId/lastHead 全清，docVersion 递增", async () => {
    // 造残留：旧封存行上继续写出的 pending + 冲突 + 被拒（同时非空时以
    // conflict 优先呈现在 UI，但 store 里三字段可并存——清除须全清）
    const sealedRowHead = headOf({
      note: {
        noteId: "88888888-8888-4888-8888-888888888888",
        attemptId: SCOPE.attemptId,
        questionId: SCOPE.questionId,
        questionRevisionId: "qrev-1",
        phase: "correction",
        revision: 3,
        currentVersionId: receiptOf(3).versionId,
        serverSavedAt: "2026-10-06T02:00:00.000Z",
        sealedAt: "2026-10-06T03:00:00.000Z",
        stuckAt: null,
        errorCause: null,
      },
    });
    await applyServerHead(SESSION_A, CORRECTION_SCOPE, sealedRowHead);
    writeNoteDoc(SESSION_A, CORRECTION_SCOPE, DOC_B);
    await applyUploadConflict(SESSION_A, CORRECTION_SCOPE, null, "已被封存");
    await applyUploadDenied(SESSION_A, CORRECTION_SCOPE, "access", "终态残留");
    const before = await recordOf(SESSION_A, CORRECTION_SCOPE);
    const beforeVersion = before.docVersion;

    await clearCorrectionRecord(SESSION_A, CORRECTION_SCOPE);

    const after = await recordOf(SESSION_A, CORRECTION_SCOPE);
    expect(after.pending).toBeNull();
    // 空稿（与 freshRecord 同形——NoteDocInput 形态，默认值读出时物化）
    expect(after.doc).toEqual({
      version: 1,
      ink: { width: 1000, strokes: [] },
    });
    expect(after.conflict).toBeNull();
    expect(after.denied).toBeNull();
    expect(after.baseRevision).toBe(0);
    expect(after.noteId).toBeNull();
    expect(after.lastHead).toBeNull();
    expect(after.editedAt).toBe(0);
    expect(after.totalPoints).toBe(0);
    expect(after.docVersion).toBe(beforeVersion + 1); // 引擎守卫感知换稿
  });

  it("无残留记录时幂等 no-op：不建壳、不通知落盘", async () => {
    const key = noteKeyOf(SESSION_A, CORRECTION_SCOPE);
    let sets = 0;
    const counting: NoteStoreBackend = {
      get: memoryNoteBackend().get,
      set: (k) => {
        if (k === key) sets += 1;
        return Promise.resolve();
      },
      getAll: memoryNoteBackend().getAll,
    };
    installNoteBackend(counting);
    await clearCorrectionRecord(SESSION_A, CORRECTION_SCOPE);
    expect(sets).toBe(0);
    expect(await getNoteRecord(SESSION_A, CORRECTION_SCOPE)).toBeNull();
  });

  it("清除后落盘：刷新（清内存重挂同一后端）读到空壳，不回读旧残留", async () => {
    const shared = memoryNoteBackend();
    installNoteBackend(shared);
    writeNoteDoc(SESSION_A, CORRECTION_SCOPE, DOC_A);
    await waitForLocalSaved(SESSION_A, CORRECTION_SCOPE);

    await clearCorrectionRecord(SESSION_A, CORRECTION_SCOPE);
    await waitForLocalSaved(SESSION_A, CORRECTION_SCOPE);
    installNoteBackend(shared); // 模拟刷新：清内存、后端留数据

    const revived = await recordOf(SESSION_A, CORRECTION_SCOPE);
    expect(revived.doc.ink.strokes).toEqual([]);
    expect(revived.baseRevision).toBe(0);
    expect(revived.pending).toBeNull();
  });
});

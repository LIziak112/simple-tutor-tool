import type {
  AnnotationBaseRef,
  AnnotationConflictCurrent,
  AnnotationDoc,
  AnnotationReceipt,
  AnnotationViewData,
} from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { digestOf } from "@/features/attempt/draft-merge";
import {
  type AnnotationSessionRef,
  annotationKeyOf,
  applyAnnotationConflict,
  applyAnnotationDenied,
  applyAnnotationReceipt,
  applyAnnotationView,
  applyBaseDisabled,
  applyBasePreview,
  clearAnnotationRetained,
  deriveAnnotationServerState,
  getAnnotationRecord,
  getAnnotationView,
  installAnnotationBackend,
  listPendingAnnotations,
  memoryAnnotationBackend,
  parseAnnotationKey,
  peekAnnotationRecord,
  resetAnnotationStoreForTest,
  resolveAnnotationConflictKeepLocal,
  settleAnnotationPersistence,
  setUploading,
  subscribeAnnotationStore,
  writeAnnotationDoc,
} from "./annotation-store";

/**
 * T6R.20 标注本地仓测试（IDB 键风格同 note-store、串行落盘、状态派生、
 * 服务端视图播种与回执/冲突/被拒落地）。真实 IDB 事务语义由 E2E/真机覆盖。
 */

const SESSION: AnnotationSessionRef = {
  origin: "https://tutor.example",
  studentId: "s-0001",
};
const SCOPE = {
  attemptId: "a-0001",
  questionId: "q-0001",
  phase: "scratch" as const,
};

it("交卷扫描保留仅在内存的待传标画，严格读失败不能误报无附件", async () => {
  const storage = memoryAnnotationBackend();
  installAnnotationBackend({
    ...storage,
    set: async () => {
      throw new Error("磁盘已满");
    },
  });
  writeAnnotationDoc(SESSION, SCOPE, docOf([strokeAt(10, 10)]));
  await settleAnnotationPersistence();
  expect(await listPendingAnnotations(SESSION, SCOPE.attemptId)).toEqual([
    SCOPE,
  ]);
  installAnnotationBackend({
    ...storage,
    getAll: vi.fn(async () => {
      throw new Error("读取失败");
    }),
  });
  await expect(
    listPendingAnnotations(SESSION, SCOPE.attemptId, { strictRead: true }),
  ).rejects.toThrow("读取失败");
});

function docOf(
  strokes: AnnotationDoc["strokes"] = [],
  o: { baseWidth?: number; baseHeight?: number } = {},
): AnnotationDoc {
  return {
    version: 1,
    baseWidth: o.baseWidth ?? 1440,
    baseHeight: o.baseHeight ?? 900,
    strokes,
  };
}

function strokeAt(x: number, y: number): AnnotationDoc["strokes"][number] {
  return {
    tool: "pen",
    color: "#1f2328",
    weight: 5.76,
    points: [{ x, y, p: 0.5, t: 0 }],
  };
}

/** 服务端视图夹具 */
function viewOf(o: {
  doc?: AnnotationDoc | null;
  base?: AnnotationBaseRef | null;
}): AnnotationViewData {
  const doc = o.doc ?? null;
  return {
    base:
      o.base === undefined
        ? {
            baseId: "b-00000000-0000-4000-8000-000000000001",
            state: "ready",
            stale: false,
            pixelWidth: 1440,
            pixelHeight: 900,
            downloadUrl:
              "/api/student/attempts/a-0001/annotation-base/b-1/image.png",
          }
        : o.base,
    maxWidthPx: 1440,
    doc,
    annotation:
      doc === null
        ? null
        : {
            annotationId: "n-00000000-0000-4000-8000-000000000001",
            revision: 3,
            hash: "a".repeat(64),
            savedAt: "2026-10-08T00:00:00Z",
            sealedAt: null,
            strokeCount: doc.strokes.length,
            pointCount: doc.strokes.reduce((n, s) => n + s.points.length, 0),
          },
  } as AnnotationViewData;
}

beforeEach(() => {
  resetAnnotationStoreForTest();
  installAnnotationBackend(memoryAnnotationBackend());
});

describe("键风格（同 note-store 五元 JSON 数组）", () => {
  it("键 = [annotation, origin, studentId, attemptId, questionId, phase]；可反解", () => {
    const key = annotationKeyOf(SESSION, SCOPE);
    expect(JSON.parse(key)).toEqual([
      "annotation",
      SESSION.origin,
      SESSION.studentId,
      SCOPE.attemptId,
      SCOPE.questionId,
      "scratch",
    ]);
    expect(parseAnnotationKey(key)).toEqual({
      session: SESSION,
      scope: SCOPE,
    });
    expect(parseAnnotationKey('["note","x"]')).toBeNull();
  });
});

describe("writeAnnotationDoc（本地写入）", () => {
  it("新写生成 pending（新 mutationId）+ editedAt 推进 + docVersion 递增；持久化完成 local=saved", async () => {
    const v1 = writeAnnotationDoc(SESSION, SCOPE, docOf([strokeAt(10, 10)]));
    expect(v1).toBe(1);
    const record = peekAnnotationRecord(SESSION, SCOPE);
    expect(record).not.toBeNull();
    if (record === null) return;
    expect(record.doc.strokes).toHaveLength(1);
    expect(record.pending?.mutationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(record.pending?.doc.strokes).toHaveLength(1);
    expect(record.editedAt).toBeGreaterThan(0);
    expect(record.local).toBe("saving");
    await settleAnnotationPersistence();
    expect(peekAnnotationRecord(SESSION, SCOPE)?.local).toBe("saved");
    const v2 = writeAnnotationDoc(
      SESSION,
      SCOPE,
      docOf([strokeAt(1, 1), strokeAt(2, 2)]),
    );
    expect(v2).toBe(2);
  });

  it("重进恢复：getAnnotationRecord 回源后端（persisted 副本 local=saved）", async () => {
    writeAnnotationDoc(SESSION, SCOPE, docOf([strokeAt(5, 5)]));
    await settleAnnotationPersistence();
    resetAnnotationStoreForTest(); // 清内存缓存（后端保持）
    const record = await getAnnotationRecord(SESSION, SCOPE);
    expect(record?.doc.strokes).toHaveLength(1);
    expect(record?.pending?.mutationId).toMatch(/-/); // pending 连同 mutationId 已原子落盘
    expect(record?.local).toBe("saved");
  });
});

describe("applyBasePreview / applyAnnotationView（服务端事实播种）", () => {
  it("迟到旧视图或云端回退不得降低已确认版本与替换正文", async () => {
    const cloud = docOf([strokeAt(8, 8)]);
    await applyAnnotationView(SESSION, SCOPE, viewOf({ doc: cloud }));
    const stale = viewOf({ doc: docOf([strokeAt(1, 1)]) });
    if (!stale.annotation) throw new Error("测试需要标画版本");
    stale.annotation.revision = 2;
    await applyAnnotationView(SESSION, SCOPE, stale);
    const record = peekAnnotationRecord(SESSION, SCOPE);
    expect(record?.baseRevision).toBe(3);
    expect(record?.doc).toEqual(cloud);
    expect(record?.conflict).not.toBeNull();
  });
  it("applyBasePreview 缓存 base 引用；applyBaseDisabled 落禁用原因且载荷到达后作废", async () => {
    await applyBaseDisabled(SESSION, SCOPE, "该题题干过长……");
    expect(peekAnnotationRecord(SESSION, SCOPE)?.baseDisabledReason).toContain(
      "题干过长",
    );
    await applyBasePreview(SESSION, SCOPE, {
      base: {
        baseId: "b-00000000-0000-4000-8000-000000000003",
        state: "pending",
        stale: false,
        pixelWidth: null,
        pixelHeight: null,
      },
      baseRenderVersion: 1,
      maxWidthPx: 1440,
      questionRevisionId: "b-00000000-0000-4000-8000-000000000001",
      questionNo: 1,
      questionMd: "题面",
      mediaSrcs: [],
      graphFigures: [],
      interactionNotes: [],
    } as Parameters<typeof applyBasePreview>[2]);
    const record = peekAnnotationRecord(SESSION, SCOPE);
    expect(record?.base?.state).toBe("pending");
    expect(record?.baseDisabledReason).toBeNull();
  });

  it("空视图（无 base 无 doc）建壳：base=null、pending=null", async () => {
    await applyAnnotationView(
      SESSION,
      SCOPE,
      viewOf({ base: null, doc: null }),
    );
    const record = peekAnnotationRecord(SESSION, SCOPE);
    expect(record?.base).toBeNull();
    expect(record?.pending).toBeNull();
    expect(record?.doc.strokes).toHaveLength(0);
  });

  it("有 doc 无本地分歧：采用服务端稿、清 pending、对齐 revision/annotationId/base", async () => {
    const serverDoc = docOf([strokeAt(7, 7)]);
    await applyAnnotationView(SESSION, SCOPE, viewOf({ doc: serverDoc }));
    const record = peekAnnotationRecord(SESSION, SCOPE);
    expect(record?.base?.state).toBe("ready");
    expect(record?.baseRevision).toBe(3);
    expect(record?.annotationId).toBe("n-00000000-0000-4000-8000-000000000001");
    expect(record?.pending).toBeNull();
    expect(digestOf(record?.doc)).toBe(digestOf(serverDoc));
  });

  it("本地有未同步且内容不同：保留本地待传（不覆盖未同步本地稿），对齐 base 引用", async () => {
    writeAnnotationDoc(SESSION, SCOPE, docOf([strokeAt(1, 1)]));
    await applyAnnotationView(
      SESSION,
      SCOPE,
      viewOf({ doc: docOf([strokeAt(9, 9)]) }),
    );
    const record = peekAnnotationRecord(SESSION, SCOPE);
    expect(record?.pending).not.toBeNull();
    expect(record?.doc.strokes[0]?.points[0]?.x).toBe(1); // 本地稿保留
    expect(record?.baseRevision).toBe(0);
    expect(record?.conflict?.current?.revision).toBe(3);
  });

  it("本地 pending 与服务端稿相等（丢回执形态）：清 pending 不回传", async () => {
    const local = docOf([strokeAt(4, 4)]);
    writeAnnotationDoc(SESSION, SCOPE, local);
    await applyAnnotationView(SESSION, SCOPE, viewOf({ doc: local }));
    expect(peekAnnotationRecord(SESSION, SCOPE)?.pending).toBeNull();
  });

  it("stale 底图引用如实缓存（UI 显示「旧版本题干的标注」）", async () => {
    await applyAnnotationView(SESSION, SCOPE, {
      ...viewOf({ doc: docOf() }),
      base: {
        baseId: "b-00000000-0000-4000-8000-000000000002",
        state: "ready",
        stale: true,
        pixelWidth: 1440,
        pixelHeight: 900,
        downloadUrl: "/x.png",
      },
    });
    expect(peekAnnotationRecord(SESSION, SCOPE)?.base?.stale).toBe(true);
  });
});

describe("回执 / 冲突 / 被拒落地", () => {
  it("mutationId 匹配才清 pending；A 回执不清 B（B 在途期间写入）", async () => {
    writeAnnotationDoc(SESSION, SCOPE, docOf([strokeAt(1, 1)]));
    const first = peekAnnotationRecord(SESSION, SCOPE)?.pending?.mutationId;
    // 在途期间写入 B（pending 换新）
    writeAnnotationDoc(SESSION, SCOPE, docOf([strokeAt(2, 2)]));
    const receipt: AnnotationReceipt = {
      annotationId: "n-00000000-0000-4000-8000-000000000009",
      revision: 1,
      hash: "b".repeat(64),
      savedAt: "2026-10-08T01:00:00Z",
    };
    if (first === undefined) throw new Error("应有 pending");
    await applyAnnotationReceipt(SESSION, SCOPE, first, receipt);
    const record = peekAnnotationRecord(SESSION, SCOPE);
    expect(record?.pending).not.toBeNull(); // B 仍 dirty
    expect(record?.baseRevision).toBe(1); // 但 baseRevision 推进
    expect(record?.annotationId).toBe(receipt.annotationId);
  });

  it("冲突落地保留 pending（裁决入口消费）；被拒终态停传", async () => {
    writeAnnotationDoc(SESSION, SCOPE, docOf([strokeAt(1, 1)]));
    const current: AnnotationConflictCurrent = {
      annotationId: "n-1",
      revision: 5,
      hash: "c".repeat(64),
      savedAt: "2026-10-08T02:00:00Z",
    };
    await applyAnnotationConflict(
      SESSION,
      SCOPE,
      "revision",
      current,
      "版本冲突",
    );
    let record = peekAnnotationRecord(SESSION, SCOPE);
    expect(record?.conflict?.current?.revision).toBe(5);
    expect(record?.conflict?.kind).toBe("revision");
    expect(record?.pending).not.toBeNull();
    await applyAnnotationDenied(SESSION, SCOPE, "access", "已交卷");
    record = peekAnnotationRecord(SESSION, SCOPE);
    expect(record?.denied?.kind).toBe("access");
  });
});

describe("冲突分类 kind 落库（批次三 A）", () => {
  it("revision/mutation/layout 三类 kind 如实落库", async () => {
    writeAnnotationDoc(SESSION, SCOPE, docOf([strokeAt(1, 1)]));
    await applyAnnotationConflict(
      SESSION,
      SCOPE,
      "revision",
      {
        annotationId: "n-1",
        revision: 5,
        hash: "c".repeat(64),
        savedAt: "2026-10-08T02:00:00Z",
      },
      "版本冲突",
    );
    expect(peekAnnotationRecord(SESSION, SCOPE)?.conflict?.kind).toBe(
      "revision",
    );
    await applyAnnotationConflict(
      SESSION,
      SCOPE,
      "mutation",
      null,
      "幂等键错配",
    );
    expect(peekAnnotationRecord(SESSION, SCOPE)?.conflict?.kind).toBe(
      "mutation",
    );
    await applyAnnotationConflict(SESSION, SCOPE, "layout", null, "另一布局");
    expect(peekAnnotationRecord(SESSION, SCOPE)?.conflict?.kind).toBe("layout");
  });

  it("旧记录缺 kind 缺省推导：current 非空→revision、空→mutation（保留旧裁决行为）", async () => {
    const storage = memoryAnnotationBackend();
    const base = {
      doc: docOf([strokeAt(1, 1)]),
      pending: null,
      baseRevision: 0,
      annotationId: null,
      base: null,
      baseDisabledReason: null,
      denied: null,
      local: "saved",
      localError: null,
      editedAt: 0,
      docVersion: 1,
    };
    await storage.set(annotationKeyOf(SESSION, SCOPE), {
      ...base,
      conflict: {
        reason: "旧版冲突",
        current: {
          annotationId: "n-1",
          revision: 5,
          hash: "c".repeat(64),
          savedAt: "2026-10-08T02:00:00Z",
        },
      },
    });
    const legacyMutationScope = { ...SCOPE, questionId: "q-0002" };
    await storage.set(annotationKeyOf(SESSION, legacyMutationScope), {
      ...base,
      conflict: { reason: "旧版幂等键错配", current: null },
    });
    installAnnotationBackend(storage);
    expect((await getAnnotationRecord(SESSION, SCOPE))?.conflict?.kind).toBe(
      "revision",
    );
    expect(
      (await getAnnotationRecord(SESSION, legacyMutationScope))?.conflict?.kind,
    ).toBe("mutation");
  });
});

describe("retained 本机保留态（批次三 B）", () => {
  it("layout keep-local＝置 retained 不重铸；revision 维持对齐重传口径", async () => {
    writeAnnotationDoc(SESSION, SCOPE, docOf([strokeAt(1, 1)]));
    const mutationId = peekAnnotationRecord(SESSION, SCOPE)?.pending
      ?.mutationId;
    await applyAnnotationConflict(
      SESSION,
      SCOPE,
      "layout",
      null,
      "服务器已有另一布局",
    );
    await expect(
      resolveAnnotationConflictKeepLocal(SESSION, SCOPE),
    ).resolves.toBe("retained");
    let record = peekAnnotationRecord(SESSION, SCOPE);
    expect(record?.conflict).toBeNull();
    expect(record?.retained?.reason).toContain("另一布局");
    expect(record?.pending?.mutationId).toBe(mutationId); // 不重铸
    expect(getAnnotationView(SESSION, SCOPE)?.server).toBe("retained");

    const correctionScope = { ...SCOPE, phase: "correction" as const };
    writeAnnotationDoc(SESSION, correctionScope, docOf([strokeAt(2, 2)]));
    await applyAnnotationConflict(
      SESSION,
      correctionScope,
      "revision",
      {
        annotationId: "n-2",
        revision: 9,
        hash: "d".repeat(64),
        savedAt: "2026-10-08T03:00:00Z",
      },
      "版本冲突",
    );
    await expect(
      resolveAnnotationConflictKeepLocal(SESSION, correctionScope),
    ).resolves.toBe("rearm");
    record = peekAnnotationRecord(SESSION, correctionScope);
    expect(record?.retained).toBeNull();
    expect(record?.baseRevision).toBe(9);
  });

  it("无冲突时 keep-local 幂等跳过（none）", async () => {
    writeAnnotationDoc(SESSION, SCOPE, docOf([strokeAt(1, 1)]));
    await expect(
      resolveAnnotationConflictKeepLocal(SESSION, SCOPE),
    ).resolves.toBe("none");
  });

  it("清除路径：手动清返回幂等；采用云端版本（choice）清；维护重置清", async () => {
    writeAnnotationDoc(SESSION, SCOPE, docOf([strokeAt(1, 1)]));
    const expected =
      peekAnnotationRecord(SESSION, SCOPE)?.pending?.mutationId ?? null;
    await applyAnnotationConflict(SESSION, SCOPE, "layout", null, "另一布局");
    await resolveAnnotationConflictKeepLocal(SESSION, SCOPE);
    expect(peekAnnotationRecord(SESSION, SCOPE)?.retained?.reason).toContain(
      "另一布局",
    );
    await expect(clearAnnotationRetained(SESSION, SCOPE)).resolves.toBe(true);
    await expect(clearAnnotationRetained(SESSION, SCOPE)).resolves.toBe(false);

    // retained 态下采用云端版本（choice）：retained 清、云端正文采用
    await applyAnnotationConflict(SESSION, SCOPE, "layout", null, "另一布局");
    await resolveAnnotationConflictKeepLocal(SESSION, SCOPE);
    const cloud = docOf([strokeAt(9, 9)]);
    await applyAnnotationView(SESSION, SCOPE, viewOf({ doc: cloud }), {
      expectedMutationId: expected,
    });
    const record = peekAnnotationRecord(SESSION, SCOPE);
    expect(record?.retained).toBeNull();
    expect(record?.conflict).toBeNull();
    expect(record?.pending).toBeNull();

    // 维护重置（resetVersion 推进）同样清 retained
    await applyAnnotationConflict(SESSION, SCOPE, "layout", null, "另一布局");
    await resolveAnnotationConflictKeepLocal(SESSION, SCOPE);
    await applyAnnotationView(SESSION, SCOPE, {
      base: null,
      doc: null,
      annotation: null,
      maxWidthPx: 1440,
      resetVersion: 5,
    });
    expect(peekAnnotationRecord(SESSION, SCOPE)?.retained).toBeNull();
  });

  it("非 choice 播种不清 retained（保留态稳定，不重启自动同步）", async () => {
    writeAnnotationDoc(SESSION, SCOPE, docOf([strokeAt(1, 1)]));
    await applyAnnotationConflict(SESSION, SCOPE, "layout", null, "另一布局");
    await resolveAnnotationConflictKeepLocal(SESSION, SCOPE);
    // 云端空视图（无 doc）：本地未同步保留，retained 不动
    await applyAnnotationView(SESSION, SCOPE, viewOf({ doc: null }));
    expect(peekAnnotationRecord(SESSION, SCOPE)?.retained?.reason).toContain(
      "另一布局",
    );
  });
});

describe("派生态与快照", () => {
  it("denied > conflict > retained > uploading > dirty > synced", async () => {
    writeAnnotationDoc(SESSION, SCOPE, docOf([strokeAt(1, 1)]));
    const record = peekAnnotationRecord(SESSION, SCOPE);
    if (record === null) throw new Error("记录应在");
    expect(deriveAnnotationServerState(record, false)).toBe("dirty");
    expect(deriveAnnotationServerState(record, true)).toBe("uploading");
    await applyAnnotationConflict(SESSION, SCOPE, "layout", null, "冲突");
    const conflicted = peekAnnotationRecord(SESSION, SCOPE);
    if (conflicted === null) throw new Error("记录应在");
    expect(deriveAnnotationServerState(conflicted, true)).toBe("conflict");
    await resolveAnnotationConflictKeepLocal(SESSION, SCOPE);
    const retainedRecord = peekAnnotationRecord(SESSION, SCOPE);
    if (retainedRecord === null) throw new Error("记录应在");
    expect(retainedRecord.retained).not.toBeNull();
    expect(deriveAnnotationServerState(retainedRecord, true)).toBe("retained");
    await applyAnnotationDenied(SESSION, SCOPE, "access", "拒");
    const denied = peekAnnotationRecord(SESSION, SCOPE);
    if (denied === null) throw new Error("记录应在");
    expect(deriveAnnotationServerState(denied, true)).toBe("denied");
  });

  it("getAnnotationView 快照：订阅通知 + uploading 翻转触发重取", async () => {
    writeAnnotationDoc(SESSION, SCOPE, docOf([strokeAt(1, 1)]));
    const notified: string[] = [];
    subscribeAnnotationStore((key) => notified.push(key));
    setUploading(SESSION, SCOPE, true);
    const view = getAnnotationView(SESSION, SCOPE);
    expect(view?.server).toBe("uploading");
    expect(notified.length).toBeGreaterThan(0);
  });
});

describe("attempt 作用域待传清单（交卷 flush 用）", () => {
  it("只列本 attempt 的 pending（含全部 phase）；其他 attempt 不进清单", async () => {
    writeAnnotationDoc(SESSION, SCOPE, docOf([strokeAt(1, 1)]));
    writeAnnotationDoc(
      SESSION,
      { ...SCOPE, phase: "correction" },
      docOf([strokeAt(2, 2)]),
    );
    writeAnnotationDoc(
      SESSION,
      { ...SCOPE, attemptId: "a-other" },
      docOf([strokeAt(3, 3)]),
    );
    const pending = await listPendingAnnotations(SESSION, "a-0001");
    expect(pending).toHaveLength(2);
    expect(pending).toContainEqual(SCOPE);
    expect(pending).toContainEqual({ ...SCOPE, phase: "correction" });
    expect(pending).not.toContainEqual({ ...SCOPE, attemptId: "a-other" });
  });
});

it("服务端重置后先归档该题本机稿，再清理旧底图与待传；迟到旧视图不恢复", async () => {
  const storage = memoryAnnotationBackend();
  installAnnotationBackend(storage);
  const original = docOf([strokeAt(10, 10)]);
  writeAnnotationDoc(SESSION, SCOPE, original);
  await settleAnnotationPersistence();
  await applyAnnotationView(SESSION, SCOPE, {
    base: null,
    doc: null,
    annotation: null,
    maxWidthPx: 1440,
    resetVersion: 5,
  });
  const saved = await getAnnotationRecord(SESSION, SCOPE);
  expect(saved?.doc.strokes).toHaveLength(0);
  expect(saved?.pending).toBeNull();
  expect(saved?.localBase).toBeNull();
  expect(
    (await storage.getAll("")).some((entry) =>
      entry[0].startsWith('["annotation-reset-archive"'),
    ),
  ).toBe(true);
  await expect(
    applyAnnotationView(SESSION, SCOPE, {
      ...viewOf({ doc: original }),
      resetVersion: 0,
    }),
  ).rejects.toThrow("重置");
  expect((await getAnnotationRecord(SESSION, SCOPE))?.doc.strokes).toHaveLength(
    0,
  );
});

it("重置归档失败不清除本机待传稿，其他作答不受重置影响", async () => {
  const storage = memoryAnnotationBackend();
  const original = docOf([strokeAt(10, 10)]);
  const other = { ...SCOPE, attemptId: "other-attempt" };
  installAnnotationBackend(storage);
  writeAnnotationDoc(SESSION, SCOPE, original);
  writeAnnotationDoc(SESSION, other, original);
  await settleAnnotationPersistence();
  installAnnotationBackend({
    ...storage,
    set: async (key, value) => {
      if (key.startsWith('["annotation-reset-archive"'))
        throw new Error("归档失败");
      await storage.set(key, value);
    },
  });
  await expect(
    applyAnnotationView(SESSION, SCOPE, {
      base: null,
      doc: null,
      annotation: null,
      maxWidthPx: 1440,
      resetVersion: 5,
    }),
  ).rejects.toThrow("归档失败");
  expect((await getAnnotationRecord(SESSION, SCOPE))?.doc).toEqual(original);
  expect((await getAnnotationRecord(SESSION, other))?.doc).toEqual(original);
});

it("重置前迟到回执不能拉回旧标画行或旧版本基线", async () => {
  writeAnnotationDoc(SESSION, SCOPE, docOf([strokeAt(10, 10)]));
  await settleAnnotationPersistence();
  const old = await getAnnotationRecord(SESSION, SCOPE);
  await applyAnnotationView(SESSION, SCOPE, {
    base: null,
    doc: null,
    annotation: null,
    maxWidthPx: 1440,
    resetVersion: 6,
  });
  await applyAnnotationReceipt(
    SESSION,
    SCOPE,
    old?.pending?.mutationId ?? "old",
    {
      annotationId: "old-row",
      revision: 99,
      hash: "a".repeat(64),
      savedAt: "2026-10-16",
    },
    0,
  );
  expect((await getAnnotationRecord(SESSION, SCOPE))?.baseRevision).toBe(0);
  expect((await getAnnotationRecord(SESSION, SCOPE))?.annotationId).toBeNull();
  expect(getAnnotationView(SESSION, SCOPE)?.resetVersion).toBe(6);
});

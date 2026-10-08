import type {
  AnnotationConflictCurrent,
  AnnotationDoc,
  AnnotationBaseRef,
  AnnotationReceipt,
  AnnotationViewData,
} from "@tutor/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { digestOf } from "@/features/attempt/draft-merge";
import {
  annotationKeyOf,
  applyAnnotationConflict,
  applyAnnotationDenied,
  applyAnnotationReceipt,
  applyAnnotationView,
  applyBaseDisabled,
  applyBasePreview,
  deriveAnnotationServerState,
  getAnnotationRecord,
  getAnnotationView,
  installAnnotationBackend,
  listPendingAnnotations,
  memoryAnnotationBackend,
  parseAnnotationKey,
  peekAnnotationRecord,
  resetAnnotationStoreForTest,
  settleAnnotationPersistence,
  setUploading,
  subscribeAnnotationStore,
  writeAnnotationDoc,
  type AnnotationSessionRef,
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
            downloadUrl: "/api/student/attempts/a-0001/annotation-base/b-1/image.png",
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
    const v2 = writeAnnotationDoc(SESSION, SCOPE, docOf([strokeAt(1, 1), strokeAt(2, 2)]));
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
    await applyAnnotationView(SESSION, SCOPE, viewOf({ base: null, doc: null }));
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
    expect(record?.annotationId).toBe(
      "n-00000000-0000-4000-8000-000000000001",
    );
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
    expect(record?.baseRevision).toBe(3);
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
    await applyAnnotationConflict(SESSION, SCOPE, current, "版本冲突");
    let record = peekAnnotationRecord(SESSION, SCOPE);
    expect(record?.conflict?.current?.revision).toBe(5);
    expect(record?.pending).not.toBeNull();
    await applyAnnotationDenied(SESSION, SCOPE, "access", "已交卷");
    record = peekAnnotationRecord(SESSION, SCOPE);
    expect(record?.denied?.kind).toBe("access");
  });
});

describe("派生态与快照", () => {
  it("denied > conflict > uploading > dirty > synced", async () => {
    writeAnnotationDoc(SESSION, SCOPE, docOf([strokeAt(1, 1)]));
    const record = peekAnnotationRecord(SESSION, SCOPE);
    if (record === null) throw new Error("记录应在");
    expect(deriveAnnotationServerState(record, false)).toBe("dirty");
    expect(deriveAnnotationServerState(record, true)).toBe("uploading");
    await applyAnnotationConflict(SESSION, SCOPE, null, "冲突");
    const conflicted = peekAnnotationRecord(SESSION, SCOPE);
    if (conflicted === null) throw new Error("记录应在");
    expect(deriveAnnotationServerState(conflicted, true)).toBe("conflict");
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

import type { AnnotationDoc, AnnotationSurfaceLayout } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryKVBackend } from "@/lib/kv-backend";
import {
  annotationBaseKeyOf,
  annotationKeyOf,
  applyAnnotationView,
  getAnnotationRecord,
  installAnnotationBackend,
  listPendingAnnotations,
  memoryAnnotationBackend,
  resetAnnotationStoreForTest,
  retryAnnotationPersistence,
  settleAnnotationPersistence,
  settleAnnotationRecordPersistence,
  writeAnnotationDoc,
  writeLocalAnnotationBase,
} from "./annotation-store";

const session = { origin: "https://tutor.test", studentId: "student-a" };
const scope = {
  attemptId: "attempt-a",
  questionId: "question-a",
  phase: "scratch" as const,
};
const layout: AnnotationSurfaceLayout = {
  renderVersion: 2,
  questionRevisionId: "11111111-1111-4111-8111-111111111111",
  cssWidth: 300,
  cssHeight: 200,
  pixelRatio: 2,
  styleVersion: 1,
  contentSignature: "a".repeat(64),
  geometrySignature: "b".repeat(64),
  fontSignature: "c".repeat(64),
};
const doc: AnnotationDoc = {
  version: 1,
  baseWidth: 600,
  baseHeight: 400,
  strokes: [],
};
const png = new Blob([new Uint8Array([137, 80, 78, 71])], {
  type: "image/png",
});

it("下载已有底图仅缓存，不制造待传编辑，也不覆盖下载期间的新笔迹", async () => {
  const baseId = "22222222-2222-4222-8222-222222222222";
  await applyAnnotationView(session, scope, {
    base: {
      baseId,
      state: "ready",
      stale: false,
      pixelWidth: 600,
      pixelHeight: 400,
      layout,
    },
    maxWidthPx: 600,
    doc: null,
    annotation: null,
  });
  await writeLocalAnnotationBase(session, scope, { png, layout }, doc, {
    boundBaseId: baseId,
  });
  expect((await getAnnotationRecord(session, scope))?.pending).toBeNull();
  const changed = {
    ...doc,
    strokes: [
      {
        tool: "pen" as const,
        color: "#ff0000",
        weight: 2,
        points: [{ x: 20, y: 30, p: 0.5, t: 0 }],
      },
    ],
  };
  writeAnnotationDoc(session, scope, changed);
  const before = await getAnnotationRecord(session, scope);
  const pending = before?.pending;
  const version = before?.docVersion;
  await writeLocalAnnotationBase(session, scope, { png, layout }, doc, {
    boundBaseId: baseId,
  });
  const after = await getAnnotationRecord(session, scope);
  expect(after?.doc).toEqual(changed);
  expect(after?.pending).toEqual(pending);
  expect(after?.docVersion).toBe(version);
  expect(after?.localBase?.boundBaseId).toBe(baseId);
  await expect(
    writeLocalAnnotationBase(session, scope, { png, layout }, doc, {
      boundBaseId: "other",
    }),
  ).rejects.toThrow("底图");
});

it("题级等待覆盖连续写入，整卷等待仍等待未完成的题", async () => {
  await writeLocalAnnotationBase(session, scope, { png, layout }, doc);
  const backend = memoryAnnotationBackend();
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const writes = vi.fn();
  installAnnotationBackend({
    ...backend,
    set: async (key, value) => {
      writes();
      await (writes.mock.calls.length === 1 ? first.promise : second.promise);
      await backend.set(key, value);
    },
  });
  const saved = writeLocalAnnotationBase(session, scope, { png, layout }, doc);
  await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
  writeAnnotationDoc(session, scope, doc);
  let settled = false;
  const waiting = settleAnnotationRecordPersistence(session, scope).then(() => {
    settled = true;
  });
  const globalWaiting = settleAnnotationPersistence();
  try {
    first.resolve();
    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
  } finally {
    second.resolve();
    await Promise.all([saved, waiting, globalWaiting]);
  }
  expect((await getAnnotationRecord(session, scope))?.local).toBe("saved");
});
beforeEach(() => {
  resetAnnotationStoreForTest();
  installAnnotationBackend(memoryAnnotationBackend());
});

it("PNG、布局、矢量、同步状态分键落地，重启恢复且不伪造baseId", async () => {
  const backend = memoryAnnotationBackend();
  const writes: Array<{ key: string; value: unknown }> = [];
  installAnnotationBackend({
    ...backend,
    set: async (key, value) => {
      writes.push({ key, value });
      await backend.set(key, value);
    },
  });
  await writeLocalAnnotationBase(session, scope, { png, layout }, doc);
  // 分键（批次五 P1-1）：底图字节入独立键，正文为不含 PNG 的小记录
  expect(writes).toHaveLength(2);
  const [baseWrite, bodyWrite] = writes;
  expect(baseWrite?.key.startsWith('["annotation-base"')).toBe(true);
  expect(baseWrite?.value).toBeInstanceOf(Uint8Array);
  expect(bodyWrite?.key).toBe(annotationKeyOf(session, scope));
  const bodyValue = bodyWrite?.value as
    | { localBase: { png?: unknown } | null }
    | undefined;
  expect(bodyValue?.localBase?.png).toBeUndefined();
  resetAnnotationStoreForTest();
  const restored = await getAnnotationRecord(session, scope);
  expect(restored?.localBase?.layout).toEqual(layout);
  expect(restored?.localBase?.png.size).toBe(png.size);
  expect(restored?.doc).toEqual(doc);
  expect(restored?.pending?.doc).toEqual(doc);
  expect(restored?.base).toBeNull();
  expect(
    await getAnnotationRecord({ ...session, studentId: "student-b" }, scope),
  ).toBeNull();
});
it("本地写失败不得冒称已保存，失败仍保留内存稿可重试", async () => {
  const backend = memoryAnnotationBackend();
  installAnnotationBackend({
    ...backend,
    set: async () => {
      throw new Error("磁盘写入失败");
    },
  });
  await expect(
    writeLocalAnnotationBase(session, scope, { png, layout }, doc),
  ).rejects.toThrow("磁盘写入失败");
  expect((await getAnnotationRecord(session, scope))?.local).toBe("failed");
});
it("不同布局或不匹配的矢量不得覆盖已有本机底图", async () => {
  await writeLocalAnnotationBase(session, scope, { png, layout }, doc);
  await expect(
    writeLocalAnnotationBase(
      session,
      scope,
      { png, layout: { ...layout, geometrySignature: "d".repeat(64) } },
      doc,
    ),
  ).rejects.toThrow("布局");
  await expect(
    writeLocalAnnotationBase(
      session,
      scope,
      { png, layout },
      { ...doc, baseWidth: 601 },
    ),
  ).rejects.toThrow("尺寸");
  expect(
    (await getAnnotationRecord(session, scope))?.localBase?.layout,
  ).toEqual(layout);
});

it("重试原子落盘保留同一底图、文档版本和待传标识", async () => {
  const backend = memoryAnnotationBackend();
  let failed = true;
  installAnnotationBackend({
    ...backend,
    set: async (key, value) => {
      if (failed) throw new Error("空间不足");
      await backend.set(key, value);
    },
  });
  await expect(
    writeLocalAnnotationBase(session, scope, { png, layout }, doc),
  ).rejects.toThrow("空间不足");
  const before = await getAnnotationRecord(session, scope);
  const version = before?.docVersion;
  const pending = before?.pending;
  await expect(retryAnnotationPersistence(session, scope)).rejects.toThrow(
    "空间不足",
  );
  failed = false;
  await retryAnnotationPersistence(session, scope);
  const saved = await getAnnotationRecord(session, scope);
  expect(saved?.local).toBe("saved");
  expect(saved?.docVersion).toBe(version);
  expect(saved?.pending).toEqual(pending);
  expect(saved?.localBase?.png).toBe(png);
  resetAnnotationStoreForTest();
  expect(
    (await getAnnotationRecord(session, scope))?.localBase?.layout,
  ).toEqual(layout);
});

it("空错误不会显示为 null；再次写入成功前持续保留原稿和失败状态", async () => {
  const backend = memoryAnnotationBackend();
  let failed = true;
  installAnnotationBackend({
    ...backend,
    set: async (key, value) => {
      if (failed) throw null;
      await backend.set(key, value);
    },
  });
  await expect(
    writeLocalAnnotationBase(session, scope, { png, layout }, doc),
  ).rejects.toThrow("本机存储");
  const before = await getAnnotationRecord(session, scope);
  expect(before?.local).toBe("failed");
  expect(before?.localError).not.toBe("null");
  await expect(retryAnnotationPersistence(session, scope)).rejects.toThrow();
  expect((await getAnnotationRecord(session, scope))?.local).toBe("failed");
  failed = false;
  await retryAnnotationPersistence(session, scope);
  const saved = await getAnnotationRecord(session, scope);
  expect(saved?.local).toBe("saved");
  expect(saved?.localBase).toEqual(before?.localBase);
  expect(saved?.pending).toEqual(before?.pending);
  expect(saved?.docVersion).toBe(before?.docVersion);
});

// ---------- 批次五（P1-1）：底图 PNG 与正文分键，每笔不再整记录重写 ----------

/** 底图独立键前缀（正文键首元为 "annotation"，天然不冲突） */
const BASE_KEY_PREFIX = '["annotation-base"';
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG2_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function strokeAt(x: number): AnnotationDoc["strokes"][number] {
  return {
    tool: "pen",
    color: "#1f2328",
    weight: 2,
    points: [{ x, y: 30, p: 0.5, t: 0 }],
  };
}

/** 计数底图键与正文键的 set 次数（底图只写一次断言用） */
function countingStorage(): {
  storage: ReturnType<typeof memoryKVBackend>;
  setCalls: string[];
  basePuts: () => number;
  bodyPuts: () => number;
} {
  const storage = memoryKVBackend();
  const setCalls: string[] = [];
  const wrapped = {
    ...storage,
    set: async (key: string, value: unknown) => {
      setCalls.push(key);
      await storage.set(key, value);
    },
  };
  installAnnotationBackend(wrapped);
  return {
    storage,
    setCalls,
    basePuts: () =>
      setCalls.filter((k) => k.startsWith(BASE_KEY_PREFIX)).length,
    bodyPuts: () =>
      setCalls.filter((k) => !k.startsWith(BASE_KEY_PREFIX)).length,
  };
}

describe("分键持久化（批次五 P1-1）", () => {
  it("每笔 writeAnnotationDoc 只写正文小记录；底图键只在首次落盘时写一次", async () => {
    const { storage, basePuts, bodyPuts } = countingStorage();
    await writeLocalAnnotationBase(session, scope, { png, layout }, doc);
    expect(basePuts()).toBe(1);
    expect(bodyPuts()).toBe(1);
    for (const x of [10, 20, 30]) {
      writeAnnotationDoc(session, scope, { ...doc, strokes: [strokeAt(x)] });
      await settleAnnotationPersistence();
    }
    expect(basePuts()).toBe(1); // 多笔不重写底图
    expect(bodyPuts()).toBe(4); // 首次 + 三笔，每笔都写正文
    // 正文记录不再内嵌 PNG 字节，只携带底图指纹引用
    const body = (await storage.get(annotationKeyOf(session, scope))) as {
      localBase: { png?: unknown; pngDigest?: unknown } | null;
    };
    expect(body.localBase?.png).toBeUndefined();
    expect(typeof body.localBase?.pngDigest).toBe("string");
    // 底图键值是 PNG 字节（WebKit 可写的 Uint8Array 形态）
    const baseEntries = await storage.getAll(BASE_KEY_PREFIX);
    expect(baseEntries).toHaveLength(1);
    expect(baseEntries[0]?.[1]).toBeInstanceOf(Uint8Array);
  });

  it("底图内容未变（同引用或同字节新引用）不重写底图键；真正替换写新键且旧键保留", async () => {
    const { storage, basePuts } = countingStorage();
    const pngA = new Blob([PNG_BYTES], { type: "image/png" });
    await writeLocalAnnotationBase(session, scope, { png: pngA, layout }, doc);
    expect(basePuts()).toBe(1);
    // 同一 Blob 引用再次本机落盘：不重写
    await writeLocalAnnotationBase(session, scope, { png: pngA, layout }, doc);
    expect(basePuts()).toBe(1);
    // 新引用但同字节（重渲染确定性输出）：内容指纹相同，不重写
    await writeLocalAnnotationBase(
      session,
      scope,
      { png: new Blob([PNG_BYTES], { type: "image/png" }), layout },
      doc,
    );
    expect(basePuts()).toBe(1);
    // 真正替换（prepare 重建/云端重绑同路径）：写新键，旧键保留（断电窗口自洽）
    await writeLocalAnnotationBase(
      session,
      scope,
      { png: new Blob([PNG2_BYTES], { type: "image/png" }), layout },
      doc,
    );
    expect(basePuts()).toBe(2);
    const baseKeys = (await storage.getAll(BASE_KEY_PREFIX)).map(([k]) => k);
    expect(baseKeys).toHaveLength(2);
  });

  it("重启恢复按键取回底图字节拼回 localBase，之后每笔仍不重写底图键", async () => {
    const { basePuts, bodyPuts } = countingStorage();
    await writeLocalAnnotationBase(
      session,
      scope,
      { png: new Blob([PNG_BYTES], { type: "image/png" }), layout },
      doc,
    );
    resetAnnotationStoreForTest();
    const restored = await getAnnotationRecord(session, scope);
    expect(restored?.localBase?.layout).toEqual(layout);
    expect(
      restored?.localBase
        ? [...new Uint8Array(await restored.localBase.png.arrayBuffer())]
        : [],
    ).toEqual([...PNG_BYTES]);
    writeAnnotationDoc(session, scope, { ...doc, strokes: [strokeAt(1)] });
    await settleAnnotationPersistence();
    expect(basePuts()).toBe(1); // 恢复后的笔迹编辑不重写底图键
    expect(bodyPuts()).toBe(2);
  });

  it("底图键缺失或指纹失配：可读错误保稿，正文记录保留不静默清稿", async () => {
    const storage = memoryKVBackend();
    installAnnotationBackend(storage);
    await writeLocalAnnotationBase(
      session,
      scope,
      { png: new Blob([PNG_BYTES], { type: "image/png" }), layout },
      doc,
    );
    await settleAnnotationPersistence();
    for (const [key] of await storage.getAll(BASE_KEY_PREFIX)) {
      await storage.del(key);
    }
    resetAnnotationStoreForTest();
    await expect(
      getAnnotationRecord(session, scope, { strictRead: true }),
    ).rejects.toThrow("底图");
    // 非严格读取不炸（与坏字节同口径：无稿呈现，但记录未删）
    expect(await getAnnotationRecord(session, scope)).toBeNull();
    const body = (await storage.get(annotationKeyOf(session, scope))) as {
      doc?: AnnotationDoc;
    };
    expect(body.doc).toEqual(doc);
    // 严格写入路径同样被拦（引用悬空的记录不允许静默重建覆盖）
    await expect(
      writeLocalAnnotationBase(session, scope, { png, layout }, doc),
    ).rejects.toThrow("底图");
    // 指纹失配（底图键内容被换）：同样可读错误（独立 scope 建稿）
    const tamperScope = { ...scope, phase: "correction" as const };
    await writeLocalAnnotationBase(
      session,
      tamperScope,
      { png: new Blob([PNG_BYTES], { type: "image/png" }), layout },
      doc,
    );
    await settleAnnotationPersistence();
    const tampered = await storage.getAll(BASE_KEY_PREFIX);
    await storage.set(
      tampered[0]?.[0] ?? "",
      new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]),
    );
    resetAnnotationStoreForTest();
    await expect(
      getAnnotationRecord(session, tamperScope, { strictRead: true }),
    ).rejects.toThrow("底图");
  });

  it("旧单键内嵌 PNG 记录可直接读取，并在下次落盘时顺带拆写为分键", async () => {
    const storage = memoryKVBackend();
    installAnnotationBackend(storage);
    const legacyDoc = { ...doc, strokes: [strokeAt(7)] };
    const seedBody = {
      doc: legacyDoc,
      pending: { mutationId: "legacy-mutation", doc: legacyDoc },
      baseRevision: 0,
      annotationId: null,
      base: null,
      baseDisabledReason: null,
      conflict: null,
      retained: null,
      denied: null,
      local: "saved",
      localError: null,
      editedAt: 1,
      docVersion: 3,
    };
    // 生产历史形态：PNG 以 Uint8Array 内嵌正文记录
    await storage.set(annotationKeyOf(session, scope), {
      ...seedBody,
      localBase: { png: PNG_BYTES, layout, boundBaseId: "legacy-base" },
    });
    // 同代 Blob 形态（未过字节后端的旧内存副本）也可读
    await storage.set(
      annotationKeyOf(session, { ...scope, phase: "correction" }),
      {
        ...seedBody,
        localBase: {
          png: new Blob([PNG_BYTES], { type: "image/png" }),
          layout,
        },
      },
    );
    const revived = await getAnnotationRecord(session, scope);
    expect(revived?.localBase?.boundBaseId).toBe("legacy-base");
    expect(
      revived?.localBase
        ? [...new Uint8Array(await revived.localBase.png.arrayBuffer())]
        : [],
    ).toEqual([...PNG_BYTES]);
    expect(revived?.pending?.mutationId).toBe("legacy-mutation");
    const blobRevived = await getAnnotationRecord(session, {
      ...scope,
      phase: "correction",
    });
    expect(
      blobRevived?.localBase
        ? [...new Uint8Array(await blobRevived.localBase.png.arrayBuffer())]
        : [],
    ).toEqual([...PNG_BYTES]);
    // 下一次落盘（任意正文写）顺带拆键：底图进独立键、正文瘦身
    writeAnnotationDoc(session, scope, { ...doc, strokes: [strokeAt(8)] });
    await settleAnnotationPersistence();
    const baseEntries = await storage.getAll(BASE_KEY_PREFIX);
    expect(baseEntries).toHaveLength(1);
    expect(baseEntries[0]?.[1]).toBeInstanceOf(Uint8Array);
    const body = (await storage.get(annotationKeyOf(session, scope))) as {
      localBase: { png?: unknown } | null;
    };
    expect(body.localBase?.png).toBeUndefined();
    // 重启后从新键恢复等价
    resetAnnotationStoreForTest();
    const again = await getAnnotationRecord(session, scope);
    expect(
      again?.localBase
        ? [...new Uint8Array(await again.localBase.png.arrayBuffer())]
        : [],
    ).toEqual([...PNG_BYTES]);
  });

  it("底图键与正文键同规则派生账号/attempt 隔离，前缀扫描不受底图键干扰", async () => {
    expect(annotationBaseKeyOf(session, scope, "digest-a")).toBe(
      JSON.stringify([
        "annotation-base",
        session.origin,
        session.studentId,
        scope.attemptId,
        scope.questionId,
        scope.phase,
        "digest-a",
      ]),
    );
    const { storage } = countingStorage();
    await writeLocalAnnotationBase(session, scope, { png, layout }, doc);
    await settleAnnotationPersistence();
    const keys = (await storage.getAll("")).map(([key]) => key);
    const baseKey = keys.find((key) => key.startsWith(BASE_KEY_PREFIX));
    expect(JSON.parse(baseKey ?? "[]").slice(0, 6)).toEqual([
      "annotation-base",
      session.origin,
      session.studentId,
      scope.attemptId,
      scope.questionId,
      scope.phase,
    ]);
    // 换账号读不到他人底图与正文
    resetAnnotationStoreForTest();
    expect(
      await getAnnotationRecord({ ...session, studentId: "student-b" }, scope, {
        strictRead: true,
      }),
    ).toBeNull();
    // 会话/attempt 前缀扫描只吃正文键，底图键不进清单
    const scopes = await listPendingAnnotations(session, scope.attemptId);
    expect(scopes).toEqual([scope]);
  });
});

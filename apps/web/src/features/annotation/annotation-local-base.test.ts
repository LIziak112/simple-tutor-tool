import type { AnnotationDoc, AnnotationSurfaceLayout } from "@tutor/contract";
import { beforeEach, expect, it, vi } from "vitest";
import {
  applyAnnotationView,
  getAnnotationRecord,
  installAnnotationBackend,
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

it("PNG、布局、矢量、同步状态同键原子落地，重启恢复且不伪造baseId", async () => {
  const backend = memoryAnnotationBackend();
  const writes: unknown[] = [];
  installAnnotationBackend({
    ...backend,
    set: async (key, value) => {
      writes.push(value);
      await backend.set(key, value);
    },
  });
  await writeLocalAnnotationBase(session, scope, { png, layout }, doc);
  expect(writes).toHaveLength(1);
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

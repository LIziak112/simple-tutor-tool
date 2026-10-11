import type { AnnotationDoc, AnnotationSurfaceLayout } from "@tutor/contract";
import { beforeEach, expect, it } from "vitest";
import {
  getAnnotationRecord,
  installAnnotationBackend,
  memoryAnnotationBackend,
  resetAnnotationStoreForTest,
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

import { expect, it } from "vitest";
import { memoryKVBackend } from "@/lib/kv-backend";
import { annotationByteBackend } from "./annotation-byte-backend";

it("底图以字节与正文原子保存，读取与扫描恢复 Blob，保留待传和绑定身份", async () => {
  const raw = memoryKVBackend();
  const backend = annotationByteBackend(raw);
  const record = {
    resetVersion: 3,
    docVersion: 17,
    doc: { strokes: ["原笔迹"] },
    pending: { mutationId: "待传版本" },
    localBase: {
      png: new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
      layout: { cssWidth: 300 },
      boundBaseId: "原底图",
    },
  };
  await backend.set("annotation-one", record);
  expect(await raw.get("annotation-one")).toEqual({
    ...record,
    localBase: { ...record.localBase, png: new Uint8Array([137, 80, 78, 71]) },
  });
  for (const revived of [
    await backend.get("annotation-one"),
    (await backend.getAll("annotation"))[0]?.[1],
  ]) {
    expect(revived).toEqual(record);
    const png = (revived as typeof record).localBase.png;
    expect(png.type).toBe("image/png");
    expect([...new Uint8Array(await png.arrayBuffer())]).toEqual([
      137, 80, 78, 71,
    ]);
  }
});

it("兼容已有 Blob 和无底图旧稿；坏字节不能降级为空稿", async () => {
  const raw = memoryKVBackend();
  const backend = annotationByteBackend(raw);
  const legacy = {
    localBase: { png: new Blob(["旧底图"], { type: "image/png" }) },
    pending: "保留",
  };
  await raw.set("old", legacy);
  expect(await backend.get("old")).toBe(legacy);
  await raw.set("none", { localBase: null });
  expect(await backend.get("none")).toEqual({ localBase: null });
  await raw.set("broken", { localBase: { png: new Uint8Array() } });
  await expect(backend.get("broken")).rejects.toThrow("底图");
});

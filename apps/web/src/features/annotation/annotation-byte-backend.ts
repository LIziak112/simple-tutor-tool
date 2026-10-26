import { ANNOTATION_BASE_PNG_MAX_BYTES } from "@tutor/contract";
import type { KVStoreBackend } from "@/lib/kv-backend";

function localBaseOf(
  value: unknown,
): { record: Record<string, unknown>; base: Record<string, unknown> } | null {
  if (typeof value !== "object" || value === null || !("localBase" in value))
    return null;
  const base = value.localBase;
  if (typeof base !== "object" || base === null) return null;
  return {
    record: value as Record<string, unknown>,
    base: base as Record<string, unknown>,
  };
}

/**
 * WebKit 部分环境不能把 Blob 写入 IDB，PNG 字节仍以 Uint8Array 落库。
 * 批次五 P1-1 分键后本包装只剩两个消费点：旧单键内嵌格式（及重置归档键）
 * 的读取解码、重置归档键的写入编码；新格式的底图字节在 annotation-store
 * 内直接以 Uint8Array 读写独立底图键，不经本包装转换。
 */
export function annotationByteBackend(raw: KVStoreBackend): KVStoreBackend {
  const decode = (value: unknown): unknown => {
    const entry = localBaseOf(value);
    if (!entry || !(entry.base.png instanceof Uint8Array)) return value;
    const bytes = entry.base.png;
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > ANNOTATION_BASE_PNG_MAX_BYTES
    )
      throw new Error("本机圈画底图字节损坏或超限，原记录已保留，请重试");
    return {
      ...entry.record,
      localBase: {
        ...entry.base,
        png: new Blob([Uint8Array.from(bytes)], { type: "image/png" }),
      },
    };
  };
  return {
    ...raw,
    get: async (key) => decode(await raw.get(key)),
    getAll: async (prefix) =>
      (await raw.getAll(prefix)).map(([key, value]) => [key, decode(value)]),
    set: async (key, value) => {
      const entry = localBaseOf(value);
      if (!entry || !(entry.base.png instanceof Blob))
        return raw.set(key, value);
      const png = new Uint8Array(await entry.base.png.arrayBuffer());
      await raw.set(key, {
        ...entry.record,
        localBase: { ...entry.base, png },
      });
    },
  };
}

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

/** WebKit 部分环境不能把 Blob 写入 IDB；同一事务保存 PNG 字节及原有正文，不另开图片键。 */
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

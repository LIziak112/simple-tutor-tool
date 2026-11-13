import {
  ANNOTATION_BASE_PNG_MAX_BYTES,
  type AnnotationDoc,
  annotationPngFingerprint,
} from "@tutor/contract";
import { digestOf } from "@/features/attempt/draft-merge";
import type { KVAtomicBackend, KVStoreBackend } from "@/lib/kv-backend";
import type { AnnotationLocalRecord } from "./annotation-store";

export type AnnotationStoreBackend = Pick<
  KVStoreBackend,
  "get" | "set" | "getAll"
> &
  Partial<Pick<KVAtomicBackend, "update">>;

type Base = NonNullable<AnnotationLocalRecord["localBase"]>;
type BaseMetadata = Omit<Base, "png">;
type Cache = { base: BaseMetadata; digest: string; bytes: Uint8Array };
type CacheEntry = { key: string; bytes: number };
type PreparedBase = { png: Blob; bytes: Uint8Array; digest: string };
export type CloudBaseIdentity = { baseId: string; resetVersion: number };
const CACHE_INDEX = '["annotation-cloud-cache-index",1]';
const CACHE_PREFIX = '["annotation-cloud-cache",';
const MAX_CACHE_BYTES = 48 * 1024 * 1024;
const MAX_CACHE_ITEMS = 24;
const OTHER_TAB = "另一页面已更新本机标画，当前修改仍保留，请先核对原稿";

export async function annotationBaseBytes(png: Blob): Promise<PreparedBase> {
  const bytes = new Uint8Array(await png.arrayBuffer());
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > ANNOTATION_BASE_PNG_MAX_BYTES
  )
    throw new Error("本机圈画底图字节损坏或超限，原记录已保留，请重试");
  return { png, bytes, digest: annotationPngFingerprint(bytes) };
}

export function emptyAnnotationDoc(doc: AnnotationDoc): boolean {
  return (
    doc.strokes.length === 0 &&
    (doc.deleted?.length ?? 0) === 0 &&
    Object.keys(doc.anchors ?? {}).length === 0
  );
}

/** 两份正文按稳定序列化比较。 */
export function annotationDocsEqual(
  a: AnnotationDoc,
  b: AnnotationDoc,
): boolean {
  return digestOf(a) === digestOf(b);
}

function mayCache(record: AnnotationLocalRecord): boolean {
  return (
    record.localBase?.cloudCache === true &&
    record.base?.state === "ready" &&
    !record.base.stale &&
    record.localBase.boundBaseId === record.base.baseId &&
    hasNoLocalWork(record)
  );
}

function hasNoLocalWork(record: Partial<AnnotationLocalRecord>): boolean {
  return (
    record.pending === null &&
    record.conflict === null &&
    record.denied === null &&
    record.retained === null &&
    record.sealedAt === null &&
    record.annotationId === null &&
    record.baseRevision === 0 &&
    record.editedAt === 0 &&
    record.doc !== undefined &&
    emptyAnnotationDoc(record.doc)
  );
}

function matchesEmptyCloudBody(
  value: unknown,
  expected: CloudBaseIdentity,
): boolean {
  if (typeof value !== "object" || value === null) return false;
  const saved = value as Partial<AnnotationLocalRecord>;
  return (
    saved.doc !== undefined &&
    saved.localBase === null &&
    (saved.resetVersion ?? 0) === expected.resetVersion &&
    saved.base?.state === "ready" &&
    !saved.base.stale &&
    saved.base.baseId === expected.baseId &&
    hasNoLocalWork(saved)
  );
}

function cacheKeyOf(key: string): string {
  return `${CACHE_PREFIX}${key}]`;
}

function cacheEntries(raw: unknown): CacheEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is CacheEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.key === "string" &&
      entry.key.startsWith(CACHE_PREFIX) &&
      Number.isSafeInteger(entry.bytes) &&
      entry.bytes > 0,
  );
}

export async function recoverAnnotationCache(
  storage: AnnotationStoreBackend,
  key: string,
  record: AnnotationLocalRecord,
): Promise<(Cache & { identity: CloudBaseIdentity }) | null> {
  if (
    record.base?.state !== "ready" ||
    record.base.stale ||
    record.base.layout === undefined ||
    !hasNoLocalWork(record)
  )
    return null;
  const raw = await storage.get(cacheKeyOf(key));
  if (typeof raw !== "object" || raw === null) return null;
  const cache = raw as Partial<Cache>;
  const { base, bytes, digest } = cache;
  if (
    base?.boundBaseId !== record.base.baseId ||
    JSON.stringify(base.layout) !== JSON.stringify(record.base.layout) ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > ANNOTATION_BASE_PNG_MAX_BYTES ||
    annotationPngFingerprint(bytes) !== digest
  )
    return null;
  return {
    base,
    bytes,
    digest,
    identity: {
      baseId: record.base.baseId,
      resetVersion: record.resetVersion ?? 0,
    },
  };
}

/** 云端空白预备使用独立可丢弃槽位，旧客户端可照常看到无本机稿的云端底图。 */
export async function persistAnnotationRecord(
  backend: AnnotationStoreBackend,
  key: string,
  record: AnnotationLocalRecord,
  baseKeyOf: (digest: string) => string,
  prepared: PreparedBase | undefined,
  knownDigest: string | undefined,
  fromCloudCache: CloudBaseIdentity | null,
): Promise<CloudBaseIdentity | null> {
  const local = record.localBase;
  const cache = backend.update !== undefined && mayCache(record);
  const base =
    local === null
      ? null
      : {
          layout: local.layout,
          ...(local.boundBaseId === undefined
            ? {}
            : { boundBaseId: local.boundBaseId }),
        };
  const body = {
    ...record,
    local: "saved",
    localError: null,
    localBase:
      cache || base === null || prepared === undefined
        ? null
        : { ...base, pngDigest: prepared.digest },
  };
  if (backend.update === undefined) {
    if (prepared !== undefined && knownDigest !== prepared.digest) {
      await backend.set(baseKeyOf(prepared.digest), prepared.bytes);
    }
    await backend.set(key, body);
    return null;
  }
  const cacheKey = cacheKeyOf(key);
  if (cache && prepared !== undefined && base?.boundBaseId !== undefined) {
    const identity = {
      baseId: base.boundBaseId,
      resetVersion: record.resetVersion ?? 0,
    };
    await backend.update([CACHE_INDEX, key], ([index, previous], write) => {
      if (
        previous !== undefined &&
        !matchesEmptyCloudBody(previous, fromCloudCache ?? identity)
      )
        throw new Error(OTHER_TAB);
      const entries = cacheEntries(index).filter(
        (entry) => entry.key !== cacheKey,
      );
      entries.push({ key: cacheKey, bytes: prepared.bytes.byteLength });
      let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
      while (entries.length > MAX_CACHE_ITEMS || bytes > MAX_CACHE_BYTES) {
        const oldest = entries.shift();
        if (oldest === undefined || oldest.key === cacheKey) break;
        bytes -= oldest.bytes;
        write.del(oldest.key);
      }
      write.set(CACHE_INDEX, entries);
      write.set(cacheKey, {
        base,
        bytes: prepared.bytes,
        digest: prepared.digest,
      } satisfies Cache);
      // 其他页面可能已落下原稿。可丢弃缓存不能覆盖该页所见之外的正文。
      if (previous === undefined) write.set(key, body);
    });
    return identity;
  }
  const baseKey =
    prepared === undefined ? undefined : baseKeyOf(prepared.digest);
  await backend.update(
    baseKey === undefined ? [CACHE_INDEX, key] : [CACHE_INDEX, key, baseKey],
    ([index, previous, hasBytes], write) => {
      if (
        fromCloudCache !== null &&
        previous !== undefined &&
        !matchesEmptyCloudBody(previous, fromCloudCache)
      )
        throw new Error(OTHER_TAB);
      if (baseKey !== undefined && !hasBytes && prepared !== undefined)
        write.set(baseKey, prepared.bytes);
      write.set(key, body);
      const entries = cacheEntries(index);
      if (entries.some((entry) => entry.key === cacheKey)) {
        write.del(cacheKey);
        write.set(
          CACHE_INDEX,
          entries.filter((entry) => entry.key !== cacheKey),
        );
      }
    },
    baseKey === undefined ? undefined : new Set([baseKey]),
  );
  return null;
}

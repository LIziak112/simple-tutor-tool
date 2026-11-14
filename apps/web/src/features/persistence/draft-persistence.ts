import type { InkDoc, StudentAnswer } from "@tutor/contract";
import { digestOf, inkDigestOf } from "@/features/persistence/draft-merge";
import type {
  AttemptDraftRecord,
  LocalSnapshotBinding,
  MaterialInkBaseMeta,
} from "@/features/persistence/draft-store";
import { randomUuid } from "@/lib/uuid";

type MaterialDraft = {
  ink?: InkDoc | undefined;
  base?: MaterialInkBaseMeta | undefined;
  snapshot?: LocalSnapshotBinding | undefined;
};

export type LocalDraftConflict =
  | { kind: "answer"; key: string; value: StudentAnswer | undefined }
  | { kind: "ink"; key: string; value: InkDoc | undefined }
  | { kind: "material"; key: string; value: MaterialDraft | undefined };

export function storedVersionOf(
  record: AttemptDraftRecord,
  conflict: LocalDraftConflict,
): LocalDraftConflict {
  const { key } = conflict;
  switch (conflict.kind) {
    case "answer":
      return { kind: "answer", key, value: record.answers[key] };
    case "ink":
      return { kind: "ink", key, value: record.inks[key] };
    case "material":
      return {
        kind: "material",
        key,
        value: {
          ink: record.materialInks?.[key],
          base: record.materialInkBases?.[key],
          snapshot: record.materialSnapshotBindings?.[key],
        },
      };
  }
}

export function readDraftRecord(value: unknown): AttemptDraftRecord {
  const raw = (value ?? {}) as Partial<AttemptDraftRecord>;
  return {
    answers: raw.answers ?? {},
    inks: raw.inks ?? {},
    materialInks: raw.materialInks ?? {},
    materialInkBases: raw.materialInkBases ?? {},
    savedAt: raw.savedAt ?? 0,
    syncedAt: raw.syncedAt ?? 0,
    answerDigests: raw.answerDigests ?? {},
    inkDigests: raw.inkDigests ?? {},
    answerRevisions: raw.answerRevisions ?? {},
    answerMutationIds: raw.answerMutationIds ?? {},
    answerQuestionRevisions: raw.answerQuestionRevisions ?? {},
    inkSnapshotBindings: raw.inkSnapshotBindings ?? {},
    materialSnapshotBindings: raw.materialSnapshotBindings ?? {},
    answerConflicts: raw.answerConflicts ?? {},
    localConflicts: raw.localConflicts ?? [],
  };
}

function setEntry<T>(
  map: Record<string, T>,
  key: string,
  value: T | undefined,
) {
  if (value === undefined) delete map[key];
  else map[key] = value;
}

function mergeMap<T>(
  base: Record<string, T> = {},
  pending: Record<string, T> = {},
  stored: Record<string, T> = {},
  take: (key: string, value: T | undefined) => boolean = () => true,
): Record<string, T> {
  const result = { ...stored };
  for (const key of new Set([...Object.keys(base), ...Object.keys(pending)])) {
    if (
      digestOf(base[key]) !== digestOf(pending[key]) &&
      take(key, pending[key])
    )
      setEntry(result, key, pending[key]);
  }
  return result;
}

function materialsOf(
  record: AttemptDraftRecord,
): Record<string, MaterialDraft> {
  return Object.fromEntries(
    [
      ...new Set([
        ...Object.keys(record.materialInks ?? {}),
        ...Object.keys(record.materialInkBases ?? {}),
      ]),
    ].map((key) => [
      key,
      {
        ink: record.materialInks?.[key],
        base: record.materialInkBases?.[key],
        snapshot: record.materialSnapshotBindings?.[key],
      },
    ]),
  );
}

/** 在同一个读写事务里合入本页相对基线的变更。 */
export function mergePersistedDraft(
  base: AttemptDraftRecord,
  pending: AttemptDraftRecord,
  stored: AttemptDraftRecord,
): AttemptDraftRecord {
  const conflicts = [...(stored.localConflicts ?? [])];
  const answerCollisions = new Set<string>();
  const inkCollisions = new Set<string>();
  const preserveOtherVersion = (
    conflict: LocalDraftConflict,
    before: string | undefined,
    current: string | undefined,
    next: string | undefined,
  ): boolean => {
    if (current === next || next === before) return true;
    if (
      current === before &&
      !conflicts.some(
        (entry) => entry.kind === conflict.kind && entry.key === conflict.key,
      )
    )
      return true;
    if (!conflicts.some((entry) => digestOf(entry) === digestOf(conflict)))
      conflicts.push(conflict);
    return false;
  };
  const answers = mergeMap(
    base.answers,
    pending.answers,
    stored.answers,
    (key, value) => {
      const take = preserveOtherVersion(
        { kind: "answer", key, value },
        digestOf(base.answers[key]),
        digestOf(stored.answers[key]),
        digestOf(value),
      );
      if (!take) answerCollisions.add(key);
      return take;
    },
  );
  const inkBody = (doc: InkDoc | undefined) =>
    doc === undefined ? undefined : inkDigestOf(doc);
  const inks = mergeMap(base.inks, pending.inks, stored.inks, (key, value) => {
    const before = inkBody(base.inks[key]);
    const current = inkBody(stored.inks[key]);
    const next = inkBody(value);
    // 迟到回执可更新同步元数据，本页正文没有改动时不写回旧正文。
    if (current !== next && next === before) return false;
    if (
      current === next &&
      (value?.serverRevision ?? 0) < (stored.inks[key]?.serverRevision ?? 0)
    )
      return false;
    const take = preserveOtherVersion(
      { kind: "ink", key, value },
      before,
      current,
      next,
    );
    if (!take) inkCollisions.add(key);
    return take;
  });
  const baseMaterials = materialsOf(base);
  const storedMaterials = materialsOf(stored);
  const materials = mergeMap(
    baseMaterials,
    materialsOf(pending),
    storedMaterials,
    (key, value) =>
      preserveOtherVersion(
        { kind: "material", key, value },
        digestOf(baseMaterials[key]),
        digestOf(storedMaterials[key]),
        digestOf(value),
      ),
  );
  const materialInks: Record<string, InkDoc> = {};
  const materialInkBases: Record<string, MaterialInkBaseMeta> = {};
  const materialSnapshotBindings: Record<string, LocalSnapshotBinding> = {};
  for (const [key, material] of Object.entries(materials)) {
    setEntry(materialInks, key, material.ink);
    setEntry(materialInkBases, key, material.base);
    setEntry(materialSnapshotBindings, key, material.snapshot);
  }
  const answerMetadata = (key: string) =>
    !answerCollisions.has(key) &&
    (pending.answerRevisions?.[key] ?? 0) >=
      (stored.answerRevisions?.[key] ?? 0);
  return {
    answers,
    inks,
    materialInks,
    materialInkBases,
    materialSnapshotBindings,
    savedAt: Math.max(stored.savedAt, pending.savedAt),
    syncedAt: Math.max(stored.syncedAt, pending.syncedAt),
    answerDigests: mergeMap(
      base.answerDigests,
      pending.answerDigests,
      stored.answerDigests,
      answerMetadata,
    ),
    inkDigests: mergeMap(
      base.inkDigests,
      pending.inkDigests,
      stored.inkDigests,
      (key) =>
        !inkCollisions.has(key) &&
        (pending.inks[key]?.serverRevision ?? 0) >=
          (stored.inks[key]?.serverRevision ?? 0),
    ),
    inkSnapshotBindings: mergeMap(
      base.inkSnapshotBindings,
      pending.inkSnapshotBindings,
      stored.inkSnapshotBindings,
      (key, binding) =>
        !inkCollisions.has(key) && binding?.digest === inkBody(inks[key]),
    ),
    answerRevisions: mergeMap(
      base.answerRevisions,
      pending.answerRevisions,
      stored.answerRevisions,
      answerMetadata,
    ),
    answerMutationIds: mergeMap(
      base.answerMutationIds,
      pending.answerMutationIds,
      stored.answerMutationIds,
      (key) => !answerCollisions.has(key),
    ),
    answerQuestionRevisions: mergeMap(
      base.answerQuestionRevisions,
      pending.answerQuestionRevisions,
      stored.answerQuestionRevisions,
      (key) => !answerCollisions.has(key),
    ),
    answerConflicts: mergeMap(
      base.answerConflicts,
      pending.answerConflicts,
      stored.answerConflicts,
      answerMetadata,
    ),
    localConflicts: conflicts,
  };
}

export function clearConfirmedDraft(
  record: AttemptDraftRecord,
): AttemptDraftRecord | undefined {
  const hasConflict = (kind: LocalDraftConflict["kind"], key: string) =>
    record.localConflicts?.some(
      (entry) => entry.kind === kind && entry.key === key,
    );
  for (const [key, answer] of Object.entries(record.answers)) {
    if (hasConflict("answer", key) || record.answerConflicts?.[key]) continue;
    if (record.answerDigests[key] !== digestOf(answer)) continue;
    delete record.answers[key];
    delete record.answerDigests[key];
    delete record.answerRevisions?.[key];
    delete record.answerMutationIds?.[key];
    delete record.answerQuestionRevisions?.[key];
  }
  for (const [key, doc] of Object.entries(record.inks)) {
    if (hasConflict("ink", key) || record.inkDigests[key] !== inkDigestOf(doc))
      continue;
    delete record.inks[key];
    delete record.inkDigests[key];
    delete record.inkSnapshotBindings?.[key];
  }
  return Object.keys(record.answers).length ||
    Object.keys(record.inks).length ||
    Object.keys(record.materialInks ?? {}).length ||
    Object.keys(record.materialInkBases ?? {}).length ||
    record.localConflicts?.length
    ? record
    : undefined;
}

export function chooseLocalDraft(
  record: AttemptDraftRecord,
  conflict: LocalDraftConflict,
  expected: LocalDraftConflict,
  takeAlternative: boolean,
): void {
  if (
    digestOf(storedVersionOf(record, conflict)) !== digestOf(expected) ||
    !record.localConflicts?.some(
      (entry) => digestOf(entry) === digestOf(conflict),
    )
  )
    throw new Error("本机稿件已变化，请重新选择");
  if (takeAlternative) {
    switch (conflict.kind) {
      case "answer":
        setEntry(record.answers, conflict.key, conflict.value);
        record.answerMutationIds ??= {};
        record.answerMutationIds[conflict.key] = randomUuid();
        break;
      case "ink": {
        const revision = record.inks[conflict.key]?.serverRevision;
        const doc = conflict.value;
        setEntry(
          record.inks,
          conflict.key,
          doc && revision !== undefined
            ? { ...doc, serverRevision: revision }
            : doc,
        );
        break;
      }
      case "material":
        record.materialInks ??= {};
        record.materialInkBases ??= {};
        record.materialSnapshotBindings ??= {};
        setEntry(record.materialInks, conflict.key, conflict.value?.ink);
        setEntry(record.materialInkBases, conflict.key, conflict.value?.base);
        setEntry(
          record.materialSnapshotBindings,
          conflict.key,
          conflict.value?.snapshot,
        );
        break;
    }
  }
  record.localConflicts = record.localConflicts.filter(
    (entry) => digestOf(entry) !== digestOf(conflict),
  );
}

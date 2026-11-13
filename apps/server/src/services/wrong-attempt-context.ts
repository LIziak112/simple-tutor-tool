import type { Db } from "../db/client.ts";
import type { ResponseRow } from "../db/schema.ts";
import {
  closureRefIds,
  contextEntriesOf,
  readFrozenAttemptContext,
} from "./attempt-context.ts";
import type { AttemptContextSnapshotEntry } from "./attempt-context-repository.ts";
import { getMaterial, getQuestionGroup } from "./material-repository.ts";
import { snapshotOfRow } from "./snapshot.ts";

type WrongAttemptContextPlan = {
  readonly usable: readonly ResponseRow[];
  readonly entries: readonly AttemptContextSnapshotEntry[];
};

/** 逐题重建冻结依赖；同一来源卷中引用到的材料保留全部已冻结版本。 */
export function wrongAttemptContextPlan(
  db: Db,
  teacherId: string | null,
  sources: readonly ResponseRow[],
): WrongAttemptContextPlan {
  const sourceContexts = new Map<
    string,
    ReturnType<typeof readFrozenAttemptContext>
  >();
  const entryByVersion = new Map<string, AttemptContextSnapshotEntry>();
  const usable: ResponseRow[] = [];

  for (const source of sources) {
    let context = sourceContexts.get(source.attemptId);
    if (context === undefined) {
      context = readFrozenAttemptContext(db, source.attemptId);
      sourceContexts.set(source.attemptId, context);
    }
    const question = snapshotOfRow(source);
    if (question === null) continue;

    let entries: AttemptContextSnapshotEntry[];
    if (context.data.freezeState === "frozen" || teacherId === null) {
      if (context.damaged.some((entry) => entry.kind === "group")) continue;
      const groups = context.data.groups.filter((group) =>
        group.questionIds.includes(source.questionId),
      );
      const materialIds = new Set([
        ...groups.flatMap((group) =>
          group.materialRefs.map((ref) => ref.material),
        ),
        ...(question.materialRefs ?? []).map((ref) => ref.material),
      ]);
      if (context.damaged.some((entry) => materialIds.has(entry.sourceId)))
        continue;
      const materials = context.data.materials.filter((material) =>
        materialIds.has(material.id),
      );
      if (
        new Set(materials.map((material) => material.id)).size !==
        materialIds.size
      )
        continue;
      entries = [
        ...groups.map(({ sourceVersion, ...snapshot }) => ({
          kind: "group" as const,
          sourceId: snapshot.id,
          sourceVersion,
          snapshot,
        })),
        ...materials.map(({ sourceVersion, ...snapshot }) => ({
          kind: "material" as const,
          sourceId: snapshot.id,
          sourceVersion,
          snapshot,
        })),
      ];
    } else {
      const refs = closureRefIds(db, teacherId, [source.questionId]);
      for (const ref of question.materialRefs ?? [])
        refs.materialIds.add(ref.material);
      const groups = [...refs.groupIds].map((id) =>
        getQuestionGroup(db, teacherId, id),
      );
      const materials = [...refs.materialIds].map((id) =>
        getMaterial(db, teacherId, id),
      );
      if (
        groups.some((group) => group === null) ||
        materials.some((material) => material === null)
      )
        continue;
      entries = contextEntriesOf({
        groups: groups.filter((group) => group !== null),
        materials: materials.filter((material) => material !== null),
      });
    }
    usable.push(source);
    for (const entry of entries) {
      const key = JSON.stringify([
        entry.kind,
        entry.sourceId,
        entry.sourceVersion,
      ]);
      if (!entryByVersion.has(key)) entryByVersion.set(key, entry);
    }
  }

  return { usable, entries: [...entryByVersion.values()] };
}

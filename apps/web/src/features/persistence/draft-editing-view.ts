import type { LocalDraftConflict } from "./draft-persistence";
import type { AttemptDraftRecord } from "./draft-store";

/** 画布持有本页已打开的文档，普通落盘不替换它的编辑基线。 */
export function editingView(
  local: AttemptDraftRecord,
  stored: AttemptDraftRecord,
  chosen?: LocalDraftConflict,
): AttemptDraftRecord {
  const view = {
    ...stored,
    inks: { ...local.inks },
    inkSnapshotBindings: { ...local.inkSnapshotBindings },
    inkDigests: { ...local.inkDigests },
    materialInks: { ...local.materialInks },
    materialSnapshotBindings: { ...local.materialSnapshotBindings },
    materialInkBases: { ...local.materialInkBases },
  };
  if (chosen?.kind === "ink") {
    const doc = stored.inks[chosen.key];
    if (doc) view.inks[chosen.key] = doc;
    else delete view.inks[chosen.key];
    const binding = stored.inkSnapshotBindings?.[chosen.key];
    if (binding) view.inkSnapshotBindings[chosen.key] = binding;
    else delete view.inkSnapshotBindings[chosen.key];
  }
  if (chosen?.kind === "material") {
    const doc = stored.materialInks?.[chosen.key];
    const base = stored.materialInkBases?.[chosen.key];
    if (doc) view.materialInks[chosen.key] = doc;
    else delete view.materialInks[chosen.key];
    if (base) view.materialInkBases[chosen.key] = base;
    else delete view.materialInkBases[chosen.key];
    const binding = stored.materialSnapshotBindings?.[chosen.key];
    if (binding) view.materialSnapshotBindings[chosen.key] = binding;
    else delete view.materialSnapshotBindings[chosen.key];
  }
  return view;
}

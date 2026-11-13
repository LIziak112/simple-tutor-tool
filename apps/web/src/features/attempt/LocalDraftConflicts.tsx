import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { InkReplay } from "@/features/ink/replay/InkReplay";
import { parseInkReplayData } from "@/features/ink/replay/model";
import { formatStudentAnswer } from "./answer-format";
import { digestOf } from "./draft-merge";
import type { LocalDraftConflict } from "./draft-persistence";
import {
  draftStore,
  getDraftSessionEpoch,
  subscribeDraftPersistence,
} from "./draft-store";

function VersionPreview({ version }: { version: LocalDraftConflict }) {
  if (version.kind === "answer")
    return <p>{formatStudentAnswer(version.value ?? null) || "未填写"}</p>;
  const ink = version.kind === "ink" ? version.value : version.value?.ink;
  const model = ink ? parseInkReplayData(ink) : null;
  return model ? <InkReplay data={model} /> : <p>无笔迹</p>;
}

export function LocalDraftConflicts({
  attemptId,
  questionIds,
  beforeResolve,
  afterResolve,
}: {
  attemptId: string;
  questionIds: readonly string[];
  beforeResolve?: () => Promise<boolean>;
  afterResolve?: () => Promise<void>;
}) {
  const conflicts = useSyncExternalStore(subscribeDraftPersistence, () =>
    draftStore.localConflicts(attemptId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!conflicts.length) return null;
  const resolve = async (
    alternative: LocalDraftConflict,
    current: LocalDraftConflict,
    useAlternative: boolean,
  ) => {
    const epoch = getDraftSessionEpoch();
    setBusy(true);
    setError(null);
    try {
      if (
        (beforeResolve && !(await beforeResolve())) ||
        epoch !== getDraftSessionEpoch()
      )
        throw new Error("请先完成当前编辑并保存本机稿");
      await draftStore.resolveLocalConflict(
        attemptId,
        alternative,
        current,
        useAlternative,
      );
      await afterResolve?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "本机稿件裁决失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="本机稿件冲突" className="rounded-lg border p-4">
      <p>同一练习在多个标签页有修改。请选择要保留的版本。</p>
      {conflicts.map((alternative) => {
        const current = draftStore.storedVersion(attemptId, alternative);
        const questionNo = questionIds.indexOf(alternative.key) + 1;
        const title =
          alternative.kind === "material"
            ? "材料圈画"
            : `第 ${questionNo || "–"} 题 · ${alternative.kind === "ink" ? "手写作答" : "答案"}`;
        return (
          <details key={digestOf(alternative)} className="mt-3">
            <summary>{title} · 查看两个版本</summary>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p>已保存版本</p>
                <VersionPreview version={current} />
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void resolve(alternative, current, false)}
                >
                  保留已保存版本
                </Button>
              </div>
              <div>
                <p>另一标签页版本</p>
                <VersionPreview version={alternative} />
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void resolve(alternative, current, true)}
                >
                  采用另一标签页版本
                </Button>
              </div>
            </div>
          </details>
        );
      })}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

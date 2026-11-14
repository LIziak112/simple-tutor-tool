import { useQueryClient } from "@tanstack/react-query";
import type { AttemptSummary } from "@tutor/contract";
import { useEffect, useState } from "react";
import { usePortalClients } from "@/features/runtime/portal-runtime";
import {
  draftSnapshotConflict,
  hasLocalMaterialWork,
} from "./attempt-local-session";
import {
  readLocalAttemptSessions,
  saveLocalAttemptSession,
} from "./attempt-session-catalog";
import {
  draftStore,
  getDraftSessionEpoch,
  subscribeDraftPersistence,
} from "./draft-store";
import { DownloadLocalAttempt } from "./LocalAttemptArchive";

/** 本机内容就是持久待激活凭据，重载及重连都会重试；绝不由浏览事件激活。 */
export function useLocalAttemptActivation(
  attempt: AttemptSummary | undefined,
): void {
  const { activateAttemptApi } = usePortalClients();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (attempt?.phase !== "opened") return;
    const epoch = getDraftSessionEpoch();
    let stopped = false;
    let busy = false;
    let complete = false;
    const current = () => !stopped && epoch === getDraftSessionEpoch();
    const retry = async () => {
      if (!current() || busy || complete || !navigator.onLine) return;
      busy = true;
      try {
        const record = await draftStore.loadDraft(attempt.id, {
          strictRead: true,
        });
        if (
          !current() ||
          !hasLocalMaterialWork(record) ||
          draftSnapshotConflict(record, attempt)
        )
          return;
        await draftStore.flush(attempt.id);
        if (!current()) return;
        const activated = await activateAttemptApi(attempt.id, {
          expectedFrozenAt: attempt.frozenAt ?? null,
        });
        if (!current()) return;
        complete = true;
        const local = (await readLocalAttemptSessions())[attempt.id];
        if (current() && local)
          await saveLocalAttemptSession({
            ...local,
            attempt: {
              ...local.attempt,
              activatedAt: activated.activatedAt,
              phase: activated.phase,
            },
          });
        if (current())
          void queryClient.invalidateQueries({ queryKey: ["student"] });
      } catch {
        /* 本机正文保留，联网、聚焦和定时继续重试。 */
      } finally {
        busy = false;
      }
    };
    const refresh = () => {
      void retry();
    };
    refresh();
    const unsubscribe = subscribeDraftPersistence(refresh);
    const timer = setInterval(refresh, 10_000);
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      stopped = true;
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [attempt, activateAttemptApi, queryClient]);
}

export function LocalAttemptRecoveryNotice({
  attemptId,
}: {
  attemptId: string;
}) {
  const [notice, setNotice] = useState<string>();
  const [preservedId, setPreservedId] = useState<string>();
  useEffect(() => {
    let stopped = false;
    void readLocalAttemptSessions()
      .then((entries) => {
        if (!stopped) {
          setNotice(entries[attemptId]?.notice);
          setPreservedId(entries[attemptId]?.preservedAttemptId);
        }
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [attemptId]);
  return notice ? (
    <div
      role="status"
      className="rounded-xl border border-border bg-muted p-4 text-sm"
    >
      <p>{notice}</p>
      {preservedId && <DownloadLocalAttempt attemptId={preservedId} />}
    </div>
  ) : null;
}

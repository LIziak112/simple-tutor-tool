import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { readLocalAttemptAttachments } from "./attempt-local-attachments";
import {
  assertDraftEpoch,
  LocalAttemptSnapshotConflictError,
} from "./attempt-local-session";
import { readLocalAttemptSessions } from "./attempt-session-catalog";
import { draftStore, getDraftSessionEpoch } from "./draft-store";

/** 下载只读原仓，不清除、不重排笔迹、不把原稿挂到新版题。 */
export async function localAttemptArchive(
  attemptId: string,
  epoch: number,
): Promise<Blob> {
  assertDraftEpoch(epoch);
  const manifest = (await readLocalAttemptSessions())[attemptId];
  assertDraftEpoch(epoch);
  if (!manifest)
    throw new Error("当前账号无法读取这份本机原稿，请重新打开练习");
  const draft = await draftStore.loadDraft(attemptId, { strictRead: true });
  const attachments = await readLocalAttemptAttachments(attemptId);
  assertDraftEpoch(epoch);
  const annotations = [];
  for (const [questionId, record] of attachments.annotations) {
    const bytes = record.localBase
      ? new Uint8Array(await record.localBase.png.arrayBuffer())
      : null;
    assertDraftEpoch(epoch);
    let binary = "";
    if (bytes)
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    annotations.push({
      questionId,
      doc: record.doc,
      pending: record.pending,
      layout: record.localBase?.layout,
      png: bytes ? `data:image/png;base64,${btoa(binary)}` : null,
    });
  }
  return new Blob(
    [
      JSON.stringify({
        format: "ownclass-local-attempt-v1",
        exportedAt: new Date().toISOString(),
        manifest,
        draft,
        notes: [...attachments.notes].map(([questionId, record]) => ({
          questionId,
          doc: record.doc,
          pending: record.pending,
        })),
        annotations,
      }),
    ],
    { type: "application/json" },
  );
}
export function DownloadLocalAttempt({ attemptId }: { attemptId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [epoch] = useState(getDraftSessionEpoch);
  const currentEpoch = getDraftSessionEpoch();
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const ownedUrls = urls.current;
    const revoke = () => {
      for (const url of ownedUrls) URL.revokeObjectURL(url);
      ownedUrls.clear();
    };
    if (currentEpoch !== epoch) revoke();
    return revoke;
  }, [currentEpoch, epoch]);
  const download = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const blob = await localAttemptArchive(attemptId, epoch);
      assertDraftEpoch(epoch);
      const url = URL.createObjectURL(blob);
      urls.current.add(url);
      const link = document.createElement("a");
      link.href = url;
      link.download = `练习本机原稿-${attemptId}.json`;
      link.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
      }, 60_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "原稿下载失败，请重试");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="outline"
        className="min-h-11"
        disabled={busy || epoch !== currentEpoch}
        onClick={() => void download()}
      >
        {busy ? "正在准备原稿…" : "下载本机原稿"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
export function LocalAttemptSnapshotConflictPanel({
  error,
}: {
  error: LocalAttemptSnapshotConflictError;
}) {
  return (
    <section
      role="alert"
      className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5"
    >
      <h2 className="font-medium">练习内容已更新</h2>
      <p className="text-sm text-muted-foreground">{error.message}</p>
      <DownloadLocalAttempt attemptId={error.attemptId} />
    </section>
  );
}
export function LocalAttemptStartFailure({ error }: { error: unknown }) {
  return error instanceof LocalAttemptSnapshotConflictError ? (
    <LocalAttemptSnapshotConflictPanel error={error} />
  ) : (
    <p role="alert" className="text-xs text-destructive">
      {error instanceof Error ? error.message : "开始失败，请稍后重试"}
    </p>
  );
}

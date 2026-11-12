import { RotateCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AttemptSyncConflicts } from "@/features/attempt/AttemptSyncConflicts";
import { retryAttemptLocalPersistence } from "@/features/attempt/use-attempt-save-status";
import type { useLessonAttempt } from "./use-lesson-attempt";

export function LessonDraftNotices({
  attemptId,
  questionIds,
  session,
  beforeResolve,
}: {
  attemptId: string;
  questionIds: readonly string[];
  session: ReturnType<typeof useLessonAttempt>;
  beforeResolve: () => Promise<boolean>;
}) {
  const { saveStatus, draftSyncContext: sync } = session;
  const [retryingSave, setRetryingSave] = useState(false);
  return (
    <>
      <AttemptSyncConflicts
        attemptId={attemptId}
        questionIds={questionIds}
        sync={sync}
        beforeResolve={beforeResolve}
      />
      {saveStatus.startsWith("本机保存失败") && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          本机草稿保存失败
          <Button
            variant="outline"
            className="min-h-11"
            disabled={retryingSave}
            onClick={async () => {
              setRetryingSave(true);
              try {
                await retryAttemptLocalPersistence(attemptId, questionIds);
                await sync.syncNow();
              } catch {
                // 重试失败保持提示（下一次点击再试）
              } finally {
                setRetryingSave(false);
              }
            }}
          >
            <RotateCw aria-hidden className="size-4" />
            重试保存
          </Button>
        </p>
      )}
    </>
  );
}

import { RotateCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAttemptEditor } from "@/features/attempt/AttemptEditorContext";
import { LocalDraftConflicts } from "@/features/attempt/LocalDraftConflicts";
import { retryAttemptLocalPersistence } from "@/features/attempt/use-attempt-save-status";
import type { useLessonAttempt } from "./use-lesson-attempt";

export function LessonSaveNotices({
  questionIds,
  session,
}: {
  questionIds: readonly string[];
  session: ReturnType<typeof useLessonAttempt>;
}) {
  const editor = useAttemptEditor(null);
  const [retrying, setRetrying] = useState(false);
  const { attemptId, draftSyncContext } = session;
  return (
    <>
      <LocalDraftConflicts
        attemptId={attemptId}
        questionIds={questionIds}
        beforeResolve={async () => !editor || (await editor.request(null))}
        afterResolve={draftSyncContext.syncNow}
      />
      {session.saveStatus.startsWith("本机保存失败") && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          本机草稿保存失败
          <Button
            variant="outline"
            className="min-h-11"
            disabled={retrying}
            onClick={async () => {
              setRetrying(true);
              try {
                await retryAttemptLocalPersistence(attemptId, questionIds);
                await draftSyncContext.syncNow();
              } catch {
                // 重试失败时保留保存提示。
              } finally {
                setRetrying(false);
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

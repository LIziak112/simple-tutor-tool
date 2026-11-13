import { ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  attemptReviewEntryViewOf,
  useAttemptReviewEntry,
} from "./attempt-review-entry";

export function AttemptReviewTopBarEntry({
  attemptId,
  released,
  onOpen,
}: {
  readonly attemptId: string;
  readonly released: boolean;
  readonly onOpen: (target: string) => void;
}) {
  const state = useAttemptReviewEntry(attemptId, released);
  const view = attemptReviewEntryViewOf(state);
  if (view === null) return null;
  return (
    <Button
      type="button"
      variant="outline"
      className="h-auto min-h-11 max-w-full shrink gap-1.5 whitespace-normal px-2.5 py-1 text-start"
      data-attempt-review-entry={state.kind}
      onClick={() => onOpen(view.target)}
    >
      <ClipboardList
        aria-hidden
        className="hidden size-4 @min-[40rem]/result-header:block"
      />
      <span className="[overflow-wrap:anywhere]">整卷复盘</span>
    </Button>
  );
}

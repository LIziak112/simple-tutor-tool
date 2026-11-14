import type { AttemptDraftData } from "@tutor/contract";
import { formatDueTime } from "@/lib/time";
import { attemptSourceLabel } from "./answer-format";
export function AttemptSourceSummary({
  data,
  total,
}: {
  data: AttemptDraftData;
  total: number;
}) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>{attemptSourceLabel(data)}</span>
      {data.attempt.sourceType === "assignment" && (
        <span>
          {data.dueAt === null
            ? "不限截止"
            : `${formatDueTime(data.dueAt)} 截止`}
        </span>
      )}
      <span>共 {total} 题</span>
    </p>
  );
}

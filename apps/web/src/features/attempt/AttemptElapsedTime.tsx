import type { AttemptTime } from "@tutor/contract";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { usePortalClients } from "@/features/runtime/portal-runtime";

import { formatActivitySec } from "./QuestionActivity";

const KEY = "attempt:show-activity-time";
/** 有界轮询服务端已收到的活动前缀；不把本机墙钟差当最终账。 */
export function AttemptElapsedTime({
  attemptId,
  time,
  timed,
  initialEstimate,
}: {
  attemptId: string;
  time: AttemptTime | undefined;
  timed: boolean;
  initialEstimate?: { activeSecTotal: number } | undefined;
}) {
  const { fetchAttemptApi } = usePortalClients();

  const [shown, setShown] = useState(() => localStorage.getItem(KEY) !== "off");
  const [estimate, setEstimate] = useState<number | null>(
    initialEstimate?.activeSecTotal ?? null,
  );
  const [synced, setSynced] = useState(false);
  useEffect(() => {
    setEstimate(initialEstimate?.activeSecTotal ?? null);
    setSynced(false);
    if (!shown || timed) return;
    let cancelled = false;
    let running = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (running || document.hidden) return;
      running = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 5000);
      try {
        const data = await fetchAttemptApi(attemptId, controller.signal);
        if (!cancelled && "timeEstimate" in data) {
          setEstimate(data.timeEstimate?.activeSecTotal ?? null);
          setSynced(true);
        }
      } catch {
        if (!cancelled) setSynced(false);
      } finally {
        clearTimeout(timeout);
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      controller?.abort();
    };
  }, [
    shown,
    timed,
    attemptId,
    initialEstimate?.activeSecTotal,
    fetchAttemptApi,
  ]);
  if (timed) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {shown && (
        <span>
          本次活动估计（待提交）：
          {estimate === null ? "等待活动记录" : formatActivitySec(estimate)}
          {!synced ? " · 等待同步" : ""}
          {time?.metric === "question_activity_sealed"
            ? ` · 已封存 ${formatActivitySec(time.knownActiveSec)}（${time.knownCount}/${time.memberCount} 题）`
            : ""}
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          const value = !shown;
          setShown(value);
          localStorage.setItem(KEY, value ? "on" : "off");
        }}
      >
        {shown ? "隐藏用时" : "显示用时"}
      </Button>
    </div>
  );
}

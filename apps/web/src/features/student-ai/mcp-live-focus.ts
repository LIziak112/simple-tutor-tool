import { useQuery } from "@tanstack/react-query";
import {
  MCP_LIVE_FOCUS_HEARTBEAT_MS,
  type StudentMcpLiveFocusRequest,
} from "@tutor/contract";
import { useEffect, useRef } from "react";
import {
  learningContextStore,
  useLearningContextSnapshot,
} from "@/features/learning-context/learning-context-store";
import { usePortalClients } from "@/features/runtime/portal-runtime";
import { randomUuid } from "@/lib/uuid";

/** 只负责传输与墓碑；当前题每次从唯一来源仓派生。 */
export function createMcpLiveFocusReporter(
  send: (input: StudentMcpLiveFocusRequest) => void,
  generationOf: () => string,
  viewId = randomUuid(),
  readQuestion: () => string | null = () => {
    const anchor = learningContextStore.getSnapshot().source.anchor;
    return anchor.kind === "question" ? anchor.questionId : null;
  },
) {
  let sequence = 0;
  let active = true;
  let published = false;
  const report = (questionId: string | null) => {
    if (questionId === null && !published) return;
    published = questionId !== null;
    send({
      viewId,
      generation: generationOf(),
      sequence: ++sequence,
      questionId,
    });
  };
  const refresh = () =>
    report(
      active && document.visibilityState === "visible" && navigator.onLine
        ? readQuestion()
        : null,
    );
  const hidden = () => {
    active = false;
    refresh();
  };
  const shown = () => {
    active = true;
    refresh();
  };
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("pagehide", hidden);
  window.addEventListener("pageshow", shown);
  window.addEventListener("online", refresh);
  window.addEventListener("offline", refresh);
  const timer = setInterval(refresh, MCP_LIVE_FOCUS_HEARTBEAT_MS);
  return {
    refresh,
    publish(questionId: string | null) {
      report(
        active && document.visibilityState === "visible" && navigator.onLine
          ? questionId
          : null,
      );
    },
    dispose() {
      report(null);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pagehide", hidden);
      window.removeEventListener("pageshow", shown);
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", refresh);
    },
  };
}
export function useMcpLiveFocus(): void {
  const { fetchMcpLiveFocusCapability, putMcpLiveFocus } = usePortalClients();
  const snapshot = useLearningContextSnapshot();
  const host = snapshot.host;
  const anchor = snapshot.source.anchor;
  const attemptId = anchor.kind === "question" ? anchor.attemptId : null;
  const { data } = useQuery({
    queryKey: ["student", "mcp-live-focus", snapshot.principal],
    enabled: host?.attemptStatus === "draft",
    refetchInterval: (query) =>
      query.state.data?.generation ? MCP_LIVE_FOCUS_HEARTBEAT_MS : false,
    queryFn: fetchMcpLiveFocusCapability,
  });
  const generation = host?.attemptStatus === "draft" ? data?.generation : null;
  const reporter = useRef<ReturnType<typeof createMcpLiveFocusReporter> | null>(
    null,
  );
  useEffect(() => {
    if (!host || !attemptId || !generation) return;
    const current = createMcpLiveFocusReporter(
      (input) => {
        void putMcpLiveFocus(attemptId, input).catch(() => {});
      },
      () => generation,
      host.viewId,
      () => {
        const latest = learningContextStore.getSnapshot();
        const a = latest.source.anchor;
        return latest.host === host && latest.visible && a.kind === "question"
          ? a.questionId
          : null;
      },
    );
    reporter.current = current;
    current.refresh();
    return () => {
      if (reporter.current === current) reporter.current = null;
      current.dispose();
    };
  }, [host, attemptId, generation, putMcpLiveFocus]);
  const currentId = anchor.kind === "question" ? anchor.questionId : null;
  useEffect(
    () => reporter.current?.publish(snapshot.visible ? currentId : null),
    [currentId, snapshot.visible],
  );
}

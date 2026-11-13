import { useQuery } from "@tanstack/react-query";
import {
  MCP_LIVE_FOCUS_HEARTBEAT_MS,
  type StudentMcpLiveFocusRequest,
  studentMcpLiveFocusCapabilitySchema,
} from "@tutor/contract";
import { useEffect, useRef } from "react";
import { randomUuid } from "@/lib/uuid";

export function createMcpLiveFocusReporter(
  send: (input: StudentMcpLiveFocusRequest) => void,
  generationOf: () => string,
  viewId = randomUuid(),
) {
  let sequence = 0;
  let questionId: string | null = null;
  let active = true;
  let published = false;
  const report = (next: string | null) => {
    if (next === null && !published) return;
    published = next !== null;
    send({
      viewId,
      generation: generationOf(),
      sequence: ++sequence,
      questionId: next,
    });
  };
  const refresh = () => {
    report(
      active && document.visibilityState === "visible" ? questionId : null,
    );
  };
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
  const timer = setInterval(refresh, MCP_LIVE_FOCUS_HEARTBEAT_MS);
  return {
    setQuestion(next: string | null) {
      if (next === questionId) return;
      questionId = next;
      refresh();
    },
    dispose() {
      report(null);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pagehide", hidden);
      window.removeEventListener("pageshow", shown);
      window.removeEventListener("online", refresh);
    },
  };
}

export function useMcpLiveFocus(
  attemptId: string,
  questionId: string | null,
  draft: boolean,
): void {
  const { data } = useQuery({
    queryKey: ["student", "mcp-live-focus"],
    enabled: draft,
    refetchInterval: (query) =>
      query.state.data?.generation ? MCP_LIVE_FOCUS_HEARTBEAT_MS : false,
    queryFn: async () => {
      const response = await fetch("/api/student/ai/mcp-live-focus");
      if (!response.ok) throw new Error("实时定位状态不可用");
      const value: unknown = await response.json();
      return typeof value === "object" && value !== null && "data" in value
        ? studentMcpLiveFocusCapabilitySchema.parse(value.data)
        : { generation: null };
    },
  });
  const generation = draft ? data?.generation : null;
  const generationRef = useRef(generation);
  if (generation) generationRef.current = generation;
  const enabled = Boolean(generation);
  const reporter = useRef<ReturnType<typeof createMcpLiveFocusReporter> | null>(
    null,
  );
  const question = useRef(questionId);
  question.current = questionId;
  useEffect(() => {
    if (!enabled) return;
    const current = createMcpLiveFocusReporter(
      (input) => {
        void fetch(
          `/api/student/attempts/${encodeURIComponent(attemptId)}/mcp-live-focus`,
          {
            method: "PUT",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
            keepalive: true,
          },
        ).catch(() => {});
      },
      () => generationRef.current ?? "",
    );
    reporter.current = current;
    current.setQuestion(question.current);
    return () => {
      reporter.current = null;
      current.dispose();
    };
  }, [attemptId, enabled]);
  useEffect(() => reporter.current?.setQuestion(questionId), [questionId]);
}

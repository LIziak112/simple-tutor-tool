import { MCP_LIVE_FOCUS_HEARTBEAT_MS } from "@tutor/contract";
import { expect, it, vi } from "vitest";
import { createMcpLiveFocusReporter } from "./mcp-live-focus";

it("前台同题心跳续期，后台撤回，回前台重新上报", () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = "visible";
  const property = vi
    .spyOn(document, "visibilityState", "get")
    .mockImplementation(() => visibility);
  const send = vi.fn();
  const reporter = createMcpLiveFocusReporter(
    send,
    () => "a".repeat(64),
    "11111111-1111-4111-8111-111111111111",
  );
  try {
    reporter.setQuestion("q1");
    vi.advanceTimersByTime(MCP_LIVE_FOCUS_HEARTBEAT_MS * 4);
    expect(send.mock.calls.map(([data]) => data.questionId)).toEqual([
      "q1",
      "q1",
      "q1",
      "q1",
      "q1",
    ]);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(send.mock.lastCall?.[0]).toMatchObject({
      sequence: 6,
      questionId: null,
    });
    vi.advanceTimersByTime(MCP_LIVE_FOCUS_HEARTBEAT_MS * 4);
    expect(send).toHaveBeenCalledTimes(6);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(send.mock.lastCall?.[0]).toMatchObject({
      sequence: 7,
      questionId: "q1",
    });
    reporter.setQuestion("q2");
    expect(send.mock.lastCall?.[0]).toMatchObject({
      sequence: 8,
      questionId: "q2",
    });
    window.dispatchEvent(new Event("pagehide"));
    expect(send.mock.lastCall?.[0]).toMatchObject({
      sequence: 9,
      questionId: null,
    });
    window.dispatchEvent(new Event("pageshow"));
    expect(send.mock.lastCall?.[0]).toMatchObject({
      sequence: 10,
      questionId: "q2",
    });
  } finally {
    reporter.dispose();
    property.mockRestore();
    vi.useRealTimers();
  }
  expect(send.mock.lastCall?.[0]).toMatchObject({
    sequence: 11,
    questionId: null,
  });
});

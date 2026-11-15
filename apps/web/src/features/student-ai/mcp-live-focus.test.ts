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
  let question: string | null = null;
  const reporter = createMcpLiveFocusReporter(
    send,
    () => "a".repeat(64),
    "11111111-1111-4111-8111-111111111111",
    () => question,
  );
  try {
    question = "q1";
    reporter.refresh();
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
    question = "q2";
    reporter.refresh();
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

it("心跳每次派生当前源，离线撤回且恢复不需要维护第二份当前题", () => {
  vi.useFakeTimers();
  let online = true;
  const connectivity = vi
    .spyOn(navigator, "onLine", "get")
    .mockImplementation(() => online);
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  const send = vi.fn();
  let question = "q1";
  const reporter = createMcpLiveFocusReporter(
    send,
    () => "b".repeat(64),
    crypto.randomUUID(),
    () => question,
  );
  try {
    reporter.refresh();
    question = "q2";
    vi.advanceTimersByTime(MCP_LIVE_FOCUS_HEARTBEAT_MS);
    expect(send.mock.lastCall?.[0].questionId).toBe("q2");
    online = false;
    window.dispatchEvent(new Event("offline"));
    expect(send.mock.lastCall?.[0].questionId).toBeNull();
    vi.advanceTimersByTime(MCP_LIVE_FOCUS_HEARTBEAT_MS);
    expect(send).toHaveBeenCalledTimes(3);
    online = true;
    window.dispatchEvent(new Event("online"));
    expect(send.mock.lastCall?.[0]).toMatchObject({
      generation: "b".repeat(64),
      questionId: "q2",
      sequence: 4,
    });
  } finally {
    reporter.dispose();
    connectivity.mockRestore();
    visibility.mockRestore();
    vi.useRealTimers();
  }
});

import { MCP_LIVE_FOCUS_TTL_MS } from "@tutor/contract";
import { expect, it, vi } from "vitest";
import { createDbFromBuffer } from "../../db/client.ts";
import { aiConnections } from "../../db/schema.ts";
import { createTestDb } from "../../db/test-utils.ts";
import { makeStudent } from "../../test/note-fixtures.ts";
import { mcpLiveContextGeneration } from "./connection-service.ts";
import {
  currentStudentMcpFocus,
  recordStudentMcpFocus,
} from "./mcp-live-focus-registry.ts";

it("恢复相同配置时换运行代次，焦点与水位不进入备份", () => {
  const db = createTestDb();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T00:00:00Z"));
  try {
    const studentId = makeStudent(db);
    db.insert(aiConnections)
      .values({
        id: "connection",
        studentId,
        channel: "mcp",
        configJson: JSON.stringify({
          liveContextEnabled: true,
          liveContextGeneration: "stored",
        }),
        createdAt: "2026-10-12",
        updatedAt: "2026-10-12",
      })
      .run();
    const generation = mcpLiveContextGeneration(db, studentId);
    if (generation === null) throw new Error("测试连接未开启");
    const report = {
      generation,
      viewId: "11111111-1111-4111-8111-111111111111",
      sequence: 1,
      questionId: "q1",
    };
    recordStudentMcpFocus(db, studentId, "attempt", report);
    vi.advanceTimersByTime(MCP_LIVE_FOCUS_TTL_MS - 1);
    expect(currentStudentMcpFocus(db, studentId)?.questionId).toBe("q1");
    vi.advanceTimersByTime(1);
    expect(currentStudentMcpFocus(db, studentId)).toBeNull();
    expect(mcpLiveContextGeneration(db, studentId, undefined, -1)).toBe(
      generation,
    );
    vi.advanceTimersByTime(MCP_LIVE_FOCUS_TTL_MS);
    expect(mcpLiveContextGeneration(db, studentId, undefined, -1)).not.toBe(
      generation,
    );

    const restored = createDbFromBuffer(db.$client.serialize());
    try {
      expect(mcpLiveContextGeneration(restored, studentId)).not.toBe(
        mcpLiveContextGeneration(db, studentId),
      );
      expect(
        mcpLiveContextGeneration(restored, studentId, undefined, -1),
      ).not.toBe(mcpLiveContextGeneration(db, studentId, undefined, -1));
      expect(currentStudentMcpFocus(restored, studentId)).toBeNull();
    } finally {
      restored.$client.close();
    }
  } finally {
    db.$client.close();
    vi.useRealTimers();
  }
});

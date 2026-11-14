import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { aiConnections, attempts } from "../db/schema.ts";
import {
  closeTimingFixtures,
  timingFixture,
} from "../test/submission-time-fixture.ts";
import { recordStudentMcpFocus } from "./ai-companion/mcp-live-focus-registry.ts";
import { getStudentMcpCurrentV2 } from "./student-mcp-current.ts";
import { listStudentMcpPractices } from "./student-mcp-practice-list.ts";

afterEach(closeTimingFixtures);
it.each(["disabled", "empty", "expired"])(
  "ACT02 %s live焦点时仍可只读定位opened，记录列表保持隐藏",
  (mode) => {
    const env = timingFixture(),
      now = new Date(),
      id = randomUUID(),
      generation = randomUUID();
    if (mode !== "disabled")
      env.db
        .insert(aiConnections)
        .values({
          id,
          studentId: env.studentId,
          channel: "mcp",
          isDefault: true,
          configJson: JSON.stringify({
            tokenHash: "fixture",
            tokenFingerprint: "fixture",
            liveContextEnabled: true,
            liveContextGeneration: generation,
          }),
          verifyStatus: "unverified",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
        .run();
    if (mode === "expired")
      recordStudentMcpFocus(
        env.db,
        env.studentId,
        env.attemptId,
        { generation, questionId: "q1", viewId: randomUUID(), sequence: 1 },
        now.getTime() - 60_001,
      );
    expect(
      getStudentMcpCurrentV2(
        env.db,
        env.studentId,
        mode === "disabled" ? undefined : id,
        now,
      ).location,
    ).toMatchObject({
      status: "recent_practice",
      practice: { practiceId: env.attemptId, phase: "opened" },
    });
    expect(listStudentMcpPractices(env.db, env.studentId, {}).total).toBe(0);
    expect(
      env.db.select().from(attempts).where(eq(attempts.id, env.attemptId)).get()
        ?.activatedAt,
    ).toBeNull();
  },
);

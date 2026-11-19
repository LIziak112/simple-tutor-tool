import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { attemptStartOkSchema } from "@tutor/contract";
import pino from "pino";
import { expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { requireAssignmentVisible } from "../services/attempt-access.ts";
import { attemptSummaryOf } from "../services/attempt-summary.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { createTrialApp } from "../test/m04-p1/assembly.ts";
import {
  attemptFacts,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import { draftForAssignment } from "../test/m04-p1/publication.ts";

it("同一开卷 URL 使用显式试验装配，候选替身成功也不创建旧卷", async () => {
  const db = createTestDb();
  const dataDir = createTestDir();
  const options = {
    db,
    dataDir,
    isProduction: false,
    logger: pino({ enabled: false }),
    publicUrl: "http://localhost:8787",
  };
  const stubId = randomUUID();
  const startedAt = "2026-11-19T00:00:00.000Z";
  const invokedFor: string[] = [];
  const trial = createTrialApp(options, (db, studentId, assignmentId) => {
    const assignment = requireAssignmentVisible(db, studentId, assignmentId);
    invokedFor.push(studentId);
    return attemptSummaryOf(
      draftForAssignment(assignment, studentId, stubId, startedAt),
    );
  });
  try {
    const { assignmentId, ownerCookie, otherCookie, studentId, teacher } =
      await setupAssignment(trial);
    for (const [cookie, status, error] of [
      [undefined, 401, "UNAUTHORIZED"],
      [teacher, 401, "UNAUTHORIZED"],
      [otherCookie, 403, "FORBIDDEN"],
    ] as const) {
      const response = await postAssignment(trial, assignmentId, cookie);
      expect(response.status).toBe(status);
      const body: unknown = await response.json();
      expect(body).toMatchObject({ ok: false, error });
      expect(body).not.toHaveProperty("data");
      assertNoLeak(body);
    }
    expect(invokedFor).toEqual([]);

    const response = await postAssignment(trial, assignmentId, ownerCookie);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(attemptStartOkSchema.parse(body).data.id).toBe(stubId);
    assertNoLeak(body);
    expect(invokedFor).toEqual([studentId]);
    expect(attemptFacts(db)).toEqual({
      attempts: 0,
      responses: 0,
      scores: 0,
      evidence: 0,
      settlements: 0,
    });

    const legacy = await postAssignment(
      createApp(options),
      assignmentId,
      ownerCookie,
    );
    expect(legacy.status).toBe(200);
    const legacyId = attemptStartOkSchema.parse(await legacy.json()).data.id;
    expect(legacyId).not.toBe(stubId);
    const restored = await postAssignment(
      createApp(options),
      assignmentId,
      ownerCookie,
    );
    expect(attemptStartOkSchema.parse(await restored.json()).data.id).toBe(
      legacyId,
    );
    expect(attemptFacts(db)).toEqual({
      attempts: 1,
      responses: 2,
      scores: 0,
      evidence: 0,
      settlements: 0,
    });
  } finally {
    db.$client.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

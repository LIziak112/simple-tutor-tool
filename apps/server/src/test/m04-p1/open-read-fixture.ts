import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { LearningError, openLearningRuntime } from "learning-kernel";
import pino from "pino";
import { createTestDb, createTestDir } from "../../db/test-utils.ts";
import { HttpError } from "../../lib/http-error.ts";
import { requireAssignmentVisible } from "../../services/attempt-access.ts";
import { attemptSummaryOf } from "../../services/attempt-summary.ts";
import { createTrialApp } from "./assembly.ts";
import { draftForAssignment, publicationForAssignment } from "./publication.ts";

export function createChoiceOpenReadFixture() {
  const db = createTestDb();
  const dataDir = createTestDir();
  const databasePath = join(dataDir, "learning.sqlite");
  const runtime = openLearningRuntime({ databasePath });
  const app = createTrialApp(
    {
      db,
      dataDir,
      isProduction: false,
      logger: pino({ enabled: false }),
      publicUrl: "http://localhost:8787",
    },
    (db, studentId, assignmentId) => {
      const assignment = requireAssignmentVisible(db, studentId, assignmentId);
      const { input, revisions } = publicationForAssignment(
        db,
        assignment,
        studentId,
      );
      const versions = new Map(
        revisions.map(({ id, version }) => [id, version]),
      );
      const questions = input.practice.questions.map((question) => {
        const version = versions.get(question.id);
        assert.ok(version !== undefined, "冻结题缺少版本");
        return { ...question, version };
      });
      runtime.publish({ ...input, practice: { ...input.practice, questions } });
      const { activityId, startedAt } = runtime.start(
        { role: "student", id: studentId },
        {
          protocolVersion: 1,
          operationId: `open:${assignmentId}`,
          practiceId: input.practice.id,
          practiceVersion: input.practice.version,
        },
      );
      return attemptSummaryOf(
        draftForAssignment(assignment, studentId, activityId, startedAt),
      );
    },
    (studentId, activityId) => {
      try {
        return runtime.read({ role: "student", id: studentId }, activityId);
      } catch (error) {
        if (error instanceof LearningError && error.code === "FORBIDDEN") {
          throw new HttpError(403, "FORBIDDEN", "无权读取此作答");
        }
        throw error;
      }
    },
  );
  return {
    app,
    db,
    runtime,
    dataDir,
    databasePath,
    close() {
      runtime.close();
      db.$client.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

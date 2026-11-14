import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { attempts, responses } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import {
  insertAttempt,
  insertResponse,
} from "../test/ai-companion-fixtures.ts";
import { gzipJson, makeStudent, noteDoc } from "../test/note-fixtures.ts";
import { getStudentNoteHead, saveNoteVersion } from "./note-service.ts";

function fixture() {
  const db = createTestDb();
  const dataDir = createTestDir();
  const studentId = makeStudent(db);
  const practiceId = insertAttempt(db, { studentId });
  db.update(attempts)
    .set({
      sourceType: "wrong",
      assignmentId: null,
      practiceWorkflowVersion: 1,
      feedbackMode: "per_question",
    })
    .where(eq(attempts.id, practiceId))
    .run();
  const responseId = insertResponse(db, practiceId, "q-1");
  const attempt = db
    .select()
    .from(attempts)
    .where(eq(attempts.id, practiceId))
    .get();
  const row = db
    .select()
    .from(responses)
    .where(eq(responses.id, responseId))
    .get();
  if (!attempt || !row) throw new Error("缺少真实冻结夹具");
  return { db, dataDir, studentId, practiceId, attempt, row };
}

describe("MCP只读提交参数使用真实笔记头", () => {
  it("真实无稿才none，答案版本缺失不猜零、不默认missing", async () => {
    const { studentMcpSubmissionParameters } = await import(
      "./student-mcp-submission-parameters.ts"
    );
    const { db, studentId, attempt, row } = fixture();
    expect(
      getStudentNoteHead(db, studentId, attempt.id, row.questionId).note,
    ).toBeNull();
    expect(
      studentMcpSubmissionParameters(db, studentId, attempt, row, 0),
    ).toMatchObject({
      available: true,
      parameters: {
        expectedAnswerRevision: 0,
        evidence: { questionId: row.questionId, state: "none" },
      },
    });
    expect(
      studentMcpSubmissionParameters(db, studentId, attempt, row, undefined),
    ).toEqual({ available: false, reason: "SUBMISSION_VERSION_UNAVAILABLE" });
  });

  it("实际saveNoteVersion→getStudentNoteHead的revision与版本指针原样作为frozen证据", async () => {
    const { studentMcpSubmissionParameters } = await import(
      "./student-mcp-submission-parameters.ts"
    );
    const { db, dataDir, studentId, attempt, row } = fixture();
    const receipt = saveNoteVersion(
      db,
      dataDir,
      studentId,
      attempt.id,
      row.questionId,
      gzipJson(noteDoc()),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    const head = getStudentNoteHead(db, studentId, attempt.id, row.questionId);
    expect(head.note).toMatchObject({
      revision: 1,
      currentVersionId: receipt.versionId,
    });
    expect(head.note).not.toHaveProperty("currentRevision");
    const result = studentMcpSubmissionParameters(
      db,
      studentId,
      attempt,
      row,
      0,
    );
    expect(result).toMatchObject({
      available: true,
      parameters: {
        evidence: {
          questionId: row.questionId,
          state: "frozen",
          versionId: head.note?.currentVersionId,
          revision: head.note?.revision,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("missing");
  });

  it("旧协议、已提交与当前限时门返回真实不可提交原因", async () => {
    const { studentMcpSubmissionParameters } = await import(
      "./student-mcp-submission-parameters.ts"
    );
    const { db, studentId, attempt, row } = fixture();
    expect(
      studentMcpSubmissionParameters(
        db,
        studentId,
        { ...attempt, practiceWorkflowVersion: null },
        row,
        0,
      ),
    ).toEqual({ available: false, reason: "WORKFLOW_LEGACY" });
    expect(
      studentMcpSubmissionParameters(
        db,
        studentId,
        attempt,
        { ...row, submittedAt: "2026-11-14T00:00:00.000Z" },
        0,
      ),
    ).toEqual({ available: false, reason: "QUESTION_ALREADY_SUBMITTED" });
    expect(
      studentMcpSubmissionParameters(
        db,
        studentId,
        { ...attempt, deadlineAt: "2026-11-14T00:00:00.000Z" },
        row,
        0,
        "2026-11-14T00:00:00.001Z",
      ),
    ).toEqual({ available: false, reason: "ATTEMPT_TIME_UP" });
  });
});

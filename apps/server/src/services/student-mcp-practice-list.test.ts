import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  aiPolicyOverrides,
  attempts,
  events,
  responses,
} from "../db/schema.ts";
import { createTestDb } from "../db/test-utils.ts";
import {
  insertAttempt,
  insertResponse,
} from "../test/ai-companion-fixtures.ts";
import { makeStudent } from "../test/note-fixtures.ts";

function fixture() {
  const db = createTestDb();
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
  const rowId = insertResponse(db, practiceId, "题-1");
  return { db, studentId, practiceId, rowId };
}

describe("学生MCP本人练习元数据索引", () => {
  it("只投影本人元数据和真实工作流，不携成绩/判定，不激活空练习", async () => {
    const { listStudentMcpPractices } = await import(
      "./student-mcp-practice-list.ts"
    );
    const { db, studentId, practiceId, rowId } = fixture();
    db.update(responses)
      .set({
        autoCorrect: true,
        finalCorrect: true,
        teacherComment: "私注哨兵",
      })
      .where(eq(responses.id, rowId))
      .run();
    const otherStudent = makeStudent(db);
    insertAttempt(db, { studentId: otherStudent });
    const before = db.select().from(attempts).all();
    const data = listStudentMcpPractices(db, studentId, {});
    expect(data.total).toBe(1);
    expect(data.practices).toEqual([
      expect.objectContaining({
        practiceId,
        status: "draft",
        title: "错题重练",
        answerProgress: { answeredCount: 0, totalCount: 1 },
        submissionProgress: { submittedCount: 0, totalCount: 1 },
        practiceWorkflow: expect.objectContaining({
          version: 1,
          canSubmitQuestion: true,
        }),
      }),
    ]);
    expect(JSON.stringify(data)).not.toMatch(
      /score|autoCorrect|finalCorrect|teacherComment|私注|activated|canSettlePartially|"phase"/,
    );
    expect(db.select().from(attempts).all()).toEqual(before);
    expect(db.select().from(events).all()).toEqual([]);
  });

  it("AI关闭不把元数据列表冒充读题授权，旧协议只返回真实空工作流", async () => {
    const { listStudentMcpPractices } = await import(
      "./student-mcp-practice-list.ts"
    );
    const { db, studentId, practiceId } = fixture();
    db.insert(aiPolicyOverrides)
      .values({
        subjectType: "student",
        subjectId: studentId,
        mode: "post_submit_only",
        updatedAt: "2026-11-14T00:00:00.000Z",
      })
      .run();
    db.update(attempts)
      .set({ practiceWorkflowVersion: null })
      .where(eq(attempts.id, practiceId))
      .run();
    const data = listStudentMcpPractices(db, studentId, {});
    expect(data.total).toBe(1);
    expect(data.practices[0]).toMatchObject({
      practiceWorkflow: null,
      submissionProgress: null,
    });
    expect(data.practices[0]).not.toHaveProperty("question");
  });

  it("作废与其他学生不进入索引，分页遵守同一本人记录顺序", async () => {
    const { listStudentMcpPractices } = await import(
      "./student-mcp-practice-list.ts"
    );
    const { db, studentId, practiceId } = fixture();
    db.update(attempts)
      .set({ abandonedAt: "2026-11-14T00:00:00.000Z" })
      .where(eq(attempts.id, practiceId))
      .run();
    expect(
      listStudentMcpPractices(db, studentId, { limit: 1, offset: 0 }),
    ).toEqual({ schemaVersion: 1, practices: [], total: 0 });
  });
});

import type {
  AiMcpCurrentContext,
  StudentMcpLiveFocusRequest,
} from "@tutor/contract";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { aiTasks } from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";
import { sqliteAiPolicyConfigSource } from "./ai-policy-config-source.ts";
import { mcpLiveContextGeneration } from "./connection-service.ts";
import {
  currentStudentMcpFocus,
  recordStudentMcpFocus,
} from "./mcp-live-focus-registry.ts";
import { resolveAttemptQuestionAiPolicy } from "./teaching-policy-service.ts";

function canLocateQuestion(
  db: Db,
  studentId: string,
  attemptId: string,
  questionId: string,
): boolean {
  try {
    const { resolution, attempt } = resolveAttemptQuestionAiPolicy(
      db,
      studentId,
      attemptId,
      questionId,
      sqliteAiPolicyConfigSource,
      { frozenOnly: true },
    );
    return resolution.usable && attempt.status === "draft";
  } catch (error) {
    if (error instanceof HttpError) return false;
    throw error;
  }
}

export function updateStudentMcpLiveFocus(
  db: Db,
  studentId: string,
  attemptId: string,
  request: StudentMcpLiveFocusRequest,
): void {
  if (
    mcpLiveContextGeneration(db, studentId) !== request.generation &&
    mcpLiveContextGeneration(db, studentId, undefined, -1) !==
      request.generation
  )
    return;
  const questionId = request.questionId;
  recordStudentMcpFocus(
    db,
    studentId,
    attemptId,
    questionId === null ||
      canLocateQuestion(db, studentId, attemptId, questionId)
      ? request
      : { ...request, questionId: null },
  );
}

const noCurrent = { status: "no_current_question" } as const;

export function getStudentMcpCurrentContext(
  db: Db,
  studentId: string,
  connectionId?: string,
): AiMcpCurrentContext {
  if (
    connectionId === undefined ||
    mcpLiveContextGeneration(db, studentId, connectionId) === null
  )
    return { status: "disabled" };
  const focus = currentStudentMcpFocus(db, studentId);
  if (
    focus === null ||
    !canLocateQuestion(db, studentId, focus.attemptId, focus.questionId)
  )
    return noCurrent;
  const task = db
    .select({ id: aiTasks.id })
    .from(aiTasks)
    .where(
      and(
        eq(aiTasks.studentId, studentId),
        eq(aiTasks.attemptId, focus.attemptId),
        eq(aiTasks.questionId, focus.questionId),
        eq(aiTasks.channel, "mcp"),
        eq(aiTasks.status, "created"),
        isNull(aiTasks.cancelRequestedAt),
      ),
    )
    .orderBy(desc(aiTasks.createdAt), desc(aiTasks.id))
    .get();
  return task === undefined
    ? { status: "student_action_required" }
    : { status: "authorized_task", taskId: task.id };
}

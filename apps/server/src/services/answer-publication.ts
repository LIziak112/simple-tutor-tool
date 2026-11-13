import type { AttemptSource } from "@tutor/contract";
import { canonicalAssignmentDueAt } from "@tutor/contract";

export type AssignmentPublication = {
  answerRelease: string;
  dueAt: string | null;
};

/** 发布策略或截止时间缺失、损坏时，已交作业仍保持受限。 */
export function answersReleased(
  assignment: AssignmentPublication,
  now: Date | string = new Date(),
): boolean {
  if (assignment.answerRelease === "on_submit") return true;
  if (assignment.answerRelease !== "after_due") return false;
  const deadline = canonicalAssignmentDueAt(assignment.dueAt);
  if (deadline === null) return false;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  return Date.parse(deadline) <= nowMs;
}

export function attemptAnswersPublished(
  input: {
    attemptSubmitted: boolean;
    sourceType: AttemptSource;
    release: AssignmentPublication | null;
  },
  now: Date | string = new Date(),
): boolean {
  if (!input.attemptSubmitted || input.sourceType !== "assignment") return true;
  return input.release !== null && answersReleased(input.release, now);
}

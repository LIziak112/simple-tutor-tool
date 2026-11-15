import type { AssignmentCheckHint, QuestionType } from "@tutor/contract";
import { QUESTION_TYPE_LABELS } from "@/features/content/question-meta";
import { formatDueTime, localInputToUtcIso } from "@/lib/time";
export function distributionText(distribution: Record<string, number>): string {
  return Object.entries(distribution)
    .map(
      ([type, count]) =>
        `${QUESTION_TYPE_LABELS[type as QuestionType] ?? type}×${count}`,
    )
    .join(" ");
}
export function checkHintLine(hint: AssignmentCheckHint): string {
  return `${hint.studentName}：已在〈${hint.courseName ?? "课程"}〉中做过〈${hint.unitTitle}〉${hint.submittedCount} 次（已看过答案）`;
}
export function dueRelativeHint(localValue: string): string | null {
  if (localValue.length === 0) return null;
  const utc = localInputToUtcIso(localValue);
  const days = Math.ceil(
    (Date.parse(utc) - Date.now()) / (24 * 60 * 60 * 1000),
  );
  if (Number.isNaN(days)) return null;
  if (days < 0) return `该时间已过（北京时间 ${formatDueTime(utc)}）`;
  if (days === 0) return "今天截止（北京时间）";
  return `${days} 天后截止（北京时间 ${formatDueTime(utc)}）`;
}

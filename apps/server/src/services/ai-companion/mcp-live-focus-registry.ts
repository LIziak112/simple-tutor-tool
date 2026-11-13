import {
  MCP_LIVE_FOCUS_TTL_MS,
  type StudentMcpLiveFocusRequest,
} from "@tutor/contract";
import type { Db } from "../../db/client.ts";

type Focus = StudentMcpLiveFocusRequest & {
  attemptId: string;
  expiresAt: number;
};
type StudentFocus = { views: Map<string, Focus>; overflowUntil: number };

const liveByConnection = new WeakMap<
  Db["$client"],
  Map<string, StudentFocus>
>();
const MAX_STUDENTS = 2048;
const MAX_VIEWS = 12;

function activeStudents(db: Db): Map<string, StudentFocus> {
  const existing = liveByConnection.get(db.$client);
  if (existing !== undefined) return existing;
  const created = new Map<string, StudentFocus>();
  liveByConnection.set(db.$client, created);
  return created;
}

function prune(focus: StudentFocus, now: number): boolean {
  for (const [viewId, view] of focus.views) {
    if (view.expiresAt + MCP_LIVE_FOCUS_TTL_MS <= now)
      focus.views.delete(viewId);
  }
  return focus.views.size === 0 && focus.overflowUntil <= now;
}

export function clearStudentMcpFocus(db: Db, studentId: string): void {
  liveByConnection.get(db.$client)?.delete(studentId);
}

export function recordStudentMcpFocus(
  db: Db,
  studentId: string,
  attemptId: string,
  request: StudentMcpLiveFocusRequest,
  now = Date.now(),
): void {
  const students = activeStudents(db);
  let focus = students.get(studentId);
  if (focus === undefined) {
    if (students.size >= MAX_STUDENTS) {
      for (const [id, entry] of students) {
        if (prune(entry, now)) students.delete(id);
      }
    }
    if (students.size >= MAX_STUDENTS) return;
    focus = { views: new Map(), overflowUntil: 0 };
    students.set(studentId, focus);
  } else {
    prune(focus, now);
  }
  const previous = focus.views.get(request.viewId);
  if (previous !== undefined && request.sequence <= previous.sequence) return;
  if (previous === undefined && focus.views.size >= MAX_VIEWS) {
    focus.overflowUntil = now + MCP_LIVE_FOCUS_TTL_MS;
    return;
  }
  // 保留撤回序号，迟到的旧心跳不能复活隐藏页面。
  focus.views.set(request.viewId, {
    ...request,
    attemptId,
    expiresAt: now + MCP_LIVE_FOCUS_TTL_MS,
  });
}

export function currentStudentMcpFocus(
  db: Db,
  studentId: string,
  now = Date.now(),
): { attemptId: string; questionId: string } | null {
  const students = liveByConnection.get(db.$client);
  const focus = students?.get(studentId);
  if (focus === undefined) return null;
  if (prune(focus, now)) {
    students?.delete(studentId);
    return null;
  }
  if (focus.overflowUntil > now) return null;
  let current: { attemptId: string; questionId: string } | null = null;
  for (const view of focus.views.values()) {
    if (view.questionId === null || view.expiresAt <= now) continue;
    if (
      current !== null &&
      (current.attemptId !== view.attemptId ||
        current.questionId !== view.questionId)
    )
      return null;
    current = { attemptId: view.attemptId, questionId: view.questionId };
  }
  return current;
}

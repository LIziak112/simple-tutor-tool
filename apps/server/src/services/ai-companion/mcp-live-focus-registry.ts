import {
  MCP_LIVE_FOCUS_MAX_VIEWS,
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
  if (previous === undefined && focus.views.size >= MCP_LIVE_FOCUS_MAX_VIEWS) {
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

export function studentMcpFocusCandidates(
  db: Db,
  studentId: string,
  now = Date.now(),
) {
  const students = liveByConnection.get(db.$client);
  const focus = students?.get(studentId);
  if (focus === undefined) return { overflow: false, candidates: [] };
  if (prune(focus, now)) {
    students?.delete(studentId);
    return { overflow: false, candidates: [] };
  }
  if (focus.overflowUntil > now) return { overflow: true, candidates: [] };
  const candidates = new Map<
    string,
    { attemptId: string; questionId: string }
  >();
  for (const view of focus.views.values()) {
    if (view.questionId === null || view.expiresAt <= now) continue;
    candidates.set(JSON.stringify([view.attemptId, view.questionId]), {
      attemptId: view.attemptId,
      questionId: view.questionId,
    });
  }
  return { overflow: false, candidates: [...candidates.values()] };
}

/** 旧工具仍只接受唯一焦点；多窗口歧义保持null旧语义。 */
export function currentStudentMcpFocus(
  db: Db,
  studentId: string,
  now = Date.now(),
): { attemptId: string; questionId: string } | null {
  const result = studentMcpFocusCandidates(db, studentId, now);
  return !result.overflow && result.candidates.length === 1
    ? (result.candidates[0] ?? null)
    : null;
}

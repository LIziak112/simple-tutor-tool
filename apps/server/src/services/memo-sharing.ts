import type { SharedMemo } from "@tutor/contract";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { memos, students, teachers } from "../db/schema";
import { memoShares } from "../db/schema-memos";
import { memoNotFound, requireOwnMemoRow, toMemo } from "./memo-read";

function availableTeacher(db: Db, studentId: string): string | null {
  return (
    db
      .select({ id: teachers.id })
      .from(students)
      .innerJoin(teachers, eq(teachers.id, students.teacherId))
      .where(
        and(
          eq(students.id, studentId),
          isNull(students.archivedAt),
          isNull(teachers.disabledAt),
        ),
      )
      .get()?.id ?? null
  );
}
export function memoShareState(db: Db, studentId: string, memoId: string) {
  requireOwnMemoRow(db, studentId, memoId);
  const availableTeacherId = availableTeacher(db, studentId);
  const share = db
    .select()
    .from(memoShares)
    .where(
      and(eq(memoShares.memoId, memoId), eq(memoShares.studentId, studentId)),
    )
    .get();
  return {
    availableTeacherId,
    teacherId:
      share?.teacherId === availableTeacherId ? availableTeacherId : null,
  };
}
export function shareMemo(
  db: Db,
  studentId: string,
  memoId: string,
  teacherId: string,
) {
  requireOwnMemoRow(db, studentId, memoId);
  if (availableTeacher(db, studentId) !== teacherId) throw memoNotFound();
  db.insert(memoShares)
    .values({
      memoId,
      studentId,
      teacherId,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: memoShares.memoId,
      set: { studentId, teacherId, createdAt: new Date().toISOString() },
    })
    .run();
  return memoShareState(db, studentId, memoId);
}
export function revokeMemoShare(db: Db, studentId: string, memoId: string) {
  requireOwnMemoRow(db, studentId, memoId);
  db.delete(memoShares)
    .where(
      and(eq(memoShares.memoId, memoId), eq(memoShares.studentId, studentId)),
    )
    .run();
}
function requireTeacherStudent(db: Db, teacherId: string, studentId: string) {
  if (availableTeacher(db, studentId) !== teacherId) throw memoNotFound();
}
export function sharedMemoRow(
  db: Db,
  teacherId: string,
  studentId: string,
  memoId: string,
) {
  requireTeacherStudent(db, teacherId, studentId);
  if (
    !db
      .select()
      .from(memoShares)
      .where(
        and(
          eq(memoShares.memoId, memoId),
          eq(memoShares.studentId, studentId),
          eq(memoShares.teacherId, teacherId),
        ),
      )
      .get()
  )
    throw memoNotFound();
  return requireOwnMemoRow(db, studentId, memoId);
}
/** 教师投影不含设备、父子关系、原始context、原题或答案。 */
export function listSharedMemos(
  db: Db,
  teacherId: string,
  studentId: string,
  before?: string,
) {
  requireTeacherStudent(db, teacherId, studentId);
  const split = before?.lastIndexOf("|") ?? -1;
  if (before !== undefined && split < 1) throw memoNotFound();
  const cursor =
    before === undefined
      ? null
      : { at: before.slice(0, split), id: before.slice(split + 1) };
  const rows = db
    .select({ memo: memos })
    .from(memos)
    .innerJoin(memoShares, eq(memoShares.memoId, memos.id))
    .where(
      and(
        eq(memos.studentId, studentId),
        eq(memoShares.studentId, studentId),
        eq(memoShares.teacherId, teacherId),
        isNull(memos.deletedAt),
        cursor === null
          ? undefined
          : or(
              lt(memos.recordedAt, cursor.at),
              and(eq(memos.recordedAt, cursor.at), lt(memos.id, cursor.id)),
            ),
      ),
    )
    .orderBy(desc(memos.recordedAt), desc(memos.id))
    .limit(31)
    .all();
  const page = rows.slice(0, 30);
  return {
    memos: page.map(({ memo: row }): SharedMemo => {
      const memo = toMemo(row);
      return {
        id: memo.id,
        ...(memo.seq === undefined ? {} : { seq: memo.seq }),
        kind: memo.kind,
        text: memo.text,
        media: memo.media,
        tags: memo.tags,
        recordedAt: memo.recordedAt,
        sourceLabel: memo.anchor.kind === "none" ? null : memo.anchor.label,
      };
    }),
    nextCursor:
      rows.length > 30 && page.at(-1)
        ? `${page.at(-1)?.memo.recordedAt}|${page.at(-1)?.memo.id}`
        : null,
  };
}

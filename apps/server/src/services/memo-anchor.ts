import type { MemoAgentCreate, MemoAnchor } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts, lectures, students, units } from "../db/schema";
import { HttpError } from "../lib/http-error";

/**
 * Agent 转记的锚核对（模块 5 第一步）：Agent 只报 id，这里核对该作答 / 讲义对
 * 本人可见，并在 label 缺省时按作答单元 / 讲义标题生成。不可见一律 404
 * MEMO_ANCHOR_NOT_FOUND（不暴露存在性）。界面记的随笔由前端带完整锚，不走这里。
 */

function anchorNotFound(): HttpError {
  return new HttpError(
    404,
    "MEMO_ANCHOR_NOT_FOUND",
    "锚到的作答或讲义不存在，或不是本人可见的",
  );
}

export function resolveAgentMemoAnchor(
  db: Db,
  studentId: string,
  anchor: NonNullable<MemoAgentCreate["anchor"]>,
): MemoAnchor {
  if (anchor.kind === "question") {
    const row = db
      .select({ unitId: attempts.unitId })
      .from(attempts)
      .where(
        and(
          eq(attempts.id, anchor.attemptId),
          eq(attempts.studentId, studentId),
        ),
      )
      .get();
    if (row === undefined) throw anchorNotFound();
    const unit =
      row.unitId === null
        ? undefined
        : db
            .select({ title: units.title })
            .from(units)
            .where(eq(units.id, row.unitId))
            .get();
    return {
      kind: "question",
      attemptId: anchor.attemptId,
      questionId: anchor.questionId,
      label: anchor.label ?? unit?.title ?? "作答",
    };
  }
  const student = db
    .select({ teacherId: students.teacherId })
    .from(students)
    .where(eq(students.id, studentId))
    .get();
  const lecture =
    student === undefined || student.teacherId === null
      ? undefined
      : db
          .select({ title: lectures.title })
          .from(lectures)
          .where(
            and(
              eq(lectures.id, anchor.lectureId),
              eq(lectures.teacherId, student.teacherId),
            ),
          )
          .get();
  if (lecture === undefined) throw anchorNotFound();
  return {
    kind: "lecture",
    lectureId: anchor.lectureId,
    sectionId: anchor.sectionId ?? null,
    label: anchor.label ?? lecture.title,
  };
}

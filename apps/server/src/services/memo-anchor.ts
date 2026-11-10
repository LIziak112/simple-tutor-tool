import type { MemoAgentCreate, MemoAnchor } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { attempts, units } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { requireVisibleStudentLecture } from "./student-course-service";

/**
 * Agent 转记的锚核对（模块 5 第一步）：Agent 只报 id，这里核对该作答 / 讲义对
 * 本人可见，并在 label 缺省时按作答单元 / 讲义标题生成。不可见一律 404
 * MEMO_ANCHOR_NOT_FOUND（不暴露存在性）。界面记的随笔由前端带完整锚，不走这里。
 * 讲义可见性与学生讲义详情共用 requireVisibleStudentLecture（D5：须在本人可见课程
 * 目录中、条目可见、已到发布时间、未软删），同教师但看不到的讲义不经此泄露标题。
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
  now: Date = new Date(),
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
  let title: string;
  try {
    title = requireVisibleStudentLecture(
      db,
      studentId,
      anchor.lectureId,
      undefined,
      now,
    ).lecture.title;
  } catch (err) {
    // 不存在 / 隐藏 / 未发布 / 已删 / 非成员：统一 404，不区分原因
    if (err instanceof HttpError) throw anchorNotFound();
    throw err;
  }
  return {
    kind: "lecture",
    lectureId: anchor.lectureId,
    sectionId: anchor.sectionId ?? null,
    label: anchor.label ?? title,
  };
}

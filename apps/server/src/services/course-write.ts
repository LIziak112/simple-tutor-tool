import type { CourseData, CourseUpdateRequest } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  courseItems,
  courseStudents,
  courses,
  students,
  teachers,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { courseHasAttempts } from "./course-service";

/**
 * 新建课程（POST /api/teacher/courses）：order 追加到末尾（T2B.4：按会话教师的
 * 课程数计数，写 courses.teacherId）；description 可选（T2A.4）。
 */
export function createCourse(
  db: Db,
  teacherId: string,
  input: {
    title: string;
    description?: string | null | undefined;
    examType?: string | null | undefined;
    reviewTemplateId?: string | null | undefined;
  },
): CourseData {
  const count = db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.teacherId, teacherId))
    .all().length;
  const id = crypto.randomUUID();
  const order = count;
  const description =
    input.description !== undefined && input.description !== null
      ? input.description
      : null;
  db.transaction((tx) => {
    tx.insert(courses)
      .values({
        id,
        teacherId,
        title: input.title,
        order,
        description,
        examType: input.examType || null,
        reviewTemplateId: input.reviewTemplateId ?? null,
        createdAt: new Date().toISOString(),
      })
      .run();
    const owner = tx
      .select({
        accountKind: teachers.accountKind,
        studentId: teachers.personalStudentId,
      })
      .from(teachers)
      .where(eq(teachers.id, teacherId))
      .get();
    if (owner?.accountKind === "personal" && owner.studentId !== null) {
      const learner = tx
        .select({ id: students.id })
        .from(students)
        .where(
          and(
            eq(students.id, owner.studentId),
            eq(students.teacherId, teacherId),
          ),
        )
        .get();
      if (!learner)
        throw new HttpError(
          409,
          "PERSONAL_ACCOUNT_RESTRICTED",
          "个人学习身份暂不可用，请重新登录",
        );
      tx.insert(courseStudents)
        .values({
          courseId: id,
          studentId: learner.id,
          joinedAt: new Date().toISOString(),
        })
        .run();
    }
  });
  return {
    id,
    title: input.title,
    order,
    description,
    examType: input.examType || null,
    reviewTemplateId: input.reviewTemplateId ?? null,
    archived: false,
    archivedAt: null,
  };
}

/**
 * 课程更新（PATCH /api/teacher/courses/:id，T2A.4 扩展）：
 * - name / title 同义（name 为 Phase 2A 术语口径，title 兼容旧调用方），缺省 = 不改；
 * - description 显式 null = 清空；archived：true 归档（D4，学生端不可见）、false 恢复。
 * T2B.4：按会话教师取课程行（非本人课程 → 404 COURSE_NOT_FOUND，D12）。
 */
export function updateCourse(
  db: Db,
  teacherId: string,
  id: string,
  input: CourseUpdateRequest,
): CourseData {
  const row = db
    .select()
    .from(courses)
    .where(and(eq(courses.teacherId, teacherId), eq(courses.id, id)))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "COURSE_NOT_FOUND", "课程不存在");
  }
  const patch: Partial<typeof courses.$inferInsert> = {};
  if (input.examType !== undefined) patch.examType = input.examType || null;
  if (input.reviewTemplateId !== undefined)
    patch.reviewTemplateId = input.reviewTemplateId;
  const title = input.name ?? input.title;
  if (title !== undefined && title !== row.title) {
    patch.title = title;
  }
  if (input.description !== undefined) {
    patch.description =
      input.description === null || input.description.length === 0
        ? null
        : input.description;
  }
  if (input.archived !== undefined) {
    // true 归档（已归档保持原时间，幂等）；false 恢复（置 null）
    patch.archivedAt = input.archived
      ? (row.archivedAt ?? new Date().toISOString())
      : null;
  }
  if (Object.keys(patch).length > 0) {
    db.update(courses).set(patch).where(eq(courses.id, id)).run();
  }
  return {
    id,
    title: patch.title ?? row.title,
    examType: patch.examType !== undefined ? patch.examType : row.examType,
    reviewTemplateId:
      patch.reviewTemplateId !== undefined
        ? patch.reviewTemplateId
        : row.reviewTemplateId,
    order: row.order,
    description:
      patch.description !== undefined ? patch.description : row.description,
    archived:
      patch.archivedAt !== undefined
        ? patch.archivedAt !== null
        : row.archivedAt !== null,
    archivedAt:
      patch.archivedAt !== undefined ? patch.archivedAt : row.archivedAt,
  };
}

/**
 * 课程删除（DELETE /api/teacher/courses/:id，D4，T2A.4 起语义升级）：
 * 仅在该课程**没有作答记录且没有按课程布置的作业**时允许（判定见
 * CourseService.courseHasAttempts——attempts.courseId OR assignments.courseId，
 * 保守口径），否则 409 COURSE_HAS_ATTEMPTS（提示改用归档）。删除不触碰
 * 资源库内容（D1 引用制），目录条目与成员随课程一并清理，成功后资源库原样保留。
 * T2B.4：按会话教师取课程行（非本人课程 → 404 COURSE_NOT_FOUND，D12）。
 */
export function deleteCourse(db: Db, teacherId: string, id: string): void {
  const row = db
    .select({ id: courses.id })
    .from(courses)
    .where(and(eq(courses.teacherId, teacherId), eq(courses.id, id)))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "COURSE_NOT_FOUND", "课程不存在");
  }
  if (courseHasAttempts(db, id)) {
    throw new HttpError(
      409,
      "COURSE_HAS_ATTEMPTS",
      "该课程已有作答记录或布置的作业，不能删除；请改用归档（归档后学生看不到，数据保留）",
    );
  }
  db.transaction((tx) => {
    tx.delete(courseItems).where(eq(courseItems.courseId, id)).run();
    tx.delete(courseStudents).where(eq(courseStudents.courseId, id)).run();
    tx.delete(courses).where(eq(courses.id, id)).run();
  });
}

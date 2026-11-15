import type { ReviewPresentation } from "@tutor/contract";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type Attempt,
  assignments,
  courses,
  students,
  units,
} from "../db/schema.ts";
import { practiceDefaultsOf } from "./practice-workflow-service.ts";
/** 只投影展示推荐，题目判定/答案授权不依赖模板。 */
export function reviewPresentationOf(
  db: Db,
  attempt: Attempt,
  unitIds: readonly string[],
): ReviewPresentation {
  const teacherId = db
    .select({ id: students.teacherId })
    .from(students)
    .where(eq(students.id, attempt.studentId))
    .get()?.id;
  if (teacherId == null)
    return { examType: null, templateId: null, unitTemplateIds: [] };
  const courseId =
    attempt.courseId ??
    (attempt.assignmentId === null
      ? null
      : db
          .select({ id: assignments.courseId })
          .from(assignments)
          .where(eq(assignments.id, attempt.assignmentId))
          .get()?.id);
  const course =
    courseId == null
      ? undefined
      : db
          .select()
          .from(courses)
          .where(
            and(eq(courses.id, courseId), eq(courses.teacherId, teacherId)),
          )
          .get();
  const unitTemplateIds: string[] = [];
  if (unitIds.length)
    for (const unit of db
      .select({ practice: units.practiceDefaultsJson })
      .from(units)
      .where(
        and(eq(units.teacherId, teacherId), inArray(units.id, [...unitIds])),
      )
      .all()) {
      const defaults = practiceDefaultsOf(unit.practice);
      if (defaults?.reviewTemplateId)
        unitTemplateIds.push(defaults.reviewTemplateId);
    }
  return {
    examType: course?.examType ?? null,
    templateId: course?.reviewTemplateId ?? null,
    unitTemplateIds: [...new Set(unitTemplateIds)],
  };
}

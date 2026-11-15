import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { courseStudents, students, teachers } from "../db/schema";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils";
import { createCourse } from "./content-service";

describe("个人学习者新建课程", () => {
  it("课程创建时自动把绑定本人加入成员，班级课程不自动加成员", () => {
    const db = createTestDb();
    const learnerId = crypto.randomUUID();
    db.insert(students)
      .values({
        id: learnerId,
        teacherId: TEST_TEACHER_ID,
        displayName: "小栗",
        loginName: "__personal_internal",
        linkToken: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      })
      .run();
    db.update(teachers)
      .set({ accountKind: "personal", personalStudentId: learnerId })
      .where(eq(teachers.id, TEST_TEACHER_ID))
      .run();
    const personal = createCourse(db, TEST_TEACHER_ID, { title: "自己的课程" });
    expect(
      db
        .select()
        .from(courseStudents)
        .where(eq(courseStudents.courseId, personal.id))
        .all()
        .map((row) => row.studentId),
    ).toEqual([learnerId]);
    db.update(teachers)
      .set({ accountKind: "class", personalStudentId: null })
      .where(eq(teachers.id, TEST_TEACHER_ID))
      .run();
    const classroom = createCourse(db, TEST_TEACHER_ID, { title: "班级课程" });
    expect(
      db
        .select()
        .from(courseStudents)
        .where(eq(courseStudents.courseId, classroom.id))
        .all(),
    ).toEqual([]);
  });
});

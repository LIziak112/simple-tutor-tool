import { courseUpdateRequestSchema } from "@tutor/contract";
import { expect, it } from "vitest";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { getCourseDetail } from "./course-service.ts";
import { createCourse, updateCourse } from "./course-write.ts";

it("课程考试标签/模板推荐可写可清空，未知模板请求拒绝，旧课迁移默认null", () => {
  expect(
    courseUpdateRequestSchema.safeParse({ reviewTemplateId: "不存在" }).success,
  ).toBe(false);
  const db = createTestDb();
  try {
    const course = createCourse(db, TEST_TEACHER_ID, { title: "模板课" });
    expect(course).toMatchObject({ examType: null, reviewTemplateId: null });
    const updated = updateCourse(db, TEST_TEACHER_ID, course.id, {
      examType: "行测",
      reviewTemplateId: "exam",
    });
    expect(updated).toMatchObject({
      examType: "行测",
      reviewTemplateId: "exam",
    });
    expect(getCourseDetail(db, TEST_TEACHER_ID, course.id)).toMatchObject({
      examType: "行测",
      reviewTemplateId: "exam",
    });
    expect(() =>
      updateCourse(db, "other", course.id, { examType: "作文" }),
    ).toThrow();
    expect(
      updateCourse(db, TEST_TEACHER_ID, course.id, {
        examType: null,
        reviewTemplateId: null,
      }),
    ).toMatchObject({ examType: null, reviewTemplateId: null });
  } finally {
    db.$client.close();
  }
});

it("真实结果携带课程与单元推荐，单元覆盖课程且元数据不包含题目秘密", async () => {
  const { studentPracticeReadEnv } = await import(
    "../test/student-mcp-practice-fixtures.ts"
  );
  const { commitImport } = await import("./content-service.ts");
  const { attempts, responses, courseStudents, courseItems } = await import(
    "../db/schema.ts"
  );
  const { eq } = await import("drizzle-orm");
  const { randomUUID } = await import("node:crypto");
  const { settleStudentAttempt } = await import("./attempt-partial.ts");
  const { getAttemptDetail } = await import("./attempt-service.ts");
  const { resolveReviewTemplate } = await import("@tutor/contract");
  const e = await studentPracticeReadEnv("class");
  try {
    const course = createCourse(e.db, TEST_TEACHER_ID, {
      title: "复盘课程",
      examType: "行测",
      reviewTemplateId: "exam",
    });
    const imported = commitImport(
      e.db,
      TEST_TEACHER_ID,
      {
        markdown:
          "---\nkind: practice\nunit: 复盘样卷\npractice:\n  reviewTemplateId: material\n---\n\n::::question{type=judge}\n真 [[正确]]\n::::",
        filename: "复盘样卷.md",
      },
      undefined,
      undefined,
      true,
    );
    const unitId = imported.units[0]?.id;
    if (!unitId) throw new Error("样卷缺单元");
    e.db
      .insert(courseStudents)
      .values({
        courseId: course.id,
        studentId: e.studentId,
        joinedAt: new Date().toISOString(),
      })
      .run();
    e.db
      .insert(courseItems)
      .values({
        id: randomUUID(),
        courseId: course.id,
        kind: "unit",
        refId: unitId,
        order: 0,
        visible: true,
        createdAt: new Date().toISOString(),
      })
      .run();
    e.db
      .update(attempts)
      .set({ sourceType: "course", courseId: course.id, unitId })
      .where(eq(attempts.id, e.practiceId))
      .run();
    e.db
      .update(responses)
      .set({ unitId })
      .where(eq(responses.attemptId, e.practiceId))
      .run();
    settleStudentAttempt(e.db, e.studentId, e.practiceId, {
      workflowVersion: 1,
      workflowRevision: 0,
      mutationId: randomUUID(),
      questions: e.revisions.map((revision, index) => ({
        questionId: `q-${index + 1}`,
        questionRevisionId: revision,
        expectedAnswerRevision: 0,
        evidence: { questionId: `q-${index + 1}`, state: "none" as const },
      })),
    });
    const data = getAttemptDetail(e.db, e.studentId, e.practiceId);
    if (!("summary" in data)) throw new Error("缺结果");
    expect(data.reviewPresentation).toEqual({
      examType: "行测",
      templateId: "exam",
      unitTemplateIds: ["material"],
    });
    expect(
      resolveReviewTemplate({
        ...data.reviewPresentation,
        questionTypes: ["choice"],
        hasMaterials: false,
      }).template.id,
    ).toBe("material");
    expect(JSON.stringify(data.reviewPresentation)).not.toMatch(
      /answers|solution|teacherComment/,
    );
  } finally {
    await e.client.close();
    e.db.$client.close();
  }
});

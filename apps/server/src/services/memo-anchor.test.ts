import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import {
  courseItems,
  courseStudents,
  courses,
  lectures,
  teachers,
} from "../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { expectHttpError } from "../test/expect-http-error.ts";
import { makeStudent } from "../test/note-fixtures.ts";
import { resolveAgentMemoAnchor } from "./memo-anchor.ts";

/**
 * Agent 转记锚核对（审查修复 #104-04）：讲义锚与学生讲义详情共用同一可见性谓词
 * （requireVisibleStudentLecture）——同教师但隐藏 / 未到发布 / 已软删 / 不在任何可见
 * 课程目录中的讲义一律 404 MEMO_ANCHOR_NOT_FOUND，其存在与标题不经转记进入随笔。
 */

const T0 = "2026-09-01T00:00:00.000Z";
const NOW = new Date("2026-10-01T00:00:00.000Z");

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("期望抛出异常但没有");
}

function insertLecture(
  db: Db,
  title: string,
  teacherId: string = TEST_TEACHER_ID,
): string {
  const id = randomUUID();
  db.insert(lectures)
    .values({
      id,
      teacherId,
      courseId: null,
      folderId: null,
      title,
      markdown: `# ${title}\n\n正文`,
      kind: "lecture",
      order: 0,
      updatedAt: T0,
      deletedAt: null,
      teachingPackJson: null,
    })
    .run();
  return id;
}

/** 一门课（学生为成员）+ 一个讲义条目；返回条目 id 便于改可见性 */
function insertCourseWithLecture(
  db: Db,
  studentId: string,
  lectureId: string,
  item: { visible?: boolean; publishAt?: string | null; member?: boolean } = {},
): { courseId: string; itemId: string } {
  const courseId = randomUUID();
  db.insert(courses)
    .values({
      id: courseId,
      teacherId: TEST_TEACHER_ID,
      title: "随笔课",
      order: 0,
      archivedAt: null,
      createdAt: T0,
    })
    .run();
  if (item.member !== false) {
    db.insert(courseStudents)
      .values({ courseId, studentId, joinedAt: T0 })
      .run();
  }
  const itemId = randomUUID();
  db.insert(courseItems)
    .values({
      id: itemId,
      courseId,
      kind: "lecture",
      refId: lectureId,
      title: null,
      order: 0,
      visible: item.visible ?? true,
      publishAt: item.publishAt ?? null,
      createdAt: T0,
    })
    .run();
  return { courseId, itemId };
}

describe("resolveAgentMemoAnchor：讲义锚按学生可见性核对", () => {
  it("可见讲义：label 缺省取标题、sectionId 透传；显式 label 保留", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const lectureId = insertLecture(db, "第二讲 比例");
    insertCourseWithLecture(db, studentId, lectureId);

    expect(
      resolveAgentMemoAnchor(
        db,
        studentId,
        { kind: "lecture", lectureId, sectionId: "s-2" },
        NOW,
      ),
    ).toEqual({
      kind: "lecture",
      lectureId,
      sectionId: "s-2",
      label: "第二讲 比例",
    });
    expect(
      resolveAgentMemoAnchor(
        db,
        studentId,
        { kind: "lecture", lectureId, label: "比例那一讲" },
        NOW,
      ),
    ).toMatchObject({ kind: "lecture", label: "比例那一讲" });
  });

  it("同教师但不在任何课程目录中的讲义：404 MEMO_ANCHOR_NOT_FOUND（标题不泄露）", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const lectureId = insertLecture(db, "未入课的讲义");
    expectHttpError(
      captureError(() =>
        resolveAgentMemoAnchor(
          db,
          studentId,
          { kind: "lecture", lectureId },
          NOW,
        ),
      ),
      404,
      "MEMO_ANCHOR_NOT_FOUND",
    );
  });

  it("条目隐藏 / 未到发布时间 / 讲义已软删 / 非课程成员 / 别的教师：一律 404", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const resolve = (lectureId: string) =>
      captureError(() =>
        resolveAgentMemoAnchor(
          db,
          studentId,
          { kind: "lecture", lectureId },
          NOW,
        ),
      );

    const hidden = insertLecture(db, "隐藏的讲义");
    insertCourseWithLecture(db, studentId, hidden, { visible: false });
    expectHttpError(resolve(hidden), 404, "MEMO_ANCHOR_NOT_FOUND");

    const scheduled = insertLecture(db, "定时发布的讲义");
    insertCourseWithLecture(db, studentId, scheduled, {
      publishAt: "2026-12-01T00:00:00.000Z",
    });
    expectHttpError(resolve(scheduled), 404, "MEMO_ANCHOR_NOT_FOUND");
    // 到点即可见
    expect(
      resolveAgentMemoAnchor(
        db,
        studentId,
        { kind: "lecture", lectureId: scheduled },
        new Date("2026-12-01T00:00:00.000Z"),
      ),
    ).toMatchObject({ kind: "lecture", label: "定时发布的讲义" });

    const deleted = insertLecture(db, "已删除的讲义");
    insertCourseWithLecture(db, studentId, deleted);
    db.update(lectures)
      .set({ deletedAt: T0 })
      .where(eq(lectures.id, deleted))
      .run();
    expectHttpError(resolve(deleted), 404, "MEMO_ANCHOR_NOT_FOUND");

    const notMember = insertLecture(db, "别人课里的讲义");
    insertCourseWithLecture(db, studentId, notMember, { member: false });
    expectHttpError(resolve(notMember), 404, "MEMO_ANCHOR_NOT_FOUND");

    const otherTeacherId = randomUUID();
    db.insert(teachers)
      .values({
        id: otherTeacherId,
        loginName: `t-${otherTeacherId.slice(0, 8)}`,
        isAdmin: false,
        disabledAt: null,
        passwordHash: null,
        apiToken: null,
        createdAt: T0,
      })
      .run();
    const foreign = insertLecture(db, "别的教师的讲义", otherTeacherId);
    expectHttpError(resolve(foreign), 404, "MEMO_ANCHOR_NOT_FOUND");
  });
});

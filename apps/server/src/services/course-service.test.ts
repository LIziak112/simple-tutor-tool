import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import {
  assignments,
  attempts,
  courseItems,
  courseStudents,
  courses,
  lectures,
  questions,
  students,
  units,
} from "../db/schema.ts";
import { createTestDb } from "../db/test-utils.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  addCourseItems,
  addCourseMembers,
  appendCourseItems,
  courseHasAttempts,
  deleteCourseItem,
  getCourseDetail,
  listCoursesForTeacher,
  listVisibleItems,
  removeCourseMembers,
  reorderCourseItems,
  updateCourseItem,
} from "./course-service.ts";

/**
 * CourseService 服务层测试（T2A.1）：目录条目 CRUD/排序（含 409
 * DUPLICATE_COURSE_ITEM）、成员增删、listVisibleItems 的 D5 过滤。
 * T2A.4 追加：appendCourseItems（批量跳过 + D8 配套练习）、教师端列表/详情
 * （状态标签、可见条目数、hasAttempts）。
 */

const T0 = "2026-09-01T00:00:00.000Z";
const NOW = "2026-09-27T12:00:00.000Z";

/** 捕获同步异常（不匹配则失败） */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("期望抛出异常但没有");
}

/** fixture：课程 + 讲义×2（一活一删）+ 单元×2（一活一删）+ 学生×2（一活一归档） */
function seed(db: Db): {
  courseId: string;
  lectureId: string;
  deletedLectureId: string;
  unitId: string;
  deletedUnitId: string;
  emptyUnitId: string;
  studentId: string;
  archivedStudentId: string;
} {
  const courseId = crypto.randomUUID();
  db.insert(courses)
    .values({ id: courseId, title: "初一上", order: 0, createdAt: T0 })
    .run();
  const lectureId = crypto.randomUUID();
  const deletedLectureId = crypto.randomUUID();
  db.insert(lectures)
    .values([
      {
        id: lectureId,
        courseId: null,
        folderId: null,
        title: "第一讲",
        markdown: "# 一",
        order: 0,
        updatedAt: T0,
        deletedAt: null,
      },
      {
        id: deletedLectureId,
        courseId: null,
        folderId: null,
        title: "已删讲",
        markdown: "# 二",
        order: 1,
        updatedAt: T0,
        deletedAt: T0,
      },
    ])
    .run();
  const unitId = "u-live";
  const deletedUnitId = "u-deleted";
  const emptyUnitId = "u-empty";
  db.insert(units)
    .values([
      {
        id: unitId,
        courseId: null,
        folderId: null,
        lectureId: lectureId,
        title: "有题单元",
        order: 0,
        updatedAt: T0,
        deletedAt: null,
      },
      {
        id: deletedUnitId,
        courseId: null,
        folderId: null,
        lectureId: null,
        title: "已删单元",
        order: 1,
        updatedAt: T0,
        deletedAt: T0,
      },
      {
        id: emptyUnitId,
        courseId: null,
        folderId: null,
        lectureId: null,
        title: "空单元",
        order: 2,
        updatedAt: T0,
        deletedAt: null,
      },
    ])
    .run();
  // u-live 一道未删题 + 一道已删题（净存活 1）；u-empty 只有已删题（净存活 0）
  db.insert(questions)
    .values([
      {
        id: "q1",
        unitId,
        order: 0,
        type: "judge",
        difficulty: 1,
        stemMd: "s",
        hintsJson: "[]",
        sourceMd: "x",
        version: 1,
        updatedAt: T0,
        deletedAt: null,
      },
      {
        id: "q2",
        unitId,
        order: 1,
        type: "judge",
        difficulty: 1,
        stemMd: "s",
        hintsJson: "[]",
        sourceMd: "x",
        version: 1,
        updatedAt: T0,
        deletedAt: T0,
      },
      {
        id: "q3",
        unitId: emptyUnitId,
        order: 0,
        type: "judge",
        difficulty: 1,
        stemMd: "s",
        hintsJson: "[]",
        sourceMd: "x",
        version: 1,
        updatedAt: T0,
        deletedAt: T0,
      },
    ])
    .run();
  const studentId = crypto.randomUUID();
  const archivedStudentId = crypto.randomUUID();
  db.insert(students)
    .values([
      {
        id: studentId,
        displayName: "张三",
        loginName: "张三",
        linkToken: "tok-a",
        linkEnabled: true,
        passwordEnabled: false,
        archivedAt: null,
        createdAt: T0,
      },
      {
        id: archivedStudentId,
        displayName: "李四",
        loginName: "李四",
        linkToken: "tok-b",
        linkEnabled: true,
        passwordEnabled: false,
        archivedAt: T0,
        createdAt: T0,
      },
    ])
    .run();
  return {
    courseId,
    lectureId,
    deletedLectureId,
    unitId,
    deletedUnitId,
    emptyUnitId,
    studentId,
    archivedStudentId,
  };
}

describe("CourseService：目录条目 CRUD（D6）", () => {
  it("添加讲义/单元/分节：默认 visible=true、order 追加；section 标题落库", () => {
    const db = createTestDb();
    const { courseId, lectureId, unitId } = seed(db);
    const inserted = addCourseItems(db, courseId, [
      { kind: "lecture", refId: lectureId },
      { kind: "unit", refId: unitId },
      { kind: "section", title: "  第一章  " },
    ]);
    expect(
      inserted.map((row) => [row.kind, row.refId, row.order, row.visible]),
    ).toEqual([
      ["lecture", lectureId, 0, true],
      ["unit", unitId, 1, true],
      ["section", null, 2, true],
    ]);
    expect(inserted[2]?.title).toBe("第一章");
  });

  it("同一资源重复加入同一课程 → 409 DUPLICATE_COURSE_ITEM（验收项）", () => {
    const db = createTestDb();
    const { courseId, unitId } = seed(db);
    addCourseItems(db, courseId, [{ kind: "unit", refId: unitId }]);
    const err = captureError(() =>
      addCourseItems(db, courseId, [{ kind: "unit", refId: unitId }]),
    );
    expect(err).toBeInstanceOf(HttpError);
    const httpErr = err as HttpError;
    expect(httpErr.status).toBe(409);
    expect(httpErr.code).toBe("DUPLICATE_COURSE_ITEM");

    // 同一批次内重复同样 409
    const batchDup = captureError(() =>
      addCourseItems(db, courseId, [
        { kind: "lecture", refId: "l-x" },
        { kind: "lecture", refId: "l-x" },
      ]),
    );
    expect((batchDup as HttpError).code).toBe("DUPLICATE_COURSE_ITEM");
  });

  it("资源不存在或已软删 → 404；输入形状不符 → 422；课程不存在 → 404", () => {
    const db = createTestDb();
    const { courseId, deletedLectureId, deletedUnitId } = seed(db);

    expect(
      (
        captureError(() =>
          addCourseItems(db, courseId, [{ kind: "unit", refId: "ghost-u" }]),
        ) as HttpError
      ).code,
    ).toBe("UNIT_NOT_FOUND");
    expect(
      (
        captureError(() =>
          addCourseItems(db, courseId, [
            { kind: "lecture", refId: deletedLectureId },
          ]),
        ) as HttpError
      ).code,
    ).toBe("LECTURE_NOT_FOUND");
    expect(
      (
        captureError(() =>
          addCourseItems(db, courseId, [
            { kind: "unit", refId: deletedUnitId },
          ]),
        ) as HttpError
      ).code,
    ).toBe("UNIT_NOT_FOUND");

    expect(
      (
        captureError(() =>
          addCourseItems(db, courseId, [
            { kind: "section", title: "分节", refId: "x" },
          ]),
        ) as HttpError
      ).status,
    ).toBe(422);
    expect(
      (
        captureError(() =>
          addCourseItems(db, courseId, [{ kind: "section" }]),
        ) as HttpError
      ).status,
    ).toBe(422);
    expect(
      (
        captureError(() =>
          addCourseItems(db, courseId, [{ kind: "lecture" }]),
        ) as HttpError
      ).status,
    ).toBe(422);
    expect(
      (
        captureError(() =>
          addCourseItems(db, courseId, [
            { kind: "lecture", refId: "l", title: "t" },
          ]),
        ) as HttpError
      ).status,
    ).toBe(422);
    expect(
      (
        captureError(() =>
          addCourseItems(db, "no-such-course", [
            { kind: "section", title: "s" },
          ]),
        ) as HttpError
      ).code,
    ).toBe("COURSE_NOT_FOUND");
  });

  it("updateCourseItem：visible/publishAt/title；非分节改 title 422；不存在 404", () => {
    const db = createTestDb();
    const { courseId, lectureId } = seed(db);
    const [sectionRow] = addCourseItems(db, courseId, [
      { kind: "section", title: "旧标题" },
    ]);
    const [lectureItemRow] = addCourseItems(db, courseId, [
      { kind: "lecture", refId: lectureId },
    ]);
    if (sectionRow === undefined || lectureItemRow === undefined) {
      throw new Error("条目插入失败");
    }
    const section = sectionRow;
    const lectureItem = lectureItemRow;

    expect(updateCourseItem(db, section.id, { title: "新标题" }).title).toBe(
      "新标题",
    );
    const updated = updateCourseItem(db, lectureItem.id, {
      visible: false,
      publishAt: "2026-10-01T00:00:00.000Z",
    });
    expect(updated.visible).toBe(false);
    expect(updated.publishAt).toBe("2026-10-01T00:00:00.000Z");
    // 显式 null 取消定时
    expect(
      updateCourseItem(db, lectureItem.id, { publishAt: null }).publishAt,
    ).toBeNull();

    expect(
      (
        captureError(() =>
          updateCourseItem(db, lectureItem.id, { title: "x" }),
        ) as HttpError
      ).status,
    ).toBe(422);
    expect(
      (
        captureError(() =>
          updateCourseItem(db, "ghost", { visible: true }),
        ) as HttpError
      ).code,
    ).toBe("COURSE_ITEM_NOT_FOUND");
  });

  it("deleteCourseItem 移除条目（资源不动）；不存在 404", () => {
    const db = createTestDb();
    const { courseId, unitId } = seed(db);
    const [itemRow] = addCourseItems(db, courseId, [
      { kind: "unit", refId: unitId },
    ]);
    if (itemRow === undefined) throw new Error("条目插入失败");
    const item = itemRow;
    deleteCourseItem(db, item.id);
    expect(db.select().from(courseItems).all()).toEqual([]);
    expect(
      db.select().from(units).where(eq(units.id, unitId)).get(),
    ).toBeDefined();
    expect(
      (captureError(() => deleteCourseItem(db, item.id)) as HttpError).code,
    ).toBe("COURSE_ITEM_NOT_FOUND");
  });

  it("reorderCourseItems：完整顺序重写持久化；缺/多 id 404", () => {
    const db = createTestDb();
    const { courseId, lectureId, unitId } = seed(db);
    const rows = addCourseItems(db, courseId, [
      { kind: "lecture", refId: lectureId },
      { kind: "unit", refId: unitId },
      { kind: "section", title: "分节" },
    ]);
    const l = rows[0];
    const u = rows[1];
    const s = rows[2];
    if (l === undefined || u === undefined || s === undefined) {
      throw new Error("条目插入失败");
    }
    reorderCourseItems(db, courseId, [s.id, u.id, l.id]);
    const after = db
      .select()
      .from(courseItems)
      .orderBy(asc(courseItems.order))
      .all();
    expect(after.map((row) => row.kind)).toEqual([
      "section",
      "unit",
      "lecture",
    ]);

    expect(
      (
        captureError(() =>
          reorderCourseItems(db, courseId, [s.id, u.id]),
        ) as HttpError
      ).code,
    ).toBe("COURSE_ITEM_NOT_FOUND");
    expect(
      (
        captureError(() =>
          reorderCourseItems(db, courseId, [s.id, u.id, l.id, "ghost"]),
        ) as HttpError
      ).code,
    ).toBe("COURSE_ITEM_NOT_FOUND");
    expect(
      (
        captureError(() =>
          reorderCourseItems(db, "ghost-course", []),
        ) as HttpError
      ).code,
    ).toBe("COURSE_NOT_FOUND");
  });
});

describe("CourseService：课程成员（D7）", () => {
  it("添加/移出成员；重复添加幂等；学生不存在 404", () => {
    const db = createTestDb();
    const { courseId, studentId, archivedStudentId } = seed(db);
    addCourseMembers(db, courseId, [studentId, archivedStudentId]);
    addCourseMembers(db, courseId, [studentId]); // 幂等
    const memberRows = db
      .select()
      .from(courseStudents)
      .where(eq(courseStudents.courseId, courseId))
      .all();
    expect(memberRows.map((row) => row.studentId).sort()).toEqual(
      [studentId, archivedStudentId].sort(),
    );

    removeCourseMembers(db, courseId, [studentId]);
    removeCourseMembers(db, courseId, [studentId]); // 幂等
    expect(
      db
        .select()
        .from(courseStudents)
        .where(eq(courseStudents.courseId, courseId))
        .all()
        .map((row) => row.studentId),
    ).toEqual([archivedStudentId]);

    expect(
      (
        captureError(() =>
          addCourseMembers(db, courseId, ["ghost-s"]),
        ) as HttpError
      ).code,
    ).toBe("STUDENT_NOT_FOUND");
    expect(
      (
        captureError(() =>
          addCourseMembers(db, "ghost-course", []),
        ) as HttpError
      ).code,
    ).toBe("COURSE_NOT_FOUND");
    expect(
      (
        captureError(() =>
          removeCourseMembers(db, "ghost-course", []),
        ) as HttpError
      ).code,
    ).toBe("COURSE_NOT_FOUND");
  });
});

describe("CourseService：listVisibleItems（D5 过滤）", () => {
  it("成员视角：可见讲义/分节可见，隐藏单元、空题单元、软删资源、未到点条目被过滤", () => {
    const db = createTestDb();
    const ctx = seed(db);
    const { courseId } = ctx;
    // 第二篇讲义：用于「定时发布未到点」条目（同一资源在同课程只能出现一次）
    const timedLectureId = crypto.randomUUID();
    db.insert(lectures)
      .values({
        id: timedLectureId,
        courseId: null,
        folderId: null,
        title: "定时讲",
        markdown: "# 定时",
        order: 3,
        updatedAt: T0,
      })
      .run();
    db.insert(courseItems)
      .values([
        {
          id: crypto.randomUUID(),
          courseId,
          kind: "lecture",
          refId: ctx.lectureId,
          title: null,
          order: 0,
          visible: true,
          publishAt: null,
          createdAt: T0,
        },
        {
          id: crypto.randomUUID(),
          courseId,
          kind: "unit",
          refId: ctx.unitId,
          title: null,
          order: 1,
          visible: true,
          publishAt: null,
          createdAt: T0,
        },
        {
          id: crypto.randomUUID(),
          courseId,
          kind: "unit",
          refId: ctx.emptyUnitId,
          title: null,
          order: 2,
          visible: true,
          publishAt: null,
          createdAt: T0,
        },
        {
          id: crypto.randomUUID(),
          courseId,
          kind: "unit",
          refId: ctx.deletedUnitId,
          title: null,
          order: 3,
          visible: true,
          publishAt: null,
          createdAt: T0,
        },
        {
          id: crypto.randomUUID(),
          courseId,
          kind: "lecture",
          refId: ctx.deletedLectureId,
          title: null,
          order: 4,
          visible: true,
          publishAt: null,
          createdAt: T0,
        },
        {
          id: crypto.randomUUID(),
          courseId,
          kind: "section",
          refId: null,
          title: "第一章",
          order: 5,
          visible: true,
          publishAt: null,
          createdAt: T0,
        },
        {
          id: crypto.randomUUID(),
          courseId,
          kind: "lecture",
          refId: timedLectureId,
          title: null,
          order: 6,
          visible: true,
          publishAt: "2099-01-01T00:00:00.000Z",
          createdAt: T0,
        },
      ])
      .run();
    // 隐藏单元条目（与上面 order 1 同 refId 冲突——单独课程再放一个隐藏单元来覆盖该条件）
    const course2 = crypto.randomUUID();
    db.insert(courses)
      .values({ id: course2, title: "初一下", order: 1, createdAt: T0 })
      .run();
    db.insert(courseItems)
      .values([
        {
          id: crypto.randomUUID(),
          courseId: course2,
          kind: "unit",
          refId: ctx.unitId,
          title: null,
          order: 0,
          visible: false,
          publishAt: null,
          createdAt: T0,
        },
      ])
      .run();

    addCourseMembers(db, courseId, [ctx.studentId]);
    addCourseMembers(db, course2, [ctx.studentId]);

    // 课程 1：可见 = 第一讲(0)、有题单元(1)、分节(5)；空题/软删/未到点被滤
    expect(
      listVisibleItems(db, ctx.studentId, courseId, NOW).map((item) => [
        item.title,
        item.order,
      ]),
    ).toEqual([
      ["第一讲", 0],
      ["有题单元", 1],
      ["第一章", 5],
    ]);
    // 课程 2：唯一单元条目隐藏 → 空
    expect(listVisibleItems(db, ctx.studentId, course2, NOW)).toEqual([]);
  });

  it("非成员 / 学生归档 / 课程归档 → 空数组；到点后（注入时钟）变可见", () => {
    const db = createTestDb();
    const ctx = seed(db);
    const future = "2026-12-01T00:00:00.000Z";
    db.insert(courseItems)
      .values({
        id: crypto.randomUUID(),
        courseId: ctx.courseId,
        kind: "lecture",
        refId: ctx.lectureId,
        title: null,
        order: 0,
        visible: true,
        publishAt: future,
        createdAt: T0,
      })
      .run();
    addCourseMembers(db, ctx.courseId, [ctx.studentId]);

    // 未到点 → 不可见；到点（注入未来时钟）→ 可见
    expect(listVisibleItems(db, ctx.studentId, ctx.courseId, NOW)).toEqual([]);
    expect(
      listVisibleItems(
        db,
        ctx.studentId,
        ctx.courseId,
        "2026-12-01T00:00:00.000Z",
      ).map((item) => item.title),
    ).toEqual(["第一讲"]);

    // 移出成员 → 空
    removeCourseMembers(db, ctx.courseId, [ctx.studentId]);
    expect(
      listVisibleItems(
        db,
        ctx.studentId,
        ctx.courseId,
        "2026-12-01T00:00:00.000Z",
      ),
    ).toEqual([]);

    // 归档学生 → 空（即便重新入课）
    db.update(students)
      .set({ archivedAt: T0 })
      .where(eq(students.id, ctx.studentId))
      .run();
    addCourseMembers(db, ctx.courseId, [ctx.studentId]);
    expect(
      listVisibleItems(
        db,
        ctx.studentId,
        ctx.courseId,
        "2026-12-01T00:00:00.000Z",
      ),
    ).toEqual([]);

    // 课程归档 → 空
    db.update(students)
      .set({ archivedAt: null })
      .where(eq(students.id, ctx.studentId))
      .run();
    db.update(courses)
      .set({ archivedAt: T0 })
      .where(eq(courses.id, ctx.courseId))
      .run();
    expect(
      listVisibleItems(
        db,
        ctx.studentId,
        ctx.courseId,
        "2026-12-01T00:00:00.000Z",
      ),
    ).toEqual([]);
  });
});

describe("CourseService：appendCourseItems（T2A.4 批量口径 + D8）", () => {
  it("withCompanionUnits：配套单元紧跟讲义之后、companion 标记 true（验收项）", () => {
    const db = createTestDb();
    const { courseId, lectureId, unitId } = seed(db);
    // seed 中 u-live 的配套讲义就是 lectureId（units.lectureId）
    const result = appendCourseItems(
      db,
      courseId,
      [{ kind: "lecture", refId: lectureId }],
      { withCompanionUnits: true },
    );
    expect(result.skipped).toEqual([]);
    expect(
      result.added.map((item) => [item.kind, item.refId, item.companion]),
    ).toEqual([
      ["lecture", lectureId, false],
      ["unit", unitId, true],
    ]);
    // 顺序：讲义在前、配套单元紧随（order 连续递增）
    expect(result.added.map((item) => item.order)).toEqual([0, 1]);
  });

  it("已在课程的资源跳过并返回清单；被跳过的讲义不展开配套", () => {
    const db = createTestDb();
    const { courseId, lectureId, unitId } = seed(db);
    // 先单独加入讲义（不带配套）
    appendCourseItems(db, courseId, [{ kind: "lecture", refId: lectureId }]);
    const result = appendCourseItems(
      db,
      courseId,
      [{ kind: "lecture", refId: lectureId }],
      { withCompanionUnits: true },
    );
    expect(result.added).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe("已在本课程");
    // 配套单元未因讲义被跳过而自动加入
    expect(
      db
        .select({ id: courseItems.id })
        .from(courseItems)
        .where(eq(courseItems.refId, unitId))
        .all(),
    ).toEqual([]);

    // 配套单元已在课程：再讲一遍（先删讲义条目重加）→ 配套跳过、清单有据
    db.delete(courseItems).where(eq(courseItems.courseId, courseId)).run();
    addCourseItems(db, courseId, [{ kind: "unit", refId: unitId }]);
    const second = appendCourseItems(
      db,
      courseId,
      [{ kind: "lecture", refId: lectureId }],
      { withCompanionUnits: true },
    );
    expect(second.added.map((item) => item.kind)).toEqual(["lecture"]);
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0]?.kind).toBe("unit");
    expect(second.skipped[0]?.reason).toBe("已在本课程");
  });

  it("visible=false 对整批生效；已软删的配套单元不进入（D8 只带未删单元）", () => {
    const db = createTestDb();
    const { courseId, lectureId, deletedUnitId } = seed(db);
    // 把已删单元也指向该讲义，验证软删配套不自动带入
    db.update(units)
      .set({ lectureId })
      .where(eq(units.id, deletedUnitId))
      .run();
    const result = appendCourseItems(
      db,
      courseId,
      [{ kind: "lecture", refId: lectureId }],
      { visible: false, withCompanionUnits: true },
    );
    expect(result.added.every((item) => item.visible === false)).toBe(true);
    expect(result.added.map((item) => item.refId)).not.toContain(deletedUnitId);
  });
});

describe("CourseService：教师端列表 / 详情 / hasAttempts（T2A.4）", () => {
  it("courseHasAttempts：条目引用单元有作答 → true（D4 现状口径）", () => {
    const db = createTestDb();
    const { courseId, lectureId, unitId, studentId } = seed(db);
    addCourseItems(db, courseId, [
      { kind: "lecture", refId: lectureId },
      { kind: "unit", refId: unitId },
    ]);
    expect(courseHasAttempts(db, courseId)).toBe(false);

    const assignmentId = crypto.randomUUID();
    db.insert(assignments)
      .values({
        id: assignmentId,
        unitId,
        title: "作业",
        createdAt: T0,
      })
      .run();
    db.insert(attempts)
      .values({
        id: crypto.randomUUID(),
        studentId,
        assignmentId,
        unitId,
        status: "draft",
        startedAt: T0,
      })
      .run();
    expect(courseHasAttempts(db, courseId)).toBe(true);
  });

  it("getCourseDetail：状态标签优先级（删除 > 无题目 > 隐藏 > 定时 > 可见）", () => {
    const db = createTestDb();
    const { courseId, lectureId, unitId, emptyUnitId, studentId } = seed(db);
    // 追加一个「加入后才被软删」的单元（D3：课程页该条目显示「已删除」标记）
    const laterDeletedUnitId = "u-later-deleted";
    db.insert(units)
      .values({
        id: laterDeletedUnitId,
        courseId: null,
        folderId: null,
        lectureId: null,
        title: "后删单元",
        order: 3,
        updatedAt: T0,
        deletedAt: null,
      })
      .run();
    addCourseMembers(db, courseId, [studentId]);
    const inserted = addCourseItems(db, courseId, [
      { kind: "section", title: "第一周" },
      { kind: "lecture", refId: lectureId },
      { kind: "unit", refId: unitId },
      { kind: "unit", refId: emptyUnitId },
      { kind: "unit", refId: laterDeletedUnitId },
    ]);
    updateCourseItem(db, inserted[1]?.id as string, {
      publishAt: "2027-01-01T00:00:00.000Z",
    });
    updateCourseItem(db, inserted[2]?.id as string, { visible: false });
    db.update(units)
      .set({ deletedAt: T0 })
      .where(eq(units.id, laterDeletedUnitId))
      .run();
    const detail = getCourseDetail(db, courseId, new Date(NOW));
    expect(detail.items.map((item) => [item.kind, item.status])).toEqual([
      ["section", "visible"],
      ["lecture", "scheduled"],
      ["unit", "hidden"],
      ["unit", "no-questions"],
      ["unit", "deleted"],
    ]);
    expect(detail.items[2]?.questionCount).toBe(1);
    expect(detail.members[0]?.displayName).toBe("张三");
  });

  it("listCoursesForTeacher：计数与归档筛选；visibleItemCount 不计隐藏与已删资源", () => {
    const db = createTestDb();
    const { courseId, lectureId, unitId, studentId } = seed(db);
    addCourseMembers(db, courseId, [studentId]);
    const inserted = addCourseItems(db, courseId, [
      { kind: "lecture", refId: lectureId },
      { kind: "unit", refId: unitId },
      { kind: "section", title: "第一周" },
    ]);
    updateCourseItem(db, inserted[1]?.id as string, { visible: false });
    const summary = listCoursesForTeacher(db, { archived: false }).find(
      (row) => row.id === courseId,
    );
    expect(summary?.memberCount).toBe(1);
    expect(summary?.memberIds).toEqual([studentId]);
    expect(summary?.itemCount).toBe(3);
    // 讲义 + 分节可见；单元隐藏不计
    expect(summary?.visibleItemCount).toBe(2);
    expect(summary?.hasAttempts).toBe(false);

    db.update(courses)
      .set({ archivedAt: T0 })
      .where(eq(courses.id, courseId))
      .run();
    expect(
      listCoursesForTeacher(db, { archived: false }).find(
        (row) => row.id === courseId,
      ),
    ).toBeUndefined();
    expect(
      listCoursesForTeacher(db, { archived: true }).find(
        (row) => row.id === courseId,
      )?.archived,
    ).toBe(true);
  });
});

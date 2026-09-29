import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import {
  courseItems,
  courseStudents,
  courses,
  lectures,
  questions,
  students,
  units,
} from "../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  getStudentCourseDetail,
  getStudentLecture,
  listStudentCourses,
  listStudentLectures,
} from "./student-course-service.ts";

/**
 * StudentCourseService 服务层测试（T2A.5）：D5 切换后的学生端读路径——
 * 我的课程计数、课程可见目录（D22 错误矩阵）、可见讲义双视图（去重 + 分组）、
 * 讲义详情（?courseId 上下文 + D8 配套练习）、publishAt 可注入时钟边界。
 * canStudentSeeItem 纯函数本身的条件组合在 visibility.test.ts（T2A.1）。
 */

const T0 = "2026-09-01T00:00:00.000Z";
/**
 * 固定时钟（publishAt 边界测试用）：L2 定时 2099-01-01 发布——远未来保证
 * 其余用默认真实时钟的断言（L2 不可见）在任何真实时间运行都确定。
 */
const LECTURE_FUTURE_PUBLISH_AT = "2099-01-01T00:00:00.000Z";
const BEFORE_PUBLISH = "2098-12-31T23:59:59.999Z";
const AT_PUBLISH = LECTURE_FUTURE_PUBLISH_AT;

/** 捕获同步异常（不匹配则失败） */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("期望抛出异常但没有");
}

/** 断言 HttpError 的 status 与 code */
function expectHttpError(err: unknown, status: number, code: string): void {
  expect(err).toBeInstanceOf(HttpError);
  const httpErr = err as HttpError;
  expect(httpErr.status).toBe(status);
  expect(httpErr.code).toBe(code);
}

/** 插入一个课程目录条目（返回 id） */
function insertItem(
  db: Db,
  courseId: string,
  item: {
    kind: "section" | "lecture" | "unit";
    refId?: string | null;
    title?: string | null;
    order: number;
    visible: boolean;
    publishAt?: string | null;
  },
): string {
  const id = crypto.randomUUID();
  db.insert(courseItems)
    .values({
      id,
      courseId,
      kind: item.kind,
      refId: item.kind === "section" ? null : (item.refId ?? null),
      title: item.kind === "section" ? (item.title ?? "") : null,
      order: item.order,
      visible: item.visible,
      publishAt: item.publishAt ?? null,
      createdAt: T0,
    })
    .run();
  return id;
}

/**
 * fixture：两门课（初一上 order0 / 初一下 order1）+ 一门已归档课；
 * 讲义 L1（两课都可见引用）、L2（定时未来发布）；单元 U1（可见，配套 L1，
 * topic 正数与负数，2 道未删题）、U2（隐藏，配套 L1，topic 隐藏主题）；
 * 成员学生 + 非成员学生 + 已归档学生。
 */
function seed(db: Db): {
  courseAId: string;
  courseBId: string;
  archivedCourseId: string;
  lectureL1Id: string;
  lectureL2Id: string;
  unitU1Id: string;
  unitU2Id: string;
  memberId: string;
  outsiderId: string;
  archivedStudentId: string;
} {
  const courseAId = crypto.randomUUID();
  const courseBId = crypto.randomUUID();
  const archivedCourseId = crypto.randomUUID();
  db.insert(courses)
    .values([
      {
        id: courseAId,
        teacherId: TEST_TEACHER_ID,
        title: "初一上",
        order: 0,
        description: "有理数与数轴",
        archivedAt: null,
        createdAt: T0,
      },
      {
        id: courseBId,
        teacherId: TEST_TEACHER_ID,
        title: "初一下",
        order: 1,
        archivedAt: null,
        createdAt: T0,
      },
      {
        id: archivedCourseId,
        teacherId: TEST_TEACHER_ID,
        title: "已归档课",
        order: 2,
        archivedAt: T0,
        createdAt: T0,
      },
    ])
    .run();

  const lectureL1Id = crypto.randomUUID();
  const lectureL2Id = crypto.randomUUID();
  db.insert(lectures)
    .values([
      {
        id: lectureL1Id,
        teacherId: TEST_TEACHER_ID,
        courseId: null,
        folderId: null,
        title: "第1讲 有理数",
        markdown: "# 第1讲 有理数\n\n正文",
        order: 0,
        updatedAt: T0,
        deletedAt: null,
      },
      {
        id: lectureL2Id,
        teacherId: TEST_TEACHER_ID,
        courseId: null,
        folderId: null,
        title: "第2讲 数轴",
        markdown: "# 第2讲 数轴\n\n正文",
        order: 1,
        updatedAt: T0,
        deletedAt: null,
      },
    ])
    .run();

  const unitU1Id = "u-companion-live";
  const unitU2Id = "u-companion-hidden";
  db.insert(units)
    .values([
      {
        id: unitU1Id,
        teacherId: TEST_TEACHER_ID,
        courseId: null,
        folderId: null,
        lectureId: lectureL1Id,
        title: "有理数小练",
        topic: "正数与负数",
        order: 0,
        updatedAt: T0,
        deletedAt: null,
      },
      {
        id: unitU2Id,
        teacherId: TEST_TEACHER_ID,
        courseId: null,
        folderId: null,
        lectureId: lectureL1Id,
        title: "隐藏小练",
        topic: "隐藏主题",
        order: 1,
        updatedAt: T0,
        deletedAt: null,
      },
    ])
    .run();
  db.insert(questions)
    .values([
      {
        id: "sc-q1",
        teacherId: TEST_TEACHER_ID,
        unitId: unitU1Id,
        order: 0,
        type: "judge",
        difficulty: 1,
        stemMd: "题干",
        hintsJson: "[]",
        sourceMd: "原文",
        version: 1,
        updatedAt: T0,
        deletedAt: null,
      },
      {
        id: "sc-q2",
        teacherId: TEST_TEACHER_ID,
        unitId: unitU1Id,
        order: 1,
        type: "judge",
        difficulty: 1,
        stemMd: "题干",
        hintsJson: "[]",
        sourceMd: "原文",
        version: 1,
        updatedAt: T0,
        deletedAt: null,
      },
      {
        id: "sc-q3",
        teacherId: TEST_TEACHER_ID,
        unitId: unitU1Id,
        order: 2,
        type: "judge",
        difficulty: 1,
        stemMd: "题干",
        hintsJson: "[]",
        sourceMd: "原文",
        version: 1,
        updatedAt: T0,
        deletedAt: T0, // 已删题不计入题数
      },
      {
        // U2 的存活题（D5 条件 4：单元至少 1 道未删题才可见——初一下的可见配套）
        id: "sc-q4",
        teacherId: TEST_TEACHER_ID,
        unitId: unitU2Id,
        order: 0,
        type: "judge",
        difficulty: 1,
        stemMd: "题干",
        hintsJson: "[]",
        sourceMd: "原文",
        version: 1,
        updatedAt: T0,
        deletedAt: null,
      },
    ])
    .run();

  // 初一上目录：分节 + L1 + U1（可见）+ U2（隐藏）+ L2（定时未来发布）
  insertItem(db, courseAId, {
    kind: "section",
    title: "第一章 有理数",
    order: 0,
    visible: true,
  });
  insertItem(db, courseAId, {
    kind: "lecture",
    refId: lectureL1Id,
    order: 1,
    visible: true,
  });
  insertItem(db, courseAId, {
    kind: "unit",
    refId: unitU1Id,
    order: 2,
    visible: true,
  });
  insertItem(db, courseAId, {
    kind: "unit",
    refId: unitU2Id,
    order: 3,
    visible: false,
  });
  insertItem(db, courseAId, {
    kind: "lecture",
    refId: lectureL2Id,
    order: 4,
    visible: true,
    publishAt: LECTURE_FUTURE_PUBLISH_AT,
  });
  // 初一下目录：L1（可见；同一讲义两课出现）+ U2（可见——跨课程可见性独立）
  insertItem(db, courseBId, {
    kind: "lecture",
    refId: lectureL1Id,
    order: 0,
    visible: true,
  });
  insertItem(db, courseBId, {
    kind: "unit",
    refId: unitU2Id,
    order: 1,
    visible: true,
  });

  const memberId = crypto.randomUUID();
  const outsiderId = crypto.randomUUID();
  const archivedStudentId = crypto.randomUUID();
  db.insert(students)
    .values([
      {
        id: memberId,
        teacherId: TEST_TEACHER_ID,
        displayName: "成员小张",
        loginName: "成员小张",
        linkToken: "tok-member",
        linkEnabled: true,
        passwordEnabled: false,
        archivedAt: null,
        createdAt: T0,
      },
      {
        id: outsiderId,
        teacherId: TEST_TEACHER_ID,
        displayName: "非成员小王",
        loginName: "非成员小王",
        linkToken: "tok-outsider",
        linkEnabled: true,
        passwordEnabled: false,
        archivedAt: null,
        createdAt: T0,
      },
      {
        id: archivedStudentId,
        teacherId: TEST_TEACHER_ID,
        displayName: "归档小李",
        loginName: "归档小李",
        linkToken: "tok-archived",
        linkEnabled: true,
        passwordEnabled: false,
        archivedAt: T0,
        createdAt: T0,
      },
    ])
    .run();
  db.insert(courseStudents)
    .values([
      { courseId: courseAId, studentId: memberId, joinedAt: T0 },
      { courseId: courseBId, studentId: memberId, joinedAt: T0 },
      { courseId: archivedCourseId, studentId: memberId, joinedAt: T0 },
    ])
    .run();

  return {
    courseAId,
    courseBId,
    archivedCourseId,
    lectureL1Id,
    lectureL2Id,
    unitU1Id,
    unitU2Id,
    memberId,
    outsiderId,
    archivedStudentId,
  };
}

describe("listStudentCourses（我的课程）", () => {
  it("成员只看到未归档课程；可见计数不含隐藏条目；completedUnitCount 恒 0", () => {
    const db = createTestDb();
    const ctx = seed(db);
    const { courses: list } = listStudentCourses(db, ctx.memberId);
    // 已归档课（成员也是它）不出现在列表（零信息）
    expect(list.map((c) => c.name)).toEqual(["初一上", "初一下"]);
    const courseA = list[0];
    expect(courseA?.description).toBe("有理数与数轴");
    // 初一上：可见讲义 = L1（L2 未到发布）；可见单元 = U1（U2 隐藏）
    expect(courseA?.visibleLectureCount).toBe(1);
    expect(courseA?.visibleUnitCount).toBe(1);
    expect(courseA?.completedUnitCount).toBe(0); // T2A.6 前占位
    const courseB = list[1];
    expect(courseB?.visibleLectureCount).toBe(1);
    expect(courseB?.visibleUnitCount).toBe(1);
  });

  it("非成员与已归档学生：空列表", () => {
    const db = createTestDb();
    const ctx = seed(db);
    expect(listStudentCourses(db, ctx.outsiderId).courses).toEqual([]);
    expect(listStudentCourses(db, ctx.archivedStudentId).courses).toEqual([]);
  });
});

describe("getStudentCourseDetail（课程可见目录，D22 矩阵）", () => {
  it("成员：只含可见条目（隐藏/未到发布零信息），单元带未删题数", () => {
    const db = createTestDb();
    const ctx = seed(db);
    const detail = getStudentCourseDetail(db, ctx.memberId, ctx.courseAId);
    expect(detail.name).toBe("初一上");
    expect(
      detail.items.map((item) => [item.kind, item.title, item.questionCount]),
    ).toEqual([
      ["section", "第一章 有理数", null],
      ["lecture", "第1讲 有理数", null],
      ["unit", "有理数小练", 2], // 2 道未删题（第 3 道已删不计）
    ]);
    // 隐藏单元 U2 与未到发布的 L2 不出现（连计数都不体现）
    expect(detail.items.some((item) => item.title === "隐藏小练")).toBe(false);
    expect(detail.items.some((item) => item.title === "第2讲 数轴")).toBe(
      false,
    );
  });

  it("非成员 403 / 课程归档 403 / 课程不存在 404（D22）", () => {
    const db = createTestDb();
    const ctx = seed(db);
    expectHttpError(
      captureError(() =>
        getStudentCourseDetail(db, ctx.outsiderId, ctx.courseAId),
      ),
      403,
      "COURSE_ACCESS_DENIED",
    );
    expectHttpError(
      captureError(() =>
        getStudentCourseDetail(db, ctx.memberId, ctx.archivedCourseId),
      ),
      403,
      "COURSE_ACCESS_DENIED",
    );
    expectHttpError(
      captureError(() =>
        getStudentCourseDetail(db, ctx.memberId, crypto.randomUUID()),
      ),
      404,
      "NOT_FOUND",
    );
  });

  it("移出成员后立即 403（D7）", () => {
    const db = createTestDb();
    const ctx = seed(db);
    db.delete(courseStudents)
      .where(
        eq(courseStudents.courseId, ctx.courseAId) &&
          eq(courseStudents.studentId, ctx.memberId),
      )
      .run();
    expectHttpError(
      captureError(() =>
        getStudentCourseDetail(db, ctx.memberId, ctx.courseAId),
      ),
      403,
      "COURSE_ACCESS_DENIED",
    );
  });
});

describe("listStudentLectures（可见讲义双视图）", () => {
  it("同一讲义两门课：去重列表只出现一次，分组视图两组各自出现", () => {
    const db = createTestDb();
    const ctx = seed(db);
    const data = listStudentLectures(db, ctx.memberId);
    // 去重并集：只有 L1（L2 未到发布不可见）
    expect(data.lectures.map((l) => l.title)).toEqual(["第1讲 有理数"]);
    // 分组：两门课各一组，L1 都在（分组视图允许重复出现）
    expect(data.courses.map((group) => group.courseName)).toEqual([
      "初一上",
      "初一下",
    ]);
    expect(
      data.courses.map((group) =>
        group.lectures.map((lecture) => lecture.title),
      ),
    ).toEqual([["第1讲 有理数"], ["第1讲 有理数"]]);
  });

  it("topic 只由可见配套单元贡献（隐藏单元零信息）", () => {
    const db = createTestDb();
    const ctx = seed(db);
    const data = listStudentLectures(db, ctx.memberId);
    // U1 可见（topic 正数与负数）；U2 在初一上隐藏、在初一下可见但 order 靠后
    expect(data.lectures[0]?.topic).toBe("正数与负数");

    // 把 U1 条目改为隐藏：初一上只剩 U2 隐藏、初一下 U2 可见 → topic 变为「隐藏主题」
    db.update(courseItems)
      .set({ visible: false })
      .where(eq(courseItems.refId, ctx.unitU1Id))
      .run();
    const after = listStudentLectures(db, ctx.memberId);
    expect(after.lectures[0]?.topic).toBe("隐藏主题");

    // U1、U2 都不可见 → topic null（配套单元全被隐藏时不泄露主题）
    db.update(courseItems)
      .set({ visible: false })
      .where(eq(courseItems.refId, ctx.unitU2Id))
      .run();
    const none = listStudentLectures(db, ctx.memberId);
    expect(none.lectures[0]?.topic).toBeNull();
  });

  it("非成员：双视图全空；未入任何课程的讲义不出现在任何学生列表（不再有全量讲义）", () => {
    const db = createTestDb();
    const ctx = seed(db);
    const outsider = listStudentLectures(db, ctx.outsiderId);
    expect(outsider.lectures).toEqual([]);
    expect(outsider.courses).toEqual([]);

    // 资源库里的讲义若未被任何课程引用（或引用条目不可见），成员也看不到
    const orphanId = crypto.randomUUID();
    db.insert(lectures)
      .values({
        id: orphanId,
        teacherId: TEST_TEACHER_ID,
        courseId: null,
        folderId: null,
        title: "孤儿讲义",
        markdown: "# 孤儿",
        order: 9,
        updatedAt: T0,
        deletedAt: null,
      })
      .run();
    const member = listStudentLectures(db, ctx.memberId);
    expect(member.lectures.some((l) => l.title === "孤儿讲义")).toBe(false);
  });
});

describe("getStudentLecture（讲义详情 + D8 配套练习）", () => {
  it("缺省 courseId：取第一个可见该讲义的课程（course.order 优先）+ 同课程可见配套单元", () => {
    const db = createTestDb();
    const ctx = seed(db);
    const detail = getStudentLecture(db, ctx.memberId, ctx.lectureL1Id);
    expect(detail.courseId).toBe(ctx.courseAId); // 初一上 order 0
    expect(detail.courseName).toBe("初一上");
    expect(detail.markdown).toContain("# 第1讲 有理数");
    // D8：只含初一上目录中可见、且 lectureId=L1 的单元（U1；U2 在 A 隐藏）
    expect(detail.companionUnits).toEqual([
      { id: ctx.unitU1Id, title: "有理数小练", questionCount: 2 },
    ]);
  });

  it("指定 courseId：换课程上下文，配套练习按该课程可见性计算", () => {
    const db = createTestDb();
    const ctx = seed(db);
    const detail = getStudentLecture(
      db,
      ctx.memberId,
      ctx.lectureL1Id,
      ctx.courseBId,
    );
    expect(detail.courseId).toBe(ctx.courseBId);
    expect(detail.courseName).toBe("初一下");
    // 初一下：U2 可见且配套 L1 → 配套 = U2（1 道未删题）
    expect(detail.companionUnits).toEqual([
      { id: ctx.unitU2Id, title: "隐藏小练", questionCount: 1 },
    ]);
  });

  it("非成员指定课程 403；课程不存在 404；无任何可见课程 404（D22）", () => {
    const db = createTestDb();
    const ctx = seed(db);
    expectHttpError(
      captureError(() =>
        getStudentLecture(db, ctx.outsiderId, ctx.lectureL1Id, ctx.courseAId),
      ),
      403,
      "COURSE_ACCESS_DENIED",
    );
    expectHttpError(
      captureError(() =>
        getStudentLecture(
          db,
          ctx.memberId,
          ctx.lectureL1Id,
          crypto.randomUUID(),
        ),
      ),
      404,
      "NOT_FOUND",
    );
    expectHttpError(
      captureError(() =>
        getStudentLecture(db, ctx.outsiderId, ctx.lectureL1Id),
      ),
      404,
      "NOT_FOUND",
    );
  });

  it("publishAt 可注入时钟：未到点 404、到点即刻 200（验收项）", () => {
    const db = createTestDb();
    const ctx = seed(db);
    // L2 定时 12:00:00Z 发布：11:59:59.999 不可见（404，不暴露存在性）
    expectHttpError(
      captureError(() =>
        getStudentLecture(
          db,
          ctx.memberId,
          ctx.lectureL2Id,
          ctx.courseAId,
          BEFORE_PUBLISH,
        ),
      ),
      404,
      "NOT_FOUND",
    );
    // 恰好到点 → 可见（「≤ 现在」含等于）
    const detail = getStudentLecture(
      db,
      ctx.memberId,
      ctx.lectureL2Id,
      ctx.courseAId,
      AT_PUBLISH,
    );
    expect(detail.title).toBe("第2讲 数轴");
    // 课程目录与列表同步生效
    const detailAt = getStudentCourseDetail(
      db,
      ctx.memberId,
      ctx.courseAId,
      AT_PUBLISH,
    );
    expect(detailAt.items.some((item) => item.title === "第2讲 数轴")).toBe(
      true,
    );
    const listBefore = listStudentLectures(db, ctx.memberId, BEFORE_PUBLISH);
    expect(listBefore.lectures.some((l) => l.title === "第2讲 数轴")).toBe(
      false,
    );
  });

  it("隐藏条目 404（visible=false，不暴露存在性）与资源软删 404（D22）", () => {
    const db = createTestDb();
    const ctx = seed(db);
    // 隐藏的 L2 之外再藏掉 L1
    db.update(courseItems)
      .set({ visible: false })
      .where(eq(courseItems.refId, ctx.lectureL1Id))
      .run();
    expectHttpError(
      captureError(() =>
        getStudentLecture(db, ctx.memberId, ctx.lectureL1Id, ctx.courseAId),
      ),
      404,
      "NOT_FOUND",
    );
    expectHttpError(
      captureError(() => getStudentLecture(db, ctx.memberId, ctx.lectureL1Id)),
      404,
      "NOT_FOUND",
    );

    // 软删资源：条目 visible 恢复也 404（D5 条件 4）
    db.update(courseItems)
      .set({ visible: true })
      .where(eq(courseItems.refId, ctx.lectureL1Id))
      .run();
    db.update(lectures)
      .set({ deletedAt: T0 })
      .where(eq(lectures.id, ctx.lectureL1Id))
      .run();
    expectHttpError(
      captureError(() =>
        getStudentLecture(db, ctx.memberId, ctx.lectureL1Id, ctx.courseAId),
      ),
      404,
      "NOT_FOUND",
    );
  });

  it("移出成员后：讲义详情立即 404（无其他可见课程时）", () => {
    const db = createTestDb();
    const ctx = seed(db);
    db.delete(courseStudents).run(); // 全部移出（course_students 无行）
    expectHttpError(
      captureError(() => getStudentLecture(db, ctx.memberId, ctx.lectureL1Id)),
      404,
      "NOT_FOUND",
    );
    // 指定原课程 → 403（D7：移出后立即不可访问）
    expectHttpError(
      captureError(() =>
        getStudentLecture(db, ctx.memberId, ctx.lectureL1Id, ctx.courseAId),
      ),
      403,
      "COURSE_ACCESS_DENIED",
    );
  });
});

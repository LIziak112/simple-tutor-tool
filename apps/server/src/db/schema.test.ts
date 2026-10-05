import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  assignmentStudents,
  assignments,
  assignmentUnits,
  attempts,
  courses,
  loginFailures,
  noteImages,
  notes,
  noteVersions,
  questions,
  responses,
  sessions,
  students,
  submissionEvidence,
  teachers,
  units,
} from "./schema";
import { createTestDb } from "./test-utils";

/** sqlite_master 行的最小形状（建表元数据查询用） */
interface TableNameRow {
  name: string;
}

/** 一条可直接落库的学生行（linkToken/loginName 均唯一） */
function studentRow(overrides: Partial<typeof students.$inferInsert> = {}) {
  return {
    id: randomUUID(),
    teacherId: null,
    displayName: "张三",
    loginName: "张三",
    passwordHash: null,
    linkToken: `link-${randomUUID()}`,
    linkEnabled: true,
    passwordEnabled: false,
    note: null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("assignments / assignment_units / assignment_students 表（T2A.7 作业结构）", () => {
  /** 造最小外键链：课程 → 单元、学生，返回各 id */
  function seedT2a7Refs(db: ReturnType<typeof createTestDb>): {
    courseId: string;
    unitId: string;
    studentId: string;
  } {
    const courseId = randomUUID();
    const unitId = "t2a7-练习一";
    const studentId = randomUUID();
    const now = new Date().toISOString();
    db.insert(courses)
      .values({ id: courseId, title: "初一上", order: 0, createdAt: now })
      .run();
    db.insert(units)
      .values({
        id: unitId,
        courseId,
        lectureId: null,
        title: "练习一",
        topic: null,
        order: 0,
        updatedAt: now,
      })
      .run();
    db.insert(students)
      .values({
        id: studentId,
        displayName: "张三",
        loginName: "张三",
        passwordHash: null,
        linkToken: `link-${randomUUID()}`,
        linkEnabled: true,
        passwordEnabled: false,
        note: null,
        archivedAt: null,
        createdAt: now,
      })
      .run();
    return { courseId, unitId, studentId };
  }

  it("迁移后 assignment_units 表存在；复合主键 (assignmentId, unitId) 拒绝重复行", () => {
    const db = createTestDb();
    const tables = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assignment_units'",
      )
      .all() as TableNameRow[];
    expect(tables.map((r) => r.name)).toEqual(["assignment_units"]);

    const { unitId } = seedT2a7Refs(db);
    const now = new Date().toISOString();
    const assignmentId = randomUUID();
    db.insert(assignments)
      .values({ id: assignmentId, unitId, title: "作业一", createdAt: now })
      .run();
    db.insert(assignmentUnits).values({ assignmentId, unitId, order: 0 }).run();
    // 同 (assignmentId, unitId) 第二行 → 违反复合主键
    expect(() =>
      db
        .insert(assignmentUnits)
        .values({ assignmentId, unitId, order: 1 })
        .run(),
    ).toThrow();
    db.$client.close();
  });

  it("assignments.unitId 可空（多单元作业走 assignment_units）；courseId 与名单时间列可读写", () => {
    const db = createTestDb();
    const { courseId, studentId } = seedT2a7Refs(db);
    const now = new Date().toISOString();
    // T2A.7 新形态：unitId 为 NULL、courseId 指向课程
    const assignmentId = randomUUID();
    db.insert(assignments)
      .values({
        id: assignmentId,
        unitId: null,
        courseId,
        title: "两单元作业",
        dueAt: null,
        deletedAt: null,
        createdAt: now,
      })
      .run();
    expect(
      db
        .select()
        .from(assignments)
        .where(eq(assignments.id, assignmentId))
        .get(),
    ).toMatchObject({ id: assignmentId, unitId: null, courseId });

    // 名单行：addedAt 恒写非空、removedAt 置值（D13 移出 = 行保留）
    db.insert(assignmentStudents)
      .values({ assignmentId, studentId, addedAt: now, removedAt: now })
      .run();
    expect(
      db
        .select()
        .from(assignmentStudents)
        .where(eq(assignmentStudents.assignmentId, assignmentId))
        .get(),
    ).toEqual({
      assignmentId,
      studentId,
      addedAt: now,
      removedAt: now,
    });
    db.$client.close();
  });
});

describe("createTestDb（内存库 + 迁移）", () => {
  it("迁移后 teachers 与 sessions 表存在", () => {
    const db = createTestDb();
    const rows = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('teachers', 'sessions') ORDER BY name",
      )
      .all() as TableNameRow[];
    expect(rows.map((r) => r.name)).toEqual(["sessions", "teachers"]);
    db.$client.close();
  });
});

describe("teachers / sessions 表读写", () => {
  it("teachers.loginName 唯一索引（D2）：同登录名第二行被拒、多个 NULL 合法（迁移前中间态）", () => {
    const db = createTestDb();
    const t1 = {
      id: randomUUID(),
      loginName: "王老师",
      isAdmin: true,
      disabledAt: null,
      passwordHash: "scrypt$模拟哈希",
      apiToken: null,
      createdAt: new Date().toISOString(),
    };
    db.insert(teachers).values(t1).run();
    // 同 loginName 不同 id → 违反唯一索引
    expect(() =>
      db
        .insert(teachers)
        .values({ ...t1, id: randomUUID(), loginName: "王老师" })
        .run(),
    ).toThrow();
    // 不同 loginName 可共存；多个 NULL（回填前的中间态）同样合法
    db.insert(teachers)
      .values({ ...t1, id: randomUUID(), loginName: "李老师" })
      .run();
    db.insert(teachers)
      .values({ ...t1, id: randomUUID(), loginName: null })
      .run();
    db.insert(teachers)
      .values({ ...t1, id: randomUUID(), loginName: null })
      .run();
    db.$client.close();
  });

  it("插入一条 teacher 与一条 session 后可原样读回", () => {
    const db = createTestDb();
    const createdAt = new Date().toISOString();

    const teacher = {
      id: randomUUID(),
      passwordHash: "scrypt$模拟哈希",
      apiToken: null,
      createdAt,
    };
    db.insert(teachers).values(teacher).run();

    const session = {
      id: randomUUID(),
      subjectType: "teacher" as const,
      subjectId: teacher.id,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt,
    };
    db.insert(sessions).values(session).run();

    // T2B.1 新增列（loginName/isAdmin/disabledAt）落默认值读回
    expect(
      db.select().from(teachers).where(eq(teachers.id, teacher.id)).get(),
    ).toEqual({
      ...teacher,
      loginName: null,
      isAdmin: false,
      disabledAt: null,
    });
    expect(
      db.select().from(sessions).where(eq(sessions.id, session.id)).get(),
    ).toEqual(session);
    db.$client.close();
  });

  it("teachers 单行设计：无密码/Token 的初始行也能落库读回", () => {
    const db = createTestDb();
    const row = {
      id: randomUUID(),
      passwordHash: null,
      apiToken: null,
      createdAt: new Date().toISOString(),
    };
    db.insert(teachers).values(row).run();
    expect(
      db.select().from(teachers).where(eq(teachers.id, row.id)).get(),
    ).toEqual({ ...row, loginName: null, isAdmin: false, disabledAt: null });
    db.$client.close();
  });
});

describe("students 表（T2.1 学生账号）", () => {
  it("迁移后 students 表存在，可原样读回（布尔列按 0/1 映射）", () => {
    const db = createTestDb();
    const tables = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'students'",
      )
      .all() as TableNameRow[];
    expect(tables.map((r) => r.name)).toEqual(["students"]);

    const row = studentRow();
    db.insert(students).values(row).run();
    expect(
      db.select().from(students).where(eq(students.id, row.id)).get(),
    ).toEqual(row);
    db.$client.close();
  });

  it("loginName 与 linkToken 数据库层唯一（迁移生成的 UNIQUE 索引兜底）", () => {
    const db = createTestDb();
    const first = studentRow();
    db.insert(students).values(first).run();
    // 同 loginName 不同 id → 违反唯一约束
    expect(() =>
      db
        .insert(students)
        .values(studentRow({ loginName: first.loginName }))
        .run(),
    ).toThrow();
    // 同 linkToken 不同 loginName → 同样违反
    expect(() =>
      db
        .insert(students)
        .values(studentRow({ loginName: "李四", linkToken: first.linkToken }))
        .run(),
    ).toThrow();
    db.$client.close();
  });
});

describe("login_failures 表（T1.9 登录限流）", () => {
  it("迁移后 login_failures 表存在，可按 key 读写计数行", () => {
    const db = createTestDb();
    const tables = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'login_failures'",
      )
      .all() as TableNameRow[];
    expect(tables.map((r) => r.name)).toEqual(["login_failures"]);

    const row = {
      key: "name:teacher",
      count: 3,
      lockedUntil: new Date(Date.now() + 600_000).toISOString(),
    };
    db.insert(loginFailures).values(row).run();
    expect(
      db
        .select()
        .from(loginFailures)
        .where(eq(loginFailures.key, row.key))
        .get(),
    ).toEqual(row);
    db.$client.close();
  });
});

describe("attempts / responses 表（T2.6 作答生命周期）", () => {
  /** 造最小外键链：课程 → 单元 → 题目、学生、作业，返回各 id */
  function seedAttemptRefs(db: ReturnType<typeof createTestDb>): {
    studentId: string;
    assignmentId: string;
    unitId: string;
    questionId: string;
  } {
    const courseId = randomUUID();
    const unitId = "unit-练习四";
    const questionId = "练习四-1";
    const studentId = randomUUID();
    const assignmentId = randomUUID();
    const now = new Date().toISOString();
    db.insert(courses)
      .values({ id: courseId, title: "默认课程", order: 0, createdAt: now })
      .run();
    db.insert(units)
      .values({
        id: unitId,
        courseId,
        lectureId: null,
        title: "练习四",
        topic: null,
        order: 0,
        updatedAt: now,
      })
      .run();
    db.insert(questions)
      .values({
        id: questionId,
        unitId,
        order: 0,
        type: "judge",
        difficulty: 1,
        stemMd: "题干 [[正确]]",
        optionsJson: null,
        answersJson: '{"kind":"judge","value":true}',
        hintsJson: "[]",
        solutionMd: null,
        sourceMd: "::::question{type=judge difficulty=1}\n题干 [[正确]]\n::::",
        version: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .run();
    db.insert(students)
      .values({
        id: studentId,
        displayName: "张三",
        loginName: "张三",
        passwordHash: null,
        linkToken: `link-${randomUUID()}`,
        linkEnabled: true,
        passwordEnabled: false,
        note: null,
        archivedAt: null,
        createdAt: now,
      })
      .run();
    db.insert(assignments)
      .values({
        id: assignmentId,
        unitId,
        title: "练习四",
        dueAt: null,
        deletedAt: null,
        createdAt: now,
      })
      .run();
    return { studentId, assignmentId, unitId, questionId };
  }

  it("迁移后两表存在；attempts 行可读写（三态 status、scoreAuto 百分比）", () => {
    const db = createTestDb();
    const tables = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('attempts','responses') ORDER BY name",
      )
      .all() as TableNameRow[];
    expect(tables.map((r) => r.name)).toEqual(["attempts", "responses"]);

    const { studentId, assignmentId, unitId } = seedAttemptRefs(db);
    const now = new Date().toISOString();
    const attempt = {
      id: randomUUID(),
      studentId,
      sourceType: "assignment" as const,
      assignmentId,
      courseId: null,
      unitId,
      attemptNo: 1,
      status: "draft" as const,
      startedAt: now,
      submittedAt: null,
      activeSec: null,
      device: null,
      scoreAuto: null,
      scoreFinal: null,
    };
    db.insert(attempts).values(attempt).run();
    expect(
      db.select().from(attempts).where(eq(attempts.id, attempt.id)).get(),
    ).toEqual(attempt);
    db.$client.close();
  });

  it("responses 默认值（questionVersion/hintsUsed/changeCount=0）与 (attemptId,questionId) 唯一约束", () => {
    const db = createTestDb();
    const { studentId, assignmentId, unitId, questionId } = seedAttemptRefs(db);
    const now = new Date().toISOString();
    const attemptId = randomUUID();
    db.insert(attempts)
      .values({
        id: attemptId,
        studentId,
        assignmentId,
        unitId,
        status: "draft",
        startedAt: now,
        submittedAt: null,
        activeSec: null,
        device: null,
        scoreAuto: null,
        scoreFinal: null,
      })
      .run();
    const responseId = randomUUID();
    // 只给必填列：默认列应自动补 0
    db.insert(responses)
      .values({
        id: responseId,
        attemptId,
        questionId,
        questionSnapshotJson: null,
        answerJson: '{"kind":"judge","value":true}',
        autoCorrect: true,
        finalCorrect: null,
        teacherMark: null,
        teacherComment: null,
        activeSec: null,
        inkId: null,
      })
      .run();
    const row = db
      .select()
      .from(responses)
      .where(eq(responses.id, responseId))
      .get();
    expect(row?.questionVersion).toBe(0);
    expect(row?.hintsUsed).toBe(0);
    expect(row?.changeCount).toBe(0);
    expect(row?.autoCorrect).toBe(true); // 布尔模式按 0/1 映射

    // 同 (attemptId, questionId) 第二行 → 违反唯一索引
    expect(() =>
      db
        .insert(responses)
        .values({
          id: randomUUID(),
          attemptId,
          questionId,
          questionSnapshotJson: null,
          answerJson: null,
          autoCorrect: null,
          finalCorrect: null,
          teacherMark: null,
          teacherComment: null,
          activeSec: null,
          hintsUsed: 0,
          changeCount: 0,
          inkId: null,
        })
        .run(),
    ).toThrow();
    db.$client.close();
  });
});

describe("notes / note_versions / note_images / submission_evidence 表（T6R.2 题目草稿）", () => {
  /** 造最小外键链：学生 + attempt（notes 只外键 attempts；题目/版本引用不带外键） */
  function seedNoteRefs(db: ReturnType<typeof createTestDb>): {
    attemptId: string;
    questionId: string;
  } {
    const student = studentRow();
    const studentId = student.id;
    const attemptId = randomUUID();
    const questionId = "练习四-7";
    const now = new Date().toISOString();
    db.insert(students).values(student).run();
    db.insert(attempts)
      .values({
        id: attemptId,
        studentId,
        sourceType: "assignment",
        assignmentId: null,
        courseId: null,
        unitId: null,
        attemptNo: 1,
        status: "draft",
        startedAt: now,
        submittedAt: null,
        activeSec: null,
        device: null,
        scoreAuto: null,
        scoreFinal: null,
      })
      .run();
    return { attemptId, questionId };
  }

  /** 造一行 notes（缺省 rev-a）；返回 noteId */
  function seedNote(
    db: ReturnType<typeof createTestDb>,
    o: { attemptId: string; questionId: string; questionRevisionId?: string },
  ): string {
    const noteId = randomUUID();
    db.insert(notes)
      .values({
        id: noteId,
        attemptId: o.attemptId,
        questionId: o.questionId,
        questionRevisionId: o.questionRevisionId ?? "rev-a",
        updatedAt: new Date().toISOString(),
      })
      .run();
    return noteId;
  }

  /** 造一行 note_versions（缺省 revision=1/hash=a*64）；返回整行 */
  function seedNoteVersion(
    db: ReturnType<typeof createTestDb>,
    noteId: string,
    o: Partial<typeof noteVersions.$inferInsert> = {},
  ): typeof noteVersions.$inferInsert {
    const revision = o.revision ?? 1;
    // renderVersion 不设基值：缺省由 DB DEFAULT 填（调用方可显式覆盖）
    const version = {
      id: randomUUID(),
      noteId,
      revision,
      bodyPath: `blobs/notes/${noteId}/v${revision}.json.gz`,
      hash: o.hash ?? "a".repeat(64),
      strokeCount: 1,
      pointCount: 10,
      paperWidth: 1000,
      paperHeight: 800,
      serverSavedAt: new Date().toISOString(),
      ...o,
    };
    db.insert(noteVersions).values(version).run();
    return version;
  }

  it("迁移后四表存在；notes 行落默认值（phase=scratch、currentRevision=0、头指针空）", () => {
    const db = createTestDb();
    const tables = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('notes','note_versions','note_images','submission_evidence') ORDER BY name",
      )
      .all() as TableNameRow[];
    expect(tables.map((r) => r.name)).toEqual([
      "note_images",
      "note_versions",
      "notes",
      "submission_evidence",
    ]);

    const { attemptId, questionId } = seedNoteRefs(db);
    const noteId = seedNote(db, {
      attemptId,
      questionId,
      questionRevisionId: "练习四-7@3@snap",
    });
    const row = db.select().from(notes).where(eq(notes.id, noteId)).get();
    expect(row).toMatchObject({
      id: noteId,
      attemptId,
      questionId,
      phase: "scratch",
      currentRevision: 0,
      currentVersionId: null,
      serverSavedAt: null,
    });
    db.$client.close();
  });

  it("scratch 唯一性由服务层保证（与 attempts 先例同口径）：库里两行同键不炸——决策见 schema 注释", () => {
    const db = createTestDb();
    const { attemptId, questionId } = seedNoteRefs(db);
    seedNote(db, { attemptId, questionId });
    // 同 (attemptId, questionId, phase='scratch') 第二行：DB 层放行（correction 多行性
    // 使全列唯一索引不可行；partial unique index 依 attempts 表先例不建）
    expect(() => seedNote(db, { attemptId, questionId })).not.toThrow();
    db.$client.close();
  });

  it("note_versions：行可读写、renderVersion 默认 1；(noteId, revision) 唯一拒绝重复", () => {
    const db = createTestDb();
    const { attemptId, questionId } = seedNoteRefs(db);
    const noteId = seedNote(db, { attemptId, questionId });
    // 插入省略 renderVersion——默认值路径真实被 exercise（勿显式传 1）
    const version = seedNoteVersion(db, noteId, {
      strokeCount: 12,
      pointCount: 2400,
      paperHeight: 1200,
      serverSavedAt: "2026-10-06T02:00:00.000Z",
    });
    expect(
      db
        .select()
        .from(noteVersions)
        .where(eq(noteVersions.id, version.id))
        .get(),
    ).toEqual({ ...version, renderVersion: 1 });

    // 同 (noteId, revision) 第二行 → 唯一索引拒绝
    expect(() =>
      db
        .insert(noteVersions)
        .values({ ...version, id: randomUUID() })
        .run(),
    ).toThrow();
    // 外键：孤儿 noteId 拒绝（foreign_keys=ON）
    expect(() =>
      db
        .insert(noteVersions)
        .values({ ...version, id: randomUUID(), noteId: randomUUID() })
        .run(),
    ).toThrow();
    db.$client.close();
  });

  it("note_images：默认 state=pending/hash=null；(noteVersionId, spec, pageIndex) 唯一", () => {
    const db = createTestDb();
    const { attemptId, questionId } = seedNoteRefs(db);
    const noteId = seedNote(db, { attemptId, questionId });
    const versionId = seedNoteVersion(db, noteId).id;
    const image = {
      id: randomUUID(),
      noteVersionId: versionId,
      spec: "analysis" as const,
      pageIndex: 0,
      cropX: 0,
      cropY: 0,
      cropW: 1000,
      cropH: 760,
      pixelWidth: 1000,
      pixelHeight: 760,
      path: `blobs/notes/${noteId}/img-${randomUUID()}.png`,
      hash: null,
    };
    db.insert(noteImages).values(image).run();
    const row = db
      .select()
      .from(noteImages)
      .where(eq(noteImages.id, image.id))
      .get();
    expect(row).toMatchObject({ ...image, state: "pending" });

    // 同 (noteVersionId, spec, pageIndex) 第二行 → 唯一索引拒绝；换 pageIndex 合法
    expect(() =>
      db
        .insert(noteImages)
        .values({ ...image, id: randomUUID() })
        .run(),
    ).toThrow();
    db.insert(noteImages)
      .values({ ...image, id: randomUUID(), pageIndex: 1 })
      .run();
    // 外键：孤儿版本拒绝
    expect(() =>
      db
        .insert(noteImages)
        .values({ ...image, id: randomUUID(), noteVersionId: randomUUID() })
        .run(),
    ).toThrow();
    db.$client.close();
  });

  it("submission_evidence：(attemptId, questionId) 唯一；frozen 指向版本、外键有效", () => {
    const db = createTestDb();
    const { attemptId, questionId } = seedNoteRefs(db);
    const noteId = seedNote(db, { attemptId, questionId });
    const versionId = seedNoteVersion(db, noteId, {
      revision: 2,
      hash: "b".repeat(64),
    }).id;
    const now = new Date().toISOString();
    const evidence = {
      id: randomUUID(),
      attemptId,
      questionId,
      state: "frozen" as const,
      versionId,
      recordedAt: now,
    };
    db.insert(submissionEvidence).values(evidence).run();
    expect(
      db
        .select()
        .from(submissionEvidence)
        .where(eq(submissionEvidence.id, evidence.id))
        .get(),
    ).toEqual(evidence);

    // 同 (attemptId, questionId) 第二行 → 唯一索引拒绝
    expect(() =>
      db
        .insert(submissionEvidence)
        .values({
          ...evidence,
          id: randomUUID(),
          state: "none",
          versionId: null,
        })
        .run(),
    ).toThrow();
    // 外键：孤儿 attemptId / versionId 拒绝
    expect(() =>
      db
        .insert(submissionEvidence)
        .values({
          ...evidence,
          id: randomUUID(),
          attemptId: randomUUID(),
          versionId: null,
        })
        .run(),
    ).toThrow();
    expect(() =>
      db
        .insert(submissionEvidence)
        .values({
          ...evidence,
          id: randomUUID(),
          attemptId,
          versionId: randomUUID(),
        })
        .run(),
    ).toThrow();
    db.$client.close();
  });

  it("notes 头指针可随 CAS 切换（mutable head）；questionId 无外键（DSL id，D10 口径）", () => {
    const db = createTestDb();
    const { attemptId } = seedNoteRefs(db);
    const noteId = seedNote(db, { attemptId, questionId: "任意-DSL.id" });
    const versionId = seedNoteVersion(db, noteId).id;
    const now = new Date().toISOString();
    db.update(notes)
      .set({
        currentRevision: 1,
        currentVersionId: versionId,
        serverSavedAt: now,
        updatedAt: now,
      })
      .where(eq(notes.id, noteId))
      .run();
    expect(
      db.select().from(notes).where(eq(notes.id, noteId)).get(),
    ).toMatchObject({
      currentRevision: 1,
      currentVersionId: versionId,
      serverSavedAt: now,
    });
    db.$client.close();
  });
});

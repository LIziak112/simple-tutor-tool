import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  aiConnections,
  aiFacts,
  aiMessages,
  aiPolicyOverrides,
  aiQuickButtons,
  aiShareTickets,
  aiTaskMaterials,
  aiTasks,
  aiTeacherSettings,
  assignmentStudents,
  assignments,
  assignmentUnits,
  attempts,
  BLOB_BACKUP_REF_COLUMNS,
  courses,
  lectures,
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
import { createTestDb, TEST_TEACHER_ID } from "./test-utils";

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
      practiceFeedbackPolicy: null,
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
      practiceFeedbackPolicy: null,
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

    // T2B.1 新增列（loginName/isAdmin/disabledAt）落默认值读回；
    // T7.7 capabilityProfileJson 未配置读回 null（全启用缺省语义在服务层）
    expect(
      db.select().from(teachers).where(eq(teachers.id, teacher.id)).get(),
    ).toEqual({
      ...teacher,
      loginName: null,
      isAdmin: false,
      disabledAt: null,
      capabilityProfileJson: null,
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
      practiceFeedbackPolicy: null,
      createdAt: new Date().toISOString(),
    };
    db.insert(teachers).values(row).run();
    expect(
      db.select().from(teachers).where(eq(teachers.id, row.id)).get(),
    ).toEqual({
      ...row,
      loginName: null,
      isAdmin: false,
      disabledAt: null,
      capabilityProfileJson: null,
    });
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
      // 讲练一体（2026-10）：非 lesson 来源 lectureId 恒 null
      lectureId: null,
      attemptNo: 1,
      status: "draft" as const,
      startedAt: now,
      submittedAt: null,
      activeSec: null,
      device: null,
      scoreAuto: null,
      scoreFinal: null,
      // T6R.3 冻结列：显式给值（回读相等断言用；缺省时 DB 默认 frozenAt=null /
      // legacyUnverified=false，见迁移测试）
      frozenAt: now,
      legacyUnverified: false,
      practiceWorkflowVersion: null,
      feedbackMode: null,
      workflowRevision: 0,
    };
    db.insert(attempts).values(attempt).run();
    expect(
      db.select().from(attempts).where(eq(attempts.id, attempt.id)).get(),
    ).toEqual({ ...attempt, abandonedAt: null });
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

describe("讲练一体三列一索引（2026-10：lectures.kind / attempts.lectureId / responses.submittedAt）", () => {
  /** 造一行讲义（folderId/courseId 均 null = 未归类）；返回行 id */
  function seedLecture(db: ReturnType<typeof createTestDb>): string {
    const id = randomUUID();
    db.insert(lectures)
      .values({
        id,
        teacherId: randomUUID(),
        title: "第1讲 有理数",
        markdown: "# 第1讲 有理数",
        order: 0,
        updatedAt: new Date().toISOString(),
      })
      .run();
    return id;
  }

  it("lectures.kind 缺省 lecture（存量行语义不变）；可写 lesson 读回（导入按文档 kind 写入）", () => {
    const db = createTestDb();
    const lectureId = seedLecture(db);
    // 不写 kind 落库 → 默认 'lecture'（存量讲义与既有三种文档形态全部如此）
    expect(
      db
        .select({ kind: lectures.kind })
        .from(lectures)
        .where(eq(lectures.id, lectureId))
        .get()?.kind,
    ).toBe("lecture");
    // 讲练页行：kind='lesson' 可写读回
    db.update(lectures)
      .set({ kind: "lesson" })
      .where(eq(lectures.id, lectureId))
      .run();
    expect(
      db
        .select({ kind: lectures.kind })
        .from(lectures)
        .where(eq(lectures.id, lectureId))
        .get()?.kind,
    ).toBe("lesson");
    db.$client.close();
  });

  it("attempts.lectureId 可空可写（lesson 来源必填语义由服务层保证）；attempts_student_lecture_idx 按 (student_id, lecture_id) 建出", () => {
    const db = createTestDb();
    // 索引存在性与列序
    const idx = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'attempts_student_lecture_idx'",
      )
      .all() as TableNameRow[];
    expect(idx.map((r) => r.name)).toEqual(["attempts_student_lecture_idx"]);
    const idxCols = db.$client
      .prepare("PRAGMA index_info('attempts_student_lecture_idx')")
      .all() as Array<{ name: string }>;
    expect(idxCols.map((c) => c.name)).toEqual(["student_id", "lecture_id"]);

    // lesson 来源 attempt 整行读写（lectureId 无外键，unitId 同款口径——
    // 指向的讲义行不建 FK，域一致性由服务层保证）
    const student = studentRow();
    db.insert(students).values(student).run();
    const now = new Date().toISOString();
    const lectureId = randomUUID();
    const attempt = {
      id: randomUUID(),
      studentId: student.id,
      sourceType: "lesson" as const,
      assignmentId: null,
      courseId: null,
      unitId: "随堂讲练",
      lectureId,
      attemptNo: 1,
      status: "draft" as const,
      startedAt: now,
      submittedAt: null,
      activeSec: null,
      device: null,
      scoreAuto: null,
      scoreFinal: null,
      frozenAt: now,
      legacyUnverified: false,
      practiceWorkflowVersion: null,
      feedbackMode: null,
      workflowRevision: 0,
    };
    db.insert(attempts).values(attempt).run();
    expect(
      db.select().from(attempts).where(eq(attempts.id, attempt.id)).get(),
    ).toEqual({ ...attempt, abandonedAt: null });
    db.$client.close();
  });

  it("responses.submittedAt 可空可写（NULL=未提交；单题提交时刻，lesson 逐题提交后续任务实装）", () => {
    const db = createTestDb();
    const student = studentRow();
    db.insert(students).values(student).run();
    const now = new Date().toISOString();
    const attemptId = randomUUID();
    db.insert(attempts)
      .values({
        id: attemptId,
        studentId: student.id,
        sourceType: "lesson",
        unitId: null,
        status: "draft",
        startedAt: now,
      })
      .run();
    const responseId = randomUUID();
    db.insert(responses)
      .values({ id: responseId, attemptId, questionId: "随堂讲练-1" })
      .run();
    // 未提交 → NULL
    expect(
      db
        .select({ submittedAt: responses.submittedAt })
        .from(responses)
        .where(eq(responses.id, responseId))
        .get()?.submittedAt,
    ).toBeNull();
    // 写入单题提交时刻读回
    const submittedAt = "2026-10-12T08:00:00.000Z";
    db.update(responses)
      .set({ submittedAt })
      .where(eq(responses.id, responseId))
      .run();
    expect(
      db
        .select({ submittedAt: responses.submittedAt })
        .from(responses)
        .where(eq(responses.id, responseId))
        .get()?.submittedAt,
    ).toBe(submittedAt);
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

  it("note_versions.mutation_id 唯一索引（T6R.4）：同值拒绝、多 NULL 放行（幂等查重物理基础）", () => {
    const db = createTestDb();
    const { attemptId, questionId } = seedNoteRefs(db);
    const noteId = seedNote(db, { attemptId, questionId });
    const n1 = seedNoteVersion(db, noteId, {
      mutationId: "11111111-1111-4111-8111-111111111111",
    });
    // 同 mutationId 第二行 → 唯一索引拒绝（跨笔记同值同样拒绝：全局唯一）
    expect(() =>
      seedNoteVersion(db, noteId, {
        revision: 2,
        mutationId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrowError();
    // 未带 mutationId（NULL）的多行互不冲突——SQLite 唯一索引允许多 NULL
    expect(() => seedNoteVersion(db, noteId, { revision: 3 })).not.toThrow();
    expect(() => seedNoteVersion(db, noteId, { revision: 4 })).not.toThrow();
    expect(n1.revision).toBe(1);
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
    ).toEqual({ ...version, renderVersion: 1, mutationId: null });

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

// ---------- 学生端 AI 伴学九表（SAI-05，技术实施方案 §5.1） ----------

/** PRAGMA index_info 行形状（索引列序断言用，attempts_student_lecture_idx 同款） */
interface IndexInfoRow {
  name: string;
}

/** 读索引的列序（存在性 + 列序一并锁定；不存在时返回空数组） */
function indexColumns(
  db: ReturnType<typeof createTestDb>,
  name: string,
): string[] {
  return (
    db.$client.prepare(`PRAGMA index_info('${name}')`).all() as IndexInfoRow[]
  ).map((col) => col.name);
}

/** 造 ai 表最小外键链：学生 → attempt（attempts 仅外键 students）；返回各 id */
function seedAiRefs(db: ReturnType<typeof createTestDb>): {
  studentId: string;
  attemptId: string;
} {
  // loginName 全局唯一：同库多次 seedAiRefs 须各带不同登录名
  const student = studentRow({ loginName: `stu-${randomUUID()}` });
  db.insert(students).values(student).run();
  const attemptId = randomUUID();
  db.insert(attempts)
    .values({
      id: attemptId,
      studentId: student.id,
      sourceType: "assignment",
      assignmentId: null,
      courseId: null,
      unitId: null,
      attemptNo: 1,
      status: "draft",
      startedAt: new Date().toISOString(),
      frozenAt: new Date().toISOString(),
      legacyUnverified: false,
      practiceWorkflowVersion: null,
      feedbackMode: null,
      workflowRevision: 0,
    })
    .run();
  return { studentId: student.id, attemptId };
}

/** 造一行 ai_tasks（缺省 channel=inapp / status=created；字段可覆盖） */
function seedAiTask(
  db: ReturnType<typeof createTestDb>,
  refs: { studentId: string; attemptId: string },
  o: Partial<typeof aiTasks.$inferInsert> = {},
): typeof aiTasks.$inferInsert {
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    studentId: refs.studentId,
    attemptId: refs.attemptId,
    questionId: "练习四-1",
    questionRevisionId: randomUUID(),
    channel: "inapp" as const,
    modeAtSend: "open_study" as const,
    promptHash: "a".repeat(64),
    contextSnapshotJson: '{"questionId":"练习四-1"}',
    status: "created" as const,
    beforeSubmit: true,
    mutationId: randomUUID(),
    leaseUntil: null,
    leaseToken: null,
    replyDeliveredAt: null,
    cancelRequestedAt: null,
    errorText: null,
    generation: 0,
    createdAt: now,
    updatedAt: now,
    ...o,
  };
  db.insert(aiTasks).values(task).run();
  return task;
}

describe("ai_teacher_settings / ai_policy_overrides 表（SAI-05 教学配置存储）", () => {
  it("迁移后两表存在；教师设置行可读写（三模板列 NULL = 默认模板）", () => {
    const db = createTestDb();
    const tables = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ai_teacher_settings','ai_policy_overrides') ORDER BY name",
      )
      .all() as TableNameRow[];
    expect(tables.map((r) => r.name)).toEqual([
      "ai_policy_overrides",
      "ai_teacher_settings",
    ]);

    const row = {
      teacherId: TEST_TEACHER_ID,
      defaultMode: "guided_only" as const,
      promptsOpen: null,
      promptsGuided: "仅启发自定义模板",
      promptsReview: null,
      updatedAt: new Date().toISOString(),
    };
    db.insert(aiTeacherSettings).values(row).run();
    expect(
      db
        .select()
        .from(aiTeacherSettings)
        .where(eq(aiTeacherSettings.teacherId, row.teacherId))
        .get(),
    ).toEqual(row);
    db.$client.close();
  });

  it("defaultMode 值域 CHECK：'inherit' 等第四值被 DB 拒绝（无行才是继承语义）", () => {
    const db = createTestDb();
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO ai_teacher_settings (teacher_id, default_mode, prompts_open, prompts_guided, prompts_review, updated_at) VALUES (?, 'inherit', NULL, NULL, NULL, ?)",
        )
        .run(TEST_TEACHER_ID, new Date().toISOString()),
    ).toThrow();
    db.$client.close();
  });

  it("ai_policy_overrides 复合主键：同 (subjectType, subjectId) 拒绝重复；mode / subjectType 值域 CHECK", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.insert(aiPolicyOverrides)
      .values({
        subjectType: "student",
        subjectId: "stu-1",
        mode: "post_submit_only",
        updatedAt: now,
      })
      .run();
    // 同键第二行 → 违反复合主键
    expect(() =>
      db
        .insert(aiPolicyOverrides)
        .values({
          subjectType: "student",
          subjectId: "stu-1",
          mode: "open_study",
          updatedAt: now,
        })
        .run(),
    ).toThrow();
    // mode='inherit' 不被值域接受（无行 = 继承，不落行）
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO ai_policy_overrides (subject_type, subject_id, mode, updated_at) VALUES ('student', 'stu-2', 'inherit', ?)",
        )
        .run(now),
    ).toThrow();
    // subjectType 值域：'course' 被拒绝（域一致性服务层校验，DB 锁值域）
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO ai_policy_overrides (subject_type, subject_id, mode, updated_at) VALUES ('course', 'c-1', 'open_study', ?)",
        )
        .run(now),
    ).toThrow();
    db.$client.close();
  });

  it("同 subjectId 跨 subjectType 共存（学生 id 与作业 id 是两个命名空间，互不挤占）", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    const sharedId = randomUUID();
    db.insert(aiPolicyOverrides)
      .values({
        subjectType: "student",
        subjectId: sharedId,
        mode: "guided_only",
        updatedAt: now,
      })
      .run();
    expect(() =>
      db
        .insert(aiPolicyOverrides)
        .values({
          subjectType: "assignment",
          subjectId: sharedId,
          mode: "open_study",
          updatedAt: now,
        })
        .run(),
    ).not.toThrow();
    db.$client.close();
  });
});

describe("ai_connections 表（SAI-05 学生连接器）", () => {
  it("迁移后表存在；行可读写（isDefault=false / verifyStatus=unverified 缺省）；(studentId, channel) 索引建出", () => {
    const db = createTestDb();
    const tables = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_connections'",
      )
      .all() as TableNameRow[];
    expect(tables.map((r) => r.name)).toEqual(["ai_connections"]);

    const student = studentRow();
    db.insert(students).values(student).run();
    const id = randomUUID();
    db.insert(aiConnections)
      .values({
        id,
        studentId: student.id,
        channel: "inapp",
        configJson:
          '{"baseUrl":"https://api.example.com","model":"glm-4.6","keyCiphertext":"x","keyIv":"y","keyTag":"z","keyFingerprint":"abcd1234"}',
        createdAt: "2026-10-15T00:00:00.000Z",
        updatedAt: "2026-10-15T00:00:00.000Z",
      })
      .run();
    expect(
      db.select().from(aiConnections).where(eq(aiConnections.id, id)).get(),
    ).toMatchObject({
      id,
      isDefault: false,
      verifyStatus: "unverified",
      verifiedAt: null,
      archivedAt: null,
    });
    expect(indexColumns(db, "ai_connections_student_channel_idx")).toEqual([
      "student_id",
      "channel",
    ]);
    db.$client.close();
  });

  it("channel 值域 CHECK：'web' 被拒绝；外键：孤儿 studentId 拒绝（无效引用不能写入）", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO ai_connections (id, student_id, channel, config_json, created_at, updated_at) VALUES (?, ?, 'web', '{}', ?, ?)",
        )
        .run(randomUUID(), randomUUID(), now, now),
    ).toThrow();
    expect(() =>
      db
        .insert(aiConnections)
        .values({
          id: randomUUID(),
          studentId: randomUUID(),
          channel: "mcp",
          configJson: '{"tokenHash":"h","tokenFingerprint":"f"}',
          createdAt: now,
          updatedAt: now,
        })
        .run(),
    ).toThrow();
    db.$client.close();
  });
});

describe("ai_tasks / ai_task_materials 表（SAI-05 任务与材料）", () => {
  it("迁移后两表存在；行可读写（status=created / retryCount=0 / generation=0 缺省）", () => {
    const db = createTestDb();
    const tables = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ai_tasks','ai_task_materials') ORDER BY name",
      )
      .all() as TableNameRow[];
    expect(tables.map((r) => r.name)).toEqual([
      "ai_task_materials",
      "ai_tasks",
    ]);

    const refs = seedAiRefs(db);
    const task = seedAiTask(db, refs);
    expect(
      db.select().from(aiTasks).where(eq(aiTasks.id, task.id)).get(),
    ).toMatchObject({
      status: "created",
      retryCount: 0,
      generation: 0,
      leaseUntil: null,
      replyDeliveredAt: null,
    });
    db.$client.close();
  });

  it("mutationId 唯一索引：同请求键第二任务被拒；不同学生不同键互不冲突", () => {
    const db = createTestDb();
    const refsA = seedAiRefs(db);
    const refsB = seedAiRefs(db);
    const mutationId = randomUUID();
    seedAiTask(db, refsA, { mutationId });
    // 同 mutationId（同学生重复请求键）→ 唯一索引拒绝（幂等查重物理基础）
    expect(() =>
      seedAiTask(db, refsA, { mutationId, questionId: "练习四-2" }),
    ).toThrow();
    // 不同学生 / 不同键各自合法
    expect(() => seedAiTask(db, refsB)).not.toThrow();
    expect(() =>
      seedAiTask(db, refsA, { questionId: "练习四-3" }),
    ).not.toThrow();
    db.$client.close();
  });

  it("status / channel 值域 CHECK：'deleted'、'web' 均被拒绝", () => {
    const db = createTestDb();
    const refs = seedAiRefs(db);
    const task = seedAiTask(db, refs);
    expect(() =>
      db.$client
        .prepare("UPDATE ai_tasks SET status = 'deleted' WHERE id = ?")
        .run(task.id),
    ).toThrow();
    expect(() =>
      db.$client
        .prepare("UPDATE ai_tasks SET channel = 'web' WHERE id = ?")
        .run(task.id),
    ).toThrow();
    db.$client.close();
  });

  it("外键：孤儿 attemptId / studentId 拒绝（无效引用不能写入）", () => {
    const db = createTestDb();
    const refs = seedAiRefs(db);
    expect(() => seedAiTask(db, refs, { attemptId: randomUUID() })).toThrow();
    expect(() => seedAiTask(db, refs, { studentId: randomUUID() })).toThrow();
    db.$client.close();
  });

  it("同 questionId 跨教师记录仍分开：各自 (attemptId, questionId) 定位互不串卷", () => {
    const db = createTestDb();
    // 教师A（TEST_TEACHER_ID 已种入）与教师B的学生各持一卷，题目 id 相同（D10 复合主键形态）
    const teacherB = {
      id: randomUUID(),
      loginName: "teacher-b",
      isAdmin: false,
      disabledAt: null,
      passwordHash: null,
      apiToken: null,
      practiceFeedbackPolicy: null,
      createdAt: new Date().toISOString(),
    };
    db.insert(teachers).values(teacherB).run();
    const studentA = studentRow({ teacherId: TEST_TEACHER_ID });
    const studentB = studentRow({ teacherId: teacherB.id, loginName: "李四" });
    db.insert(students).values(studentA).run();
    db.insert(students).values(studentB).run();
    const now = new Date().toISOString();
    const attemptA = randomUUID();
    const attemptB = randomUUID();
    for (const [attemptId, studentId] of [
      [attemptA, studentA.id],
      [attemptB, studentB.id],
    ] as const) {
      db.insert(attempts)
        .values({
          id: attemptId,
          studentId,
          sourceType: "assignment",
          attemptNo: 1,
          status: "draft",
          startedAt: now,
        })
        .run();
    }
    const sharedQuestionId = "shared-q";
    seedAiTask(
      db,
      { studentId: studentA.id, attemptId: attemptA },
      { questionId: sharedQuestionId },
    );
    seedAiTask(
      db,
      { studentId: studentB.id, attemptId: attemptB },
      { questionId: sharedQuestionId },
    );
    // ai_tasks_attempt_question_idx 对应查询：各自只取到本教师的任务
    const rowsA = db
      .select({ studentId: aiTasks.studentId })
      .from(aiTasks)
      .where(eq(aiTasks.attemptId, attemptA))
      .all();
    expect(rowsA).toEqual([{ studentId: studentA.id }]);
    const rowsB = db
      .select({ studentId: aiTasks.studentId })
      .from(aiTasks)
      .where(eq(aiTasks.attemptId, attemptB))
      .all();
    expect(rowsB).toEqual([{ studentId: studentB.id }]);
    db.$client.close();
  });

  it("四个查询索引建出且列序一致（student/created、attempt/question、channel/status、status/lease）", () => {
    const db = createTestDb();
    expect(indexColumns(db, "ai_tasks_student_created_idx")).toEqual([
      "student_id",
      "created_at",
    ]);
    expect(indexColumns(db, "ai_tasks_attempt_question_idx")).toEqual([
      "attempt_id",
      "question_id",
    ]);
    expect(indexColumns(db, "ai_tasks_channel_status_idx")).toEqual([
      "channel",
      "status",
    ]);
    expect(indexColumns(db, "ai_tasks_status_lease_idx")).toEqual([
      "status",
      "lease_until",
    ]);
    db.$client.close();
  });

  it("ai_task_materials：(taskId, kind, pageIndex) 唯一；kind 值域 CHECK；外键孤儿 taskId 拒绝", () => {
    const db = createTestDb();
    const refs = seedAiRefs(db);
    const task = seedAiTask(db, refs);
    const material = {
      id: randomUUID(),
      taskId: task.id,
      kind: "draft" as const,
      pageIndex: 0,
      pngPath: "blobs/ai-materials/aaaaaaaa.png",
      pixelWidth: 1000,
      pixelHeight: 800,
      byteSize: 2048,
      hash: "b".repeat(64),
      state: "ready" as const,
    };
    db.insert(aiTaskMaterials).values(material).run();
    expect(
      db
        .select()
        .from(aiTaskMaterials)
        .where(eq(aiTaskMaterials.id, material.id))
        .get(),
    ).toEqual(material);

    // 同 (taskId, kind, pageIndex) 第二行 → 唯一索引拒绝；换 pageIndex 合法
    expect(() =>
      db
        .insert(aiTaskMaterials)
        .values({ ...material, id: randomUUID() })
        .run(),
    ).toThrow();
    expect(() =>
      db
        .insert(aiTaskMaterials)
        .values({ ...material, id: randomUUID(), pageIndex: 1 })
        .run(),
    ).not.toThrow();
    // kind 值域：'photo' 被拒绝
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO ai_task_materials (id, task_id, kind, page_index, png_path, pixel_width, pixel_height, byte_size, hash, state) VALUES (?, ?, 'photo', 2, ?, 1, 1, 1, ?, 'ready')",
        )
        .run(randomUUID(), task.id, "blobs/ai-materials/b.png", "c".repeat(64)),
    ).toThrow();
    // 外键：孤儿 taskId 拒绝
    expect(() =>
      db
        .insert(aiTaskMaterials)
        .values({
          ...material,
          id: randomUUID(),
          pageIndex: 3,
          taskId: randomUUID(),
        })
        .run(),
    ).toThrow();
    db.$client.close();
  });

  it("BLOB_BACKUP_REF_COLUMNS 登记 ai_task_materials.png_path（备份/GC 引用保护单源）", () => {
    expect(BLOB_BACKUP_REF_COLUMNS).toContainEqual([
      "ai_task_materials",
      "png_path",
    ]);
  });

  it("删除连接 / 快捷按钮不级联材料；材料在则任务不可物理删（正式证据保护）", () => {
    const db = createTestDb();
    const refs = seedAiRefs(db);
    const task = seedAiTask(db, refs);
    db.insert(aiTaskMaterials)
      .values({
        id: randomUUID(),
        taskId: task.id,
        kind: "annotation",
        pageIndex: 0,
        pngPath: "blobs/ai-materials/d.png",
        pixelWidth: 1000,
        pixelHeight: 800,
        byteSize: 2048,
        hash: "d".repeat(64),
        state: "ready",
      })
      .run();
    // 连接 / 快捷按钮行删除后材料行原样保留（FK 图上无级联路径）
    const connId = randomUUID();
    db.insert(aiConnections)
      .values({
        id: connId,
        studentId: refs.studentId,
        channel: "link",
        configJson: '{"defaultValidHours":24}',
        createdAt: "2026-10-15T00:00:00.000Z",
        updatedAt: "2026-10-15T00:00:00.000Z",
      })
      .run();
    db.delete(aiConnections).where(eq(aiConnections.id, connId)).run();
    db.delete(aiQuickButtons)
      .where(eq(aiQuickButtons.studentId, refs.studentId))
      .run();
    expect(
      db
        .select()
        .from(aiTaskMaterials)
        .where(eq(aiTaskMaterials.taskId, task.id))
        .all(),
    ).toHaveLength(1);
    // 材料行存在期间任务不可物理删（FK 拦截；取消回信不删除正式证据）
    expect(() =>
      db.delete(aiTasks).where(eq(aiTasks.id, task.id)).run(),
    ).toThrow();
    db.$client.close();
  });
});

describe("ai_messages / ai_facts / ai_share_tickets / ai_quick_buttons 表（SAI-05）", () => {
  it("ai_messages：行可读写、(taskId, createdAt) 索引建出、role 值域与外键", () => {
    const db = createTestDb();
    const refs = seedAiRefs(db);
    const task = seedAiTask(db, refs);
    const message = {
      id: randomUUID(),
      taskId: task.id,
      role: "student" as const,
      contentMd: "这道题第二步怎么变形？",
      createdAt: new Date().toISOString(),
    };
    db.insert(aiMessages).values(message).run();
    expect(
      db.select().from(aiMessages).where(eq(aiMessages.id, message.id)).get(),
    ).toEqual(message);
    expect(indexColumns(db, "ai_messages_task_created_idx")).toEqual([
      "task_id",
      "created_at",
    ]);
    expect(() =>
      db
        .insert(aiMessages)
        .values({ ...message, id: randomUUID(), taskId: randomUUID() })
        .run(),
    ).toThrow();
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO ai_messages (id, task_id, role, content_md, created_at) VALUES (?, ?, 'system', 'x', ?)",
        )
        .run(randomUUID(), task.id, new Date().toISOString()),
    ).toThrow();
    db.$client.close();
  });

  it("ai_facts：11 类事实可写（含 late_reply）、两索引建出、坏 type 拒绝", () => {
    const db = createTestDb();
    const refs = seedAiRefs(db);
    const task = seedAiTask(db, refs);
    const now = new Date().toISOString();
    for (const type of [
      "task_created",
      "link_generated",
      "dispatched",
      "link_viewed",
      "reply_received",
      "reply_delivered",
      "paused",
      "resumed",
      "cancelled",
      "failed",
      "late_reply",
    ] as const) {
      db.insert(aiFacts)
        .values({
          id: randomUUID(),
          taskId: task.id,
          attemptId: refs.attemptId,
          questionId: "练习四-1",
          studentId: refs.studentId,
          type,
          beforeSubmit: true,
          detailJson: null,
          serverTs: now,
        })
        .run();
    }
    expect(
      db
        .select({ id: aiFacts.id })
        .from(aiFacts)
        .where(eq(aiFacts.taskId, task.id))
        .all(),
    ).toHaveLength(11);
    expect(indexColumns(db, "ai_facts_task_ts_idx")).toEqual([
      "task_id",
      "server_ts",
    ]);
    expect(indexColumns(db, "ai_facts_attempt_question_ts_idx")).toEqual([
      "attempt_id",
      "question_id",
      "server_ts",
    ]);
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO ai_facts (id, task_id, attempt_id, question_id, student_id, type, before_submit, detail_json, server_ts) VALUES (?, ?, ?, 'q', ?, 'deleted', 1, NULL, ?)",
        )
        .run(randomUUID(), task.id, refs.attemptId, refs.studentId, now),
    ).toThrow();
    db.$client.close();
  });

  it("ai_share_tickets：tokenHash 唯一、viewCount 缺省 0、外键孤儿拒绝", () => {
    const db = createTestDb();
    const refs = seedAiRefs(db);
    const task = seedAiTask(db, refs);
    const ticket = {
      id: randomUUID(),
      taskId: task.id,
      tokenHash: "e".repeat(64),
      payloadHash: "f".repeat(64),
      expiresAt: "2026-10-16T00:00:00.000Z",
      revokedAt: null,
      viewCount: 0,
      lastViewedAt: null,
      createdAt: new Date().toISOString(),
    };
    db.insert(aiShareTickets).values(ticket).run();
    expect(
      db
        .select()
        .from(aiShareTickets)
        .where(eq(aiShareTickets.id, ticket.id))
        .get(),
    ).toEqual(ticket);
    // 同 tokenHash 第二行（另一任务）→ 唯一索引拒绝
    const otherTask = seedAiTask(db, refs, { questionId: "练习四-9" });
    expect(() =>
      db
        .insert(aiShareTickets)
        .values({ ...ticket, id: randomUUID(), taskId: otherTask.id })
        .run(),
    ).toThrow();
    // 换 tokenHash（撤销后重开新票据）合法
    expect(() =>
      db
        .insert(aiShareTickets)
        .values({
          ...ticket,
          id: randomUUID(),
          tokenHash: "0".repeat(64),
        })
        .run(),
    ).not.toThrow();
    // 外键：孤儿 taskId 拒绝
    expect(() =>
      db
        .insert(aiShareTickets)
        .values({
          ...ticket,
          id: randomUUID(),
          tokenHash: "1".repeat(64),
          taskId: randomUUID(),
        })
        .run(),
    ).toThrow();
    db.$client.close();
  });

  it("ai_quick_buttons：(studentId, orderIndex) 唯一、enabled 缺省 true、外键孤儿拒绝", () => {
    const db = createTestDb();
    const refs = seedAiRefs(db);
    const button = {
      id: "hint-next",
      studentId: refs.studentId,
      name: "启发下一步",
      prompt: "请指出下一步该做什么。",
      orderIndex: 0,
      attachmentPref: '{"annotation":true,"draft":true,"formalInk":true}',
      updatedAt: new Date().toISOString(),
    };
    db.insert(aiQuickButtons).values(button).run();
    expect(
      db
        .select()
        .from(aiQuickButtons)
        .where(eq(aiQuickButtons.id, button.id))
        .get(),
    ).toEqual({ ...button, enabled: true });
    // 同 (studentId, orderIndex) 第二行 → 唯一索引拒绝；换序合法；换学生同序合法
    expect(() =>
      db
        .insert(aiQuickButtons)
        .values({ ...button, id: "b2", orderIndex: 0 })
        .run(),
    ).toThrow();
    expect(() =>
      db
        .insert(aiQuickButtons)
        .values({ ...button, id: "b2", orderIndex: 1 })
        .run(),
    ).not.toThrow();
    const otherStudent = studentRow({ loginName: "王五" });
    db.insert(students).values(otherStudent).run();
    expect(() =>
      db
        .insert(aiQuickButtons)
        .values({
          ...button,
          id: "hint-next-other",
          studentId: otherStudent.id,
          orderIndex: 0,
        })
        .run(),
    ).not.toThrow();
    // 外键：孤儿 studentId 拒绝
    expect(() =>
      db
        .insert(aiQuickButtons)
        .values({
          ...button,
          id: "b3",
          studentId: randomUUID(),
        })
        .run(),
    ).toThrow();
    db.$client.close();
  });
});

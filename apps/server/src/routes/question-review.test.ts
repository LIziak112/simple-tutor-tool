import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client.ts";
import {
  attempts,
  courses,
  notes,
  responses,
  students,
  teachers,
} from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";

/**
 * 学生主页「错题与存疑」聚合端点集成测试（T-PR4 Web-2②，app.request() 直调
 * 路由 + 内存库）：
 * - 三 kind 行级口径：wrong 的 #6980-3 未做判错排除、unsure 自标「不会」、
 *   corrected 订正笔记 EXISTS；
 * - 共享谓词（teacherVisibleResponsesWhere）：作废卷整卷排除、draft 只纳入
 *   单题已提交的行；
 * - 代表行 / redoCount / lastAt（同题两轮取最近）、from / to 时间轴、
 *   courseId 筛选、offset 游标分页；
 * - 域隔离（他人学生 404 不暴露存在性）、参数校验 400、summary 行不含
 *   答案 / 解析 / 选项键。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const TEACHER_B_ID = "cccccccc-0000-4000-8000-00000000000b";

const T1 = "2026-09-10T08:00:00.000Z";
const T2 = "2026-09-11T08:00:00.000Z";
const T3 = "2026-09-12T08:00:00.000Z";
const T4 = "2026-09-13T08:00:00.000Z";
const T5 = "2026-09-14T08:00:00.000Z";

const STU_A = "bbbbbbbb-0000-4000-8000-00000000000a";
const STU_B = "bbbbbbbb-0000-4000-8000-00000000000b";

/** 夹具题目快照（choice，含考点；题干不含答案标记——本面不考泄露投影） */
const SNAP = JSON.stringify({
  type: "choice",
  difficulty: 3,
  stemMd: "数轴上到原点的距离等于 $3$ 的点表示的数是（　）",
  knowledge: ["绝对值"],
});

/** 组装被测应用：内存库 + 教师 Cookie（每条用例独立实例） */
async function makeApp(): Promise<{
  app: ReturnType<typeof createApp>;
  db: Db;
  cookie: string;
}> {
  const db = createTestDb();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    publicUrl: "http://localhost:8787",
    dataDir: createTestDir(),
  });
  const setup = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "teacher", password: TEACHER_PASSWORD }),
  });
  const line = setup.headers
    .getSetCookie()
    .find((c) => c.startsWith("tutor_session="));
  if (!line) throw new Error("setup 响应没有会话 cookie");
  return { app, db, cookie: line.split(";")[0] ?? "" };
}

function insertStudent(db: Db, id: string, teacherId: string): void {
  db.insert(students)
    .values({
      id,
      teacherId,
      displayName: `学生 ${id.slice(-1)}`,
      loginName: `login-${id.slice(-1)}`,
      passwordHash: null,
      linkToken: `link-${id}`,
      linkEnabled: true,
      passwordEnabled: false,
      note: null,
      archivedAt: null,
      createdAt: "2026-09-01T00:00:00.000Z",
    })
    .run();
}

interface AttemptSeed {
  id: string;
  studentId: string;
  status: "draft" | "submitted" | "graded";
  startedAt: string;
  submittedAt?: string | null;
  courseId?: string | null;
  abandoned?: boolean;
}

function insertAttempt(db: Db, seed: AttemptSeed): void {
  db.insert(attempts)
    .values({
      id: seed.id,
      studentId: seed.studentId,
      sourceType: seed.courseId === undefined ? "lesson" : "course",
      assignmentId: null,
      courseId: seed.courseId ?? null,
      unitId: null,
      attemptNo: 1,
      status: seed.status,
      startedAt: seed.startedAt,
      submittedAt: seed.submittedAt ?? null,
      activeSec: null,
      device: null,
      scoreAuto: null,
      scoreFinal: null,
      ...(seed.abandoned ? { abandonedAt: T5 } : {}),
    })
    .run();
}

interface ResponseSeed {
  attemptId: string;
  questionId: string;
  submittedAt?: string | null;
  finalCorrect?: boolean | null;
  autoCorrect?: boolean | null;
  answered?: boolean;
  studentFlag?: string | null;
}

function insertResponse(db: Db, seed: ResponseSeed): void {
  db.insert(responses)
    .values({
      id: `resp-${seed.attemptId}-${seed.questionId}`,
      attemptId: seed.attemptId,
      questionId: seed.questionId,
      unitId: null,
      questionVersion: 1,
      questionSnapshotJson: SNAP,
      answerJson: null,
      submittedAt: seed.submittedAt ?? null,
      autoCorrect: seed.autoCorrect ?? null,
      finalCorrect: seed.finalCorrect ?? null,
      answered: seed.answered ?? false,
      studentFlag: seed.studentFlag ?? null,
      teacherMark: null,
      teacherComment: null,
    })
    .run();
}

/** correction 阶段订正笔记行（kind=corrected 的 EXISTS 命中源） */
function insertCorrectionNote(
  db: Db,
  attemptId: string,
  questionId: string,
): void {
  db.insert(notes)
    .values({
      id: `note-${attemptId}-${questionId}`,
      attemptId,
      questionId,
      questionRevisionId: `rev-${questionId}`,
      phase: "correction",
      updatedAt: "2026-09-15T00:00:00.000Z",
    })
    .run();
}

async function getReview(
  app: ReturnType<typeof createApp>,
  cookie: string,
  studentId: string,
  query = "",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(
    `/api/teacher/students/${studentId}/question-review${query}`,
    { headers: { cookie } },
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

/** 取 setup 教师的 id（teachers 表唯一一行，setup 建立） */
function getTeacherId(db: Db): string {
  const row = db.select({ id: teachers.id }).from(teachers).get();
  if (row === undefined) throw new Error("setup 教师行不存在");
  return row.id;
}

describe("question-review 三 kind 行级口径", () => {
  it("kind=wrong：判错且已答的行入列；未做判错、draft 未提交行、作废卷排除；同题两轮取最近代表作答（redoCount/lastAt）", async () => {
    const { app, db, cookie } = await makeApp();
    const teacherId = getTeacherId(db);
    insertStudent(db, STU_A, teacherId);
    // qa-1：已交卷 T1，q1 判错（已答）、q2 判错但未做（#6980-3 不算错题）
    insertAttempt(db, {
      id: "qa-1",
      studentId: STU_A,
      status: "submitted",
      startedAt: T1,
      submittedAt: T1,
    });
    insertResponse(db, {
      attemptId: "qa-1",
      questionId: "q1",
      submittedAt: T1,
      finalCorrect: false,
      autoCorrect: false,
      answered: true,
    });
    insertResponse(db, {
      attemptId: "qa-1",
      questionId: "q2",
      submittedAt: T1,
      finalCorrect: false,
      autoCorrect: false,
      answered: false,
    });
    // qa-2：已交卷 T2，q1 第二轮判错（代表作答应取本轮）
    insertAttempt(db, {
      id: "qa-2",
      studentId: STU_A,
      status: "submitted",
      startedAt: T2,
      submittedAt: T2,
    });
    insertResponse(db, {
      attemptId: "qa-2",
      questionId: "q1",
      submittedAt: T2,
      finalCorrect: false,
      autoCorrect: false,
      answered: true,
    });
    // qa-3：进行中讲练 draft（T3），q3 未逐题提交（排除）、q4 已逐题提交（纳入）
    insertAttempt(db, {
      id: "qa-3",
      studentId: STU_A,
      status: "draft",
      startedAt: T3,
    });
    insertResponse(db, {
      attemptId: "qa-3",
      questionId: "q3",
      submittedAt: null,
      finalCorrect: false,
      answered: true,
    });
    insertResponse(db, {
      attemptId: "qa-3",
      questionId: "q4",
      submittedAt: T3,
      finalCorrect: false,
      answered: true,
    });
    // qa-4：作废卷（整卷排除）
    insertAttempt(db, {
      id: "qa-4",
      studentId: STU_A,
      status: "submitted",
      startedAt: T1,
      submittedAt: T1,
      abandoned: true,
    });
    insertResponse(db, {
      attemptId: "qa-4",
      questionId: "q5",
      submittedAt: T1,
      finalCorrect: false,
      answered: true,
    });

    const { status, body } = await getReview(app, cookie, STU_A);
    expect(status).toBe(200);
    const data = body.data as {
      total: number;
      nextCursor: string | null;
      questions: Array<Record<string, unknown>>;
    };
    // lastAt 倒序：q4（T3）在前、q1（T2）在后；q2/q3/q5 不入列
    expect(data.total).toBe(2);
    expect(data.questions.map((row) => row.questionId)).toEqual(["q4", "q1"]);
    const q1 = data.questions[1] as Record<string, unknown>;
    expect(q1.attemptId).toBe("qa-2");
    expect(q1.redoCount).toBe(1);
    expect(q1.lastAt).toBe(T2);
    expect(q1.finalCorrect).toBe(false);
    expect(q1.studentFlag).toBeNull();
    expect(q1.hasCorrection).toBe(false);
    expect(q1.hasAiHelp).toBe(false);
    expect(q1.type).toBe("choice");
    expect(q1.difficulty).toBe(3);
    expect(q1.knowledge).toEqual(["绝对值"]);
    expect(typeof q1.stemMd).toBe("string");
    // summary 行不含答案 / 解析 / 选项 / 学生答案键（本面只有判定与计数）
    for (const key of ["answer", "answers", "solutionMd", "options"]) {
      expect(Object.keys(q1)).not.toContain(key);
    }
    const q4 = data.questions[0] as Record<string, unknown>;
    expect(q4.attemptId).toBe("qa-3");
    expect(q4.redoCount).toBe(0);
    expect(q4.lastAt).toBe(T3);
  });

  it("kind=unsure：自标「不会」的行入列（判对也算），不出现在 wrong 档", async () => {
    const { app, db, cookie } = await makeApp();
    insertStudent(db, STU_A, getTeacherId(db));
    insertAttempt(db, {
      id: "qa-5",
      studentId: STU_A,
      status: "submitted",
      startedAt: T4,
      submittedAt: T4,
    });
    insertResponse(db, {
      attemptId: "qa-5",
      questionId: "q6",
      submittedAt: T4,
      finalCorrect: true,
      autoCorrect: true,
      answered: true,
      studentFlag: "unsure",
    });

    const unsure = await getReview(app, cookie, STU_A, "?kind=unsure");
    expect(unsure.status).toBe(200);
    const unsureData = unsure.body.data as {
      questions: Array<Record<string, unknown>>;
    };
    expect(unsureData.questions.map((row) => row.questionId)).toEqual(["q6"]);
    expect(unsureData.questions[0]?.studentFlag).toBe("unsure");

    const wrong = await getReview(app, cookie, STU_A);
    const wrongData = wrong.body.data as {
      questions: Array<Record<string, unknown>>;
    };
    expect(wrongData.questions).toHaveLength(0);
  });

  it("kind=corrected：有订正笔记的行入列（hasCorrection=true），无笔记的判错行不入列", async () => {
    const { app, db, cookie } = await makeApp();
    insertStudent(db, STU_A, getTeacherId(db));
    insertAttempt(db, {
      id: "qa-6",
      studentId: STU_A,
      status: "submitted",
      startedAt: T5,
      submittedAt: T5,
    });
    insertResponse(db, {
      attemptId: "qa-6",
      questionId: "q7",
      submittedAt: T5,
      finalCorrect: false,
      answered: true,
    });
    insertResponse(db, {
      attemptId: "qa-6",
      questionId: "q8",
      submittedAt: T5,
      finalCorrect: false,
      answered: true,
    });
    insertCorrectionNote(db, "qa-6", "q7");

    const { status, body } = await getReview(
      app,
      cookie,
      STU_A,
      "?kind=corrected",
    );
    expect(status).toBe(200);
    const data = body.data as {
      questions: Array<Record<string, unknown>>;
    };
    expect(data.questions.map((row) => row.questionId)).toEqual(["q7"]);
    expect(data.questions[0]?.hasCorrection).toBe(true);
  });
});

describe("question-review 筛选、分页与边界", () => {
  it("from / to 按单题提交时刻过滤（与 MCP-A 同轴）", async () => {
    const { app, db, cookie } = await makeApp();
    insertStudent(db, STU_A, getTeacherId(db));
    insertAttempt(db, {
      id: "qa-7",
      studentId: STU_A,
      status: "submitted",
      startedAt: T1,
      submittedAt: T3,
    });
    insertResponse(db, {
      attemptId: "qa-7",
      questionId: "q9",
      submittedAt: T1,
      finalCorrect: false,
      answered: true,
    });
    insertResponse(db, {
      attemptId: "qa-7",
      questionId: "q10",
      submittedAt: T3,
      finalCorrect: false,
      answered: true,
    });

    const fromView = await getReview(app, cookie, STU_A, `?from=${T2}`);
    expect(
      (fromView.body.data as { questions: Array<{ questionId: string }> })
        .questions,
    ).toEqual([expect.objectContaining({ questionId: "q10" })]);
    const toView = await getReview(app, cookie, STU_A, `?to=${T2}`);
    expect(
      (toView.body.data as { questions: Array<{ questionId: string }> })
        .questions,
    ).toEqual([expect.objectContaining({ questionId: "q9" })]);
  });

  it("courseId 只命中该课程来源的卷", async () => {
    const { app, db, cookie } = await makeApp();
    const teacherId = getTeacherId(db);
    insertStudent(db, STU_A, teacherId);
    const courseC1 = "44444444-0000-4000-8000-0000000000c1";
    const courseC2 = "44444444-0000-4000-8000-0000000000c2";
    // attempts.courseId 外键指向 courses——先建两门课程行再挂卷
    db.insert(courses)
      .values([
        {
          id: courseC1,
          teacherId,
          title: "课程一",
          order: 0,
          archivedAt: null,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
        {
          id: courseC2,
          teacherId,
          title: "课程二",
          order: 1,
          archivedAt: null,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      ])
      .run();
    insertAttempt(db, {
      id: "qa-8",
      studentId: STU_A,
      status: "submitted",
      startedAt: T1,
      submittedAt: T1,
      courseId: courseC1,
    });
    insertResponse(db, {
      attemptId: "qa-8",
      questionId: "q11",
      submittedAt: T1,
      finalCorrect: false,
      answered: true,
    });
    insertAttempt(db, {
      id: "qa-9",
      studentId: STU_A,
      status: "submitted",
      startedAt: T2,
      submittedAt: T2,
      courseId: "44444444-0000-4000-8000-0000000000c2",
    });
    insertResponse(db, {
      attemptId: "qa-9",
      questionId: "q12",
      submittedAt: T2,
      finalCorrect: false,
      answered: true,
    });

    const { body } = await getReview(
      app,
      cookie,
      STU_A,
      `?courseId=${courseC1}`,
    );
    expect(
      (body.data as { questions: Array<{ questionId: string }> }).questions,
    ).toEqual([expect.objectContaining({ questionId: "q11" })]);
  });

  it("分页：total 为聚合后题目数，cursor 翻页不重不漏，末页 nextCursor=null", async () => {
    const { app, db, cookie } = await makeApp();
    insertStudent(db, STU_A, getTeacherId(db));
    insertAttempt(db, {
      id: "qa-10",
      studentId: STU_A,
      status: "submitted",
      startedAt: T1,
      submittedAt: T1,
    });
    for (const qid of ["q13", "q14", "q15"]) {
      insertResponse(db, {
        attemptId: "qa-10",
        questionId: qid,
        submittedAt: T1,
        finalCorrect: false,
        answered: true,
      });
    }

    const page1 = await getReview(app, cookie, STU_A, "?limit=2");
    const data1 = page1.body.data as {
      total: number;
      nextCursor: string | null;
      questions: Array<{ questionId: string }>;
    };
    expect(data1.total).toBe(3);
    expect(data1.questions.map((row) => row.questionId)).toEqual([
      "q13",
      "q14",
    ]);
    expect(data1.nextCursor).toBe("2");

    const page2 = await getReview(app, cookie, STU_A, "?limit=2&cursor=2");
    const data2 = page2.body.data as {
      total: number;
      nextCursor: string | null;
      questions: Array<{ questionId: string }>;
    };
    expect(data2.questions.map((row) => row.questionId)).toEqual(["q15"]);
    expect(data2.nextCursor).toBeNull();
  });

  it("域隔离：他人学生的 id → 404 STUDENT_NOT_FOUND（不暴露存在性）", async () => {
    const { app, db, cookie } = await makeApp();
    db.insert(teachers)
      .values({
        id: TEACHER_B_ID,
        loginName: "teacher-b-qr",
        isAdmin: false,
        disabledAt: null,
        passwordHash: "scrypt$qr-fixture",
        apiToken: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
    insertStudent(db, STU_B, TEACHER_B_ID);

    const { status, body } = await getReview(app, cookie, STU_B);
    expect(status).toBe(404);
    expect(body.error).toBe("STUDENT_NOT_FOUND");
  });

  it("参数校验：kind 越界 / limit=0 → 400 VALIDATION_ERROR", async () => {
    const { app, cookie } = await makeApp();
    const badKind = await getReview(app, cookie, STU_A, "?kind=never");
    expect(badKind.status).toBe(400);
    expect(badKind.body.error).toBe("VALIDATION_ERROR");
    const badLimit = await getReview(app, cookie, STU_A, "?limit=0");
    expect(badLimit.status).toBe(400);
  });
});

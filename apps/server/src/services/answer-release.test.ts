import type { AttemptDetailData, AttemptResultData } from "@tutor/contract";
import { publicStemMd } from "@tutor/md-dsl";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import { attempts, questions, students, units } from "../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { HttpError } from "../lib/http-error.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { createAssignment, updateAssignment } from "./assignment-service.ts";
import {
  answersReleased,
  getAttemptDetail,
  saveDraftAnswer,
  startAttempt,
  submitAttempt,
} from "./attempt-service.ts";

/**
 * T2A.8（D11）答案公布时机服务层测试（可注入时钟，参照 course-service 定时测试先例）：
 * - answersReleased 纯函数：on_submit 恒公布；after_due 按 now ≥ dueAt 判定
 *   （读时比较、无定时任务）；after_due 无截止（防御态）fail closed；
 * - after_due 截止**前**：submit 响应与 GET 详情两份响应都是受限形态——
 *   answers/solutionMd/autoCorrect 全 null、题干公开化（比对 publicStemMd）、
 *   summary 对错计数零化（pending=answered 口径）、scoreAuto 置 null 投影
 *   （库里保留真实判分）；assertNoLeak 通过且未解锁提示内容绝不下发；
 * - 截止**后**：同一 attempt 详情完整可见（无需任何后台动作）；
 * - on_submit：全程完整（含设了截止时间的作业——截止不锁答案）；
 * - create/PATCH 的 400 三态：创建 after_due 无截止、改 after_due 而无截止、
 *   after_due 下取消截止；合法组合（同请求补截止）放行。
 */

/** 固定时钟（服务函数 now 参数注入，见各用例） */
const T0 = "2026-09-27T00:00:00.000Z";
/** 截止前（交卷与查看都取这一时刻） */
const BEFORE_DUE = "2026-09-27T12:00:00.000Z";
const DUE_AT = "2026-09-27T18:00:00.000Z";
/** 截止后（同一 attempt 的下一次读取） */
const AFTER_DUE = "2026-09-28T00:00:00.000Z";

/** 未解锁提示内容（泄露矩阵断言用——学生从未请求过它） */
const LOCKED_HINT = "提示一：想想正负的定义";

/** 捕获同步异常（不匹配则失败），course-service.test 同款 */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("期望抛出异常但没有");
}

/** 断言 HttpError 的状态码与错误码 */
function expectHttpError(
  err: unknown,
  status: number,
  code: string,
): asserts err is HttpError {
  if (!(err instanceof HttpError)) {
    throw new Error(`期望 HttpError，实际是 ${String(err)}`);
  }
  expect(err.status).toBe(status);
  expect(err.code).toBe(code);
}

/** 详情 data 断言为结果视图（交卷后读取的口径；拿到草稿视图即测试失败） */
function asResultView(data: AttemptDetailData): AttemptResultData {
  // 联合判别：结果视图必有 answersReleased（T2A.8），草稿视图没有
  if (!("answersReleased" in data)) {
    throw new Error("期望结果视图，实际拿到草稿视图");
  }
  return data;
}

/**
 * fixture：学生 + 单元 + 两道可自动判分的判断题（对 / 错，题干含 [[答案]] 标记）。
 * 原第二题为填空——2026-10-02 fill 全人工批改起改为判断：公布机制的「截止后
 * 完整恢复 scoreFinal=100」断言需要整卷交卷即 graded，含 fill 的卷恒进待批。
 */
function seed(db: Db): { studentId: string; unitId: string } {
  const studentId = crypto.randomUUID();
  db.insert(students)
    .values({
      id: studentId,
      teacherId: TEST_TEACHER_ID,
      displayName: "张三",
      loginName: `zhang-${studentId.slice(0, 8)}`,
      passwordHash: null,
      linkToken: `link-${studentId}`,
      createdAt: T0,
    })
    .run();
  const unitId = "u-release";
  db.insert(units)
    .values({
      id: unitId,
      teacherId: TEST_TEACHER_ID,
      courseId: null,
      folderId: null,
      lectureId: null,
      title: "有理数运算",
      topic: null,
      order: 0,
      updatedAt: T0,
      deletedAt: null,
    })
    .run();
  db.insert(questions)
    .values([
      {
        id: "rel-q1",
        teacherId: TEST_TEACHER_ID,
        unitId,
        order: 0,
        type: "judge",
        difficulty: 1,
        stemMd: "$0$ 既不是正数，也不是负数。[[正确]]",
        optionsJson: null,
        answersJson: JSON.stringify({ kind: "judge", value: true }),
        hintsJson: JSON.stringify([LOCKED_HINT]),
        solutionMd: "$0$ 是正数与负数的分界点。",
        sourceMd: "::::question",
        version: 1,
        updatedAt: T0,
        deletedAt: null,
      },
      {
        id: "rel-q2",
        teacherId: TEST_TEACHER_ID,
        unitId,
        order: 1,
        type: "judge",
        difficulty: 2,
        stemMd: "判断：方程 $x+1=3$ 的解是 $x=1$。[[错误]]",
        optionsJson: null,
        answersJson: JSON.stringify({ kind: "judge", value: false }),
        hintsJson: "[]",
        solutionMd: "移项得 $x=3-1=2$，解不是 $x=1$。",
        sourceMd: "::::question",
        version: 1,
        updatedAt: T0,
        deletedAt: null,
      },
    ])
    .run();
  return { studentId, unitId };
}

/**
 * 布置作业并交卷（两题全对）：返回定位三件套。
 * answerRelease/dueAt 透传给 createAssignment；交卷时刻由调用方传入 submit。
 */
function makeSubmittedAttempt(
  db: Db,
  options: {
    answerRelease?: "on_submit" | "after_due";
    dueAt?: string;
    submitAt?: string;
  },
): {
  studentId: string;
  assignmentId: string;
  attemptId: string;
} {
  const { studentId, unitId } = seed(db);
  const assignment = createAssignment(db, TEST_TEACHER_ID, {
    unitIds: [unitId],
    studentIds: [studentId],
    ...(options.dueAt !== undefined ? { dueAt: options.dueAt } : {}),
    ...(options.answerRelease !== undefined
      ? { answerRelease: options.answerRelease }
      : {}),
  });
  expect(assignment.answerRelease).toBe(options.answerRelease ?? "on_submit");
  const attempt = startAttempt(db, studentId, assignment.id);
  saveDraftAnswer(db, studentId, attempt.id, "rel-q1", {
    kind: "judge",
    value: true,
  });
  saveDraftAnswer(db, studentId, attempt.id, "rel-q2", {
    kind: "judge",
    value: false,
  });
  submitAttempt(db, studentId, attempt.id, options.submitAt ?? BEFORE_DUE);
  return { studentId, assignmentId: assignment.id, attemptId: attempt.id };
}

describe("answersReleased 纯函数（T2A.8 判定口径）", () => {
  it("on_submit 恒已公布（无论有无截止、now 取何值）", () => {
    expect(answersReleased({ answerRelease: "on_submit", dueAt: null })).toBe(
      true,
    );
    expect(
      answersReleased(
        { answerRelease: "on_submit", dueAt: "2099-01-01T00:00:00.000Z" },
        BEFORE_DUE,
      ),
    ).toBe(true);
  });

  it("after_due：now ≥ dueAt 才公布（边界 = 截止时刻即公布）；Date 与字符串两种 now 等价", () => {
    const assignment = {
      answerRelease: "after_due" as const,
      dueAt: DUE_AT,
    };
    expect(answersReleased(assignment, BEFORE_DUE)).toBe(false);
    expect(answersReleased(assignment, AFTER_DUE)).toBe(true);
    // 边界：恰好等于截止时刻 → 已公布
    expect(answersReleased(assignment, DUE_AT)).toBe(true);
    expect(answersReleased(assignment, new Date(AFTER_DUE))).toBe(true);
    expect(answersReleased(assignment, new Date(BEFORE_DUE))).toBe(false);
  });

  it("after_due 而 dueAt 缺失（防御态，create/PATCH 已 400 拦截）：fail closed 按未公布", () => {
    expect(answersReleased({ answerRelease: "after_due", dueAt: null })).toBe(
      false,
    );
  });
});

describe("after_due 截止前：受限形态（可注入时钟）", () => {
  it("submit 响应与 GET 详情两份响应都受限：逐字段断言 + assertNoLeak + 未解锁提示不下发", () => {
    const db = createTestDb();
    const { studentId, attemptId } = makeSubmittedAttempt(db, {
      answerRelease: "after_due",
      dueAt: DUE_AT,
      submitAt: BEFORE_DUE,
    });

    // 前置：库里确实有真实判分与答案（受限才有意义）
    const attemptRow = db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get();
    expect(attemptRow?.scoreAuto).toBe(100);
    expect(attemptRow?.submittedAt).toBe(BEFORE_DUE);

    // ① GET 详情（截止前读取）：受限形态
    const detail = asResultView(
      getAttemptDetail(db, studentId, attemptId, BEFORE_DUE),
    );
    expect(detail.answersReleased).toBe(false);
    expect(detail.dueAt).toBe(DUE_AT);
    // scoreAuto 置 null 投影（库里保留 100，见上方前置断言）
    expect(detail.attempt.scoreAuto).toBeNull();
    // summary 不泄露对错：correct/wrong/autoGradable=0、pending=answered 口径；
    // D9：scoreFinal/pendingCount 同法置 null 投影
    expect(detail.summary).toEqual({
      total: 2,
      answered: 2,
      correct: 0,
      wrong: 0,
      pending: 2,
      unanswered: 0,
      autoGradable: 0,
      scoreFinal: null,
      pendingCount: null,
    });

    const qs = detail.units.flatMap((unit) => unit.questions);
    expect(qs.length).toBe(2);
    // 题干 = publicStemMd 公开化版（[[答案]] 标记已替换为 [[]]，比对库内原文）
    const rawStems = new Map(
      db
        .select({ id: questions.id, stemMd: questions.stemMd })
        .from(questions)
        .all()
        .map((row) => [row.id, row.stemMd] as const),
    );
    for (const q of qs) {
      expect(q.answers).toBeNull();
      expect(q.solutionMd).toBeNull();
      expect(q.autoCorrect).toBeNull();
      expect(rawStems.get(q.snapshot.id)).toBeDefined();
      expect(q.snapshot.stemMd).toBe(
        publicStemMd(rawStems.get(q.snapshot.id) ?? ""),
      );
      expect(q.snapshot.stemMd).not.toContain("[[正确]]");
      expect(q.snapshot.stemMd).not.toContain("[[错误]]");
    }
    // 本人答案照常下发（受限形态仍可见）
    expect(qs.find((q) => q.questionId === "rel-q1")?.answer).toEqual({
      kind: "judge",
      value: true,
    });
    expect(qs.find((q) => q.questionId === "rel-q2")?.answer).toEqual({
      kind: "judge",
      value: false,
    });

    // 泄露矩阵：answer（本人答案）放行；answers/solutionMd 键名放行——契约要求
    // 受限形态保留这两个可空键（值恒 null，上方已逐字段断言），assertNoLeak 按
    // 键名判定故需放行；提示内容与其余教师侧键仍全量拦截
    assertNoLeak(detail, { allow: ["answer", "answers", "solutionMd"] });
    expect(JSON.stringify(detail)).not.toContain(LOCKED_HINT);
    expect(JSON.stringify(detail)).not.toContain("分界点"); // 详解文本
    expect(JSON.stringify(detail)).not.toContain("移项得"); // 详解文本

    // ② 交卷瞬间的 submit 响应同样是受限形态（同一口径二次断言）
    const db2 = createTestDb();
    const again = makeSubmittedAttempt(db2, {
      answerRelease: "after_due",
      dueAt: DUE_AT,
      submitAt: BEFORE_DUE,
    });
    const resubmitView = asResultView(
      getAttemptDetail(db2, again.studentId, again.attemptId, BEFORE_DUE),
    );
    expect(resubmitView.answersReleased).toBe(false);
    expect(resubmitView.attempt.scoreAuto).toBeNull();
    // 键名放行理由见上：值恒 null 已另行逐字段断言
    assertNoLeak(resubmitView, { allow: ["answer", "answers", "solutionMd"] });
  });
});

describe("截止后与 on_submit：完整形态", () => {
  it("同一 attempt：把 now 推到截止后，详情自动恢复完整（无任何后台动作）", () => {
    const db = createTestDb();
    const { studentId, attemptId } = makeSubmittedAttempt(db, {
      answerRelease: "after_due",
      dueAt: DUE_AT,
      submitAt: BEFORE_DUE,
    });

    const full = asResultView(
      getAttemptDetail(db, studentId, attemptId, AFTER_DUE),
    );
    expect(full.answersReleased).toBe(true);
    expect(full.attempt.scoreAuto).toBe(100);
    expect(full.summary).toEqual({
      total: 2,
      answered: 2,
      correct: 2,
      wrong: 0,
      pending: 0,
      unanswered: 0,
      autoGradable: 2,
      // D9：截止后恢复完整形态——scoreFinal=100、待批 0
      scoreFinal: 100,
      pendingCount: 0,
    });
    const qs = full.units.flatMap((unit) => unit.questions);
    expect(qs.find((q) => q.questionId === "rel-q1")?.answers).toEqual({
      kind: "judge",
      value: true,
    });
    expect(qs.find((q) => q.questionId === "rel-q1")?.autoCorrect).toBe(true);
    // 原始题干（含答案标记）恢复下发
    expect(
      qs.find((q) => q.questionId === "rel-q1")?.snapshot.stemMd,
    ).toContain("[[正确]]");
    expect(qs.find((q) => q.questionId === "rel-q2")?.solutionMd).toContain(
      "移项得",
    );
  });

  it("交卷时已过截止：submit 响应直接是完整形态", () => {
    const db = createTestDb();
    const { studentId, unitId } = seed(db);
    const assignment = createAssignment(db, TEST_TEACHER_ID, {
      unitIds: [unitId],
      studentIds: [studentId],
      dueAt: "2026-01-01T00:00:00.000Z", // 早已截止
      answerRelease: "after_due",
    });
    const attempt = startAttempt(db, studentId, assignment.id);
    const submitted = submitAttempt(db, studentId, attempt.id, AFTER_DUE);
    expect(submitted.answersReleased).toBe(true);
    // D1（T3.2a）：未作答客观题（两道判断）判 false 进分母 → 全错 0 分；
    // 且全部 finalCorrect 非 null → 交卷即 graded（D3，attempt 状态已是 graded）
    expect(submitted.attempt.scoreAuto).toBe(0);
    expect(submitted.attempt.status).toBe("graded");
    expect(
      submitted.units.flatMap((unit) => unit.questions)[0]?.answers,
    ).toEqual({ kind: "judge", value: true });
  });

  it("on_submit（默认与显式）全程完整：截止时间不锁答案", () => {
    const db = createTestDb();
    // 默认（缺省字段 = on_submit）且设了未来截止：交卷即完整
    const { studentId, attemptId } = makeSubmittedAttempt(db, {
      dueAt: DUE_AT,
      submitAt: BEFORE_DUE,
    });
    const detail = asResultView(
      getAttemptDetail(db, studentId, attemptId, BEFORE_DUE),
    );
    expect(detail.answersReleased).toBe(true);
    expect(detail.attempt.scoreAuto).toBe(100);

    // 显式 on_submit 同理
    const db2 = createTestDb();
    const explicit = makeSubmittedAttempt(db2, {
      answerRelease: "on_submit",
      dueAt: DUE_AT,
      submitAt: BEFORE_DUE,
    });
    const detail2 = asResultView(
      getAttemptDetail(db2, explicit.studentId, explicit.attemptId, BEFORE_DUE),
    );
    expect(detail2.answersReleased).toBe(true);
  });
});

describe("create/PATCH 的 400 三态与合法组合", () => {
  it("创建：answerRelease=after_due 而 dueAt 缺失 → 400 VALIDATION_ERROR（中文写明缘由）", () => {
    const db = createTestDb();
    const { studentId, unitId } = seed(db);
    const err = captureError(() =>
      createAssignment(db, TEST_TEACHER_ID, {
        unitIds: [unitId],
        studentIds: [studentId],
        answerRelease: "after_due",
      }),
    );
    expectHttpError(err, 400, "VALIDATION_ERROR");
    expect(err.message).toContain("截止后公布");
    expect(err.message).toContain("截止时间");
  });

  it("PATCH：无截止的作业改成 after_due → 400；after_due 下取消截止（dueAt 置 null）→ 400", () => {
    const db = createTestDb();
    const { studentId, unitId } = seed(db);
    // 无截止作业（默认 on_submit）
    const plain = createAssignment(db, TEST_TEACHER_ID, {
      unitIds: [unitId],
      studentIds: [studentId],
    });
    const errSwitch = captureError(() =>
      updateAssignment(db, TEST_TEACHER_ID, plain.id, {
        answerRelease: "after_due",
      }),
    );
    expectHttpError(errSwitch, 400, "VALIDATION_ERROR");
    expect(errSwitch.message).toContain("截止时间");

    // 有截止的 after_due 作业：显式置 null 取消截止 → 400（防死锁态）
    const due = createAssignment(db, TEST_TEACHER_ID, {
      unitIds: [unitId],
      studentIds: [studentId],
      dueAt: DUE_AT,
      answerRelease: "after_due",
    });
    const errRemove = captureError(() =>
      updateAssignment(db, TEST_TEACHER_ID, due.id, { dueAt: null }),
    );
    expectHttpError(errRemove, 400, "VALIDATION_ERROR");
    expect(errRemove.message).toContain("截止后公布");
  });

  it("合法组合放行：改 after_due 同时补截止；after_due 下改截止时间；先改回 on_submit 再取消截止", () => {
    const db = createTestDb();
    const { studentId, unitId } = seed(db);
    const plain = createAssignment(db, TEST_TEACHER_ID, {
      unitIds: [unitId],
      studentIds: [studentId],
    });

    // 同一请求补截止 → 合法
    const switched = updateAssignment(db, TEST_TEACHER_ID, plain.id, {
      answerRelease: "after_due",
      dueAt: DUE_AT,
    });
    expect(switched.answerRelease).toBe("after_due");
    expect(switched.dueAt).toBe(DUE_AT);

    // after_due 下改截止时间（非 null）→ 合法
    const moved = updateAssignment(db, TEST_TEACHER_ID, plain.id, {
      dueAt: AFTER_DUE,
    });
    expect(moved.dueAt).toBe(AFTER_DUE);
    expect(moved.answerRelease).toBe("after_due");

    // 先改回 on_submit 再取消截止 → 合法（同一请求即满足组合约束）
    const undone = updateAssignment(db, TEST_TEACHER_ID, plain.id, {
      answerRelease: "on_submit",
      dueAt: null,
    });
    expect(undone.answerRelease).toBe("on_submit");
    expect(undone.dueAt).toBeNull();
  });
});

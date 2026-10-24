import { randomUUID } from "node:crypto";
import type { AiAttemptReviewReport } from "@tutor/contract";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.ts";
import {
  aiAttemptReviewFacts,
  aiAttemptReviewTasks,
  aiTasks,
  assignments,
  attempts,
  responses,
  teachers,
} from "../../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../../db/test-utils.ts";
import { makeStudent } from "../../test/note-fixtures.ts";
import {
  attemptReviewActionOf,
  attemptReviewDetailOf,
  attemptReviewPreviewOf,
  claimAttemptReviewTask,
  createAttemptReviewTask,
  listAttemptReviewTasks,
  submitAttemptReviewResult,
} from "./student-ai-attempt-review.ts";
import { aiQueueSummaryOf } from "./student-ai-queue.ts";

/**
 * 本次练习整体复盘服务测试（任务 1ef854c7；交接方案 §10 矩阵的服务端部分：
 * T01–T07、T09–T12 主链路）。矩阵其余项（路由泄露双断言、迁移备份、E2E）
 * 由路由测试与流水线覆盖，未在本文件重复。
 *
 * 核心口径：整体任务与旧逐题批量并行不混装；四桶互斥；draft/未公布整卷
 * 统一拒绝；预览版本锚（范围/判分/公布态变化 → 409）；幂等键重放；同
 * attempt 活动任务唯一；待处理/日配额与逐题任务同事务合计；领取即出站
 * （快照含允许的答案解析、不含他人数据）；迟到/取消写回只记事实。
 */

const SECRET = "attempt-review-test-secret-0001";
/** 题面/解析哨兵：断言快照只含本人本卷内容 */
const SENTINEL_STEM = "SENTINEL_AR_STEM_A";
const SENTINEL_SOLUTION = "SENTINEL_AR_SOLUTION_A";
const OTHER_SENTINEL_STEM = "SENTINEL_AR_STEM_OTHER";

const active: ReturnType<typeof createTestDb>[] = [];

function world() {
  const db = createTestDb();
  active.push(db);
  db.update(teachers)
    .set({ passwordHash: "scrypt$fixture" })
    .where(eq(teachers.id, TEST_TEACHER_ID))
    .run();
  const studentId = makeStudent(db);
  const otherStudentId = makeStudent(db);
  return { db, studentId, otherStudentId };
}

afterEach(() => {
  for (const db of active.splice(0)) db.$client.close();
});

/** 已交卷作业卷（answerRelease 缺省 on_submit 即已公布） */
function insertSubmittedAttempt(
  db: Db,
  studentId: string,
  options: {
    answerRelease?: "on_submit" | "after_due";
    dueAt?: string | null;
    status?: "draft" | "submitted" | "graded";
  } = {},
) {
  const assignmentId = randomUUID();
  db.insert(assignments)
    .values({
      id: assignmentId,
      teacherId: TEST_TEACHER_ID,
      title: "整体复盘作业",
      dueAt: options.dueAt ?? null,
      answerRelease: options.answerRelease ?? "on_submit",
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    .run();
  const attemptId = randomUUID();
  db.insert(attempts)
    .values({
      id: attemptId,
      studentId,
      sourceType: "assignment",
      assignmentId,
      status: options.status ?? "submitted",
      startedAt: "2026-06-01T00:00:00.000Z",
      submittedAt:
        (options.status ?? "submitted") === "draft"
          ? null
          : "2026-06-01T01:00:00.000Z",
    })
    .run();
  return attemptId;
}

/** 结果页一题：自定义题面哨兵 + 最终判定 + 作答文本 + 笔迹存在性 */
function addResultQuestion(
  db: Db,
  attemptId: string,
  questionId: string,
  options: {
    stem?: string;
    solution?: string;
    finalCorrect?: boolean | null;
    answerIndex?: number | null;
    inkId?: string | null;
    badAnswerJson?: boolean;
  } = {},
) {
  const id = randomUUID();
  const answerJson =
    options.answerIndex === null || options.answerIndex === undefined
      ? options.badAnswerJson === true
        ? "{not-json"
        : null
      : JSON.stringify({ kind: "choice", index: options.answerIndex });
  db.insert(responses)
    .values({
      id,
      attemptId,
      questionId,
      unitId: "u-ar",
      questionVersion: 1,
      questionSnapshotJson: JSON.stringify({
        type: "choice",
        difficulty: 3,
        knowledge: ["考点A"],
        stemMd: options.stem ?? `题面-${questionId}`,
        options: [{ text: "甲" }, { text: "乙" }],
        answers: { kind: "choice", index: 1 },
        hints: [],
        solutionMd: options.solution ?? `解析-${questionId}`,
        sourceMd: "::::question{type=choice}\n题干\n:::",
        id: questionId,
      }),
      answerJson,
      submittedAt: "2026-06-01T01:00:00.000Z",
      autoCorrect: options.finalCorrect ?? null,
      finalCorrect: options.finalCorrect ?? null,
      inkId: options.inkId ?? null,
      teacherComment: null,
    })
    .run();
  return id;
}

/** 标准三题卷：1 对、1 错（有作答）、1 未作答 */
function threeQuestionAttempt(db: Db, studentId: string) {
  const attemptId = insertSubmittedAttempt(db, studentId);
  addResultQuestion(db, attemptId, "q-correct", {
    stem: SENTINEL_STEM,
    solution: SENTINEL_SOLUTION,
    finalCorrect: true,
    answerIndex: 1,
  });
  addResultQuestion(db, attemptId, "q-wrong", {
    finalCorrect: false,
    answerIndex: 0,
  });
  addResultQuestion(db, attemptId, "q-blank", {
    finalCorrect: null,
    answerIndex: null,
  });
  return attemptId;
}

function validReport(): AiAttemptReviewReport {
  return {
    schemaVersion: 1,
    overview: "本次练习覆盖 3 题，已判分正确率 50%。",
    knowledgeFindings: [
      {
        statement: "选择题考点已掌握",
        evidenceQuestionNos: [1],
        basis: "platform_fact",
        confidence: "high",
      },
    ],
    errorPatterns: [
      {
        statement: "第 2 题作答与参考答案不符（假设：审题偏差）",
        evidenceQuestionNos: [2],
        basis: "ai_hypothesis",
        confidence: "medium",
      },
    ],
    performanceNotes: [
      {
        statement: "1 题未作答",
        evidenceQuestionNos: [3],
        basis: "platform_fact",
        confidence: "high",
      },
    ],
    trainingPlan: [
      {
        knowledgePoint: "考点A",
        relatedQuestionNos: [2, 3],
        action: "完成一组同类题补练",
        priority: "high",
        caveat: "待补练后验证，不保证提分",
      },
    ],
    limitations: ["正式笔迹未包含，不能分析书写过程"],
  };
}

describe("整体复盘：范围、四桶与预览", () => {
  it("T01/T02 四桶互斥加总=题数；未作答不当待批；未公布整卷拒绝", () => {
    const { db, studentId } = world();
    const attemptId = threeQuestionAttempt(db, studentId);
    const preview = attemptReviewPreviewOf(
      db,
      { studentId, attemptId },
      { hmacSecret: SECRET },
    );
    expect(preview.questionCount).toBe(3);
    expect(preview.counts).toMatchObject({
      total: 3,
      correctCount: 1,
      incorrectCount: 1,
      unansweredCount: 1,
      pendingCount: 0,
      gradedCount: 2,
      accuracyAmongGraded: 0.5,
    });
    expect(preview.notes.length).toBeGreaterThan(0);

    // draft / 未公布 → 整卷统一拒绝
    const draftAttempt = insertSubmittedAttempt(db, studentId, {
      status: "draft",
    });
    expect(() =>
      attemptReviewPreviewOf(
        db,
        { studentId, attemptId: draftAttempt },
        { hmacSecret: SECRET },
      ),
    ).toThrowError(/还未交卷/);

    const unreleased = insertSubmittedAttempt(db, studentId, {
      answerRelease: "after_due",
      dueAt: "2099-01-01T00:00:00.000Z",
    });
    expect(() =>
      attemptReviewPreviewOf(
        db,
        { studentId, attemptId: unreleased },
        { hmacSecret: SECRET },
      ),
    ).toThrowError(/答案未公布/);
  });

  it("T02 坏 answerJson → unknown 作答态计入待批，不假报未做", () => {
    const { db, studentId } = world();
    const attemptId = insertSubmittedAttempt(db, studentId);
    addResultQuestion(db, attemptId, "q-bad", {
      finalCorrect: null,
      answerIndex: null,
      badAnswerJson: true,
    });
    const preview = attemptReviewPreviewOf(
      db,
      { studentId, attemptId },
      { hmacSecret: SECRET },
    );
    expect(preview.counts.unknownAnswerCount).toBe(1);
    expect(preview.counts.pendingCount).toBe(1);
    expect(preview.counts.missingAnswerCount).toBe(0);
    // 回归（/code-review）：含 unknown 的卷也要能通过创建（作答态三桶之和
    // = 总数，否则坏 answerJson 的练习预览能过、创建必炸，成为功能死角）
    const { task, created } = createAttemptReviewTask(
      db,
      {
        studentId,
        attemptId,
        mutationId: "m-unknown",
        expectedPreviewVersion: preview.opaquePreviewVersion,
        purpose: "复盘",
      },
      { hmacSecret: SECRET },
    );
    expect(created).toBe(true);
    expect(task.questionCount).toBe(1);
  });

  it("T06 手写笔迹：作答态为已作答并声明不能分析笔迹，不冒充未作答", () => {
    const { db, studentId } = world();
    const attemptId = insertSubmittedAttempt(db, studentId);
    addResultQuestion(db, attemptId, "q-ink", {
      finalCorrect: null,
      answerIndex: null,
      inkId: "ink-1",
    });
    const preview = attemptReviewPreviewOf(
      db,
      { studentId, attemptId },
      { hmacSecret: SECRET },
    );
    expect(preview.counts.hasAnswerCount).toBe(1);
    expect(preview.notes.some((note) => note.includes("正式笔迹"))).toBe(true);
  });

  it("T06 超 30 题明确拒绝（不截断）", () => {
    const { db, studentId } = world();
    const attemptId = insertSubmittedAttempt(db, studentId);
    for (let i = 0; i < 31; i += 1) {
      addResultQuestion(db, attemptId, `q-${i}`, { finalCorrect: false });
    }
    expect(() =>
      attemptReviewPreviewOf(
        db,
        { studentId, attemptId },
        { hmacSecret: SECRET },
      ),
    ).toThrowError(/整体复盘上限/);
  });
});

describe("整体复盘：创建、幂等与配额", () => {
  it("T01 创建成功：任务落库、事实落账、快照自检通过", () => {
    const { db, studentId } = world();
    const attemptId = threeQuestionAttempt(db, studentId);
    const preview = attemptReviewPreviewOf(
      db,
      { studentId, attemptId },
      { hmacSecret: SECRET },
    );
    const { task, created } = createAttemptReviewTask(
      db,
      {
        studentId,
        attemptId,
        mutationId: "m-1",
        expectedPreviewVersion: preview.opaquePreviewVersion,
        purpose: "帮我看看这次练习的整体问题",
      },
      { hmacSecret: SECRET },
    );
    expect(created).toBe(true);
    expect(task.status).toBe("created");
    expect(task.questionCount).toBe(3);
    const facts = db
      .select()
      .from(aiAttemptReviewFacts)
      .where(eq(aiAttemptReviewFacts.taskId, task.id))
      .all();
    expect(facts.map((fact) => fact.type)).toContain("task_created");
  });

  it("T04 预览版本锚：跳过预览/范围变化后创建 → 409 要求重新预览", () => {
    const { db, studentId } = world();
    const attemptId = threeQuestionAttempt(db, studentId);
    expect(() =>
      createAttemptReviewTask(
        db,
        {
          studentId,
          attemptId,
          mutationId: "m-stale",
          expectedPreviewVersion: "v1-forged",
          purpose: "复盘",
        },
        { hmacSecret: SECRET },
      ),
    ).toThrowError(/重新预览/);

    // 预览后教师批改（判分变化）→ 同版本创建 409
    const preview = attemptReviewPreviewOf(
      db,
      { studentId, attemptId },
      { hmacSecret: SECRET },
    );
    db.update(responses)
      .set({ finalCorrect: true })
      .where(eq(responses.questionId, "q-blank"))
      .run();
    expect(() =>
      createAttemptReviewTask(
        db,
        {
          studentId,
          attemptId,
          mutationId: "m-2",
          expectedPreviewVersion: preview.opaquePreviewVersion,
          purpose: "复盘",
        },
        { hmacSecret: SECRET },
      ),
    ).toThrowError(/范围或判定已变化/);
  });

  it("T05 幂等键：同键同内容重放返回原任务；同键异内容 409", () => {
    const { db, studentId } = world();
    const attemptId = threeQuestionAttempt(db, studentId);
    const preview = attemptReviewPreviewOf(
      db,
      { studentId, attemptId },
      { hmacSecret: SECRET },
    );
    const version = preview.opaquePreviewVersion;
    const first = createAttemptReviewTask(
      db,
      {
        studentId,
        attemptId,
        mutationId: "m-idem",
        expectedPreviewVersion: version,
        purpose: "复盘",
      },
      { hmacSecret: SECRET },
    );
    expect(first.created).toBe(true);
    const replay = createAttemptReviewTask(
      db,
      {
        studentId,
        attemptId,
        mutationId: "m-idem",
        expectedPreviewVersion: version,
        purpose: "复盘",
      },
      { hmacSecret: SECRET },
    );
    expect(replay.created).toBe(false);
    expect(replay.task.id).toBe(first.task.id);
    expect(() =>
      createAttemptReviewTask(
        db,
        {
          studentId,
          attemptId,
          mutationId: "m-idem",
          expectedPreviewVersion: version,
          purpose: "不同的复盘诉求",
        },
        { hmacSecret: SECRET },
      ),
    ).toThrowError(/幂等键已用于不同内容/);
  });

  it("T09 同 attempt 活动任务唯一：同范围复用，不同诉求 409", () => {
    const { db, studentId } = world();
    const attemptId = threeQuestionAttempt(db, studentId);
    const preview = attemptReviewPreviewOf(
      db,
      { studentId, attemptId },
      { hmacSecret: SECRET },
    );
    const version = preview.opaquePreviewVersion;
    const first = createAttemptReviewTask(
      db,
      {
        studentId,
        attemptId,
        mutationId: "m-a",
        expectedPreviewVersion: version,
        purpose: "复盘",
      },
      { hmacSecret: SECRET },
    );
    const reuse = createAttemptReviewTask(
      db,
      {
        studentId,
        attemptId,
        mutationId: "m-b",
        expectedPreviewVersion: version,
        purpose: "复盘",
      },
      { hmacSecret: SECRET },
    );
    expect(reuse.created).toBe(false);
    expect(reuse.task.id).toBe(first.task.id);
    expect(() =>
      createAttemptReviewTask(
        db,
        {
          studentId,
          attemptId,
          mutationId: "m-c",
          expectedPreviewVersion: version,
          purpose: "只看错题规律",
        },
        { hmacSecret: SECRET },
      ),
    ).toThrowError(/已有进行中的整体复盘任务/);
  });

  it("T09 待处理配额与逐题任务同事务合计（10 上限）", () => {
    const { db, studentId } = world();
    const attemptId = threeQuestionAttempt(db, studentId);
    // 直接种 10 个逐题任务行（pending 桶）占满待处理配额
    for (let i = 0; i < 10; i += 1) {
      db.insert(aiTasks)
        .values({
          id: randomUUID(),
          studentId,
          attemptId,
          questionId: `q-${i}`,
          questionRevisionId: randomUUID(),
          channel: "mcp",
          modeAtSend: "open_study",
          promptHash: "hash",
          contextSnapshotJson: "{}",
          beforeSubmit: false,
          mutationId: `quota-${i}`,
          status: "created",
          createdAt: "2026-06-01T02:00:00.000Z",
          updatedAt: "2026-06-01T02:00:00.000Z",
        })
        .run();
    }
    const preview = attemptReviewPreviewOf(
      db,
      { studentId, attemptId },
      { hmacSecret: SECRET },
    );
    expect(() =>
      createAttemptReviewTask(
        db,
        {
          studentId,
          attemptId,
          mutationId: "m-quota",
          expectedPreviewVersion: preview.opaquePreviewVersion,
          purpose: "复盘",
        },
        { hmacSecret: SECRET },
      ),
    ).toThrowError(/待处理的 AI 任务已达上限/);
  });

  it("T09-b 列表 keyset 翻页不重不漏（回归：AND(lt,lte) 会整段漏行）", () => {
    const { db, studentId } = world();
    for (let i = 0; i < 25; i += 1) {
      const attemptId = threeQuestionAttempt(db, studentId);
      const preview = attemptReviewPreviewOf(
        db,
        { studentId, attemptId },
        { hmacSecret: SECRET },
      );
      const { task } = createAttemptReviewTask(
        db,
        {
          studentId,
          attemptId,
          mutationId: `m-page-${i}`,
          expectedPreviewVersion: preview.opaquePreviewVersion,
          purpose: "复盘",
        },
        { hmacSecret: SECRET },
      );
      // 建完立即转终态（replied 不占待处理配额），否则第 11 个任务被
      // AI_TASK_PENDING_PER_STUDENT 挡下——本用例只测翻页，不走配额
      db.update(aiAttemptReviewTasks)
        .set({ status: "replied" })
        .where(eq(aiAttemptReviewTasks.id, task.id))
        .run();
    }
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = listAttemptReviewTasks(db, {
        studentId,
        limit: 10,
        ...(cursor !== null ? { cursor } : {}),
      });
      for (const task of page.tasks) {
        expect(seen.has(task.id)).toBe(false);
        seen.add(task.id);
      }
      pages += 1;
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen.size).toBe(25);
    expect(pages).toBe(3);
  });
});

describe("整体复盘：领取、租约与写回", () => {
  function createTask(db: Db, studentId: string, attemptId: string) {
    const preview = attemptReviewPreviewOf(
      db,
      { studentId, attemptId },
      { hmacSecret: SECRET },
    );
    return createAttemptReviewTask(
      db,
      {
        studentId,
        attemptId,
        mutationId: `m-${randomUUID()}`,
        expectedPreviewVersion: preview.opaquePreviewVersion,
        purpose: "复盘",
      },
      { hmacSecret: SECRET },
    ).task;
  }

  it("T07 领取即出站：整体快照含本卷内容与答案解析，不含他人数据；旧逐题不受影响", () => {
    const { db, studentId, otherStudentId } = world();
    const attemptId = threeQuestionAttempt(db, studentId);
    createTask(db, studentId, attemptId);
    const otherAttempt = insertSubmittedAttempt(db, otherStudentId);
    addResultQuestion(db, otherAttempt, "q-other", {
      stem: OTHER_SENTINEL_STEM,
      finalCorrect: true,
    });
    createTask(db, otherStudentId, otherAttempt);

    const view = claimAttemptReviewTask(
      db,
      { studentId },
      { hmacSecret: SECRET },
    );
    expect(view).not.toBeNull();
    const raw = JSON.stringify(view);
    expect(view?.taskKind).toBe("attempt_review");
    expect(view?.generation).toBe(1);
    expect(raw).toContain(SENTINEL_STEM);
    expect(raw).toContain(SENTINEL_SOLUTION);
    expect(raw).toContain("注入防御");
    expect(raw).not.toContain(OTHER_SENTINEL_STEM);
    expect(view?.snapshot.questions).toHaveLength(3);
    // 题序 = 学生结果视图展示序（回归：查表自然序会走唯一索引返回 UUID
    // 序，与学生卷面错位、证据题号指错题）
    expect(
      view?.snapshot.questions.map((question) => question.questionId),
    ).toEqual(["q-correct", "q-wrong", "q-blank"]);
  });

  it("T04 领取时范围变化：指定领取 → 409 且任务转 paused；恢复后可重试", () => {
    const { db, studentId } = world();
    const attemptId = threeQuestionAttempt(db, studentId);
    const task = createTask(db, studentId, attemptId);
    db.update(responses)
      .set({ finalCorrect: true })
      .where(eq(responses.questionId, "q-blank"))
      .run();
    expect(() =>
      claimAttemptReviewTask(
        db,
        { studentId, taskId: task.id },
        { hmacSecret: SECRET },
      ),
    ).toThrowError(/范围或授权已变化/);
    const paused = db
      .select()
      .from(aiAttemptReviewTasks)
      .where(eq(aiAttemptReviewTasks.id, task.id))
      .get();
    expect(paused?.status).toBe("paused");

    // paused → retry → 范围已重算（重新预览创建新任务才对；这里只验证
    // retry 动作把任务送回 created，领取时仍会被范围门拦住）
    attemptReviewActionOf(db, {
      studentId,
      taskId: task.id,
      action: "retry",
    });
    const retried = db
      .select()
      .from(aiAttemptReviewTasks)
      .where(eq(aiAttemptReviewTasks.id, task.id))
      .get();
    expect(retried?.status).toBe("created");
    expect(() =>
      claimAttemptReviewTask(
        db,
        { studentId, taskId: task.id },
        { hmacSecret: SECRET },
      ),
    ).toThrowError(/范围或授权已变化/);
  });

  it("T10 租约到期惰性回收：过期后可重新领取，代次递增", () => {
    const { db, studentId } = world();
    const attemptId = threeQuestionAttempt(db, studentId);
    const task = createTask(db, studentId, attemptId);
    const t0 = "2026-06-01T03:00:00.000Z";
    const first = claimAttemptReviewTask(
      db,
      { studentId, taskId: task.id },
      { hmacSecret: SECRET, now: t0 },
    );
    expect(first?.lease.leaseToken).toBeDefined();
    // 11 分钟后租约过期：重新领取成功，代次 +1
    const second = claimAttemptReviewTask(
      db,
      { studentId, taskId: task.id },
      { hmacSecret: SECRET, now: "2026-06-01T03:11:00.000Z" },
    );
    expect(second?.generation).toBe((first?.generation ?? 0) + 1);
  });

  it("T11 写回：成功入库、证据越界拒绝、迟到落账不覆盖、同内容幂等", () => {
    const { db, studentId } = world();
    const attemptId = threeQuestionAttempt(db, studentId);
    const task = createTask(db, studentId, attemptId);
    const claimed = claimAttemptReviewTask(
      db,
      { studentId, taskId: task.id },
      { hmacSecret: SECRET },
    );
    expect(claimed).not.toBeNull();

    // 证据越界 → 400
    const wild = {
      ...validReport(),
      errorPatterns: [
        {
          statement: "越界证据（伪造）",
          evidenceQuestionNos: [99],
          basis: "ai_hypothesis" as const,
          confidence: "medium" as const,
        },
      ],
    };
    expect(() =>
      submitAttemptReviewResult(
        db,
        {
          studentId,
          taskId: task.id,
          leaseToken: claimed?.lease.leaseToken ?? "",
          generation: claimed?.generation ?? 0,
          snapshotVersion: claimed?.snapshotVersion ?? "",
          report: wild,
        },
        { hmacSecret: SECRET },
      ),
    ).toThrowError(/范围之外/);

    // 成功写回
    const result = submitAttemptReviewResult(
      db,
      {
        studentId,
        taskId: task.id,
        leaseToken: claimed?.lease.leaseToken ?? "",
        generation: claimed?.generation ?? 0,
        snapshotVersion: claimed?.snapshotVersion ?? "",
        report: validReport(),
      },
      { hmacSecret: SECRET },
    );
    expect(result.duplicate).toBe(false);

    // 详情可读：报告 + hasResult
    const detail = attemptReviewDetailOf(db, { studentId, taskId: task.id });
    expect(detail.task.status).toBe("replied");
    expect(detail.task.hasResult).toBe(true);
    expect(detail.result?.overview).toContain("3 题");

    // 同内容重放幂等；同代异内容 409
    const replay = submitAttemptReviewResult(
      db,
      {
        studentId,
        taskId: task.id,
        leaseToken: claimed?.lease.leaseToken ?? "",
        generation: claimed?.generation ?? 0,
        snapshotVersion: claimed?.snapshotVersion ?? "",
        report: validReport(),
      },
      { hmacSecret: SECRET },
    );
    expect(replay.duplicate).toBe(true);
    expect(() =>
      submitAttemptReviewResult(
        db,
        {
          studentId,
          taskId: task.id,
          leaseToken: claimed?.lease.leaseToken ?? "",
          generation: claimed?.generation ?? 0,
          snapshotVersion: claimed?.snapshotVersion ?? "",
          report: { ...validReport(), overview: "另一个版本" },
        },
        { hmacSecret: SECRET },
      ),
    ).toThrowError(/不同内容的报告/);

    // 迟到写回（已回信后换代次再提交：租约核对失效）→ 409 + late_reply
    // 事实，已有报告不被覆盖
    expect(() =>
      submitAttemptReviewResult(
        db,
        {
          studentId,
          taskId: task.id,
          leaseToken: "someone-else",
          generation: (claimed?.generation ?? 0) + 7,
          snapshotVersion: claimed?.snapshotVersion ?? "",
          report: validReport(),
        },
        { hmacSecret: SECRET },
      ),
    ).toThrowError(/迟到事实|租约已失效/);
    const facts = db
      .select()
      .from(aiAttemptReviewFacts)
      .where(eq(aiAttemptReviewFacts.taskId, task.id))
      .all();
    expect(facts.map((fact) => fact.type)).toContain("late_reply");
  });

  it("T12 顶栏三计数并入整体任务；归档/打开动作按表裁决", () => {
    const { db, studentId } = world();
    const attemptId = threeQuestionAttempt(db, studentId);
    const task = createTask(db, studentId, attemptId);
    expect(aiQueueSummaryOf(db, studentId).pendingCount).toBe(1);

    const claimed = claimAttemptReviewTask(
      db,
      { studentId, taskId: task.id },
      { hmacSecret: SECRET },
    );
    expect(aiQueueSummaryOf(db, studentId).processingCount).toBe(1);
    submitAttemptReviewResult(
      db,
      {
        studentId,
        taskId: task.id,
        leaseToken: claimed?.lease.leaseToken ?? "",
        generation: claimed?.generation ?? 0,
        snapshotVersion: claimed?.snapshotVersion ?? "",
        report: validReport(),
      },
      { hmacSecret: SECRET },
    );
    const summary = aiQueueSummaryOf(db, studentId);
    expect(summary.unreadReplyCount).toBe(1);

    // open → 未读清零；created 状态不能 open（409）
    attemptReviewActionOf(db, { studentId, taskId: task.id, action: "open" });
    expect(aiQueueSummaryOf(db, studentId).unreadReplyCount).toBe(0);
    attemptReviewActionOf(db, {
      studentId,
      taskId: task.id,
      action: "archive",
    });
    const detail = attemptReviewDetailOf(db, { studentId, taskId: task.id });
    expect(detail.task.archivedAt).not.toBeNull();
    // 归档不改状态（replied），open/archive 仍合法；cancel 不在允许表 → 409
    expect(() =>
      attemptReviewActionOf(db, {
        studentId,
        taskId: task.id,
        action: "cancel",
      }),
    ).toThrowError(/不支持该动作/);
  });
});

import { randomUUID } from "node:crypto";
import type { AiBatchCreateData } from "@tutor/contract";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.ts";
import {
  aiTasks,
  assignments,
  attempts,
  responses,
  teachers,
} from "../../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../../db/test-utils.ts";
import { makeStudent } from "../../test/note-fixtures.ts";
import { createAiBatchReviewTasks } from "./student-ai-batch.ts";
import { claimMcpTask, createAiTask } from "./student-ai-queue.ts";
import { outboundAssemblyOfTask } from "./student-ai-worker.ts";

/**
 * SAI-31 批量错题复盘服务测试（B16「先测」①②③④⑤ 的服务端部分）。
 *
 * 批量语义：一题一份上下文（不拼卷、不注入当天概况）；逐项裁决——判对/
 * 无权/未公布/未交卷/缺快照逐项拒绝，一题失败不连坐；幂等键按批派生
 * （重放不重复创建）；同题已有进行中任务复用不重复计费（paused）；配额
 * 超限逐项失败。可选题从本人本次结果的 responses 行推导，不信请求里的
 * 任何 correct 标记（请求结构上就没有该字段）。
 */

const SECRET = "batch-review-test-secret-0001";
/** 三题题面哨兵：断言每份快照/出站只含本题 */
const SENTINELS = [
  "SENTINEL_STEM_Q1",
  "SENTINEL_STEM_Q2",
  "SENTINEL_STEM_Q3",
] as const;

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

/** 结果页一题：自定义题面哨兵 + 最终判定（null=待批） */
function addResultQuestion(
  db: Db,
  attemptId: string,
  questionId: string,
  options: {
    stem?: string;
    finalCorrect?: boolean | null;
    snapshotNull?: boolean;
  } = {},
) {
  const id = randomUUID();
  db.insert(responses)
    .values({
      id,
      attemptId,
      questionId,
      unitId: null,
      questionVersion: 1,
      questionSnapshotJson: options.snapshotNull
        ? null
        : JSON.stringify({
            type: "choice",
            difficulty: 3,
            knowledge: ["考点A"],
            stemMd: options.stem ?? `题面-${questionId}`,
            options: [{ text: "甲" }, { text: "乙" }],
            answers: { kind: "choice", index: 1 },
            hints: [],
            solutionMd: `解析-${questionId}`,
            sourceMd: "::::question{type=choice}\n题干\n:::",
            id: questionId,
          }),
      answerJson: null,
      submittedAt: "2026-06-01T00:00:00.000Z",
      autoCorrect: options.finalCorrect ?? null,
      finalCorrect: options.finalCorrect ?? null,
      teacherComment: null,
    })
    .run();
  return id;
}

/**
 * 一份已交卷作业卷（answerRelease 可指定，缺省 on_submit 即已公布）。
 * status 可指定（draft 用例）；题目行由调用方按需 addResultQuestion。
 */
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
      title: "批量复盘作业",
      dueAt: options.dueAt ?? null,
      answerRelease: options.answerRelease ?? "on_submit",
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    .run();
  const attemptId = randomUUID();
  const submitted = options.status ?? "submitted";
  db.insert(attempts)
    .values({
      id: attemptId,
      studentId,
      sourceType: "assignment",
      assignmentId,
      courseId: null,
      unitId: null,
      lectureId: null,
      attemptNo: 1,
      status: submitted,
      startedAt: "2026-06-01T00:00:00.000Z",
      submittedAt: submitted === "draft" ? null : "2026-06-01T01:00:00.000Z",
      frozenAt: "2026-06-01T00:00:00.000Z",
      legacyUnverified: false,
      abandonedAt: null,
    })
    .run();
  return attemptId;
}

/** 统一批量调用（单通道单诉求），默认三题错题集 */
function batchOf(
  db: Db,
  studentId: string,
  items: { attemptId: string; questionId: string }[],
  mutationId = "batch-mut-1",
  channel: "inapp" | "mcp" | "link" = "inapp",
): AiBatchCreateData {
  return createAiBatchReviewTasks(
    db,
    {
      studentId,
      items,
      channel,
      question: "请帮我复盘这道题",
      mutationId,
    },
    { hmacSecret: SECRET },
  );
}

function itemsOf(attemptId: string, questionIds: string[]) {
  return questionIds.map((questionId) => ({ attemptId, questionId }));
}

/** 单条目结果的强类型取回（noUncheckedIndexedAccess 下的测试断言助手） */
function soleItem(result: AiBatchCreateData) {
  expect(result.items).toHaveLength(1);
  const [item] = result.items;
  if (item === undefined) throw new Error("测试前提失败：应有且仅有一项结果");
  return item;
}

function tasksOf(db: Db, studentId: string) {
  return db
    .select()
    .from(aiTasks)
    .where(eq(aiTasks.studentId, studentId))
    .all();
}

describe("SAI-31 批量复盘服务：可选题来源与逐项裁决（先测①②）", () => {
  it("全判对卷：逐项拒绝「已判对」，不创建任何任务", () => {
    const { db, studentId } = world();
    const attemptId = insertSubmittedAttempt(db, studentId);
    addResultQuestion(db, attemptId, "q-1", { finalCorrect: true });
    addResultQuestion(db, attemptId, "q-2", { finalCorrect: true });
    const result = batchOf(db, studentId, itemsOf(attemptId, ["q-1", "q-2"]));
    expect(result.summary).toEqual({
      created: 0,
      alreadyExists: 0,
      paused: 0,
      failed: 2,
    });
    expect(result.items.every((item) => item.outcome === "failed")).toBe(true);
    expect(result.items.every((item) => item.taskId === null)).toBe(true);
    expect(tasksOf(db, studentId)).toHaveLength(0);
  });

  it("全待批卷：待批题可加入（学生主动勾选由前端把关），服务端照常创建", () => {
    const { db, studentId } = world();
    const attemptId = insertSubmittedAttempt(db, studentId);
    addResultQuestion(db, attemptId, "q-1", { finalCorrect: null });
    addResultQuestion(db, attemptId, "q-2", { finalCorrect: null });
    const result = batchOf(db, studentId, itemsOf(attemptId, ["q-1", "q-2"]));
    expect(result.summary.created).toBe(2);
    expect(tasksOf(db, studentId)).toHaveLength(2);
  });

  it("混合卷：错题与待批创建，判对逐项拒绝（伪造请求也不放过）", () => {
    const { db, studentId } = world();
    const attemptId = insertSubmittedAttempt(db, studentId);
    addResultQuestion(db, attemptId, "q-wrong", { finalCorrect: false });
    addResultQuestion(db, attemptId, "q-pending", { finalCorrect: null });
    addResultQuestion(db, attemptId, "q-right", { finalCorrect: true });
    const result = batchOf(db, studentId, [
      { attemptId, questionId: "q-wrong" },
      { attemptId, questionId: "q-pending" },
      { attemptId, questionId: "q-right" },
    ]);
    expect(result.summary).toEqual({
      created: 2,
      alreadyExists: 0,
      paused: 0,
      failed: 1,
    });
    const rejected = result.items.find((item) => item.outcome === "failed");
    expect(rejected?.questionId).toBe("q-right");
    expect(rejected?.error).toContain("已判对");
  });

  it("长列表超过学生待处理配额：前 10 题创建、其后逐项带配额原因失败", () => {
    const { db, studentId } = world();
    const attemptId = insertSubmittedAttempt(db, studentId);
    const questionIds = Array.from({ length: 12 }, (_, i) => `q-long-${i}`);
    for (const id of questionIds) {
      addResultQuestion(db, attemptId, id, { finalCorrect: false });
    }
    const result = batchOf(db, studentId, itemsOf(attemptId, questionIds));
    expect(result.items).toHaveLength(12);
    expect(result.summary.created).toBe(10);
    expect(result.summary.failed).toBe(2);
    const quotaFailed = result.items.filter(
      (item) => item.outcome === "failed",
    );
    expect(quotaFailed.length).toBe(2);
    for (const item of quotaFailed) {
      expect(item.error).toContain("上限");
    }
  });

  it("他人 attemptId / 不在卷内的题：逐项拒绝且不泄露对错", () => {
    const { db, studentId, otherStudentId } = world();
    const mineId = insertSubmittedAttempt(db, studentId);
    addResultQuestion(db, mineId, "q-mine", { finalCorrect: false });
    const otherId = insertSubmittedAttempt(db, otherStudentId);
    addResultQuestion(db, otherId, "q-other", { finalCorrect: false });
    const result = batchOf(db, studentId, [
      { attemptId: mineId, questionId: "q-mine" },
      { attemptId: otherId, questionId: "q-other" },
      { attemptId: mineId, questionId: "q-not-in-attempt" },
    ]);
    expect(result.summary).toEqual({
      created: 1,
      alreadyExists: 0,
      paused: 0,
      failed: 2,
    });
    const other = result.items.find((item) => item.questionId === "q-other");
    expect(other?.outcome).toBe("failed");
    expect(other?.error).toContain("只能查看自己的作答");
    const missing = result.items.find(
      (item) => item.questionId === "q-not-in-attempt",
    );
    expect(missing?.outcome).toBe("failed");
    expect(missing?.error).toContain("不属于这次练习");
  });

  it("未公布（after_due 未到）：该卷全部条目统一拒绝，判对判错同文案不泄露", () => {
    const { db, studentId } = world();
    const attemptId = insertSubmittedAttempt(db, studentId, {
      answerRelease: "after_due",
      dueAt: "2099-01-01T00:00:00.000Z",
    });
    addResultQuestion(db, attemptId, "q-wrong", { finalCorrect: false });
    addResultQuestion(db, attemptId, "q-right", { finalCorrect: true });
    const result = batchOf(
      db,
      studentId,
      itemsOf(attemptId, ["q-wrong", "q-right"]),
    );
    expect(result.summary.failed).toBe(2);
    const messages = new Set(result.items.map((item) => item.error));
    expect(messages.size).toBe(1);
    expect([...messages][0]).toContain("未公布");
    expect(tasksOf(db, studentId)).toHaveLength(0);
  });

  it("未交卷（draft）：逐项拒绝", () => {
    const { db, studentId } = world();
    const attemptId = insertSubmittedAttempt(db, studentId, {
      status: "draft",
    });
    addResultQuestion(db, attemptId, "q-1", { finalCorrect: false });
    const result = batchOf(db, studentId, itemsOf(attemptId, ["q-1"]));
    expect(result.summary.failed).toBe(1);
    expect(result.items[0].error).toContain("交卷");
  });
});

describe("SAI-31 批量复盘服务：部分失败与重试不连坐（先测③）", () => {
  it("三题一题缺快照：另两题成功；重试只重发失败项，成功项不重复创建", () => {
    const { db, studentId } = world();
    const attemptId = insertSubmittedAttempt(db, studentId);
    addResultQuestion(db, attemptId, "q-ok-1", { finalCorrect: false });
    addResultQuestion(db, attemptId, "q-ok-2", { finalCorrect: false });
    addResultQuestion(db, attemptId, "q-broken", {
      finalCorrect: false,
      snapshotNull: true,
    });
    const first = batchOf(
      db,
      studentId,
      [
        { attemptId, questionId: "q-ok-1" },
        { attemptId, questionId: "q-ok-2" },
        { attemptId, questionId: "q-broken" },
      ],
      "batch-retry-1",
    );
    expect(first.summary).toEqual({
      created: 2,
      alreadyExists: 0,
      paused: 0,
      failed: 1,
    });
    expect(
      first.items.find((item) => item.questionId === "q-broken")?.error,
    ).toContain("快照");

    // 重试只重发失败项（同批幂等键）：失败项仍失败（缺件是确定性的），
    // 不重复创建成功项（它们根本不在请求里）
    const retry = batchOf(
      db,
      studentId,
      [{ attemptId, questionId: "q-broken" }],
      "batch-retry-1",
    );
    expect(retry.summary).toEqual({
      created: 0,
      alreadyExists: 0,
      paused: 0,
      failed: 1,
    });
    expect(tasksOf(db, studentId)).toHaveLength(2);

    // 若客户端把全部三题重发（同批幂等键）：成功两项 already_exists 不重复创建
    const replay = batchOf(
      db,
      studentId,
      [
        { attemptId, questionId: "q-ok-1" },
        { attemptId, questionId: "q-ok-2" },
        { attemptId, questionId: "q-broken" },
      ],
      "batch-retry-1",
    );
    expect(replay.summary).toEqual({
      created: 0,
      alreadyExists: 2,
      paused: 0,
      failed: 1,
    });
    expect(tasksOf(db, studentId)).toHaveLength(2);
  });
});

describe("SAI-31 批量复盘服务：幂等与不重复收费（先测④）", () => {
  it("同 batch 重放：全部 already_exists，不新建行", () => {
    const { db, studentId } = world();
    const attemptId = insertSubmittedAttempt(db, studentId);
    addResultQuestion(db, attemptId, "q-1", { finalCorrect: false });
    addResultQuestion(db, attemptId, "q-2", { finalCorrect: false });
    const items = itemsOf(attemptId, ["q-1", "q-2"]);
    const first = batchOf(db, studentId, items, "batch-replay");
    expect(first.summary.created).toBe(2);
    const second = batchOf(db, studentId, items, "batch-replay");
    expect(second.summary).toEqual({
      created: 0,
      alreadyExists: 2,
      paused: 0,
      failed: 0,
    });
    expect(tasksOf(db, studentId)).toHaveLength(2);
  });

  it("已有单题任务（别的幂等键，进行中）：outcome=paused 复用，不重复创建", () => {
    const { db, studentId } = world();
    const attemptId = insertSubmittedAttempt(db, studentId);
    addResultQuestion(db, attemptId, "q-1", { finalCorrect: false });
    const existing = createAiTask(
      db,
      {
        studentId,
        attemptId,
        questionId: "q-1",
        question: "单题求助",
        channel: "inapp",
        mutationId: "single-mut-1",
      },
      { hmacSecret: SECRET },
    );
    expect(existing.created).toBe(true);
    const result = batchOf(db, studentId, itemsOf(attemptId, ["q-1"]));
    expect(result.summary).toEqual({
      created: 0,
      alreadyExists: 0,
      paused: 1,
      failed: 0,
    });
    const pausedItem = result.items[0];
    expect(pausedItem.taskId).toBe(existing.task.id);
    expect(tasksOf(db, studentId)).toHaveLength(1);
  });

  it("幂等键撞上他人任务：逐项拒绝，不返回他人任务 id", () => {
    const { db, studentId, otherStudentId } = world();
    const attemptA = insertSubmittedAttempt(db, studentId);
    addResultQuestion(db, attemptA, "q-1", { finalCorrect: false });
    // 他学生先占了派生幂等键（batch-mut-x:attemptId:questionId）
    const otherId = insertSubmittedAttempt(db, otherStudentId);
    addResultQuestion(db, otherId, "q-1", { finalCorrect: false });
    createAiTask(
      db,
      {
        studentId: otherStudentId,
        attemptId: otherId,
        questionId: "q-1",
        question: "别人的任务",
        channel: "inapp",
        mutationId: `batch-mut-x:${attemptA}:q-1`,
      },
      { hmacSecret: SECRET },
    );
    const result = batchOf(
      db,
      studentId,
      itemsOf(attemptA, ["q-1"]),
      "batch-mut-x",
    );
    expect(result.summary.failed).toBe(1);
    expect(result.items[0].taskId).toBeNull();
    expect(result.items[0].error).toContain("幂等键");
  });

  it("待处理配额满：逐项失败并带配额原因，不创建半批僵尸", () => {
    const { db, studentId } = world();
    const attemptId = insertSubmittedAttempt(db, studentId);
    // 已有 10 个进行中任务（各占不同题，避免同题上限先行）
    for (let i = 0; i < 10; i += 1) {
      const questionId = `q-fill-${i}`;
      addResultQuestion(db, attemptId, questionId, { finalCorrect: false });
      createAiTask(
        db,
        {
          studentId,
          attemptId,
          questionId,
          question: "占额任务",
          channel: "mcp",
          mutationId: `fill-${i}`,
        },
        { hmacSecret: SECRET },
      );
    }
    addResultQuestion(db, attemptId, "q-new", { finalCorrect: false });
    const result = batchOf(db, studentId, itemsOf(attemptId, ["q-new"]));
    expect(result.summary.failed).toBe(1);
    expect(result.items[0].error).toContain("上限");
    expect(
      tasksOf(db, studentId).filter((task) => task.questionId === "q-new"),
    ).toHaveLength(0);
  });
});

describe("SAI-31 批量复盘服务：一题一份上下文（先测⑤）", () => {
  it("每题快照只含本题哨兵，不含其他题；出站装配与 MCP 领取同样隔离", () => {
    const { db, studentId } = world();
    const attemptId = insertSubmittedAttempt(db, studentId);
    const ids = ["q-iso-1", "q-iso-2", "q-iso-3"];
    ids.forEach((id, index) => {
      addResultQuestion(db, attemptId, id, {
        finalCorrect: false,
        stem: `题面${SENTINELS[index]}原文`,
      });
    });
    const result = batchOf(
      db,
      studentId,
      itemsOf(attemptId, ids),
      "batch-iso",
      "mcp",
    );
    expect(result.summary.created).toBe(3);

    const rows = tasksOf(db, studentId);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const index = ids.indexOf(row.questionId);
      expect(index).toBeGreaterThanOrEqual(0);
      const snapshotText = row.contextSnapshotJson;
      // 含本题哨兵
      expect(snapshotText).toContain(SENTINELS[index]);
      // 不含其他题哨兵（去掉自己的那个再查）
      const others = SENTINELS.filter((_, i) => i !== index);
      for (const other of others) {
        expect(snapshotText).not.toContain(other);
      }
    }

    // MCP 领取视图（外部 AI 实际收到的输入）同样只含本题
    const first = rows.find((row) => row.questionId === "q-iso-1");
    expect(first).toBeDefined();
    if (first === undefined) return;
    const claimed = claimMcpTask(db, { studentId, taskId: first.id });
    expect(claimed).not.toBeNull();
    const refreshed = db
      .select()
      .from(aiTasks)
      .where(eq(aiTasks.id, first.id))
      .get();
    expect(refreshed).toBeDefined();
    if (refreshed === undefined) return;
    const outbound = outboundAssemblyOfTask(db, refreshed);
    const outboundText = outbound.messages
      .map((message) => message.content)
      .join("\n");
    expect(outboundText).toContain(SENTINELS[0]);
    expect(outboundText).not.toContain(SENTINELS[1]);
    expect(outboundText).not.toContain(SENTINELS[2]);
    expect(outboundText).not.toContain("当天");
  });
});

import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { TextContent } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import { attempts, courses, responses, students } from "../db/schema.ts";
import { TEST_TEACHER_ID } from "../db/test-utils.ts";
import { createAiTask } from "../services/ai-companion/student-ai-queue.ts";
import { createAiShareTicket } from "../services/ai-companion/student-ai-share.ts";
import { getTeacherAttemptAiRecords } from "../services/ai-companion/teacher-ai-records.ts";
import { expectHttpError } from "./ai-companion-fixtures.ts";
import { connectMcpClientViaApp } from "./mcp-test-utils.ts";
import {
  createMatrixWorld,
  hitsOf,
  jsonViaApp,
  type MatrixWorld,
  shellOf,
} from "./student-ai-matrix-world.ts";

/**
 * SAI-32 跨通道安全矩阵 · 维度 2（B17）：身份/对象隔离。
 * 双教师、双学生、同 questionId 不同域、跨 attempt/response/阶段材料、
 * 归档/失权/作废。
 *
 * 用例编号：
 * D2-01 双教师同 questionId：出站只含本域冻结快照（他域答案哨兵不出现）
 * D2-02 跨学生任务访问：详情/更新/分享/取消/打开全部 404 且与随机 UUID 同文案
 * D2-03 MCP 跨学生领取：他学生 taskId 拒绝（与随机 UUID 同文案）、FIFO 不越域
 * D2-04 跨 attempt 同 questionId：新卷任务装配新卷自己的冻结行，不串旧卷
 * D2-05 讲练重开（作废）：新任务 409；存量任务详情/打开/票据读取/领取一致拒绝
 * D2-06 学生归档：会话出口 401；MCP token 即时失效
 * D2-07 课程失权：非成员 course 卷创建任务与票据读取 403 COURSE_ACCESS_DENIED
 * D2-08 教师域：他教师读本域学生按卷 AI 记录 404（服务层单源抽查，
 *       路由级四态鉴权与同文案防枚举由 teacher-ai-records.test.ts ①④ 全覆盖）
 */

const activeDbs: Db[] = [];

function world(): MatrixWorld {
  const w = createMatrixWorld();
  activeDbs.push(w.db);
  return w;
}

afterEach(() => {
  for (const db of activeDbs.splice(0)) db.$client.close();
});

/** 直插一份 attempt（矩阵世界之外的形态：lesson/course/同题新卷） */
function insertExtraAttempt(
  w: MatrixWorld,
  row: {
    studentId: string;
    sourceType: "assignment" | "course" | "wrong" | "lesson";
    assignmentId?: string | null;
    courseId?: string | null;
    unitId?: string | null;
    lectureId?: string | null;
    abandonedAt?: string | null;
  },
): string {
  const id = randomUUID();
  w.db
    .insert(attempts)
    .values({
      id,
      studentId: row.studentId,
      sourceType: row.sourceType,
      assignmentId: row.assignmentId ?? null,
      courseId: row.courseId ?? null,
      unitId: row.unitId ?? null,
      lectureId: row.lectureId ?? null,
      attemptNo: 1,
      status: "draft",
      startedAt: "2026-06-01T00:00:00.000Z",
      frozenAt: "2026-06-01T00:00:00.000Z",
      legacyUnverified: false,
      abandonedAt: row.abandonedAt ?? null,
    })
    .run();
  return id;
}

/** 给 response 行改写快照答案哨兵（跨 attempt 隔离断言用） */
function seedAnswer(
  w: MatrixWorld,
  responseId: string,
  answerText: string,
): void {
  const row = w.db
    .select()
    .from(responses)
    .where(eq(responses.id, responseId))
    .get();
  if (row === undefined) throw new Error("矩阵 D2：response 行缺失");
  const snapshot = JSON.parse(row.questionSnapshotJson ?? "{}") as Record<
    string,
    unknown
  >;
  snapshot.answers = { kind: "fill", blanks: [[answerText]] };
  w.db
    .update(responses)
    .set({ questionSnapshotJson: JSON.stringify(snapshot) })
    .where(eq(responses.id, responseId))
    .run();
}

/** 直插 response（复用矩阵世界哨兵 stem/solution 由调用方注入） */
function insertExtraResponse(
  w: MatrixWorld,
  attemptId: string,
  questionId: string,
): string {
  const id = randomUUID();
  w.db
    .insert(responses)
    .values({
      id,
      attemptId,
      questionId,
      unitId: null,
      questionVersion: 1,
      questionSnapshotJson: JSON.stringify({
        type: "choice",
        difficulty: 3,
        knowledge: ["考点A"],
        stemMd: "跨卷题面",
        options: [{ text: "甲" }, { text: "乙" }],
        answers: { kind: "choice", index: 1 },
        hints: [],
        solutionMd: "跨卷解析",
        sourceMd: "",
        id: questionId,
      }),
      answerJson: null,
      submittedAt: null,
      teacherComment: null,
    })
    .run();
  return id;
}

async function createTask(
  w: MatrixWorld,
  over: Record<string, unknown> = {},
): Promise<{
  status: number;
  error: string | null;
  data: Record<string, unknown> | null;
  raw: string;
}> {
  const res = await jsonViaApp(
    w.app,
    w.cookie1,
    "/api/student/ai/tasks",
    "POST",
    {
      attemptId: w.attempt1,
      questionId: w.qMain,
      question: "请讲解本题",
      channel: "inapp",
      materials: { annotation: false, draft: false, formalInk: false },
      mutationId: randomUUID(),
      ...over,
    },
  );
  return shellOf(res);
}

async function mcpCall(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const block = (result.content as TextContent[]).find(
    (c) => c.type === "text",
  );
  if (block === undefined) throw new Error(`${name} 结果没有 text content`);
  return {
    data: JSON.parse(block.text) as Record<string, unknown>,
    isError: result.isError === true,
  };
}

describe("SAI-32 矩阵维度 2：身份/对象隔离", () => {
  it("D2-01 双教师同 questionId：出站只含本域冻结快照", async () => {
    const w = world();
    // 学生 1（教师 A 域）任务：出站只含 A 域答案哨兵，教师 B 域同 id 快照不出现
    const created = await createTask(w);
    expect(created.status).toBe(201);
    w.addInappConnection();
    const { recorded } = await w.dispatchInapp();
    expect(recorded.length).toBe(1);
    expect(recorded[0]?.body).toContain(w.sentinel.refAnswer);
    expect(recorded[0]?.body).not.toContain(w.sentinel.peerRef);
    // 学生 2（教师 B 域）经链接通道同理：只含他域自己快照
    const created2 = await jsonViaApp(
      w.app,
      w.cookie2,
      "/api/student/ai/tasks",
      "POST",
      {
        attemptId: w.attempt2,
        questionId: w.qMain,
        question: "请讲解本题",
        channel: "link",
        materials: { annotation: false, draft: false, formalInk: false },
        mutationId: randomUUID(),
      },
    );
    expect(created2.status).toBe(201);
    const share2 = await jsonViaApp(
      w.app,
      w.cookie2,
      `/api/student/ai/tasks/${(await shellOf(created2)).data?.id}/share`,
      "POST",
      {},
    );
    expect(share2.status).toBe(200);
    const url2 = ((await share2.json()) as { data: { ticketUrl: string } }).data
      .ticketUrl;
    const body2 = await shellOf(await w.app.request(new URL(url2).pathname));
    expect(body2.status).toBe(200);
    expect(body2.raw).toContain(w.sentinel.peerRef);
    expect(body2.raw).not.toContain(w.sentinel.refAnswer);
  });

  it("D2-02 跨学生任务访问：五个出口全部 404 且与随机 UUID 同文案", async () => {
    const w = world();
    const created = await createTask(w, { channel: "link" });
    const taskId = created.data?.id as string;
    const randomId = randomUUID();
    const exits = [
      `/api/student/ai/tasks/${taskId}`,
      `/api/student/ai/tasks/${randomId}`,
    ];
    for (const path of exits) {
      const detail = await shellOf(
        await jsonViaApp(w.app, w.cookie2, path, "GET"),
      );
      expect(detail.status).toBe(404);
      expect(detail.error).toBe("NOT_FOUND");
    }
    // 动作出口（学生 2 持自己会话访问学生 1 的任务）
    for (const [path, method, body] of [
      [
        `/api/student/ai/tasks/${taskId}/update-pending`,
        "POST",
        { question: "x" },
      ],
      [`/api/student/ai/tasks/${taskId}/share`, "POST", {}],
      [`/api/student/ai/tasks/${taskId}/cancel`, "POST", undefined],
      [`/api/student/ai/tasks/${taskId}/opened`, "POST", undefined],
    ] as const) {
      const res = await jsonViaApp(w.app, w.cookie2, path, method, body);
      const shell = await shellOf(res);
      expect(shell.status).toBe(404);
      expect(shell.error).toBe("NOT_FOUND");
      expect(shell.raw).not.toContain(w.sentinel.refAnswer);
    }
    // 防枚举：他人任务与随机 UUID 文案一致
    const stranger = await shellOf(
      await jsonViaApp(
        w.app,
        w.cookie2,
        `/api/student/ai/tasks/${taskId}`,
        "GET",
      ),
    );
    const randomHit = await shellOf(
      await jsonViaApp(
        w.app,
        w.cookie2,
        `/api/student/ai/tasks/${randomId}`,
        "GET",
      ),
    );
    expect(stranger.raw).toBe(randomHit.raw);
  });

  it("D2-03 MCP 跨学生领取：他学生 taskId 拒绝且同文案、FIFO 不越域", async () => {
    const w = world();
    const created = await createTask(w, { channel: "mcp" });
    const taskId = created.data?.id as string;
    // 学生 2 建自己的 mcp 连接并领取：指定学生 1 的任务 → NOT_FOUND 同文案
    const token2 = await w.createMcpToken(w.student2);
    const client2 = await connectMcpClientViaApp(
      w.app,
      "/mcp/student",
      token2,
      "d2-03",
    );
    const steal = await mcpCall(client2, "claim_ai_task", { taskId });
    expect(steal.isError).toBe(true);
    expect(steal.data.error).toBe("NOT_FOUND");
    const random = await mcpCall(client2, "claim_ai_task", {
      taskId: randomUUID(),
    });
    expect(random.data.error).toBe(steal.data.error);
    expect(JSON.stringify(random.data)).toBe(JSON.stringify(steal.data));
    // FIFO：学生 2 无自己的任务 → claimed:false（不越域捞学生 1 的任务）
    const fifo = await mcpCall(client2, "claim_ai_task", {});
    expect(fifo.isError).toBe(false);
    expect(fifo.data.claimed).toBe(false);
    await client2.close();
    // 学生 1 自己领取照常
    const token1 = await w.createMcpToken(w.student1);
    const client1 = await connectMcpClientViaApp(
      w.app,
      "/mcp/student",
      token1,
      "d2-03-b",
    );
    const own = await mcpCall(client1, "claim_ai_task", { taskId });
    expect(own.isError).toBe(false);
    expect(own.data.claimed).toBe(true);
    await client1.close();
  });

  it("D2-04 跨 attempt 同 questionId：新卷任务装配新卷自己的冻结行", async () => {
    const w = world();
    const newAttemptRef = `MATRIX_NEW_ATTEMPT_REF_${randomUUID().slice(0, 8)}`;
    const attempt3 = insertExtraAttempt(w, {
      studentId: w.student1,
      sourceType: "wrong",
    });
    const response3 = insertExtraResponse(w, attempt3, w.qMain);
    seedAnswer(w, response3, newAttemptRef);
    // 新卷任务：出站含新卷答案哨兵，不含旧卷（attempt1）答案哨兵
    const created = await createTask(w, {
      attemptId: attempt3,
      channel: "inapp",
    });
    expect(created.status).toBe(201);
    w.addInappConnection();
    const { recorded } = await w.dispatchInapp();
    expect(recorded.length).toBe(1);
    expect(recorded[0]?.body).toContain(newAttemptRef);
    expect(recorded[0]?.body).not.toContain(w.sentinel.refAnswer);
    // 旧卷任务不受新卷影响（旧卷仍装配旧冻结行）
    const oldTask = await createTask(w);
    expect(oldTask.status).toBe(201);
    const second = await w.dispatchInapp();
    expect(second.recorded.length).toBe(1);
    expect(second.recorded[0]?.body).toContain(w.sentinel.refAnswer);
    expect(second.recorded[0]?.body).not.toContain(newAttemptRef);
  });

  it("D2-05 讲练重开（作废）：新任务 409；存量任务各出口一致拒绝", async () => {
    const w = world();
    // 存量 link 任务 + 票据与 mcp 任务（重开前建好）
    const created = await createTask(w, { channel: "link" });
    const taskId = created.data?.id as string;
    const { token } = createAiShareTicket(w.db, {
      studentId: w.student1,
      taskId,
    });
    const mcpTask = await createTask(w, { channel: "mcp" });
    const mcpTaskId = mcpTask.data?.id as string;
    // 讲练重开：attempt 置作废（服务端口径 abandonedAt ≠ null）
    w.db
      .update(attempts)
      .set({ abandonedAt: "2026-06-02T00:00:00.000Z" })
      .where(eq(attempts.id, w.attempt1))
      .run();
    // 新任务创建 → 409 ATTEMPT_ABANDONED
    const blocked = await createTask(w);
    expect(blocked.status).toBe(409);
    expect(blocked.error).toBe("ATTEMPT_ABANDONED");
    // 存量任务详情：可用动作收敛（不再发送/分享/追问），不抛 5xx
    const detail = await shellOf(
      await jsonViaApp(
        w.app,
        w.cookie1,
        `/api/student/ai/tasks/${taskId}`,
        "GET",
      ),
    );
    expect(detail.status).toBe(200);
    expect(
      (detail.data as { task?: { allowedActions?: string[] } })?.task
        ?.allowedActions,
    ).toEqual(["cancel"]);
    // 打开回信 → 409 ATTEMPT_ABANDONED（作废传播；正文不交付）
    const opened = await shellOf(
      await jsonViaApp(
        w.app,
        w.cookie1,
        `/api/student/ai/tasks/${taskId}/opened`,
        "POST",
      ),
    );
    expect(opened.status).toBe(409);
    expect(opened.error).toBe("ATTEMPT_ABANDONED");
    // 票据读取 → 拒绝（requireUsableAttempt 409 ATTEMPT_ABANDONED 传播）
    const ticketRead = await shellOf(
      await w.app.request(`/api/public/ai/share/${token}`),
    );
    expect(ticketRead.status).toBe(409);
    expect(ticketRead.error).toBe("ATTEMPT_ABANDONED");
    expect(
      hitsOf(ticketRead.raw, [w.sentinel.refAnswer, w.sentinel.solution]),
    ).toEqual([]);
    // MCP 指定领取 → 403 AI_POLICY_DISABLED（policyUsable 捕获后按不可用）
    const token1 = await w.createMcpToken(w.student1);
    const client1 = await connectMcpClientViaApp(
      w.app,
      "/mcp/student",
      token1,
      "d2-05",
    );
    const claim = await mcpCall(client1, "claim_ai_task", {
      taskId: mcpTaskId,
    });
    expect(claim.isError).toBe(true);
    expect(claim.data.error).toBe("AI_POLICY_DISABLED");
    await client1.close();
  });

  it("D2-06 学生归档：会话出口 401、MCP token 即时失效", async () => {
    const w = world();
    const created = await createTask(w, { channel: "mcp" });
    expect(created.status).toBe(201);
    const token1 = await w.createMcpToken(w.student1);
    w.db
      .update(students)
      .set({ archivedAt: "2026-06-02T00:00:00.000Z" })
      .where(eq(students.id, w.student1))
      .run();
    // 会话出口：requireStudent 401
    const detail = await shellOf(
      await jsonViaApp(
        w.app,
        w.cookie1,
        `/api/student/ai/tasks/${created.data?.id}`,
        "GET",
      ),
    );
    expect(detail.status).toBe(401);
    // MCP：逐请求实时核对 → 401（initialize 即拒或工具调用 isError，不返回任务内容）
    let client: Client | null = null;
    let connectRejected = false;
    try {
      client = await connectMcpClientViaApp(
        w.app,
        "/mcp/student",
        token1,
        "d2-06",
      );
    } catch {
      connectRejected = true;
    }
    if (!connectRejected && client !== null) {
      const claim = await client
        .callTool({ name: "claim_ai_task", arguments: {} })
        .then(
          (result) => JSON.stringify(result),
          (error: unknown) =>
            `${error instanceof Error ? error.message : String(error)}`,
        );
      expect(claim).not.toContain(w.sentinel.refAnswer);
      await client.close().catch(() => undefined);
    } else {
      expect(connectRejected).toBe(true);
    }
  });

  it("D2-07 课程失权：非成员 course 卷创建任务 403 COURSE_ACCESS_DENIED", async () => {
    const w = world();
    const courseId = randomUUID();
    w.db
      .insert(courses)
      .values({
        id: courseId,
        teacherId: TEST_TEACHER_ID,
        title: "矩阵课程",
        order: 0,
        archivedAt: null,
        createdAt: "2026-06-01T00:00:00.000Z",
      })
      .run();
    // 学生 1 不是成员（courseStudents 无行）→ requireVisibleCourseUnit 403
    const courseAttempt = insertExtraAttempt(w, {
      studentId: w.student1,
      sourceType: "course",
      courseId,
      unitId: "matrix-unit",
    });
    insertExtraResponse(w, courseAttempt, "matrix-course-q");
    const blocked = await createTask(w, {
      attemptId: courseAttempt,
      questionId: "matrix-course-q",
    });
    expect(blocked.status).toBe(403);
    expect(blocked.error).toBe("COURSE_ACCESS_DENIED");
    expect(blocked.raw).not.toContain(w.sentinel.refAnswer);
  });

  it("D2-08 教师域：他教师读本域学生按卷 AI 记录 404（服务层单源）", () => {
    const w = world();
    const { task } = createAiTask(
      w.db,
      {
        studentId: w.student1,
        attemptId: w.attempt1,
        questionId: w.qMain,
        question: "请讲解本题",
        channel: "mcp",
        mutationId: randomUUID(),
      },
      { hmacSecret: "matrix-sync-secret" },
    );
    // 本域教师照常
    const own = getTeacherAttemptAiRecords(w.db, w.teacherA, w.attempt1);
    expect(own.records.length).toBe(1);
    expect(own.records[0]?.taskId).toBe(task.id);
    // 他域教师（相同显示名学生、相同 questionId 场景由 D2-01 覆盖快照隔离）
    expectHttpError(
      () => getTeacherAttemptAiRecords(w.db, w.teacherB, w.attempt1),
      404,
      "ATTEMPT_NOT_FOUND",
    );
  });
});

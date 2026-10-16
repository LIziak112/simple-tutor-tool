import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ApiErr } from "@tutor/contract";
import {
  aiTeacherAttemptRecordsOkSchema,
  aiTeacherTaskDetailOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession, createTeacherSession } from "../auth/session.ts";
import { loadOrCreateSecretKey } from "../config.ts";
import {
  aiTaskMaterials,
  attempts,
  responses,
  students,
  teachers,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { attachAiTaskMaterials } from "../services/ai-companion/student-ai-materials.ts";
import {
  archiveAiTask,
  beginInappDispatch,
  cancelAiTask,
  claimMcpTask,
  completeInappDispatch,
  createAiTask,
  openStudentAiReply,
} from "../services/ai-companion/student-ai-queue.ts";
import {
  insertAiConnectionFixture,
  insertAttempt,
  insertResponse,
} from "../test/ai-companion-fixtures.ts";
import { makeNotePng } from "../test/note-fixtures.ts";

/**
 * SAI-24 教师督学记录路由测试（B13；需求规格 §9、B13 失败用例五组逐条）：
 * - ① 四态鉴权：ai-records / 任务详情 / 材料 PNG 三端点的无会话 / 学生
 *   Cookie / 域外教师 / 本人；
 * - ② 四态可区分：仅入队 / 已外发未回信 / 已回信未看 / 有查看记录的每题
 *   摘要（distinct 题数口径）两两不同；
 * - ③ 完成后复盘不计作答中辅助（提交后才创建/外发的事实阶段如实）；
 * - ④ 越权硬测：其他教师持有**相同学生显示名 / 相同 questionId** 时仍不能
 *   读本人域的记录、任务详情或材料图（域 = attempt→student→teacherId）；
 * - ⑤ 取消/归档不抹事实；缺材料显示真实缺失（行状态 + 文件缺失 500），
 *   不用当前新稿冒充；教师私注不进任何督学载荷。
 */

const TEACHER_B_ID = "teacher-b-sai24-001";
const PRIVATE_NOTE_SENTINEL = "教师私注哨兵TC";

interface World {
  app: ReturnType<typeof createApp>;
  db: ReturnType<typeof createTestDb>;
  dataDir: string;
  hmacSecret: string;
  teacher: string;
  teacherB: string;
  student: string;
  attemptA: string;
  attemptB: string;
  /** 教师乙的学生（与 s-a 同显示名）及其作答（含相同 questionId） */
  studentC: string;
  attemptC: string;
}

const active: ReturnType<typeof createTestDb>[] = [];

function world(): World {
  const db = createTestDb();
  active.push(db);
  // 甲（TEST_TEACHER_ID 种子行补密码哈希——守卫查教师行完整性，不经登录流程）
  db.update(teachers)
    .set({ passwordHash: "scrypt$fixture" })
    .where(eq(teachers.id, TEST_TEACHER_ID))
    .run();
  db.insert(teachers)
    .values({
      id: TEACHER_B_ID,
      loginName: "乙老师",
      isAdmin: false,
      disabledAt: null,
      passwordHash: "scrypt$fixture",
      apiToken: null,
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    .run();
  // s-a（甲）/ s-b（甲）/ s-c（乙，与 s-a 同显示名——越权组的同名向量）
  for (const [id, teacherId] of [
    ["s-a", TEST_TEACHER_ID],
    ["s-b", TEST_TEACHER_ID],
    ["s-c", TEACHER_B_ID],
  ] as const) {
    db.insert(students)
      .values({
        id,
        teacherId,
        displayName: "同名学生",
        loginName: id,
        linkToken: id,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
  }
  const attemptA = insertAttempt(db, { studentId: "s-a" });
  const attemptB = insertAttempt(db, { studentId: "s-a" });
  const attemptC = insertAttempt(db, { studentId: "s-c" });
  // 四态题目 + 邻题（携教师私注哨兵，供泄露扫描）
  for (const questionId of [
    "q-queued",
    "q-dispatched",
    "q-replied",
    "q-opened",
    "q-beta",
  ]) {
    insertResponse(db, attemptA, questionId);
  }
  db.update(responses)
    .set({ teacherComment: PRIVATE_NOTE_SENTINEL })
    .where(eq(responses.questionId, "q-beta"))
    .run();
  // 越权组的相同 questionId：甲乙两侧各有一份同名题目作答
  insertResponse(db, attemptA, "q-shared");
  insertResponse(db, attemptB, "q-mixed");
  insertResponse(db, attemptC, "q-shared");
  for (const studentId of ["s-a", "s-c"]) {
    insertAiConnectionFixture(db, studentId);
  }
  const dataDir = createTestDir();
  const app = createApp({
    db,
    dataDir,
    publicUrl: "http://localhost",
    isProduction: false,
    logger: pino({ enabled: false }),
  });
  return {
    app,
    db,
    dataDir,
    hmacSecret: loadOrCreateSecretKey(dataDir),
    teacher: `tutor_session=${createTeacherSession(db, TEST_TEACHER_ID).token}`,
    teacherB: `tutor_session=${createTeacherSession(db, TEACHER_B_ID).token}`,
    student: `tutor_student_session=${createStudentSession(db, "s-a").token}`,
    attemptA,
    attemptB,
    attemptC,
    studentC: "s-c",
  };
}

afterEach(() => {
  for (const db of active.splice(0)) db.$client.close();
});

async function get(
  app: ReturnType<typeof createApp>,
  path: string,
  cookie?: string,
): Promise<Response> {
  return app.request(path, {
    method: "GET",
    headers: cookie === undefined ? {} : { cookie },
  });
}

/** 经服务层为学生 s-a 创建一个任务（默认页内通道） */
function createTask(
  w: World,
  questionId: string,
  channel: "inapp" | "mcp" = "inapp",
  attemptId = w.attemptA,
): string {
  const { task } = createAiTask(
    w.db,
    {
      studentId: "s-a",
      attemptId,
      questionId,
      question: `这道题（${questionId}）的思路是什么？`,
      channel,
      mutationId: randomUUID(),
    },
    { hmacSecret: w.hmacSecret },
  );
  return task.id;
}

/** 页内出站并写回一条回信 */
function dispatchWithReply(w: World, taskId: string, replyMd: string): void {
  const begin = beginInappDispatch(w.db, { studentId: "s-a", taskId });
  completeInappDispatch(w.db, {
    studentId: "s-a",
    taskId,
    generation: begin.generation,
    replyMd,
    expectedRuntimeEpoch: begin.runtimeEpoch,
  });
}

/** 整卷提交（阶段判定事实源：attempt.status → submitted） */
function submitAttempt(w: World, attemptId: string): void {
  w.db
    .update(attempts)
    .set({ status: "submitted", submittedAt: "2026-06-02T00:00:00.000Z" })
    .where(eq(attempts.id, attemptId))
    .run();
}

/** 错误壳断言：状态码 + 错误码，返回壳（可续查中文消息） */
async function expectErr(
  res: Response,
  status: number,
  code: string,
): Promise<ApiErr> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as ApiErr;
  expect(body.error).toBe(code);
  return body;
}

async function recordsOf(w: World, attemptId: string, cookie = w.teacher) {
  const res = await get(
    w.app,
    `/api/teacher/attempts/${attemptId}/ai-records`,
    cookie,
  );
  expect(res.status).toBe(200);
  return aiTeacherAttemptRecordsOkSchema.parse(await res.json()).data;
}

// ---------- ① 四态鉴权（路由鉴权完成条件） ----------

it("① ai-records / 任务详情 / 材料 PNG 的四态鉴权", async () => {
  const w = world();
  const taskId = createTask(w, "q-queued");

  // ai-records：无会话与学生 Cookie 都 401（教师守卫）
  await expectErr(
    await get(w.app, `/api/teacher/attempts/${w.attemptA}/ai-records`),
    401,
    "UNAUTHORIZED",
  );
  await expectErr(
    await get(
      w.app,
      `/api/teacher/attempts/${w.attemptA}/ai-records`,
      w.student,
    ),
    401,
    "UNAUTHORIZED",
  );
  // 本人 200 且符合契约；不存在的 attempt 404 同口径
  const data = await recordsOf(w, w.attemptA);
  expect(data.attemptId).toBe(w.attemptA);
  await expectErr(
    await get(
      w.app,
      `/api/teacher/attempts/${randomUUID()}/ai-records`,
      w.teacher,
    ),
    404,
    "ATTEMPT_NOT_FOUND",
  );

  // 任务详情：无会话 401、本人 200 且符合契约
  await expectErr(
    await get(w.app, `/api/teacher/ai/tasks/${taskId}`),
    401,
    "UNAUTHORIZED",
  );
  const detailRes = await get(
    w.app,
    `/api/teacher/ai/tasks/${taskId}`,
    w.teacher,
  );
  expect(detailRes.status).toBe(200);
  const detail = aiTeacherTaskDetailOkSchema.parse(await detailRes.json()).data;
  expect(detail.task.id).toBe(taskId);
  // 教师域详情可见快照与提示词哈希（教师本可见全部作答材料）
  expect(detail.task.contextSnapshot.questionId).toBe("q-queued");
  expect(detail.task.promptHash).toMatch(/^[0-9a-f]{64}$/);

  // 材料 PNG：无会话 401、本人 200 image/png
  const [material] = attachAiTaskMaterials(w.db, w.dataDir, {
    studentId: "s-a",
    taskId,
    pages: [
      {
        kind: "draft",
        pageIndex: 0,
        pixelWidth: 320,
        pixelHeight: 200,
        png: makeNotePng(),
      },
    ],
  });
  const materialUrl = `/api/teacher/ai/tasks/${taskId}/materials/${material?.id}/image.png`;
  const pngRes = await get(w.app, materialUrl, w.teacher);
  expect(pngRes.status).toBe(200);
  expect(pngRes.headers.get("content-type")).toBe("image/png");
  await expectErr(await get(w.app, materialUrl), 401, "UNAUTHORIZED");
});

// ---------- ② 四态可区分（摘要模型完成条件：distinct 题数而非请求次数） ----------

it("② 仅入队 / 已外发未回信 / 已回信未看 / 有查看记录四态摘要两两可区分", async () => {
  const w = world();
  // q-queued：仅入队（再发起一次重试任务——taskCount 累计而题数不增）
  createTask(w, "q-queued");
  createTask(w, "q-queued");
  // q-dispatched：MCP 领取即外发、无回信
  const mcpTask = createTask(w, "q-dispatched", "mcp");
  expect(
    claimMcpTask(w.db, { studentId: "s-a", taskId: mcpTask }),
  ).not.toBeNull();
  // q-replied：页内出站 + 回信写回，学生未打开
  dispatchWithReply(w, createTask(w, "q-replied"), "先看已知条件再设未知数。");
  // q-opened：出站 + 回信 + 学生打开
  const openedTask = createTask(w, "q-opened");
  dispatchWithReply(w, openedTask, "本题考察分配律。");
  openStudentAiReply(w.db, { studentId: "s-a", taskId: openedTask });

  const data = await recordsOf(w, w.attemptA);
  const summaryOf = (questionId: string) =>
    data.questions.find((q) => q.questionId === questionId)?.facts;
  const queued = summaryOf("q-queued");
  const dispatched = summaryOf("q-dispatched");
  const replied = summaryOf("q-replied");
  const opened = summaryOf("q-opened");
  expect(queued).toBeDefined();
  expect(dispatched).toBeDefined();
  expect(replied).toBeDefined();
  expect(opened).toBeDefined();
  // 仅入队：只记「发起过求助」，不能说已获帮助
  expect(queued).toMatchObject({
    requested: true,
    requestedBeforeSubmit: true,
    queuedOnly: true,
    dispatched: false,
    replyReceived: false,
    platformOpened: false,
  });
  // 重试再求助只累计任务不增题数（distinct 题数口径）
  expect(queued?.taskCount).toBe(2);
  // 已外发未回信
  expect(dispatched).toMatchObject({
    queuedOnly: false,
    dispatched: true,
    dispatchedBeforeSubmit: true,
    replyReceived: false,
    platformOpened: false,
  });
  // 已回信未看（回信 ≠ 学生已读）
  expect(replied).toMatchObject({
    dispatched: true,
    replyReceived: true,
    repliedBeforeSubmit: true,
    platformOpened: false,
  });
  // 有查看记录（平台有打开记录，不证明阅读理解）
  expect(opened).toMatchObject({
    replyReceived: true,
    platformOpened: true,
    platformOpenedBeforeSubmit: true,
  });
  // 四态的 (queuedOnly, dispatched, replyReceived, platformOpened) 两两不同
  const tuples = [queued, dispatched, replied, opened].map((f) => [
    f?.queuedOnly,
    f?.dispatched,
    f?.replyReceived,
    f?.platformOpened,
  ]);
  expect(new Set(tuples.map((t) => JSON.stringify(t))).size).toBe(4);
  // 任务行轻量形态：有诉求、通道、状态与事实时间线，无回信正文
  const openedRow = data.records.find((r) => r.taskId === openedTask);
  expect(openedRow?.channel).toBe("inapp");
  expect(openedRow?.question).toContain("q-opened");
  expect(openedRow?.hasReply).toBe(true);
  expect(openedRow?.facts.map((f) => f.type)).toContain("reply_delivered");
  expect(JSON.stringify(data)).not.toContain("本题考察分配律");
  // 无记录的题不在 questions 数组（前端按零态呈现「无平台记录」）
  expect(data.questions.some((q) => q.questionId === "q-beta")).toBe(false);
});

// ---------- ③ 完成后复盘不计作答中辅助 ----------

it("③ 提交后才创建/外发的事实阶段如实：复盘与混排不染为作答中已获帮助", async () => {
  const w = world();
  // attemptB：提交后创建（纯复盘）
  submitAttempt(w, w.attemptB);
  createTask(w, "q-mixed", "inapp", w.attemptB);
  // attemptA：提交前创建、提交后才外发 + 回信 + 打开（SAI-14 摘要样例的记录层镜像）
  const late = createTask(w, "q-shared");
  submitAttempt(w, w.attemptA);
  dispatchWithReply(w, late, "复盘：从条件出发反推。");
  openStudentAiReply(w.db, { studentId: "s-a", taskId: late });

  // 纯复盘：requested=true 但 requestedBeforeSubmit=false
  const review = await recordsOf(w, w.attemptB);
  expect(review.questions[0]?.facts).toMatchObject({
    requested: true,
    requestedBeforeSubmit: false,
    dispatched: false,
  });

  // 提交前发起、提交后才外发/回信/打开：外发侧全部 beforeSubmit=false
  const mixed = await recordsOf(w, w.attemptA);
  expect(mixed.questions[0]?.facts).toMatchObject({
    requested: true,
    requestedBeforeSubmit: true,
    dispatched: true,
    dispatchedBeforeSubmit: false,
    replyReceived: true,
    repliedBeforeSubmit: false,
    platformOpened: true,
    platformOpenedBeforeSubmit: false,
  });
});

// ---------- ④ 越权硬测：相同学生显示名 / 相同 questionId 不能越域 ----------

it("④ 其他教师（相同显示名学生、相同 questionId）不能读记录、详情或材料图", async () => {
  const w = world();
  const taskId = createTask(w, "q-shared");
  const [material] = attachAiTaskMaterials(w.db, w.dataDir, {
    studentId: "s-a",
    taskId,
    pages: [
      {
        kind: "draft",
        pageIndex: 0,
        pixelWidth: 320,
        pixelHeight: 200,
        png: makeNotePng(),
      },
    ],
  });
  // 教师乙的学生 s-c（与 s-a 同显示名）在相同 questionId 上有自己的任务
  const ownTask = createAiTask(
    w.db,
    {
      studentId: w.studentC,
      attemptId: w.attemptC,
      questionId: "q-shared",
      question: "乙侧学生自己的求助",
      channel: "inapp",
      mutationId: randomUUID(),
    },
    { hmacSecret: w.hmacSecret },
  ).task.id;

  // 甲本人可读自己的记录；乙读甲的记录 → 404 同文案（不暴露存在性）
  const own = await recordsOf(w, w.attemptA, w.teacher);
  expect(own.records.some((r) => r.taskId === taskId)).toBe(true);
  const errA = await expectErr(
    await get(
      w.app,
      `/api/teacher/attempts/${w.attemptA}/ai-records`,
      w.teacherB,
    ),
    404,
    "ATTEMPT_NOT_FOUND",
  );
  const errMissing = await expectErr(
    await get(
      w.app,
      `/api/teacher/attempts/${randomUUID()}/ai-records`,
      w.teacherB,
    ),
    404,
    "ATTEMPT_NOT_FOUND",
  );
  expect(errA.message).toBe(errMissing.message);

  // 乙读甲的任务详情 → 404 与不存在同文案；材料图同样 404
  const errTask = await expectErr(
    await get(w.app, `/api/teacher/ai/tasks/${taskId}`, w.teacherB),
    404,
    "NOT_FOUND",
  );
  const errTaskMissing = await expectErr(
    await get(w.app, `/api/teacher/ai/tasks/${randomUUID()}`, w.teacherB),
    404,
    "NOT_FOUND",
  );
  expect(errTask.message).toBe(errTaskMissing.message);
  await expectErr(
    await get(
      w.app,
      `/api/teacher/ai/tasks/${taskId}/materials/${material?.id}/image.png`,
      w.teacherB,
    ),
    404,
    "NOT_FOUND",
  );

  // 阳性对照：乙读自己学生（同名、同 questionId）的记录只含乙侧任务
  const ownB = await recordsOf(w, w.attemptC, w.teacherB);
  expect(ownB.records.map((r) => r.taskId)).toEqual([ownTask]);
  expect(ownB.questions[0]?.facts.taskCount).toBe(1);
});

// ---------- ⑤ 取消/归档不抹事实 + 缺材料真实呈现 ----------

it("⑤ 取消与归档后事实保留；缺材料显示真实缺失不用新稿冒充", async () => {
  const w = world();
  const taskId = createTask(w, "q-queued");
  const rows = attachAiTaskMaterials(w.db, w.dataDir, {
    studentId: "s-a",
    taskId,
    pages: [
      {
        kind: "draft",
        pageIndex: 0,
        pixelWidth: 320,
        pixelHeight: 200,
        png: makeNotePng(),
      },
      {
        kind: "draft",
        pageIndex: 1,
        pixelWidth: 320,
        pixelHeight: 200,
        png: makeNotePng(),
      },
    ],
  });
  // 取消（阻止交付）+ 归档（队列整理）：都不是教学事实的删除
  cancelAiTask(w.db, { studentId: "s-a", taskId });
  archiveAiTask(w.db, { studentId: "s-a", taskId });

  const data = await recordsOf(w, w.attemptA);
  const summary = data.questions.find(
    (q) => q.questionId === "q-queued",
  )?.facts;
  expect(summary?.requested).toBe(true);
  expect(summary?.taskCount).toBe(1);
  const row = data.records.find((r) => r.taskId === taskId);
  expect(row?.status).toBe("cancelled");
  expect(row?.archivedAt).not.toBeNull();
  expect(row?.facts.map((f) => f.type)).toEqual(
    expect.arrayContaining(["task_created", "cancelled", "archived"]),
  );

  // 详情：取消后诉求与事实时间线仍完整可读
  const detailRes = await get(
    w.app,
    `/api/teacher/ai/tasks/${taskId}`,
    w.teacher,
  );
  expect(detailRes.status).toBe(200);
  const detail = aiTeacherTaskDetailOkSchema.parse(await detailRes.json()).data;
  expect(detail.messages.some((m) => m.role === "student")).toBe(true);
  expect(detail.task.archivedAt).not.toBeNull();

  // 缺材料真实呈现：一页置 missing（行状态如实）、一页删文件（读取报故障）
  const missingPage = rows.find((r) => r.pageIndex === 0);
  const brokenPage = rows.find((r) => r.pageIndex === 1);
  expect(missingPage).toBeDefined();
  expect(brokenPage).toBeDefined();
  if (missingPage === undefined || brokenPage === undefined) {
    throw new Error("材料夹具不完整");
  }
  w.db
    .update(aiTaskMaterials)
    .set({ state: "missing" })
    .where(eq(aiTaskMaterials.id, missingPage.id))
    .run();
  rmSync(join(w.dataDir, brokenPage.pngPath));
  const detail2 = aiTeacherTaskDetailOkSchema.parse(
    await (
      await get(w.app, `/api/teacher/ai/tasks/${taskId}`, w.teacher)
    ).json(),
  ).data;
  expect(detail2.task.materials.map((m) => m.state)).toEqual([
    "missing",
    "ready",
  ]);
  await expectErr(
    await get(
      w.app,
      `/api/teacher/ai/tasks/${taskId}/materials/${brokenPage.id}/image.png`,
      w.teacher,
    ),
    500,
    "AI_MATERIAL_BROKEN",
  );

  // 教师私注不进任何督学载荷（邻题 q-beta 的 teacherComment 哨兵）
  expect(JSON.stringify(data)).not.toContain(PRIVATE_NOTE_SENTINEL);
  expect(JSON.stringify(detail)).not.toContain(PRIVATE_NOTE_SENTINEL);
  expect(JSON.stringify(detail2)).not.toContain(PRIVATE_NOTE_SENTINEL);
});

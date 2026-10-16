import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { TextContent } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { runBackfills } from "../db/backfill.ts";
import { createDbHandle } from "../db/client.ts";
import type { Db } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  aiFacts,
  aiMessages,
  aiTasks,
  attempts,
  teachers,
} from "../db/schema.ts";
import { createTestDir, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { submitLessonQuestion } from "../services/attempt-service.ts";
import { connectMcpClientViaApp } from "./mcp-test-utils.ts";
import { makeNotePng } from "./note-fixtures.ts";
import { insertResponse } from "./ai-companion-fixtures.ts";
import {
  createMatrixWorld,
  jsonViaApp,
  shellOf,
  type MatrixWorld,
} from "./student-ai-matrix-world.ts";

/**
 * SAI-32 跨通道安全矩阵 · 维度 5（B17）：竞态——真实并发触发。
 *
 * 每个用例都构造真实的并发窗口（Promise.all 双请求交错 / transport 挂起
 * 制造「出站已在途」窗口 / SDK 回执飞行中换底层连接），断言任一串行化
 * 顺序下的共同不变量：CAS 恰一胜者、迟到回执只记事实不覆盖、策略与
 * 完成态在外发/交付时点实时重校验。SQLite 同步事务保证单请求原子性，
 * 本维度证明的是原子块之间的交错都落在合法状态机上。
 *
 * 用例清单（批次文档维度 5）：
 * D5-01 更新 pending ∥ 领取（同任务双写，快照不混装）
 * D5-02 双客户端并发指定领取（恰一租约，败者 409 不改抢）
 * D5-03 取消 ∥ 回信写回（迟到回执只记事实，取消不复活）
 * D5-04 交卷 ∥ 出站在途（挂起 transport 真窗口：装配按出发时点，交付按当前态）
 * D5-05 教师禁用 ∥ 出站在途（在途出站完成 + 后续任务暂停零出站）
 * D5-06 教师禁用 ∥ 票据图片下载（正文与 PNG 双向实时重校验）
 * D5-07 讲练单题提交 ∥ 领取 + 重开新卷完成态不串卷
 * D5-08 备份恢复 ∥ MCP 迟到回执（runtimeEpoch 拒旧代 + 新代照常工作）
 */

const activeDbs: Db[] = [];

function world(options: Parameters<typeof createMatrixWorld>[0] = {}): MatrixWorld {
  const w = createMatrixWorld(options);
  activeDbs.push(w.db);
  return w;
}

afterEach(() => {
  for (const db of activeDbs.splice(0)) db.$client.close();
});

async function createTask(
  w: MatrixWorld,
  over: Record<string, unknown> = {},
): Promise<string> {
  const res = await jsonViaApp(w.app, w.cookie1, "/api/student/ai/tasks", "POST", {
    attemptId: w.attempt1,
    questionId: w.qMain,
    question: "请讲解本题",
    channel: "inapp",
    materials: { annotation: false, draft: false, formalInk: false },
    mutationId: randomUUID(),
    ...over,
  });
  const shell = await shellOf(res);
  expect(shell.status).toBe(201);
  return shell.data?.id as string;
}

/** MCP claim（指定 taskId）→ 解析数据段或错误体 */
async function claimTask(
  client: Client,
  taskId: string,
): Promise<{ data: Record<string, unknown>; isError: boolean; raw: string }> {
  const result = await client.callTool({
    name: "claim_ai_task",
    arguments: { taskId },
  });
  const block = (result.content as TextContent[]).find((c) => c.type === "text");
  if (block === undefined) throw new Error("claim 结果没有 text content");
  return {
    data: JSON.parse(block.text) as Record<string, unknown>,
    isError: result.isError === true,
    raw: block.text,
  };
}

/** MCP 回信写回 */
async function submitReply(
  client: Client,
  input: {
    taskId: string;
    leaseToken: string;
    contextVersion?: string;
    runtimeEpoch?: string;
    replyMarkdown?: string;
  },
): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  const result = await client.callTool({
    name: "submit_ai_reply",
    arguments: {
      taskId: input.taskId,
      leaseToken: input.leaseToken,
      replyMarkdown: input.replyMarkdown ?? "D5 回信正文",
      ...(input.contextVersion !== undefined && { contextVersion: input.contextVersion }),
      ...(input.runtimeEpoch !== undefined && { runtimeEpoch: input.runtimeEpoch }),
    },
  });
  const block = (result.content as TextContent[]).find((c) => c.type === "text");
  if (block === undefined) throw new Error("submit_ai_reply 结果没有 text content");
  return {
    data: JSON.parse(block.text) as Record<string, unknown>,
    isError: result.isError === true,
  };
}

function taskRow(w: MatrixWorld, taskId: string) {
  return w.db.select().from(aiTasks).where(eq(aiTasks.id, taskId)).get();
}

function dispatchedFacts(w: MatrixWorld, taskId: string) {
  return w.db
    .select()
    .from(aiFacts)
    .where(and(eq(aiFacts.taskId, taskId), eq(aiFacts.type, "dispatched")))
    .all();
}

function assistantReplyCount(w: MatrixWorld, taskId: string): number {
  return w.db
    .select()
    .from(aiMessages)
    .where(and(eq(aiMessages.taskId, taskId), eq(aiMessages.role, "assistant")))
    .all().length;
}

/** 轮询等待条件成立（挂起窗口用：begin 事务已落库、transport 未返回） */
async function untilTrue(check: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("条件在限定时间内未成立");
}

describe("SAI-32 矩阵维度 5：竞态（真实并发触发）", () => {
  it("D5-01 更新 pending ∥ 领取：恰一原子胜者、快照不混装", async () => {
    const w = world();
    const taskId = await createTask(w, { channel: "mcp" });
    const token = await w.createMcpToken();
    const client = await connectMcpClientViaApp(w.app, "/mcp/student", token, "d5-01");
    // 双写同任务：两条路径都走完整 app/MCP 异步链，SQLite 串行化成某个顺序
    const [updateShell, claim] = await Promise.all([
      shellOf(
        await jsonViaApp(
          w.app,
          w.cookie1,
          `/api/student/ai/tasks/${taskId}/update-pending`,
          "POST",
          { question: "D5 更新后的诉求" },
        ),
      ),
      claimTask(client, taskId),
    ]);
    // 任一串行顺序都合法：更新先赢 → 领取拿重装配快照；领取先赢 → 更新 409
    expect([200, 409]).toContain(updateShell.status);
    expect(claim.isError).toBe(false);
    expect(claim.data.claimed).toBe(true);
    // 共同不变量：终态 claimed、恰一条 dispatched 事实、恰一份租约
    const row = taskRow(w, taskId);
    expect(row?.status).toBe("claimed");
    expect(dispatchedFacts(w, taskId).length).toBe(1);
    expect(row?.leaseToken).toBe(claim.data.leaseToken);
    // 快照不混装：问题正文在首条学生消息上（要么全旧要么全新，与更新胜负一致）
    const firstMessage = w.db
      .select()
      .from(aiMessages)
      .where(and(eq(aiMessages.taskId, taskId), eq(aiMessages.role, "student")))
      .all()[0];
    if (updateShell.status === 200) {
      expect(firstMessage?.contentMd).toContain("D5 更新后的诉求");
      expect(claim.raw).toContain("D5 更新后的诉求");
    } else {
      expect(updateShell.error).toBe("AI_STATE_CONFLICT");
    }
    await client.close();
  });

  it("D5-02 双客户端并发指定领取：恰一租约，败者 409 不改抢", async () => {
    const w = world();
    const taskId = await createTask(w, { channel: "mcp" });
    const token = await w.createMcpToken();
    // 同一 token 两个 SDK 客户端（每通道一条连接；竞争面是并发请求本身）
    const clientA = await connectMcpClientViaApp(w.app, "/mcp/student", token, "d5-02a");
    const clientB = await connectMcpClientViaApp(w.app, "/mcp/student", token, "d5-02b");
    const [a, b] = await Promise.all([claimTask(clientA, taskId), claimTask(clientB, taskId)]);
    const winners = [a, b].filter((r) => !r.isError);
    const losers = [a, b].filter((r) => r.isError);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect((losers[0]?.data as { error?: string }).error).toBe("AI_STATE_CONFLICT");
    // 恰一份租约、generation 恰 +1（创建 0 → 领取 1）、dispatched 事实恰一条
    const row = taskRow(w, taskId);
    expect(row?.status).toBe("claimed");
    expect(row?.leaseToken).toBe(winners[0]?.data.leaseToken);
    expect(row?.generation).toBe(1);
    expect(dispatchedFacts(w, taskId).length).toBe(1);
    await clientA.close();
    await clientB.close();
  });

  it("D5-03 取消 ∥ 回信写回：迟到回执只记事实，取消态永不复活回信", async () => {
    const w = world();
    const taskId = await createTask(w, { channel: "mcp" });
    const token = await w.createMcpToken();
    const client = await connectMcpClientViaApp(w.app, "/mcp/student", token, "d5-03");
    const claim = await claimTask(client, taskId);
    expect(claim.isError).toBe(false);
    const lease = {
      taskId,
      leaseToken: claim.data.leaseToken as string,
      contextVersion: claim.data.contextVersion as string,
      runtimeEpoch: claim.data.runtimeEpoch as string,
    };
    // 取消（HTTP）与写回（MCP）并发：两事务串行化，先到者定终态
    const [cancelShell, submit] = await Promise.all([
      shellOf(
        await jsonViaApp(w.app, w.cookie1, `/api/student/ai/tasks/${taskId}/cancel`, "POST"),
      ),
      submitReply(client, lease),
    ]);
    const row = taskRow(w, taskId);
    expect(["cancelled", "replied"]).toContain(row?.status);
    if (row?.status === "cancelled") {
      // 取消先赢：写回成迟到事实（stale_lease），正文不入 ai_messages
      expect(cancelShell.status).toBe(200);
      expect(submit.isError).toBe(true);
      expect((submit.data as { error?: string }).error).toBe("AI_STATE_CONFLICT");
      expect(assistantReplyCount(w, taskId)).toBe(0);
      const lateFacts = w.db
        .select()
        .from(aiFacts)
        .where(and(eq(aiFacts.taskId, taskId), eq(aiFacts.type, "late_reply")))
        .all();
      expect(lateFacts.length).toBe(1);
      expect(JSON.parse(lateFacts[0]?.detailJson ?? "{}")).toMatchObject({
        reason: "stale_lease",
      });
    } else {
      // 写回先赢：取消被拒（终态不可取消），回信恰一条
      expect(cancelShell.status).toBe(409);
      expect(submit.isError).toBe(false);
      expect(assistantReplyCount(w, taskId)).toBe(1);
    }
    await client.close();
  });

  it("D5-04 交卷 ∥ 出站在途：装配按出发时点，交付按当前完成态", async () => {
    const w = world();
    w.setTeacherDefault(w.teacherA, "guided_only");
    const taskId = await createTask(w);
    w.addInappConnection();
    // 挂起 transport：begin（CAS dispatching + 装配启发提示词）已落库，
    // 出站请求在途——此时交卷落库，随后释放 transport
    let releaseHold: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const dispatchRun = w.dispatchInapp(hold);
    await untilTrue(() => taskRow(w, taskId)?.status === "dispatching");
    w.submitAttempt1();
    releaseHold?.();
    await dispatchRun;
    // 出站载荷按出发时点装配（作答中启发规则）——合法授权的外发
    const row = taskRow(w, taskId);
    expect(row?.status).toBe("replied");
    // 交卷已在途窗口内完成：本题完成 → 交付按当前态开放（open_study 复盘）
    const opened = await shellOf(
      await jsonViaApp(w.app, w.cookie1, `/api/student/ai/tasks/${taskId}/opened`, "POST"),
    );
    expect(opened.status).toBe(200);
    const detail = await shellOf(
      await jsonViaApp(w.app, w.cookie1, `/api/student/ai/tasks/${taskId}`, "GET"),
    );
    expect(detail.raw).toContain("MATRIX-FAKE-REPLY");
  });

  it("D5-05 教师禁用 ∥ 出站在途：在途出站完成，后续任务暂停零出站", async () => {
    const w = world();
    const taskA = await createTask(w);
    w.addInappConnection();
    let releaseHold: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const firstRun = w.dispatchInapp(hold);
    await untilTrue(() => taskRow(w, taskA)?.status === "dispatching");
    // A 出站在途：此刻（候选列举已结束）再建 B（仍开放，合法入库待发）
    const taskB = await createTask(w);
    // 教师切 post_submit_only（作答中禁用 AI）——落在 A 出站窗口内
    w.setOverride("student", w.student1, "post_submit_only");
    releaseHold?.();
    const first = await firstRun;
    // 在途出站按出发时点合法完成（A replied，恰一次出站记录）
    expect(taskRow(w, taskA)?.status).toBe("replied");
    expect(first.recorded.length).toBe(1);
    // 后续派发轮：B begin 实时重校验 → 转 paused（未出站、零出站记录）
    const secondRun = await w.dispatchInapp();
    expect(taskRow(w, taskB)?.status).toBe("paused");
    expect(secondRun.recorded.length).toBe(0);
    // A 的回信交付同样被当前禁用拦住（完成态未到，opened 403）
    const opened = await shellOf(
      await jsonViaApp(w.app, w.cookie1, `/api/student/ai/tasks/${taskA}/opened`, "POST"),
    );
    expect(opened.status).toBe(403);
    expect(opened.error).toBe("AI_POLICY_DISABLED");
  });

  it("D5-06 教师禁用 ∥ 票据图片下载：正文与 PNG 双向实时重校验", async () => {
    const w = world();
    const taskId = await createTask(w, { channel: "link" });
    // 上传材料 + 生成票据
    const png = makeNotePng();
    const form = new FormData();
    form.append(
      "manifest",
      JSON.stringify([
        { kind: "annotation", pageIndex: 0, pixelWidth: 320, pixelHeight: 200 },
      ]),
    );
    form.append("page-0", new Blob([png], { type: "image/png" }));
    const upload = await w.app.request(`/api/student/ai/tasks/${taskId}/materials`, {
      method: "POST",
      headers: { cookie: w.cookie1 },
      body: form,
    });
    expect(upload.status).toBe(200);
    const share = await jsonViaApp(
      w.app,
      w.cookie1,
      `/api/student/ai/tasks/${taskId}/share`,
      "POST",
      {},
    );
    expect(share.status).toBe(200);
    const { data } = (await share.json()) as { data: { ticketUrl: string } };
    const path = new URL(data.ticketUrl).pathname;
    // 开放期：正文与 PNG 都可达
    const bodyBefore = await shellOf(await w.app.request(path));
    const pngBefore = await w.app.request(`${path}/materials/0.png`);
    expect(bodyBefore.status).toBe(200);
    expect(pngBefore.status).toBe(200);
    // 禁用落在两次下载之间：后续正文与 PNG 都被实时重校验拒绝
    w.setOverride("student", w.student1, "post_submit_only");
    const bodyAfter = await shellOf(await w.app.request(path));
    const pngAfter = await w.app.request(`${path}/materials/0.png`);
    expect(bodyAfter.status).toBe(403);
    expect(bodyAfter.error).toBe("AI_POLICY_DISABLED");
    expect(pngAfter.status).toBe(403);
    expect(await pngAfter.text()).not.toContain("PNG");
    // 恢复开放：同一票据重新可达（字节同源）
    w.clearOverride("student", w.student1);
    const pngRevived = await w.app.request(`${path}/materials/0.png`);
    expect(pngRevived.status).toBe(200);
    expect(Buffer.from(await pngRevived.arrayBuffer()).equals(Buffer.from(png))).toBe(true);
  });

  it("D5-07 讲练单题提交 ∥ 领取 + 重开新卷完成态不串卷", async () => {
    const w = world();
    w.setTeacherDefault(w.teacherA, "guided_only");
    // 讲练卷（sourceType=lesson）+ 本题/邻题两行
    const lessonAttempt = randomUUID();
    w.db
      .insert(attempts)
      .values({
        id: lessonAttempt,
        studentId: w.student1,
        sourceType: "lesson",
        assignmentId: null,
        courseId: null,
        unitId: null,
        lectureId: null,
        attemptNo: 1,
        status: "draft",
        startedAt: "2026-06-01T00:00:00.000Z",
        frozenAt: "2026-06-01T00:00:00.000Z",
        legacyUnverified: false,
        abandonedAt: null,
      })
      .run();
    const lessonRespId = insertResponse(w.db, lessonAttempt, w.qMain);
    insertResponse(w.db, lessonAttempt, w.qNeighbor);
    const taskId = await createTask(w, {
      attemptId: lessonAttempt,
      channel: "mcp",
      question: "D5 讲练求助",
    });
    const token = await w.createMcpToken();
    const client = await connectMcpClientViaApp(w.app, "/mcp/student", token, "d5-07");
    // 领取飞行中单题提交（真实服务入口）：两事务串行化，任一顺序都合法
    const claimPromise = claimTask(client, taskId);
    submitLessonQuestion(w.db, w.student1, lessonAttempt, w.qMain, {
      questionRevisionId: lessonRespId,
    });
    const claim = await claimPromise;
    expect(claim.isError).toBe(false);
    expect(claim.data.claimed).toBe(true);
    const mode = claim.data.modeAtSend as string;
    // 装配原子性：模式与提示词规则同源（启发 ↔ 作答中 / 复盘 ↔ 完成后）
    if (mode === "guided_only") {
      expect(claim.raw).toContain("当前为仅启发");
      expect(claim.raw).not.toContain("当前为完成后复盘");
    } else {
      expect(mode).toBe("open_study");
      expect(claim.raw).toContain("当前为完成后复盘");
    }
    // 重开新卷（attemptNo+1 全新行）：完成态不跨卷继承，新任务按作答中装配
    const lessonAttempt2 = randomUUID();
    w.db
      .insert(attempts)
      .values({
        id: lessonAttempt2,
        studentId: w.student1,
        sourceType: "lesson",
        assignmentId: null,
        courseId: null,
        unitId: null,
        lectureId: null,
        attemptNo: 2,
        status: "draft",
        startedAt: "2026-06-01T00:00:00.000Z",
        frozenAt: "2026-06-01T00:00:00.000Z",
        legacyUnverified: false,
        abandonedAt: null,
      })
      .run();
    insertResponse(w.db, lessonAttempt2, w.qMain);
    const task2 = await createTask(w, {
      attemptId: lessonAttempt2,
      channel: "mcp",
      question: "D5 重开后的新求助",
    });
    const claim2 = await claimTask(client, task2);
    expect(claim2.isError).toBe(false);
    expect(claim2.data.modeAtSend).toBe("guided_only");
    expect(claim2.raw).toContain("当前为仅启发");
    await client.close();
  });

  it("D5-08 备份恢复 ∥ MCP 迟到回执：旧代拒绝只记事实，新代照常工作", async () => {
    // 文件库 + 可重启句柄：restore 语义 = 底层连接被换（runtimeEpoch 变化）
    const dir = createTestDir();
    const openHook = (fresh: Db): void => {
      runMigrations(fresh);
      runBackfills(fresh);
      fresh
        .insert(teachers)
        .values({
          id: TEST_TEACHER_ID,
          loginName: "teacher",
          isAdmin: true,
          disabledAt: null,
          passwordHash: null,
          apiToken: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        })
        .onConflictDoNothing()
        .run();
    };
    const handle = createDbHandle(`${dir}/tutor.db`.replaceAll("\\", "/"), openHook);
    const w = world({ db: handle.db, dataDir: dir });
    const taskId = await createTask(w, { channel: "mcp" });
    const token = await w.createMcpToken();
    const client = await connectMcpClientViaApp(w.app, "/mcp/student", token, "d5-08");
    const claim = await claimTask(client, taskId);
    expect(claim.isError).toBe(false);
    // 回执飞行中（SDK 请求已发出、handler 未及执行）恢复数据库：
    // 同 tick 内同步 restart 必然先于 handler 落地
    const submitFlight = submitReply(client, {
      taskId,
      leaseToken: claim.data.leaseToken as string,
      contextVersion: claim.data.contextVersion as string,
      runtimeEpoch: claim.data.runtimeEpoch as string,
      replyMarkdown: "D5 迟到回信",
    });
    handle.restart();
    const submit = await submitFlight;
    // 旧代回执拒绝：409 + late_reply 事实（runtime_epoch_stale），正文不入库
    expect(submit.isError).toBe(true);
    expect((submit.data as { error?: string }).error).toBe("AI_STATE_CONFLICT");
    expect(assistantReplyCount(w, taskId)).toBe(0);
    const lateFacts = w.db
      .select()
      .from(aiFacts)
      .where(and(eq(aiFacts.taskId, taskId), eq(aiFacts.type, "late_reply")))
      .all();
    expect(lateFacts.length).toBe(1);
    expect(JSON.parse(lateFacts[0]?.detailJson ?? "{}")).toMatchObject({
      reason: "runtime_epoch_stale",
    });
    expect(taskRow(w, taskId)?.status).toBe("claimed");
    // 新代照常工作：恢复后新建任务领取 + 写回成功
    const task2 = await createTask(w, { channel: "mcp" });
    const claim2 = await claimTask(client, task2);
    expect(claim2.isError).toBe(false);
    const submit2 = await submitReply(client, {
      taskId: task2,
      leaseToken: claim2.data.leaseToken as string,
      contextVersion: claim2.data.contextVersion as string,
      runtimeEpoch: claim2.data.runtimeEpoch as string,
    });
    expect(submit2.isError).toBe(false);
    expect(taskRow(w, task2)?.status).toBe("replied");
    await client.close();
  });
});

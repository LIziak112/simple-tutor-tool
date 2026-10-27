import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { TextContent } from "@modelcontextprotocol/sdk/types.js";
import {
  aiAttemptReviewCreateOkSchema,
  aiAttemptReviewMcpClaimViewSchema,
  aiAttemptReviewPreviewOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession } from "../auth/session.ts";
import type { Db } from "../db/client.ts";
import {
  aiFacts,
  aiPolicyOverrides,
  aiTasks,
  annotationBases,
  annotations,
  attempts,
  responses,
} from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { attachAiTaskMaterials } from "../services/ai-companion/student-ai-materials.ts";
import { createAiTask } from "../services/ai-companion/student-ai-queue.ts";
import {
  insertAttempt,
  insertResponse,
} from "../test/ai-companion-fixtures.ts";
import {
  callToolJson,
  connectMcpClientViaApp,
} from "../test/mcp-test-utils.ts";
import { makeNotePng, makeStudent } from "../test/note-fixtures.ts";
import { STUDENT_MCP_TOOL_NAMES } from "./student-server.ts";

/**
 * SAI-26 学生 MCP 任务工具测试（B14 必测 6 组；真实 SDK Streamable HTTP
 * 客户端全链路：claim → feedback → 学生页面 API 可读）。
 * 工具四类：list_my_ai_tasks（只读列表）/ claim_ai_task（领取+装配）/
 * renew_ai_lease（续租）/ submit_ai_reply（回信写回）——全部走 SAI-12/09/11
 * 既有服务层（同一规则），MCP 层不直接更新数据库。
 */

const silentLogger: Logger = pino({ enabled: false });
const SECRET = "sai26-mcp-secret";
const NOW = "2026-06-01T00:00:00.000Z";

interface ToolsEnv {
  app: ReturnType<typeof createApp>;
  db: Db;
  dataDir: string;
  token: string;
  studentId: string;
  studentCookie: string;
  /** 建好的题目世界：attemptId + 两道题 */
  world: { attemptId: string; q1: string; q2: string };
}

/** 学生 + mcp 连接（真实 token）+ 两题卷 */
async function makeEnv(): Promise<ToolsEnv> {
  const db = createTestDb();
  const dataDir = createTestDir();
  const studentId = makeStudent(db);
  const attemptId = insertAttempt(db, { studentId });
  const q1 = "sai26-q1";
  const q2 = "sai26-q2";
  insertResponse(db, attemptId, q1);
  insertResponse(db, attemptId, q2);
  const app = createApp({
    db,
    dataDir,
    publicUrl: "http://localhost:8787",
    isProduction: false,
    logger: silentLogger,
  });
  const studentCookie = `tutor_student_session=${
    createStudentSession(db, studentId).token
  }`;
  const created = await app.request("/api/student/ai/connections", {
    method: "POST",
    headers: { cookie: studentCookie, "content-type": "application/json" },
    body: JSON.stringify({ channel: "mcp" }),
  });
  const body = (await created.json()) as {
    data: { credential: { token: string } | null };
  };
  if (body.data.credential === null) throw new Error("mcp token 创建失败");
  return {
    app,
    db,
    dataDir,
    token: body.data.credential.token,
    studentId,
    studentCookie,
    world: { attemptId, q1, q2 },
  };
}

/** 建立 SDK 客户端连接（Streamable HTTP + Bearer token；样板见 test/mcp-test-utils.ts） */
const connectClient = (env: ToolsEnv, token = env.token) =>
  connectMcpClientViaApp(env.app, "/mcp/student", token, "sai26-tools-test");

/** callTool + 取第一段 text 解析 JSON；isError 时返回解析后的错误对象 */
async function callJson(
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

/** 建 mcp 任务（channel=mcp；可指定题与创建时刻偏移毫秒——FIFO 顺序确定性） */
function mkTask(
  env: ToolsEnv,
  opts?: { questionId?: string; question?: string; atMs?: number },
): string {
  const { task } = createAiTask(
    env.db,
    {
      studentId: env.studentId,
      attemptId: env.world.attemptId,
      questionId: opts?.questionId ?? env.world.q1,
      question: opts?.question ?? "请帮我讲解本题",
      channel: "mcp",
      mutationId: randomUUID(),
    },
    { hmacSecret: SECRET, now: new Date(Date.parse(NOW) + (opts?.atMs ?? 0)) },
  );
  return task.id;
}

// ---------- 必测①：重放同 claim / 两客户端竞争唯一写回 ----------

describe("SAI-26 领取与写回竞争", () => {
  it("整体复盘真实 MCP 领取含全部选项，作答作废后拒绝报告交付", async () => {
    const env = await makeEnv();
    env.db
      .update(attempts)
      .set({ status: "submitted", submittedAt: NOW })
      .where(eq(attempts.id, env.world.attemptId))
      .run();
    const previewRes = await env.app.request(
      `/api/student/ai/attempt-reviews/preview?attemptId=${env.world.attemptId}`,
      { headers: { cookie: env.studentCookie } },
    );
    expect(previewRes.status).toBe(200);
    const preview = aiAttemptReviewPreviewOkSchema.parse(
      await previewRes.json(),
    ).data;
    const createdRes = await env.app.request(
      "/api/student/ai/attempt-reviews",
      {
        method: "POST",
        headers: {
          cookie: env.studentCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          attemptId: env.world.attemptId,
          mutationId: randomUUID(),
          expectedPreviewVersion: preview.opaquePreviewVersion,
          purpose: "复盘",
          channel: "mcp",
        }),
      },
    );
    expect(createdRes.status).toBe(201);
    const task = aiAttemptReviewCreateOkSchema.parse(await createdRes.json())
      .data.task;
    const client = await connectClient(env);
    try {
      const result = await callToolJson(client, "claim_attempt_review", {
        taskId: task.id,
      });
      expect(result.isError).toBe(false);
      const { claimed, ...payload } = result.data;
      expect(claimed).toBe(true);
      const view = aiAttemptReviewMcpClaimViewSchema.parse(payload);
      expect(view.snapshot.questions[0]?.options).toEqual([
        { text: "甲" },
        { text: "乙" },
      ]);
      env.db
        .update(attempts)
        .set({ abandonedAt: NOW })
        .where(eq(attempts.id, env.world.attemptId))
        .run();
      const reply = await callToolJson(client, "submit_attempt_review_result", {
        taskId: task.id,
        leaseToken: view.lease.leaseToken,
        generation: view.generation,
        snapshotVersion: view.snapshotVersion,
        report: {
          schemaVersion: 1,
          overview: "不应交付的答案正文",
          knowledgeFindings: [],
          errorPatterns: [],
          performanceNotes: [],
          trainingPlan: [],
          limitations: [],
        },
      });
      expect(reply.isError).toBe(true);
      expect(reply.data.error).toBe("ATTEMPT_ABANDONED");
      const detailRes = await env.app.request(
        `/api/student/ai/attempt-reviews/${task.id}`,
        { headers: { cookie: env.studentCookie } },
      );
      expect(detailRes.status).toBe(409);
      expect(await detailRes.text()).not.toContain("不应交付的答案正文");
    } finally {
      await client.close();
      env.db.$client.close();
    }
  });
  it("FIFO 两客户端各领一题；指定已领 taskId 重放 409；非持有者不能写回", async () => {
    const env = await makeEnv();
    const t1 = mkTask(env);
    const t2 = mkTask(env, { questionId: env.world.q2, atMs: 1000 });
    const a = await connectClient(env);
    const b = await connectClient(env);

    const claimA = await callToolJson(a, "claim_ai_task", {});
    expect(claimA.isError).toBe(false);
    expect(claimA.data.claimed).toBe(true);
    expect(claimA.data.taskId).toBe(t1); // createdAt FIFO
    const leaseA = claimA.data.leaseToken as string;

    const claimB = await callToolJson(b, "claim_ai_task", {});
    expect(claimB.data.taskId).toBe(t2);

    // 重放同 claim（指定 taskId）：已领取 → 409 稳定错误，不悄悄改抢新任务
    const replay = await callToolJson(a, "claim_ai_task", { taskId: t1 });
    expect(replay.isError).toBe(true);
    expect(replay.data.error).toBe("AI_STATE_CONFLICT");

    // 竞争：B 用自己的 lease 试图写回 A 领取的 t1 → 409（late_reply 事实）
    const steal = await callToolJson(b, "submit_ai_reply", {
      taskId: t1,
      leaseToken: claimB.data.leaseToken,
      replyMarkdown: "B 的抢写回信",
    });
    expect(steal.isError).toBe(true);
    expect(steal.data.error).toBe("AI_STATE_CONFLICT");

    // 唯一有效持有者 A 写回成功
    const ok = await callToolJson(a, "submit_ai_reply", {
      taskId: t1,
      leaseToken: leaseA,
      replyMarkdown: "A 的正式回信",
      contextVersion: claimA.data.contextVersion,
    });
    expect(ok.isError).toBe(false);
    expect(ok.data.duplicate).toBe(false);
    await a.close();
    await b.close();
  });

  it("无可领取任务：claimed:false（正常状态不是错误）；空队列领取后再领下一题", async () => {
    const env = await makeEnv();
    const client = await connectClient(env);
    const empty = await callToolJson(client, "claim_ai_task", {});
    expect(empty.isError).toBe(false);
    expect(empty.data.claimed).toBe(false);
    const t1 = mkTask(env);
    const first = await callToolJson(client, "claim_ai_task", {});
    expect(first.data.taskId).toBe(t1);
    const second = await callToolJson(client, "claim_ai_task", {});
    expect(second.data.claimed).toBe(false);
    await client.close();
  });
});

// ---------- 必测②：只读 list 无副作用；annotation 真实 ----------

describe("SAI-26 只读列表与工具注解", () => {
  it("list_my_ai_tasks 不领取/不标记已读（状态与事实零变化），元信息+游标分页", async () => {
    const env = await makeEnv();
    const t1 = mkTask(env);
    mkTask(env, { questionId: env.world.q2 });
    const client = await connectClient(env);
    const list1 = await callToolJson(client, "list_my_ai_tasks", { limit: 1 });
    expect(list1.isError).toBe(false);
    const tasks1 = list1.data.tasks as { id: string; status: string }[];
    expect(tasks1).toHaveLength(1);
    expect(typeof list1.data.nextCursor).toBe("string");
    const list2 = await callToolJson(client, "list_my_ai_tasks", {
      limit: 1,
      cursor: list1.data.nextCursor,
    });
    expect((list2.data.tasks as { id: string }[])[0]?.id).not.toBe(
      tasks1[0]?.id,
    );
    // 零副作用：状态仍 created、零 dispatched 事实
    const row = env.db.select().from(aiTasks).where(eq(aiTasks.id, t1)).get();
    expect(row?.status).toBe("created");
    const facts = env.db
      .select()
      .from(aiFacts)
      .all()
      .filter((f) => f.taskId === t1);
    expect(facts.filter((f) => f.type === "dispatched")).toHaveLength(0);
    await client.close();
  });

  it("工具注解真实：list 只读、submit 幂等非破坏、claim/renew 无只读标记", async () => {
    const env = await makeEnv();
    const client = await connectClient(env);
    const list = await client.listTools();
    const byName = new Map(list.tools.map((tool) => [tool.name, tool]));
    expect(list.tools.map((t) => t.name).sort()).toEqual(
      [...STUDENT_MCP_TOOL_NAMES].sort(),
    );
    expect(byName.get("list_my_ai_tasks")?.annotations?.readOnlyHint).toBe(
      true,
    );
    expect(byName.get("submit_ai_reply")?.annotations?.idempotentHint).toBe(
      true,
    );
    expect(byName.get("submit_ai_reply")?.annotations?.destructiveHint).toBe(
      false,
    );
    expect(byName.get("claim_ai_task")?.annotations?.readOnlyHint).toBeFalsy();
    expect(byName.get("renew_ai_lease")?.annotations?.readOnlyHint).toBeFalsy();
    // 整体复盘四工具（任务 1ef854c7）注解同口径：list 只读，submit 幂等
    // 非破坏，claim/renew 无只读标记
    expect(
      byName.get("list_my_attempt_reviews")?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(
      byName.get("submit_attempt_review_result")?.annotations?.idempotentHint,
    ).toBe(true);
    expect(
      byName.get("submit_attempt_review_result")?.annotations?.destructiveHint,
    ).toBe(false);
    expect(
      byName.get("claim_attempt_review")?.annotations?.readOnlyHint,
    ).toBeFalsy();
    expect(
      byName.get("renew_attempt_review_lease")?.annotations?.readOnlyHint,
    ).toBeFalsy();
    // 错题组卷两工具（2026-10）：list 只读；create 非幂等、显式标 destructive=false
    expect(
      byName.get("list_my_wrong_questions")?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(
      byName.get("create_wrong_practice")?.annotations?.idempotentHint,
    ).toBe(false);
    expect(
      byName.get("create_wrong_practice")?.annotations?.destructiveHint,
    ).toBe(false);
    await client.close();
  });
});

// ---------- 必测③：pending 提交后领取采用复盘模式；教师关闭后受限 ----------

describe("SAI-26 模式裁决（pending 提交后 / 教师关闭）", () => {
  it("提交前创建的任务，提交后领取 → 复盘模式（modeAtSend=open_study）+ 提示词重装配", async () => {
    const env = await makeEnv();
    // 默认开放模式创建（pending），教师改 post_submit_only，学生交卷后领取
    const t1 = mkTask(env);
    const beforeClaim = env.db
      .select()
      .from(aiTasks)
      .where(eq(aiTasks.id, t1))
      .get();
    expect(beforeClaim?.modeAtSend).toBe("open_study");
    env.db
      .insert(aiPolicyOverrides)
      .values({
        subjectType: "student",
        subjectId: env.studentId,
        mode: "post_submit_only",
        updatedAt: NOW,
      })
      .run();
    // 提交后：attempt submitted + 响应行 submittedAt → completed
    env.db
      .update(attempts)
      .set({ status: "submitted", submittedAt: NOW })
      .where(eq(attempts.id, env.world.attemptId))
      .run();
    env.db
      .update(responses)
      .set({ submittedAt: NOW })
      .where(eq(responses.attemptId, env.world.attemptId))
      .run();
    const client = await connectClient(env);
    const claim = await callToolJson(client, "claim_ai_task", {});
    expect(claim.isError).toBe(false);
    expect(claim.data.taskId).toBe(t1);
    expect(claim.data.modeAtSend).toBe("open_study"); // 完成后恒复盘尺度
    const system = claim.data.systemPromptMd as string;
    expect(system.length).toBeGreaterThan(0);
    const messages = claim.data.messages as { role: string; content: string }[];
    expect(messages.some((m) => m.role === "user")).toBe(true);
    await client.close();
  });

  it("教师关闭（post_submit_only）后：未完成题领取 403；已持有租约的续租/写回按队列语义", async () => {
    const env = await makeEnv();
    // 关闭前创建两题并领取一题（持有租约），再关闭
    const t1 = mkTask(env);
    const t2 = mkTask(env, { questionId: env.world.q2, atMs: 1000 });
    const client = await connectClient(env);
    const claim = await callToolJson(client, "claim_ai_task", {});
    expect(claim.data.taskId).toBe(t1);
    env.db
      .insert(aiPolicyOverrides)
      .values({
        subjectType: "student",
        subjectId: env.studentId,
        mode: "post_submit_only",
        updatedAt: NOW,
      })
      .run();
    // 未完成的新任务：指定领取 → 403 AI_POLICY_DISABLED（教师刚改立即生效）
    const blocked = await callToolJson(client, "claim_ai_task", { taskId: t2 });
    expect(blocked.isError).toBe(true);
    expect(blocked.data.error).toBe("AI_POLICY_DISABLED");
    // FIFO 领取：无可领取 → claimed:false（不报错、不半领取）
    const fifo = await callToolJson(client, "claim_ai_task", {});
    expect(fifo.isError).toBe(false);
    expect(fifo.data.claimed).toBe(false);
    // 已持有租约：续租与写回仍按队列语义（回信作为事实入库，交付由页面侧裁决）
    const renew = await callToolJson(client, "renew_ai_lease", {
      taskId: t1,
      leaseToken: claim.data.leaseToken,
    });
    expect(renew.isError).toBe(false);
    const submit = await callToolJson(client, "submit_ai_reply", {
      taskId: t1,
      leaseToken: claim.data.leaseToken,
      replyMarkdown: "关闭后的迟到但有效的写回",
      contextVersion: claim.data.contextVersion,
    });
    expect(submit.isError).toBe(false);
    await client.close();
  });
});

// ---------- 必测④：旧 lease / 旧 contextVersion / 重复反馈的稳定错误 ----------

describe("SAI-26 稳定错误与幂等", () => {
  it("同反馈重放 duplicate；不同正文不覆盖首次成功；过期租约 409", async () => {
    const env = await makeEnv();
    const t1 = mkTask(env);
    const client = await connectClient(env);
    const claim = await callToolJson(client, "claim_ai_task", {});
    const reply = { taskId: t1, leaseToken: claim.data.leaseToken as string };
    const first = await callToolJson(client, "submit_ai_reply", {
      ...reply,
      replyMarkdown: "唯一首次回信",
      contextVersion: claim.data.contextVersion,
    });
    expect(first.data.duplicate).toBe(false);
    // 同内容重放 → duplicate（幂等，不重复入库）
    const again = await callToolJson(client, "submit_ai_reply", {
      ...reply,
      replyMarkdown: "唯一首次回信",
    });
    expect(again.isError).toBe(false);
    expect(again.data.duplicate).toBe(true);
    // 不同正文 → 409，首次成功不被覆盖
    const overwrite = await callToolJson(client, "submit_ai_reply", {
      ...reply,
      replyMarkdown: "试图覆盖的第二次回信",
    });
    expect(overwrite.isError).toBe(true);
    expect(overwrite.data.error).toBe("AI_STATE_CONFLICT");
    // 过期租约：直接改行模拟超时后迟到写回 → 409（late_reply 事实保留）
    env.db
      .update(aiTasks)
      .set({ leaseUntil: "2026-06-01T00:00:01.000Z" })
      .where(eq(aiTasks.id, t1))
      .run();
    const stale = await callToolJson(client, "submit_ai_reply", {
      taskId: t1,
      leaseToken: "00000000-0000-4000-8000-000000000000",
      replyMarkdown: "旧租约的迟到回信",
    });
    expect(stale.isError).toBe(true);
    expect(stale.data.error).toBe("AI_STATE_CONFLICT");
    // 首次成功回信仍是学生看到的唯一正文
    const row = env.db.select().from(aiTasks).where(eq(aiTasks.id, t1)).get();
    expect(row?.status).toBe("replied");
    await client.close();
  });

  it("旧 contextVersion → 409 稳定错误（context_stale）", async () => {
    const env = await makeEnv();
    const t1 = mkTask(env);
    const client = await connectClient(env);
    const claim = await callToolJson(client, "claim_ai_task", {});
    const stale = await callToolJson(client, "submit_ai_reply", {
      taskId: t1,
      leaseToken: claim.data.leaseToken,
      replyMarkdown: "基于旧上下文的回信",
      contextVersion: "0".repeat(64),
    });
    expect(stale.isError).toBe(true);
    expect(stale.data.error).toBe("AI_STATE_CONFLICT");
    await client.close();
  });
});

// ---------- 必测⑤：多图超限显式 / 跨任务材料不串 ----------

describe("SAI-26 材料图像边界", () => {
  it("领取返回本任务图像（SDK image content）；单任务多页与跨任务边界清晰", async () => {
    const env = await makeEnv();
    const t1 = mkTask(env);
    const png1 = makeNotePng(100, 80, 10);
    const png2 = makeNotePng(100, 80, 20);
    attachAiTaskMaterials(env.db, env.dataDir, {
      studentId: env.studentId,
      taskId: t1,
      pages: [
        {
          kind: "draft",
          pageIndex: 0,
          pixelWidth: 100,
          pixelHeight: 80,
          png: png1,
        },
        {
          kind: "draft",
          pageIndex: 1,
          pixelWidth: 100,
          pixelHeight: 80,
          png: png2,
        },
      ],
    });
    const t2 = mkTask(env, { questionId: env.world.q2 });
    const other = makeNotePng(120, 90, 30);
    attachAiTaskMaterials(env.db, env.dataDir, {
      studentId: env.studentId,
      taskId: t2,
      pages: [
        {
          kind: "annotation",
          pageIndex: 0,
          pixelWidth: 120,
          pixelHeight: 90,
          png: other,
        },
      ],
    });
    const client = await connectClient(env);
    // 指定领取 t1（避开 FIFO 顺序耦合）
    const claim1 = await client.callTool({
      name: "claim_ai_task",
      arguments: { taskId: t1 },
    });
    expect(claim1.isError).toBeFalsy();
    const blocks = claim1.content as {
      type: string;
      data?: string;
      mimeType?: string;
      text?: string;
    }[];
    const images = blocks.filter((b) => b.type === "image");
    expect(images).toHaveLength(2);
    expect(images[0]?.mimeType).toBe("image/png");
    expect(images[0]?.data).toBe(Buffer.from(png1).toString("base64"));
    expect(images[1]?.data).toBe(Buffer.from(png2).toString("base64"));
    const meta = JSON.parse(
      (blocks.find((b) => b.type === "text")?.text ?? "") as string,
    ) as { materials: { kind: string; pageIndex: number; byteSize: number }[] };
    expect(meta.materials).toEqual([
      { kind: "draft", pageIndex: 0, byteSize: png1.byteLength },
      { kind: "draft", pageIndex: 1, byteSize: png2.byteLength },
    ]);

    // t2：只含自己的材料——不把 t1 的图/题面塞进来
    const claim2 = await client.callTool({
      name: "claim_ai_task",
      arguments: { taskId: t2 },
    });
    const blocks2 = claim2.content as {
      type: string;
      data?: string;
      text?: string;
    }[];
    const images2 = blocks2.filter((b) => b.type === "image");
    expect(images2).toHaveLength(1);
    expect(images2[0]?.data).toBe(Buffer.from(other).toString("base64"));
    const text2 = (blocks2.find((b) => b.type === "text")?.text ??
      "") as string;
    expect(text2).not.toContain(Buffer.from(png1).toString("base64"));
    await client.close();
  });

  it("多图超限：显式 AI_MATERIAL_TOO_LARGE（带租约信息可仅文字写回）；includeImages=false 显式不附图", async () => {
    const env = await makeEnv();
    const t1 = mkTask(env);
    // 3 页 × ~1.5MiB（单页 ≤2MiB 附件上限内）= 4.5MiB > 4MiB 领取附图预算
    const pageBytes = 1536 * 1024;
    attachAiTaskMaterials(env.db, env.dataDir, {
      studentId: env.studentId,
      taskId: t1,
      pages: [0, 1, 2].map((pageIndex) => ({
        kind: "draft" as const,
        pageIndex,
        pixelWidth: 100,
        pixelHeight: 80,
        png: makeNotePng(100, 80, pageBytes - 64),
      })),
    });
    const client = await connectClient(env);
    const over = await callToolJson(client, "claim_ai_task", {});
    expect(over.isError).toBe(true);
    expect(over.data.error).toBe("AI_MATERIAL_TOO_LARGE");
    // 不静默丢页：领取已发生，租约信息随错误交付（客户端可仅文字写回或放任过期）
    expect(typeof over.data.leaseToken).toBe("string");
    expect(over.data.taskId).toBe(t1);
    const textOnly = await callToolJson(client, "submit_ai_reply", {
      taskId: t1,
      leaseToken: over.data.leaseToken,
      replyMarkdown: "未见图的文字回信",
    });
    expect(textOnly.isError).toBe(false);

    // includeImages=false：显式声明不附图，正常领取（图片客户端降级路径）
    const t2 = mkTask(env, { questionId: env.world.q2 });
    const noImages = await client.callTool({
      name: "claim_ai_task",
      arguments: { includeImages: false },
    });
    expect(noImages.isError).toBeFalsy();
    const blocks = noImages.content as { type: string; text?: string }[];
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(0);
    const meta = JSON.parse(
      (blocks.find((b) => b.type === "text")?.text ?? "") as string,
    ) as { taskId: string; imagesIncluded: boolean };
    expect(meta.taskId).toBe(t2);
    expect(meta.imagesIncluded).toBe(false);
    await client.close();
  });
});

// ---------- 必测⑥：伪造 queueId / 跨学生 / 学生页面可读 ----------

describe("SAI-26 伪造任务与页面闭环", () => {
  it("伪造 taskId / 他学生 taskId → 同文案 NOT_FOUND；MCP 写回后学生 API 可读、事实正确", async () => {
    const env = await makeEnv();
    // 另一学生的真实任务（同教师域）：防枚举同文案
    const otherStudent = makeStudent(env.db);
    const otherAttempt = insertAttempt(env.db, { studentId: otherStudent });
    insertResponse(env.db, otherAttempt, "other-q");
    const otherTask = createAiTask(
      env.db,
      {
        studentId: otherStudent,
        attemptId: otherAttempt,
        questionId: "other-q",
        question: "他学生的求助",
        channel: "mcp",
        mutationId: randomUUID(),
      },
      { hmacSecret: SECRET, now: new Date(NOW) },
    ).task.id;

    const client = await connectClient(env);
    const forged = await callToolJson(client, "submit_ai_reply", {
      taskId: randomUUID(),
      leaseToken: "any",
      replyMarkdown: "伪造任务的回信",
    });
    expect(forged.isError).toBe(true);
    expect(forged.data.error).toBe("NOT_FOUND");
    const cross = await callToolJson(client, "submit_ai_reply", {
      taskId: otherTask,
      leaseToken: "any",
      replyMarkdown: "跨学生写回",
    });
    expect(cross.isError).toBe(true);
    expect(cross.data.message).toBe(forged.data.message); // 同文案防枚举

    // 完整闭环：领取 → 写回 → 学生页面 API 可读、平台事实正确
    const t1 = mkTask(env);
    const claim = await callToolJson(client, "claim_ai_task", { taskId: t1 });
    const submit = await callToolJson(client, "submit_ai_reply", {
      taskId: t1,
      leaseToken: claim.data.leaseToken,
      replyMarkdown: "## 讲解\n先看条件……",
      contextVersion: claim.data.contextVersion,
      runtimeEpoch: claim.data.runtimeEpoch,
    });
    expect(submit.isError).toBe(false);
    // 事实：task_created（创建）+ dispatched(mcp_claim) + reply_received(mcp)
    const facts = env.db
      .select()
      .from(aiFacts)
      .where(eq(aiFacts.taskId, t1))
      .all();
    expect(facts.map((f) => f.type).sort()).toEqual(
      ["dispatched", "reply_received", "task_created"].sort(),
    );
    // 学生页面（同一规则另一接口）：任务 replied、消息含回信
    const detail = await env.app.request(`/api/student/ai/tasks/${t1}`, {
      headers: { cookie: env.studentCookie },
    });
    expect(detail.status).toBe(200);
    const data = (
      (await detail.json()) as {
        data: {
          task: { status: string; hasReply: boolean };
          messages: { role: string; contentMd: string }[];
        };
      }
    ).data;
    expect(data.task.status).toBe("replied");
    expect(data.task.hasReply).toBe(true);
    expect(
      data.messages.some(
        (m) => m.role === "assistant" && m.contentMd.includes("讲解"),
      ),
    ).toBe(true);
    await client.close();
  });

  it("工具入参自报 studentId 无效（身份只从 token 派生，域不转移）", async () => {
    const env = await makeEnv();
    // 他学生先建一个更早的待领取任务：若自报身份生效，FIFO 会领到它
    const otherStudent = makeStudent(env.db);
    const otherAttempt = insertAttempt(env.db, { studentId: otherStudent });
    insertResponse(env.db, otherAttempt, "spoof-q");
    const otherTask = createAiTask(
      env.db,
      {
        studentId: otherStudent,
        attemptId: otherAttempt,
        questionId: "spoof-q",
        question: "他学生更早的求助",
        channel: "mcp",
        mutationId: randomUUID(),
      },
      { hmacSecret: SECRET, now: new Date(Date.parse(NOW) - 1000) },
    ).task.id;
    const mine = mkTask(env);

    const client = await connectClient(env);
    // claim / list 入参全部塞他学生 id：zod 剥离未知字段，域仍是 token 绑定学生
    const claim = await callToolJson(client, "claim_ai_task", {
      studentId: otherStudent,
    });
    expect(claim.isError).toBe(false);
    expect(claim.data.taskId).toBe(mine); // FIFO 领到的是本人任务，不是更早的他学生任务
    const listed = await callToolJson(client, "list_my_ai_tasks", {
      studentId: otherStudent,
    });
    const listedIds = ((listed.data.tasks as { id: string }[]) ?? []).map(
      (task) => task.id,
    );
    expect(listedIds).toContain(mine);
    expect(listedIds).not.toContain(otherTask);
    // 他学生任务未被冒领：仍 created
    const otherStatus = env.db
      .select({ status: aiTasks.status })
      .from(aiTasks)
      .where(eq(aiTasks.id, otherTask))
      .get();
    expect(otherStatus?.status).toBe("created");
    await client.close();
  });
});

/** 建带一笔 UUID 笔画+锚点的圈画材料（annotations 行 revision 1 → refs 漂移） */
function seedAnnotationMaterial(env: ToolsEnv, questionId: string): void {
  const strokeId = randomUUID();
  const doc = {
    version: 1,
    baseWidth: 100,
    baseHeight: 80,
    strokes: [
      {
        tool: "pen",
        color: "#1f2328",
        weight: 4,
        id: strokeId,
        startedAt: 1,
        pointer: "pen",
        points: [{ x: 1, y: 2, p: 0.5, t: 0 }],
      },
    ],
    anchors: { [strokeId]: "stem/p/0" },
  };
  const relBody = `blobs/annotation-bodies/${randomUUID()}.json.gz`;
  mkdirSync(join(env.dataDir, "blobs/annotation-bodies"), {
    recursive: true,
  });
  writeFileSync(
    join(env.dataDir, relBody),
    gzipSync(Buffer.from(JSON.stringify(doc))),
  );
  const baseId = randomUUID();
  env.db
    .insert(annotationBases)
    .values({
      id: baseId,
      attemptId: env.world.attemptId,
      questionId,
      questionRevisionId: "rev-sai26",
      phase: "scratch",
      snapshotHash: "b".repeat(64),
      baseRenderVersion: 2,
      state: "ready",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  env.db
    .insert(annotations)
    .values({
      id: randomUUID(),
      attemptId: env.world.attemptId,
      questionId,
      phase: "scratch",
      baseId,
      revision: 1,
      bodyPath: relBody,
      hash: "a".repeat(64),
      strokeCount: 1,
      pointCount: 1,
      sealedAt: null,
      updatedAt: NOW,
    })
    .run();
}

describe("LR-PR5 材料钉住漂移（评审 #12249 必改③锁）", () => {
  it("创建后材料漂移 → 该题任务 claim 无 record；未漂移任务照常带", async () => {
    const env = await makeEnv();
    const client = await connectClient(env);
    // atMs 显式定序：同毫秒创建会让 FIFO 顺序不确定（全量负载下翻车过）
    mkTask(env, { atMs: 1 });
    mkTask(env, { questionId: env.world.q2, atMs: 2 });
    mkTask(env, { atMs: 3 });
    // 三个任务都创建完再让 q1 漂移：t1/t3（q1）现 refs ≠ 钉住，t2（q2）相等
    seedAnnotationMaterial(env, env.world.q1);
    const first = await callJson(client, "claim_ai_task", {});
    expect(first.isError).toBe(false);
    expect(first.data.record).toBeUndefined();
    const second = await callJson(client, "claim_ai_task", {});
    expect(second.isError).toBe(false);
    expect(second.data.record).toBeDefined();
    const third = await callJson(client, "claim_ai_task", {});
    expect(third.isError).toBe(false);
    expect(third.data.record).toBeUndefined();
    await client.close();
  });
});

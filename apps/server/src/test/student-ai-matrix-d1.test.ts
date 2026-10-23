import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { TextContent } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import { aiTasks } from "../db/schema.ts";
import { assertNoLeak } from "./assert-no-leak.ts";
import { connectMcpClientViaApp } from "./mcp-test-utils.ts";
import { makeNotePng } from "./note-fixtures.ts";
import {
  createMatrixWorld,
  hitsOf,
  jsonViaApp,
  type MatrixWorld,
  shellOf,
} from "./student-ai-matrix-world.ts";

/**
 * SAI-32 跨通道安全矩阵 · 维度 1（B17）：
 * 三通道（inapp / mcp / link）× 三模式（open_study / guided_only /
 * post_submit_only）× 未完成/完成 × 配置来源（教师默认 / 学生覆盖 / 作业覆盖 /
 * 继承默认），含「提交后普通答案尚未公布」三态对照。
 *
 * 双断言方向性（批次文档「必须保留的对照」）：
 * - 允许侧（开放/启发/完成后）：参考答案与官方解析哨兵**必须**出现在合法
 *   出站上下文（页内出站载荷 / MCP 领取数据段 / 链接正文）——不得为「安全
 *   绿灯」把用户要的参考删掉；
 * - 禁止侧（post_submit_only 且未完成）：全部 AI 出口拒绝，且零任务行、
 *   零出站、零票据副作用；
 * - 普通取卷出口（GET /attempts/:id）在任何形态下仍按原有答案公布规则，
 *   不因 AI 策略放宽（assertNoLeak 基础设施零触碰）。
 *
 * 用例编号 D1-01..D1-16（威胁表驱动；每例可独立复跑）：
 * D1-01 inapp×open×未完成×全继承：出站含参考+解析（允许方向）
 * D1-02 inapp×guided×未完成×教师默认：参考+解析仍随启发外发 + 启发硬约束
 * D1-03 inapp×post×未完成×学生明确关闭：创建 403 + 零任务行 + 零出站
 * D1-04 inapp×post×未完成×作业明确关闭（学生 open）：403 不可绕过
 * D1-05 inapp×post×未完成×教师默认继承（学生/作业继承）：403
 * D1-06 inapp×post×学生明确关闭×已完成：完成后恒开放复盘（参考+解析出站）
 * D1-07 mcp×open×未完成：领取数据段含参考+解析
 * D1-08 mcp×post×未完成×学生关闭：领取拒绝（指定 403 / FIFO 无可领）
 * D1-09 mcp×post×已完成：领取照常（复盘尺度）
 * D1-10 link×open×未完成：票据正文含参考+解析
 * D1-11 link×post×未完成：票据生成 403；已有票据正文与附件直连一致拒绝
 * D1-12 link×guided×未完成：启发同样携带参考+解析（§2.1）
 * D1-13 对照：after_due 未到+已交卷：普通结果视图无答案，AI 出口有答案
 * D1-14 教师默认 post + 学生显式 open：显式学生设置覆盖继承默认
 * D1-15 全未配置：继承默认开放伴学
 * D1-16 完成态优先于明确关闭（学生 post + 已完成 → 开放复盘）
 * D1-17 link×post×已完成：票据生成与公开读取/附件按完成态开放复盘（闸门补测）
 *
 * M4-D1（总计划 §12.2）v1 逐题卷「本题完成」按行级 submittedAt（D1-18..20，
 * attempt 仍 draft 的单题提交事实）：
 * D1-18 v1 逐题卷×guided×本题已提交：本题复盘携带参考+解析，邻题仍作答中启发尺度
 * D1-19 v1 逐题卷×post×本题提交邻题未提交：本题复盘出站，邻题 403 零出站 + 普通取卷无答案
 * D1-20 v1 逐题卷教师中途切 post：已提交题出站照常复盘，未提交邻题出站前拦截转 paused
 */

const activeDbs: Db[] = [];

function world(): MatrixWorld {
  const w = createMatrixWorld();
  activeDbs.push(w.db);
  return w;
}

/** v1 逐题卷世界（M4-D1：attempt1 建成新协议 per_question 卷，其余夹具同 world） */
function perQuestionWorld(): MatrixWorld {
  const w = createMatrixWorld({
    workflow: { feedbackMode: "per_question" },
  });
  activeDbs.push(w.db);
  return w;
}

afterEach(() => {
  for (const db of activeDbs.splice(0)) db.$client.close();
});

/** 经路由创建任务（学生 1、qMain）；返回响应壳 */
async function createTask(
  w: MatrixWorld,
  over: Record<string, unknown> = {},
): Promise<{
  status: number;
  error: string | null;
  data: Record<string, unknown> | null;
}> {
  const res = await jsonViaApp(
    w.app,
    w.cookie1,
    "/api/student/ai/tasks",
    "POST",
    {
      attemptId: w.attempt1,
      questionId: w.qMain,
      question: `请讲解：${w.sentinel.question}`,
      channel: "inapp",
      materials: { annotation: false, draft: false, formalInk: false },
      mutationId: randomUUID(),
      ...over,
    },
  );
  return shellOf(res);
}

/** 任务行数（零副作用断言用） */
function taskRowCount(w: MatrixWorld): number {
  return w.db.select({ id: aiTasks.id }).from(aiTasks).all().length;
}

/** MCP callTool → 解析首段 text 为 JSON */
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

describe("SAI-32 矩阵维度 1：三通道 × 三模式 × 完成态 × 配置来源", () => {
  it("D1-01 inapp×open×未完成×全继承：出站含参考答案与官方解析（允许方向）", async () => {
    const w = world();
    const created = await createTask(w);
    expect(created.status).toBe(201);
    w.addInappConnection();
    const { recorded } = await w.dispatchInapp();
    expect(recorded.length).toBe(1);
    const payload = recorded[0]?.body ?? "";
    // 双断言之允许侧：参考答案与官方解析哨兵必须在出站载荷中
    expect(payload).toContain(w.sentinel.refAnswer);
    expect(payload).toContain(w.sentinel.solution);
    // 教师私注与邻题答案不得进入任何出站
    expect(
      hitsOf(payload, [
        w.sentinel.teacherNote,
        w.sentinel.neighborRef,
        w.sentinel.peerRef,
      ]),
    ).toEqual([]);
    expect(payload).toContain("开放伴学");
  });

  it("D1-02 inapp×guided×未完成×教师默认：启发同样携带参考+解析，硬约束在场", async () => {
    const w = world();
    w.setTeacherDefault(w.teacherA, "guided_only");
    const created = await createTask(w);
    expect(created.status).toBe(201);
    w.addInappConnection();
    const { recorded } = await w.dispatchInapp();
    expect(recorded.length).toBe(1);
    const payload = recorded[0]?.body ?? "";
    expect(payload).toContain(w.sentinel.refAnswer);
    expect(payload).toContain(w.sentinel.solution);
    expect(payload).toContain("仅启发");
    expect(payload).toContain("不直接给出最终答案");
  });

  it("D1-03 inapp×post×未完成×学生明确关闭：创建 403 + 零任务行 + 零出站", async () => {
    const w = world();
    w.setOverride("student", w.student1, "post_submit_only");
    const created = await createTask(w);
    expect(created.status).toBe(403);
    expect(created.error).toBe("AI_POLICY_DISABLED");
    expect(taskRowCount(w)).toBe(0);
    w.addInappConnection();
    const { recorded } = await w.dispatchInapp();
    expect(recorded).toEqual([]);
  });

  it("D1-04 inapp×post×未完成×作业明确关闭（学生 open）：403 不可绕过", async () => {
    const w = world();
    w.setOverride("student", w.student1, "open_study");
    w.setOverride("assignment", w.assignmentId, "post_submit_only");
    const created = await createTask(w);
    expect(created.status).toBe(403);
    expect(created.error).toBe("AI_POLICY_DISABLED");
    expect(taskRowCount(w)).toBe(0);
  });

  it("D1-05 inapp×post×未完成×教师默认继承（学生/作业均继承）：403", async () => {
    const w = world();
    w.setTeacherDefault(w.teacherA, "post_submit_only");
    const created = await createTask(w);
    expect(created.status).toBe(403);
    expect(created.error).toBe("AI_POLICY_DISABLED");
    expect(taskRowCount(w)).toBe(0);
  });

  it("D1-06 inapp×post×学生明确关闭×已完成：完成后恒开放复盘", async () => {
    const w = world();
    w.setOverride("student", w.student1, "post_submit_only");
    w.submitAttempt1();
    const created = await createTask(w);
    expect(created.status).toBe(201);
    w.addInappConnection();
    const { recorded } = await w.dispatchInapp();
    expect(recorded.length).toBe(1);
    const payload = recorded[0]?.body ?? "";
    expect(payload).toContain(w.sentinel.refAnswer);
    expect(payload).toContain(w.sentinel.solution);
    expect(payload).toContain("完成后复盘");
  });

  it("D1-07 mcp×open×未完成：领取数据段含参考+解析", async () => {
    const w = world();
    const created = await createTask(w, { channel: "mcp" });
    expect(created.status).toBe(201);
    const token = await w.createMcpToken();
    const client = await connectMcpClientViaApp(
      w.app,
      "/mcp/student",
      token,
      "d1-07",
    );
    const claim = await mcpCall(client, "claim_ai_task", {});
    expect(claim.isError).toBe(false);
    expect(claim.data.claimed).toBe(true);
    const context = JSON.stringify(claim.data);
    expect(context).toContain(w.sentinel.refAnswer);
    expect(context).toContain(w.sentinel.solution);
    expect(
      hitsOf(context, [
        w.sentinel.teacherNote,
        w.sentinel.neighborRef,
        w.sentinel.peerRef,
      ]),
    ).toEqual([]);
    await client.close();
  });

  it("D1-08 mcp×post×未完成×学生关闭：指定领取 403、FIFO 无可领、零出站", async () => {
    const w = world();
    // 开放期先建好任务（模拟教师中途关闭前的存量），再关闭
    const created = await createTask(w, { channel: "mcp" });
    expect(created.status).toBe(201);
    w.setOverride("student", w.student1, "post_submit_only");
    const taskId = created.data?.id;
    expect(typeof taskId).toBe("string");
    const token = await w.createMcpToken();
    const client = await connectMcpClientViaApp(
      w.app,
      "/mcp/student",
      token,
      "d1-08",
    );
    const fifo = await mcpCall(client, "claim_ai_task", {});
    expect(fifo.isError).toBe(false);
    expect(fifo.data.claimed).toBe(false);
    const specified = await mcpCall(client, "claim_ai_task", { taskId });
    expect(specified.isError).toBe(true);
    expect(specified.data.error).toBe("AI_POLICY_DISABLED");
    // 任务行保持 created（未领取、无 dispatched 事实、无租约）
    const row = w.db
      .select()
      .from(aiTasks)
      .where(eq(aiTasks.id, taskId as string))
      .get();
    expect(row?.status).toBe("created");
    expect(row?.leaseToken).toBeNull();
    await client.close();
  });

  it("D1-09 mcp×post×已完成：领取照常（复盘尺度）", async () => {
    const w = world();
    w.setOverride("student", w.student1, "post_submit_only");
    w.submitAttempt1();
    const created = await createTask(w, { channel: "mcp" });
    expect(created.status).toBe(201);
    const token = await w.createMcpToken();
    const client = await connectMcpClientViaApp(
      w.app,
      "/mcp/student",
      token,
      "d1-09",
    );
    const claim = await mcpCall(client, "claim_ai_task", {});
    expect(claim.isError).toBe(false);
    expect(claim.data.claimed).toBe(true);
    expect(JSON.stringify(claim.data)).toContain(w.sentinel.refAnswer);
    expect(claim.data.modeAtSend).toBe("open_study");
    await client.close();
  });

  it("D1-10 link×open×未完成：票据正文含参考+解析", async () => {
    const w = world();
    const created = await createTask(w, { channel: "link" });
    expect(created.status).toBe(201);
    const share = await jsonViaApp(
      w.app,
      w.cookie1,
      `/api/student/ai/tasks/${created.data?.id}/share`,
      "POST",
      {},
    );
    const shareBody = await shellOf(share);
    expect(share.status).toBe(200);
    const ticketUrl = shareBody.data?.ticketUrl;
    expect(typeof ticketUrl).toBe("string");
    const path = new URL(ticketUrl as string).pathname;
    const body = await shellOf(await w.app.request(path));
    expect(body.status).toBe(200);
    expect(body.raw).toContain(w.sentinel.refAnswer);
    expect(body.raw).toContain(w.sentinel.solution);
    expect(
      hitsOf(body.raw, [w.sentinel.teacherNote, w.sentinel.neighborRef]),
    ).toEqual([]);
  });

  it("D1-11 link×post×未完成：票据生成 403；已有票据正文与附件一致拒绝", async () => {
    const w = world();
    // 开放期建任务 + 票据 + 材料，再关闭（存量票据的中途关闭形态）
    const created = await createTask(w, { channel: "link" });
    expect(created.status).toBe(201);
    const taskId = created.data?.id as string;
    const pngRes = await w.app.request(
      `/api/student/ai/tasks/${taskId}/materials`,
      {
        method: "POST",
        headers: { cookie: w.cookie1 },
        body: newSoleForm(),
      },
    );
    expect(pngRes.status).toBe(200);
    const share = await jsonViaApp(
      w.app,
      w.cookie1,
      `/api/student/ai/tasks/${taskId}/share`,
      "POST",
      {},
    );
    expect(share.status).toBe(200);
    const ticketUrl = ((await share.json()) as { data: { ticketUrl: string } })
      .data.ticketUrl;
    const path = new URL(ticketUrl).pathname;
    // 教师中途关闭（学生明确 post_submit_only 且未完成）
    w.setOverride("student", w.student1, "post_submit_only");
    const body = await shellOf(await w.app.request(path));
    expect(body.status).toBe(403);
    expect(body.error).toBe("AI_POLICY_DISABLED");
    const material = await shellOf(
      await w.app.request(`${path}/materials/0.png`),
    );
    expect(material.status).toBe(403);
    expect(material.error).toBe("AI_POLICY_DISABLED");
    // 新票据生成同样拒绝
    const denied = await jsonViaApp(
      w.app,
      w.cookie1,
      `/api/student/ai/tasks/${taskId}/share`,
      "POST",
      {},
    );
    expect(denied.status).toBe(403);
    expect((await shellOf(denied)).error).toBe("AI_POLICY_DISABLED");
  });

  it("D1-12 link×guided×未完成：启发同样携带参考+解析（需求 §2.1）", async () => {
    const w = world();
    w.setTeacherDefault(w.teacherA, "guided_only");
    const created = await createTask(w, { channel: "link" });
    expect(created.status).toBe(201);
    const share = await jsonViaApp(
      w.app,
      w.cookie1,
      `/api/student/ai/tasks/${created.data?.id}/share`,
      "POST",
      {},
    );
    expect(share.status).toBe(200);
    const ticketUrl = ((await share.json()) as { data: { ticketUrl: string } })
      .data.ticketUrl;
    const body = await shellOf(
      await w.app.request(new URL(ticketUrl).pathname),
    );
    expect(body.status).toBe(200);
    expect(body.raw).toContain(w.sentinel.refAnswer);
    expect(body.raw).toContain(w.sentinel.solution);
    // 正文如实呈现发送时模式为仅启发（不承诺保密，§2.1 边界）
    expect(body.raw).toContain("仅启发");
  });

  it("D1-13 对照：after_due 未到+已交卷：普通结果视图无答案，AI 出口有答案", async () => {
    const w = createMatrixWorld({
      answerRelease: "after_due",
      dueAt: "2099-01-01T00:00:00.000Z",
    });
    activeDbs.push(w.db);
    w.submitAttempt1();
    // 普通取卷出口：答案未公布 → 无参考答案/解析哨兵 + assertNoLeak
    // （受限形态允许 null 值的 answers/solutionMd 键——与 student-attempts
    // 既有口径一致，allow 列表不改 assertNoLeak 基础设施）
    const detail = await shellOf(
      await jsonViaApp(
        w.app,
        w.cookie1,
        `/api/student/attempts/${w.attempt1}`,
        "GET",
      ),
    );
    expect(detail.status).toBe(200);
    expect(
      hitsOf(detail.raw, [w.sentinel.refAnswer, w.sentinel.solution]),
    ).toEqual([]);
    assertNoLeak(JSON.parse(detail.raw), {
      allow: ["answers", "answer", "solutionMd"],
    });
    const parsedDetail = JSON.parse(detail.raw) as {
      data?: {
        answersReleased?: boolean;
        units?: { questions?: { answers?: unknown; solutionMd?: unknown }[] }[];
      };
    };
    expect(parsedDetail.data?.answersReleased).toBe(false);
    for (const unit of parsedDetail.data?.units ?? []) {
      for (const question of unit.questions ?? []) {
        expect(question.answers).toBeNull();
        expect(question.solutionMd).toBeNull();
      }
    }
    // AI 出口：完成后复盘 → 参考答案解析可出（受控 AI 出口例外）
    const status = await shellOf(
      await jsonViaApp(
        w.app,
        w.cookie1,
        `/api/student/ai/status?attemptId=${w.attempt1}&questionId=${w.qMain}`,
        "GET",
      ),
    );
    expect(status.status).toBe(200);
    expect(
      (status.data as { resolution?: { usable?: boolean } })?.resolution
        ?.usable,
    ).toBe(true);
    const created = await createTask(w);
    expect(created.status).toBe(201);
    w.addInappConnection();
    const { recorded } = await w.dispatchInapp();
    expect(recorded.length).toBe(1);
    expect(recorded[0]?.body).toContain(w.sentinel.refAnswer);
    expect(recorded[0]?.body).toContain(w.sentinel.solution);
  });

  it("D1-14 教师默认 post + 学生显式 open：显式学生设置覆盖继承默认", async () => {
    const w = world();
    w.setTeacherDefault(w.teacherA, "post_submit_only");
    w.setOverride("student", w.student1, "open_study");
    const created = await createTask(w);
    expect(created.status).toBe(201);
    expect(created.data?.modeAtSend).toBe("open_study");
  });

  it("D1-15 全未配置：继承默认开放伴学", async () => {
    const w = world();
    const created = await createTask(w);
    expect(created.status).toBe(201);
    expect(created.data?.modeAtSend).toBe("open_study");
  });

  it("D1-16 完成态优先于明确关闭：学生 post + 已完成 → 状态裁决开放复盘", async () => {
    const w = world();
    w.setOverride("student", w.student1, "post_submit_only");
    w.submitAttempt1();
    const status = await shellOf(
      await jsonViaApp(
        w.app,
        w.cookie1,
        `/api/student/ai/status?attemptId=${w.attempt1}&questionId=${w.qMain}`,
        "GET",
      ),
    );
    expect(status.status).toBe(200);
    const resolution = (
      status.data as { resolution?: { usable: boolean; mode: string } }
    )?.resolution;
    expect(resolution?.usable).toBe(true);
    expect(resolution?.mode).toBe("open_study");
  });

  it("D1-17 link×post×已完成：票据生成与公开读取/附件按完成态开放复盘（闸门补测）", async () => {
    const w = world();
    w.setOverride("student", w.student1, "post_submit_only");
    w.submitAttempt1();
    // 完成后创建 link 任务不再被 post_submit_only 拦截（复盘尺度）
    const created = await createTask(w, { channel: "link" });
    expect(created.status).toBe(201);
    const taskId = created.data?.id as string;
    const pngRes = await w.app.request(
      `/api/student/ai/tasks/${taskId}/materials`,
      {
        method: "POST",
        headers: { cookie: w.cookie1 },
        body: newSoleForm(),
      },
    );
    expect(pngRes.status).toBe(200);
    const share = await jsonViaApp(
      w.app,
      w.cookie1,
      `/api/student/ai/tasks/${taskId}/share`,
      "POST",
      {},
    );
    expect(share.status).toBe(200);
    const ticketUrl = ((await share.json()) as { data: { ticketUrl: string } })
      .data.ticketUrl;
    const path = new URL(ticketUrl).pathname;
    // 公开读取（无会话）按当前完成态实时裁决：开放复盘，参考+解析在场
    const body = await shellOf(await w.app.request(path));
    expect(body.status).toBe(200);
    expect(body.raw).toContain(w.sentinel.refAnswer);
    expect(body.raw).toContain(w.sentinel.solution);
    expect(
      hitsOf(body.raw, [w.sentinel.teacherNote, w.sentinel.neighborRef]),
    ).toEqual([]);
    // 附件同一裁决链路（requireShareTicketByToken 单源）
    const material = await w.app.request(`${path}/materials/0.png`);
    expect(material.status).toBe(200);
    expect(material.headers.get("content-type")).toBe("image/png");
  });

  it("D1-18 v1 逐题卷×guided×本题行级提交：本题复盘携带参考+解析，邻题仍作答中启发尺度", async () => {
    const w = perQuestionWorld();
    w.setTeacherDefault(w.teacherA, "guided_only");
    // 服务端单题提交本题（M2 行级事实；attempt 仍 draft）
    w.submitQuestion1(w.qMain);
    // 本题：已提交 → 完成态恒 open_study 复盘（启发限制解除）
    const created = await createTask(w);
    expect(created.status).toBe(201);
    expect(created.data?.modeAtSend).toBe("open_study");
    w.addInappConnection();
    const first = await w.dispatchInapp();
    expect(first.recorded.length).toBe(1);
    const mainPayload = first.recorded[0]?.body ?? "";
    // 双断言之允许侧：复盘尺度携带参考答案与官方解析
    expect(mainPayload).toContain(w.sentinel.refAnswer);
    expect(mainPayload).toContain(w.sentinel.solution);
    expect(mainPayload).toContain("完成后复盘");
    expect(
      hitsOf(mainPayload, [w.sentinel.teacherNote, w.sentinel.neighborRef]),
    ).toEqual([]);
    // 邻题：未提交 → 仍作答中（guided 启发尺度，不随本题提交进入复盘）
    const neighbor = await createTask(w, { questionId: w.qNeighbor });
    expect(neighbor.status).toBe(201);
    expect(neighbor.data?.modeAtSend).toBe("guided_only");
    const second = await w.dispatchInapp();
    expect(second.recorded.length).toBe(1);
    const neighborPayload = second.recorded[0]?.body ?? "";
    expect(neighborPayload).toContain("仅启发");
    expect(neighborPayload).toContain("不直接给出最终答案");
    expect(neighborPayload).not.toContain("完成后复盘");
  });

  it("D1-19 v1 逐题卷×post×本题提交邻题未提交：本题复盘出站，邻题 403 零出站 + 普通取卷无答案", async () => {
    const w = perQuestionWorld();
    w.setOverride("student", w.student1, "post_submit_only");
    // 提交前：创建拒绝 + 零任务行（禁止场景：无任何出站载体）
    const before = await createTask(w);
    expect(before.status).toBe(403);
    expect(before.error).toBe("AI_POLICY_DISABLED");
    expect(taskRowCount(w)).toBe(0);
    // 服务端行级提交本题（attempt 仍 draft）
    w.submitQuestion1(w.qMain);
    // 本题：提交后可进入复盘
    const created = await createTask(w);
    expect(created.status).toBe(201);
    expect(created.data?.modeAtSend).toBe("open_study");
    // 邻题：未提交 → 仍不可用（本题提交不解锁邻题）
    const neighbor = await createTask(w, { questionId: w.qNeighbor });
    expect(neighbor.status).toBe(403);
    expect(neighbor.error).toBe("AI_POLICY_DISABLED");
    expect(taskRowCount(w)).toBe(1);
    // 出站：仅本题派发，携带参考+解析；教师私注与邻题答案零出现
    w.addInappConnection();
    const { recorded } = await w.dispatchInapp();
    expect(recorded.length).toBe(1);
    const payload = recorded[0]?.body ?? "";
    expect(payload).toContain(w.sentinel.refAnswer);
    expect(payload).toContain(w.sentinel.solution);
    expect(
      hitsOf(payload, [w.sentinel.teacherNote, w.sentinel.neighborRef]),
    ).toEqual([]);
    // 普通取卷出口不因行级提交解锁答案（draft 草稿视图与 AI 授权相互独立）
    const detail = await shellOf(
      await jsonViaApp(
        w.app,
        w.cookie1,
        `/api/student/attempts/${w.attempt1}`,
        "GET",
      ),
    );
    expect(detail.status).toBe(200);
    expect(
      hitsOf(detail.raw, [
        w.sentinel.refAnswer,
        w.sentinel.solution,
        w.sentinel.teacherNote,
        w.sentinel.neighborRef,
      ]),
    ).toEqual([]);
    assertNoLeak(JSON.parse(detail.raw));
  });

  it("D1-20 v1 逐题卷教师中途切 post：已提交题出站照常复盘，未提交邻题出站前拦截转 paused", async () => {
    const w = perQuestionWorld();
    // 开放期（默认 open_study）先建两题任务
    const main = await createTask(w);
    expect(main.status).toBe(201);
    const neighbor = await createTask(w, { questionId: w.qNeighbor });
    expect(neighbor.status).toBe(201);
    // 服务端行级提交本题 + 教师中途切换 post_submit_only
    w.submitQuestion1(w.qMain);
    w.setTeacherDefault(w.teacherA, "post_submit_only");
    w.addInappConnection();
    const { recorded } = await w.dispatchInapp();
    // 本题已完成 → 复盘裁决不可被新关闭重锁：出站照常携带参考+解析
    expect(recorded.length).toBe(1);
    const payload = recorded[0]?.body ?? "";
    expect(payload).toContain(w.sentinel.refAnswer);
    expect(payload).toContain(w.sentinel.solution);
    expect(
      hitsOf(payload, [w.sentinel.teacherNote, w.sentinel.neighborRef]),
    ).toEqual([]);
    // 邻题未提交 → 出站前重校验拦截：paused、零出站（同一任务下次派发按新模式+新完成态）
    const neighborRow = w.db
      .select()
      .from(aiTasks)
      .where(eq(aiTasks.id, neighbor.data?.id as string))
      .get();
    expect(neighborRow?.status).toBe("paused");
    // 本题任务正常走完派发（不被新关闭转 paused）
    const mainRow = w.db
      .select()
      .from(aiTasks)
      .where(eq(aiTasks.id, main.data?.id as string))
      .get();
    expect(mainRow?.status).not.toBe("paused");
    expect(mainRow?.status).not.toBe("created");
  });
});

/** 材料上传 multipart（一页 annotation PNG；矩阵世界不依赖真实笔迹） */
function newSoleForm(): FormData {
  const form = new FormData();
  form.append(
    "manifest",
    JSON.stringify([
      { kind: "annotation", pageIndex: 0, pixelWidth: 320, pixelHeight: 200 },
    ]),
  );
  form.append("page-0", new Blob([makeNotePng()], { type: "image/png" }));
  return form;
}

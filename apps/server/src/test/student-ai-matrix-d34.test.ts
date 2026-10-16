import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { TextContent } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import { aiTasks, students } from "../db/schema.ts";
import { assertNoLeak } from "./assert-no-leak.ts";
import { connectMcpClientViaApp } from "./mcp-test-utils.ts";
import { makeNotePng } from "./note-fixtures.ts";
import {
  createMatrixWorld,
  hitsOf,
  jsonViaApp,
  shellOf,
  type MatrixWorld,
} from "./student-ai-matrix-world.ts";

/**
 * SAI-32 跨通道安全矩阵 · 维度 3+4（B17）：出口全枚举 + 哨兵唯一标识。
 *
 * 出口清单（批次文档维度 3）：创建/列表/详情/领取/回信交付/正文/附件/
 * 复制文字（降级=同一票据正文端点）/批量创建/错误/日志。
 * 哨兵五类（维度 4）：参考答案 refAnswer / 官方解析 solution / 教师私注
 * teacherNote / 邻题答案 neighborRef / 他域内容 peerRef，另有学生姓名与
 * 凭证（mcp token / inapp apiKey）。扫描对象是正文、Markdown、HTML、
 * 图片字节与错误响应实体，不只扫键名。
 *
 * 用例编号：
 * D3-01 创建/列表/汇总/状态四读出口：assertNoLeak + 零哨兵
 * D3-02 详情：回信按当前策略交付——关闭且未交付时 assistant 消息被过滤
 * D3-03 回信交付门禁（opened）：未交付+关闭 403 → 开放交付 → 再关闭不撤回
 * D3-04 动作出口（update-pending/followup/cancel/retry/archive）壳零哨兵
 * D3-05 材料上传回执 + 票据生成响应：凭证只出现在该给的响应里
 * D3-06 链接正文 HTML：允许哨兵在场、私注/邻题/他域/姓名/UUID 不在场
 * D3-07 链接附件 PNG：字节逐位相等 + 防缓存头
 * D3-08 错误响应实体：404/403/409/400 全壳零哨兵零 token 回显
 * D3-09 MCP list：元信息零内容
 * D3-10 MCP claim：数据段含本题允许哨兵、图片字节同源、私注邻题不在场
 * D3-11 页内出站载荷：允许哨兵 + 注入防御句在场，apiKey 只进 Authorization 头
 * D3-12 批量复盘：逐题快照隔离（各题任务只含本题哨兵）
 * D3-13 日志面：全流程日志零密文哨兵/零 token/零 apiKey
 * D3-14 复制文字降级路径 = 票据正文端点（同 D3-06 授权同源，独立复跑一条）
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

async function createTask(
  w: MatrixWorld,
  over: Record<string, unknown> = {},
): Promise<{ status: number; error: string | null; data: Record<string, unknown> | null }> {
  const res = await jsonViaApp(w.app, w.cookie1, "/api/student/ai/tasks", "POST", {
    attemptId: w.attempt1,
    questionId: w.qMain,
    question: "请讲解本题",
    channel: "inapp",
    materials: { annotation: false, draft: false, formalInk: false },
    mutationId: randomUUID(),
    ...over,
  });
  return shellOf(res);
}

async function mcpCall(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ data: Record<string, unknown>; isError: boolean; raw: string }> {
  const result = await client.callTool({ name, arguments: args });
  const block = (result.content as TextContent[]).find((c) => c.type === "text");
  if (block === undefined) throw new Error(`${name} 结果没有 text content`);
  return {
    data: JSON.parse(block.text) as Record<string, unknown>,
    isError: result.isError === true,
    raw: JSON.stringify(result),
  };
}

/** 上传一页 annotation 材料到任务 */
async function uploadMaterial(w: MatrixWorld, taskId: string): Promise<Uint8Array> {
  const png = makeNotePng();
  const form = new FormData();
  form.append(
    "manifest",
    JSON.stringify([
      { kind: "annotation", pageIndex: 0, pixelWidth: 320, pixelHeight: 200 },
    ]),
  );
  form.append("page-0", new Blob([png], { type: "image/png" }));
  const res = await w.app.request(`/api/student/ai/tasks/${taskId}/materials`, {
    method: "POST",
    headers: { cookie: w.cookie1 },
    body: form,
  });
  expect(res.status).toBe(200);
  return png;
}

/** 生成票据并返回公开读路径 */
async function makeTicketPath(
  w: MatrixWorld,
  taskId: string,
): Promise<{ path: string; token: string }> {
  const share = await jsonViaApp(
    w.app,
    w.cookie1,
    `/api/student/ai/tasks/${taskId}/share`,
    "POST",
    {},
  );
  expect(share.status).toBe(200);
  const { data } = (await share.json()) as { data: { ticketUrl: string } };
  const { ticketUrl } = data;
  return {
    path: new URL(ticketUrl).pathname,
    token: ticketUrl.split("/").pop() ?? "",
  };
}

describe("SAI-32 矩阵维度 3+4：出口全枚举与哨兵扫描", () => {
  it("D3-01 创建/列表/汇总/状态四读出口：assertNoLeak + 零哨兵", async () => {
    const w = world();
    const created = await createTask(w, { channel: "link" });
    expect(created.status).toBe(201);
    const taskId = created.data?.id as string;
    const exits = [
      await shellOf(
        await jsonViaApp(w.app, w.cookie1, "/api/student/ai/tasks?limit=20", "GET"),
      ),
      await shellOf(
        await jsonViaApp(w.app, w.cookie1, "/api/student/ai/queue-summary", "GET"),
      ),
      await shellOf(
        await jsonViaApp(
          w.app,
          w.cookie1,
          `/api/student/ai/status?attemptId=${w.attempt1}&questionId=${w.qMain}`,
          "GET",
        ),
      ),
      await shellOf(await jsonViaApp(w.app, w.cookie1, `/api/student/ai/tasks/${taskId}`, "GET")),
    ];
    for (const exit of exits) {
      expect(exit.status).toBe(200);
      assertNoLeak(JSON.parse(exit.raw));
      expect(hitsOf(exit.raw, w.secretSentinels)).toEqual([]);
    }
  });

  it("D3-02 详情：回信按当前策略交付——关闭且未交付时 assistant 消息被过滤", async () => {
    const w = world();
    const created = await createTask(w);
    expect(created.status).toBe(201);
    w.addInappConnection();
    const { recorded } = await w.dispatchInapp();
    expect(recorded.length).toBe(1);
    // 教师关闭（未完成）且学生尚未打开 → 详情不交付回信正文
    w.setOverride("student", w.student1, "post_submit_only");
    const detail = await shellOf(
      await jsonViaApp(w.app, w.cookie1, `/api/student/ai/tasks/${created.data?.id}`, "GET"),
    );
    expect(detail.status).toBe(200);
    const messages = (detail.data as { messages?: { role: string; contentMd?: string }[] })
      ?.messages;
    expect(messages).toBeDefined();
    expect(messages?.every((message) => message.role === "student")).toBe(true);
    expect(JSON.stringify(detail.raw)).not.toContain("MATRIX-FAKE-REPLY");
    // hasReply 事实仍在（任务视图）
    expect((detail.data as { task?: { hasReply?: boolean } })?.task?.hasReply).toBe(true);
  });

  it("D3-03 回信交付门禁（opened）：未交付+关闭 403 → 开放交付 → 再关闭不撤回", async () => {
    const w = world();
    const created = await createTask(w);
    expect(created.status).toBe(201);
    w.addInappConnection();
    await w.dispatchInapp();
    const taskId = created.data?.id as string;
    w.setOverride("student", w.student1, "post_submit_only");
    const blocked = await shellOf(
      await jsonViaApp(w.app, w.cookie1, `/api/student/ai/tasks/${taskId}/opened`, "POST"),
    );
    expect(blocked.status).toBe(403);
    expect(blocked.error).toBe("AI_POLICY_DISABLED");
    // 教师恢复开放 → 交付成功
    w.clearOverride("student", w.student1);
    const opened = await shellOf(
      await jsonViaApp(w.app, w.cookie1, `/api/student/ai/tasks/${taskId}/opened`, "POST"),
    );
    expect(opened.status).toBe(200);
    // 已交付后再次关闭：重复打开幂等放行（已展示内容不假装撤回，§3.3）
    w.setOverride("student", w.student1, "post_submit_only");
    const reopened = await shellOf(
      await jsonViaApp(w.app, w.cookie1, `/api/student/ai/tasks/${taskId}/opened`, "POST"),
    );
    expect(reopened.status).toBe(200);
    const detail = await shellOf(
      await jsonViaApp(w.app, w.cookie1, `/api/student/ai/tasks/${taskId}`, "GET"),
    );
    expect(detail.raw).toContain("MATRIX-FAKE-REPLY");
  });

  it("D3-04 动作出口（update-pending/followup/cancel/retry/archive）壳零哨兵", async () => {
    const w = world();
    const created = await createTask(w, { channel: "link" });
    const taskId = created.data?.id as string;
    const actions = [
      [`/api/student/ai/tasks/${taskId}/update-pending`, { question: "更新后的诉求" }],
      [`/api/student/ai/tasks/${taskId}/followup`, { question: "追问内容", mutationId: randomUUID() }],
      [`/api/student/ai/tasks/${taskId}/archive`, undefined],
      [`/api/student/ai/tasks/${taskId}/retry`, undefined],
    ] as const;
    for (const [path, body] of actions) {
      const res = await jsonViaApp(w.app, w.cookie1, path, "POST", body);
      const shell = await shellOf(res);
      // followup 对 created 态任务合法语义是 409（未回信不可追问）——两种结局都过泄露面
      expect([200, 409], `${path} → ${shell.status} ${shell.error}`).toContain(shell.status);
      expect(hitsOf(shell.raw, w.secretSentinels)).toEqual([]);
    }
    const cancelled = await jsonViaApp(
      w.app,
      w.cookie1,
      `/api/student/ai/tasks/${taskId}/cancel`,
      "POST",
    );
    const cancelShell = await shellOf(cancelled);
    expect(cancelShell.status).toBe(200);
    expect(hitsOf(cancelShell.raw, w.secretSentinels)).toEqual([]);
  });

  it("D3-05 材料上传回执 + 票据生成响应：凭证只出现在该给的响应里", async () => {
    const w = world();
    const created = await createTask(w, { channel: "link" });
    const taskId = created.data?.id as string;
    await uploadMaterial(w, taskId);
    const { token } = await makeTicketPath(w, taskId);
    // 票据 token 明文只随生成响应（这是产品语义——链接就是要交给学生的凭证）；
    // 但 token 不得出现在任何其他读出口
    const others = [
      await shellOf(await jsonViaApp(w.app, w.cookie1, "/api/student/ai/tasks", "GET")),
      await shellOf(await jsonViaApp(w.app, w.cookie1, `/api/student/ai/tasks/${taskId}`, "GET")),
      await shellOf(await jsonViaApp(w.app, w.cookie2, "/api/student/ai/tasks", "GET")),
    ];
    for (const exit of others) {
      expect(exit.raw).not.toContain(token);
    }
  });

  it("D3-06 链接正文 HTML：允许哨兵在场、禁发内容不在场", async () => {
    const w = world();
    // 学生姓名哨兵（正文装配结构上不收学生姓名——D4 实证）
    w.db
      .update(students)
      .set({ displayName: `MATRIX_NAME_${randomUUID().slice(0, 6)}` })
      .where(eq(students.id, w.student1))
      .run();
    const nameRow = w.db
      .select({ displayName: students.displayName })
      .from(students)
      .where(eq(students.id, w.student1))
      .get();
    const nameSentinel = nameRow?.displayName ?? "";
    const created = await createTask(w, { channel: "link" });
    const taskId = created.data?.id as string;
    await uploadMaterial(w, taskId);
    const { path, token } = await makeTicketPath(w, taskId);
    const res = await w.app.request(path);
    expect(res.status).toBe(200);
    const html = await res.text();
    // 允许侧双断言：参考答案与官方解析必须在（受控 AI 出口例外）
    expect(html).toContain(w.sentinel.refAnswer);
    expect(html).toContain(w.sentinel.solution);
    expect(html).toContain("MATRIX_STEM_MAIN");
    // 禁发面：私注/邻题答案/他域内容/学生姓名/任务与票据内部 UUID/附件绝对路径
    expect(hitsOf(html, [w.sentinel.teacherNote, w.sentinel.neighborRef, w.sentinel.peerRef])).toEqual([]);
    expect(html).not.toContain(nameSentinel);
    expect(html).not.toContain(taskId);
    // 票据正文页对本票据附件的自引用链接（持链者语义）允许携带本票据 token；
    // 剥掉该形态后 token 不得以任何其他形态出现
    expect(html.replaceAll(`/api/public/ai/share/${token}/materials/`, "")).not.toContain(token);
    expect(html).not.toContain(w.dataDir.replaceAll("\\", "/"));
    // 响应头：no-store / no-referrer / noindex + CSP
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("D3-07 链接附件 PNG：字节逐位相等 + 防缓存头", async () => {
    const w = world();
    const created = await createTask(w, { channel: "link" });
    const taskId = created.data?.id as string;
    const png = await uploadMaterial(w, taskId);
    const { path } = await makeTicketPath(w, taskId);
    const res = await w.app.request(`${path}/materials/0.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBe(png.byteLength);
    expect(Buffer.from(bytes).equals(Buffer.from(png))).toBe(true);
    // 越界页号 / 穿越形态 404 同文案
    for (const page of ["5.png", "x.png", "..png", "0.PNG"]) {
      const miss = await w.app.request(`${path}/materials/${page}`);
      expect(miss.status).toBe(404);
    }
  });

  it("D3-08 错误响应实体：404/403/409/400 全壳零哨兵零 token 回显", async () => {
    const w = world();
    const created = await createTask(w, { channel: "link" });
    const taskId = created.data?.id as string;
    const { path, token } = await makeTicketPath(w, taskId);
    const errors: { res: Response; label: string }[] = [];
    errors.push({
      res: await w.app.request(`/api/public/ai/share/${"B".repeat(43)}`),
      label: "猜 token 404",
    });
    errors.push({
      res: await w.app.request(`/api/public/ai/share/${token}/materials/9.png`),
      label: "附件越界 404",
    });
    const noSession = await jsonViaApp(w.app, "", "/api/student/ai/tasks", "POST", {
      attemptId: w.attempt1,
      questionId: w.qMain,
      question: "x",
      channel: "link",
      materials: { annotation: false, draft: false, formalInk: false },
      mutationId: randomUUID(),
    });
    errors.push({ res: noSession, label: "无会话 401" });
    const badBody = await jsonViaApp(w.app, w.cookie1, "/api/student/ai/tasks", "POST", {
      attemptId: "not-a-uuid",
      questionId: w.qMain,
      question: "x",
      channel: "link",
      materials: { annotation: false, draft: false, formalInk: false },
      mutationId: randomUUID(),
    });
    errors.push({ res: badBody, label: "形状错误 400" });
    const strangerTask = await jsonViaApp(
      w.app,
      w.cookie2,
      `/api/student/ai/tasks/${taskId}`,
      "GET",
    );
    errors.push({ res: strangerTask, label: "跨学生 404" });
    for (const { res, label } of errors) {
      const shell = await shellOf(res);
      expect(shell.status, label).toBeGreaterThanOrEqual(400);
      expect(hitsOf(shell.raw, w.secretSentinels), label).toEqual([]);
      expect(shell.raw, label).not.toContain(token);
    }
    void path;
  });

  it("D3-09 MCP list：元信息零内容", async () => {
    const w = world();
    const created = await createTask(w, { channel: "mcp" });
    expect(created.status).toBe(201);
    const token = await w.createMcpToken();
    const client = await connectMcpClientViaApp(w.app, "/mcp/student", token, "d3-09");
    const list = await mcpCall(client, "list_my_ai_tasks", { status: "created" });
    expect(list.isError).toBe(false);
    expect(hitsOf(list.raw, w.secretSentinels)).toEqual([]);
    await client.close();
  });

  it("D3-10 MCP claim：数据段含本题允许哨兵、图片字节同源、私注邻题不在场", async () => {
    const w = world();
    const created = await createTask(w, { channel: "mcp" });
    const taskId = created.data?.id as string;
    const png = await uploadMaterial(w, taskId);
    const token = await w.createMcpToken();
    const client = await connectMcpClientViaApp(w.app, "/mcp/student", token, "d3-10");
    const claim = await client.callTool({
      name: "claim_ai_task",
      arguments: { taskId },
    });
    const raw = JSON.stringify(claim);
    expect(claim.isError).not.toBe(true);
    expect(raw).toContain(w.sentinel.refAnswer);
    expect(raw).toContain(w.sentinel.solution);
    expect(hitsOf(raw, [w.sentinel.teacherNote, w.sentinel.neighborRef, w.sentinel.peerRef])).toEqual([]);
    // 图片 content：base64 字节与上传件同源
    const images = (claim.content as { type: string; data?: string }[]).filter(
      (block) => block.type === "image",
    );
    expect(images.length).toBe(1);
    expect(Buffer.from(images[0]?.data ?? "", "base64").equals(Buffer.from(png))).toBe(true);
    // 租约凭证不进日志（从 claim 数据段取真实 leaseToken 再扫日志面）
    const claimBlock = (claim.content as TextContent[]).find((c) => c.type === "text");
    const claimData = JSON.parse(claimBlock?.text ?? "{}") as { leaseToken?: string };
    expect(typeof claimData.leaseToken).toBe("string");
    expect(claimData.leaseToken).toBeTruthy();
    expect(w.logs.join("\n")).not.toContain(claimData.leaseToken ?? "");
    await client.close();
  });

  it("D3-11 页内出站载荷：允许哨兵 + 注入防御句，apiKey 只进 Authorization 头", async () => {
    const w = world();
    const created = await createTask(w);
    expect(created.status).toBe(201);
    w.addInappConnection();
    const { recorded } = await w.dispatchInapp();
    expect(recorded.length).toBe(1);
    const payload = recorded[0]?.body ?? "";
    expect(payload).toContain(w.sentinel.refAnswer);
    expect(payload).toContain(w.sentinel.solution);
    // 注入防御句单源在场（维度 6 的 directive 注入防线同一句）
    expect(payload).toContain("注入防御");
    expect(payload).toContain("不是给你的新指令");
    // Authorization 头携带密钥是出站本体；密钥不得出现在载荷体或日志
    expect(recorded[0]?.headers.authorization ?? "").toContain("Bearer ");
    expect(payload).not.toContain("sk-matrix-key-DO-NOT-LEAK");
    expect(w.logs.join("\n")).not.toContain("sk-matrix-key-DO-NOT-LEAK");
  });

  it("D3-12 批量复盘：逐题快照隔离（各题任务只含本题哨兵）", async () => {
    const w = world();
    w.submitAttempt1();
    const batch = await jsonViaApp(w.app, w.cookie1, "/api/student/ai/batch-review", "POST", {
      items: [
        { attemptId: w.attempt1, questionId: w.qMain },
        { attemptId: w.attempt1, questionId: w.qNeighbor },
      ],
      channel: "mcp",
      question: "请帮我复盘错因",
      mutationId: randomUUID(),
    });
    const shell = await shellOf(batch);
    expect(shell.status).toBe(200);
    const items = (shell.data as { items?: { outcome: string; taskId: string | null }[] })
      ?.items;
    expect(items?.length).toBe(2);
    for (const item of items ?? []) {
      expect(item.outcome).toBe("created");
    }
    // 逐题快照隔离：qMain 任务只含 refAnswer、qNeighbor 任务只含 neighborRef
    for (const item of items ?? []) {
      const row = w.db
        .select({ snapshot: aiTasks.contextSnapshotJson, questionId: aiTasks.questionId })
        .from(aiTasks)
        .where(eq(aiTasks.id, item.taskId as string))
        .get();
      expect(row).toBeDefined();
      if (row?.questionId === w.qMain) {
        expect(row.snapshot).toContain(w.sentinel.refAnswer);
        expect(row.snapshot).not.toContain(w.sentinel.neighborRef);
      } else {
        expect(row?.snapshot).toContain(w.sentinel.neighborRef);
        expect(row?.snapshot).not.toContain(w.sentinel.refAnswer);
      }
      expect(row?.snapshot).not.toContain(w.sentinel.teacherNote);
    }
    // 伪造 correct 字段 → strict 400（契约结构上无该字段）
    const forged = await jsonViaApp(w.app, w.cookie1, "/api/student/ai/batch-review", "POST", {
      items: [{ attemptId: w.attempt1, questionId: w.qMain, correct: false }],
      channel: "mcp",
      question: "伪造标记",
      mutationId: randomUUID(),
    });
    expect((await shellOf(forged)).status).toBe(400);
  });

  it("D3-13 日志面：全流程日志零密文哨兵/零 token/零 apiKey", async () => {
    const w = world();
    // 打满三通道流量 + 错误路径
    const inappTask = await createTask(w);
    w.addInappConnection();
    await w.dispatchInapp();
    const linkTask = await createTask(w, { channel: "link" });
    await uploadMaterial(w, linkTask.data?.id as string);
    const { path } = await makeTicketPath(w, linkTask.data?.id as string);
    await w.app.request(path);
    await w.app.request(`/api/public/ai/share/${"C".repeat(43)}`);
    const token = await w.createMcpToken();
    const client = await connectMcpClientViaApp(w.app, "/mcp/student", token, "d3-13");
    await mcpCall(client, "list_my_ai_tasks", {});
    await client.close();
    void inappTask;
    const logs = w.logs.join("\n");
    expect(hitsOf(logs, w.secretSentinels)).toEqual([]);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain("sk-matrix-key-DO-NOT-LEAK");
    // 分享路径脱敏：日志里的 share 路径不含真 token
    const shareLines = logs.split("\n").filter((line) => line.includes("/api/public/ai/share/"));
    for (const line of shareLines) {
      expect(line).not.toMatch(new RegExp(`/api/public/ai/share/${path.split("/").pop()}`));
    }
  });

  it("D3-14 复制文字降级路径 = 票据正文端点（授权同源独立复跑）", async () => {
    const w = world();
    const created = await createTask(w, { channel: "link" });
    const taskId = created.data?.id as string;
    const { path } = await makeTicketPath(w, taskId);
    // 降级（外部 AI 读不了链接 → 复制文字）读的就是同一票据正文端点；
    // 中途关闭后该路径同样拒绝（与服务端实时裁决同源，不因降级绕过）
    w.setOverride("student", w.student1, "post_submit_only");
    const degraded = await shellOf(await w.app.request(path));
    expect(degraded.status).toBe(403);
    expect(degraded.error).toBe("AI_POLICY_DISABLED");
    expect(hitsOf(degraded.raw, w.secretSentinels)).toEqual([]);
    w.clearOverride("student", w.student1);
    const allowed = await shellOf(await w.app.request(path));
    expect(allowed.status).toBe(200);
    expect(allowed.raw).toContain(w.sentinel.refAnswer);
  });
});
